/* Passerelle — Node.js : équivalence sur les données du client (passerelle verify) */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  coverage,
  EQ_ECS_MODES,
  EQ_STATES,
  eqBoundWindow,
  eqComparePipelineOutputs,
  eqLogstashSource,
  eqOutName,
  eqPinNow,
  eqPipelineParts,
  eqReportCSV,
  eqReportHTML,
  eqReportMarkdown,
  eqRunCase,
  eqSentence,
  eqStateOf,
  eqSummarize,
  eqTimeField,
  eqVectorSource,
  eqWindow,
  isObj,
  KB_TYPES,
  kibanaInventory,
  mergeConfig,
  preprocessDSL,
  translateDSL,
  translateLogstash,
  verdictOf
} from '../engine/index.js';
import { collect, expand, fail, outDir, VERSION } from './common.js';
import { loadCfgOrFail } from './config.js';

/*
 * Le banc différentiel prouve la traduction sur un jeu de données de test. « passerelle verify » rejoue la même
 * preuve sur les données du client : chaque requête DSL est jouée sur son Elasticsearch et sa traduction sur son
 * ClickHouse, sur une fenêtre de temps close, puis les résultats sont comparés par le comparateur du banc
 * (src/engine/equivalence.js). Le résultat est un rapport daté, requête par requête.
 *
 * Lecture seule des deux côtés : Elasticsearch ne reçoit que des _search (jamais d’écriture, jamais de scroll ni de
 * point-in-time), ClickHouse que des SELECT sous readonly = 1. Il s’appuie sur common.js et le moteur ;
 * src/server.js et src/node/assist.js l’appellent.
 */

/* ---------- Elasticsearch (lecture seule) ---------- */
// Les seules routes appelées. Tout le reste est refusé ici, quoi que demande l’appelant.
// _watcher/_query/watches : lecture des watches (passerelle watcher pull), privilège monitor_watcher
const ES_ALLOWED = [
  ['GET', /^\/$/],
  ['POST', /^\/[^/?]+\/_search$/],
  ['POST', /^\/_watcher\/_query\/watches$/]
];

export function esClient(cfg, override) {
  const es = cfg.elasticsearch;
  const endpoint = expand(override || es.endpoint).replace(/\/+$/, '');
  if (!endpoint) throw new Error('elasticsearch.endpoint n’est pas configuré (ou --es URL)');
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`elasticsearch.endpoint illisible : ${endpoint}`);
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const key = expand(es.api_key);
  const user = expand(es.user);
  if (key) headers.authorization = `ApiKey ${key}`;
  else if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${expand(es.password)}`).toString('base64')}`;
  const timeout = (Number(cfg.verify.timeout) || 60) * 1000;
  async function call(method, path, body) {
    const route = path.split('?')[0];
    if (!ES_ALLOWED.some(([m, re]) => m === method && re.test(route)))
      throw new Error(
        `appel Elasticsearch refusé : ${method} ${route} (lecture seule : GET /, POST /<index>/_search et POST /_watcher/_query/watches)`
      );
    try {
      const r = await fetch(endpoint + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout + 5000)
      });
      const text = await r.text();
      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: { type: 'réponse illisible', reason: text.slice(0, 160) } };
      }
      return { status: r.status, body: parsed };
    } catch (e) {
      return {
        status: 0,
        body: {
          error: {
            type: 'connexion',
            reason:
              e.name === 'TimeoutError' ? 'délai dépassé' : (e.cause && (e.cause.code || e.cause.message)) || e.message
          }
        }
      };
    }
  }
  return {
    endpoint,
    info: () => call('GET', '/'),
    // Les décomptes exacts (track_total_hits) sont nécessaires : sans eux, Elasticsearch plafonne le total à 10 000
    search(index, dsl) {
      const body = Object.assign({}, dsl);
      if (body.track_total_hits === undefined) body.track_total_hits = true;
      if (body.timeout === undefined) body.timeout = `${Math.round(timeout / 1000)}s`;
      return call(
        'POST',
        `/${encodeURIComponent(index).replace(/%2A/g, '*').replace(/%2C/g, ',')}/_search?allow_partial_search_results=false`,
        body
      );
    },
    // Une page des watches du cluster ({ from, size }) : { count, watches: [{ _id, watch, status }] }
    queryWatches: body => call('POST', '/_watcher/_query/watches', body)
  };
}

/* ---------- ClickHouse (lecture seule) ---------- */
function clickhouseReader(cfg) {
  const ch = cfg.clickhouse;
  const ep = expand(ch.endpoint).replace(/\/+$/, '');
  if (!ep) throw new Error('clickhouse.endpoint n’est pas configuré');
  const timeout = Number(cfg.verify.timeout) || 60;
  async function query(sql) {
    const url = new URL(ep + '/');
    url.searchParams.set('database', expand(ch.database) || 'default');
    // readonly = 1 et les réglages du résultat dans la même requête : ClickHouse les applique d’un bloc (voir clickhouseQuery)
    url.searchParams.set('readonly', '1');
    url.searchParams.set('max_execution_time', String(timeout));
    url.searchParams.set('default_format', 'JSONEachRow');
    url.searchParams.set('date_time_output_format', 'iso');
    url.searchParams.set('output_format_json_quote_64bit_integers', '0');
    url.searchParams.set('output_format_json_quote_denormals', '1');
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    const user = expand(ch.user);
    if (user) {
      headers['x-clickhouse-user'] = user;
      headers['x-clickhouse-key'] = expand(ch.password);
    }
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers, body: sql, signal: AbortSignal.timeout(timeout * 1000 + 5000) });
    } catch (e) {
      return {
        error: `ClickHouse injoignable : ${e.name === 'TimeoutError' ? 'délai dépassé' : (e.cause && (e.cause.code || e.cause.message)) || e.message}`
      };
    }
    const text = (await r.text()).trim();
    if (!r.ok) {
      const m = /Code: \d+\. DB::Exception: [^\n]*/.exec(text);
      return { error: (m ? m[0] : `HTTP ${r.status} ${text}`).slice(0, 260) };
    }
    try {
      return {
        rows: text
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
      };
    } catch {
      return { error: `réponse illisible de ClickHouse : ${text.slice(0, 120)}` };
    }
  }
  return { query };
}

/* ---------- Les requêtes à comparer ---------- */
// Texte d’une requête (JSON, ou « GET index/_search » suivi du JSON, ou le corps d’un client) → { index, dsl } ou { error }
function verifyParseQuery(text, index) {
  let body = String(text || '').trim();
  let idx = index || '';
  const m = /^(GET|POST)\s+(\S+)[^\n]*\n?/i.exec(body);
  if (m) {
    const segs = m[2].replace(/^\//, '').split('/');
    if (segs[0] && !segs[0].startsWith('_')) idx = idx || segs[0];
    body = body.slice(m[0].length).trim();
  }
  let dsl;
  try {
    dsl = body ? JSON.parse(preprocessDSL(body)) : {};
  } catch (e) {
    return { error: `JSON invalide : ${e.message}` };
  }
  if (!isObj(dsl)) return { error: 'la requête doit être un objet JSON' };
  if (dsl.params && isObj(dsl.params.body)) {
    idx = idx || dsl.params.index || '';
    dsl = dsl.params.body;
  } else if (isObj(dsl.body) && (dsl.index || Object.keys(dsl).length <= 3)) {
    idx = idx || dsl.index || '';
    dsl = dsl.body;
  }
  return { index: idx, dsl };
}

// Fichiers de requêtes DSL et exports Kibana → liste { title, source, index, dsl } (ou error)
function verifyCollectQueries(o, cfg) {
  const out = [];
  const files = collect(o._, /\.(json|txt|es|ndjson)$/i);
  if (!files.length) fail('aucun fichier .json, .txt, .es ou .ndjson trouvé');
  const kibana = files.filter(f => /\.ndjson$/i.test(f));
  for (const f of files.filter(x => !kibana.includes(x))) {
    const r = verifyParseQuery(fs.readFileSync(f, 'utf8'), o.index);
    out.push(
      r.error
        ? { title: path.basename(f), source: f, error: r.error }
        : { title: path.basename(f), source: f, index: r.index, dsl: r.dsl }
    );
  }
  if (kibana.length) {
    const inv = kibanaInventory(
      kibana.map(f => fs.readFileSync(f, 'utf8')),
      cfg,
      { names: kibana.map(f => path.basename(f)), timeZone: null }
    );
    const byKey = new Map(inv.entries.map(x => [x.key, x]));
    for (const e of inv.entries)
      for (const q of e.queries || []) {
        const parent = e.parent ? (byKey.get(e.parent) || {}).title : '';
        const title = `${parent ? `${parent} › ` : ''}${e.title}${e.queries.length > 1 ? ` › ${q.title}` : ''}`;
        // Le motif d’index de la vue de données de Kibana : --index le remplace, comme pour dsl2sql
        out.push(
          q.dsl
            ? {
                title,
                source: `${kibana.map(f => path.basename(f)).join(', ')} (${KB_TYPES[e.type] || e.type})`,
                index: o.index || q.pattern || '',
                dsl: q.dsl
              }
            : { title, source: kibana.join(', '), error: q.error || 'requête non reconstituée' }
        );
      }
  }
  return out;
}

/* ---------- passerelle verify queries ---------- */
const VERIFY_MARK = { identical: '✓', different: '≠', error: '✗', inconclusive: '~', not_compared: '-' };
const verifyStamp = d =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');

function verifyWriteReport(rep, o) {
  const render = {
    md: eqReportMarkdown,
    html: eqReportHTML,
    csv: eqReportCSV,
    json: r => JSON.stringify(r, null, 2) + '\n'
  };
  const fmt = o.format || 'md';
  if (!render[fmt]) fail(`--format attend md, html, csv ou json pour verify, pas « ${fmt} »`);
  if (!o.out) {
    process.stdout.write(render[fmt](rep));
    return;
  }
  outDir(o.out);
  const base = path.join(o.out, `equivalence-${rep.kind}-${verifyStamp(new Date(rep.generated_at))}`);
  for (const f of ['md', 'html', 'csv', 'json']) fs.writeFileSync(`${base}.${f}`, render[f](rep));
  process.stderr.write(`rapport → ${base}.{md,html,csv,json}\n`);
}
function verifyExit(rep, o) {
  const s = rep.summary.byState;
  if (s.different) process.exit(2);
  if (s.error) process.exit(1);
  if (o.strict && (s.inconclusive || s.not_compared)) process.exit(2);
}
// Écarts cités : au plus « examples », avec ou sans valeurs
export function verifyDiffs(diffs, cfg, o) {
  const max = Math.max(1, Number(o.examples) || Number(cfg.verify.examples) || 3);
  const list = (diffs || []).map(d => (o['no-values'] ? d.safe : d.text));
  return list.length > max
    ? list
        .slice(0, max)
        .concat([
          `… et ${list.length - max} autre${list.length - max > 1 ? 's' : ''} écart${list.length - max > 1 ? 's' : ''}`
        ])
    : list;
}

async function verifyQueries(o) {
  if (!o._.length)
    fail('aucune requête à comparer. Exemple : passerelle verify queries requetes/ --index "logs-*" --out rapport/');
  const cfg = loadCfgOrFail(o);
  let es;
  let chr;
  try {
    es = esClient(cfg, o.es);
    chr = clickhouseReader(cfg);
  } catch (e) {
    fail(e.message);
  }
  const now = Date.now();
  const win = eqWindow(
    { from: o.from, to: o.to, length: o.last || cfg.verify.window.length, lag: o.lag || cfg.verify.window.lag },
    now
  );
  if (win.error) fail(win.error);
  const queries = verifyCollectQueries(o, cfg);
  if (o['max-queries'] !== undefined && queries.length > Number(o['max-queries']))
    fail(`${queries.length} requêtes, plus que --max-queries ${o['max-queries']} : chacune pèse sur les deux moteurs`);

  // Les deux moteurs répondent-ils ? Mieux vaut le savoir avant la première requête
  const info = await es.info();
  if (info.status !== 200)
    fail(
      `Elasticsearch ne répond pas sur ${es.endpoint} (${info.body.error ? `${info.body.error.type || ''} ${info.body.error.reason || ''}`.trim() : `HTTP ${info.status}`})`
    );
  const ver = await chr.query('SELECT version() AS v');
  if (ver.error) fail(ver.error);

  const items = [];
  const fields = new Set();
  for (const q of queries) {
    const t0 = Date.now();
    const item = { title: q.title, source: q.source, index: q.index || '' };
    items.push(item);
    const finish = (state, reason, extra) => {
      Object.assign(item, { state, reason: reason || '', elapsed_ms: Date.now() - t0 }, extra || {});
      process.stderr.write(`${VERIFY_MARK[state]} ${EQ_STATES[state]} : ${q.title}${reason ? ` — ${reason}` : ''}\n`);
    };
    if (q.error) {
      finish('error', q.error);
      continue;
    }
    if (!q.index) {
      finish('error', 'index inconnu : précisez --index');
      continue;
    }
    if (q.dsl.pit) {
      finish('not_compared', 'la requête porte un point-in-time : à rejouer à la main');
      continue;
    }
    const index = q.index;
    const translate = dsl => translateDSL(JSON.stringify(dsl), cfg, { index });
    const first = translate(q.dsl);
    if (first.error) {
      finish('error', `traduction : ${first.error}`, { translation: { verdict: 'unrecognized' } });
      continue;
    }
    if (first.parameters && first.parameters.length) {
      finish('not_compared', `paramètres à fournir : ${first.parameters.map(p => p.source).join(', ')}`, {
        table: first.table,
        translation: { verdict: verdictOf(first) }
      });
      continue;
    }
    const field = eqTimeField(cfg, first.table);
    fields.add(field);
    const pinned = eqPinNow(q.dsl, win.to).dsl;
    const dsl = o['no-window'] ? pinned : eqBoundWindow(pinned, field, win.from, win.to);
    // Une agrégation composite seule à la racine : ses pages sont lues jusqu’au bout des deux côtés
    const roots = Object.keys(dsl.aggs || dsl.aggregations || {});
    const composite = roots.length === 1 && (dsl.aggs || dsl.aggregations)[roots[0]].composite ? roots[0] : null;
    if (!composite && roots.some(r => (dsl.aggs || dsl.aggregations)[r].composite)) {
      finish('not_compared', 'agrégation composite avec d’autres agrégations : à comparer à la main', {
        table: first.table,
        translation: { verdict: verdictOf(first) }
      });
      continue;
    }
    const c = {
      dsl,
      composite,
      stream: cfg.clickhouse.composite_mode === 'stream',
      tol: Number(cfg.verify.tolerance) || 1e-9,
      skipTodo: true,
      noProbe: true
    };
    if (composite && !c.dsl.aggs) c.dsl = Object.assign({}, dsl, { aggs: dsl.aggregations });
    const res = await eqRunCase(c, {
      translate,
      search: d => es.search(index, d),
      searchPit: () => ({ status: 0, body: {} }),
      sql: s => chr.query(s)
    });
    const st = eqStateOf(res);
    const t = res.t || first;
    finish(st.state, st.reason, {
      table: t.table,
      translation: {
        verdict: t.error ? 'unrecognized' : verdictOf(t),
        coverage: t.stats ? coverage(t.stats).percent : null
      },
      docs: res.docs === undefined ? null : res.docs,
      diffs: verifyDiffs(
        res.diffs || (res.detail && res.verdict === '≠' ? [{ text: res.detail, safe: res.safe || res.detail }] : []),
        cfg,
        o
      )
    });
  }
  const rep = {
    kind: 'queries',
    generated_at: new Date(now).toISOString(),
    passerelle: VERSION,
    conditions: {
      window: o['no-window']
        ? null
        : {
            from: win.from,
            to: win.to,
            field: [...fields].join(', ') || '@timestamp',
            explicit: win.explicit,
            length: o.last || cfg.verify.window.length,
            lag: o.lag || cfg.verify.window.lag
          },
      engines: {
        Elasticsearch: `${info.body.version ? info.body.version.number : '?'}${info.body.cluster_name && !o['no-values'] ? ` (cluster ${info.body.cluster_name})` : ''}`,
        ClickHouse: `${ver.rows[0] ? ver.rows[0].v : '?'}, base ${expand(cfg.clickhouse.database) || 'default'}`
      },
      notes: [`« now » figé à ${new Date(win.to).toISOString()} pour les deux moteurs.`].concat(
        o['no-window']
          ? [
              'Aucune fenêtre ajoutée : les requêtes sont comparées sur la période qu’elles décrivent, dernières minutes comprises.'
            ]
          : []
      )
    },
    values_hidden: !!o['no-values'],
    items
  };
  rep.summary = eqSummarize(items);
  process.stderr.write(`${eqSentence(rep.summary, 'requête')}\n`);
  verifyWriteReport(rep, o);
  verifyExit(rep, o);
}

/* ---------- passerelle verify pipelines ---------- */
// Un moteur lancé sur un fichier : { code, out, timedOut }
export function verifyRun(bin, args, opts) {
  return new Promise(resolve => {
    let fd = null;
    try {
      fd = opts.stdin ? fs.openSync(opts.stdin, 'r') : null;
    } catch {
      return resolve({ code: -1, out: `lecture impossible : ${opts.stdin}`, error: true });
    }
    const child = nodeSpawn(bin, args, {
      env: opts.env || process.env,
      cwd: opts.cwd,
      stdio: [fd === null ? 'ignore' : fd, 'pipe', 'pipe'],
      windowsHide: true
    });
    let tail = '';
    let timedOut = false;
    let spawnError = null;
    const keep = d => {
      tail = (tail + d).slice(-6000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeout || 600000);
    child.on('error', e => {
      spawnError = e;
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (fd !== null)
        try {
          fs.closeSync(fd);
        } catch {
          /* déjà fermé */
        }
      resolve({
        code: spawnError ? -1 : code,
        out: spawnError
          ? spawnError.code === 'ENOENT'
            ? `binaire introuvable : ${bin}`
            : spawnError.message
          : tail.replace(/\x1b\[[0-9;]*m/g, ''),
        timedOut,
        error: !!spawnError
      });
    });
  });
}
export const verifyEvents = file =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];
export const verifyOutputs = (dir, prefix, names) =>
  Object.fromEntries(names.map(n => [n, verifyEvents(path.join(dir, `${eqOutName(prefix, n)}.ndjson`))]));
export const lastLines = (text, n) =>
  String(text)
    .split('\n')
    .filter(l => l.trim() && !/librdkafka|rdkafka::/.test(l))
    .slice(-n)
    .join(' ⏎ ')
    .slice(0, 400);

// Deux retouches d’environnement, pas de traitement : un dossier de données à soi, et pas d’API (le port 8686
// est peut-être celui du Vector qui tourne déjà sur cette machine)
export const verifyRetouch = (yaml, dataDir) =>
  yaml.replace(/^data_dir:.*$/m, `data_dir: ${dataDir}`).replace(/^api:\n(?: {2}.*\n)+/m, 'api:\n  enabled: false\n');
// Vector joue l’échantillon (entrée standard) avec cette configuration : null, ou la raison de l’échec
export async function verifyPlayVector(yaml, vecDir, input, vectorBin, timeout) {
  const conf = path.join(vecDir, 'vector.yaml');
  fs.writeFileSync(conf, yaml);
  const venv = Object.assign({}, process.env, { VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION: 'true' });
  const v = await verifyRun(vectorBin, ['--quiet', '--color', 'never', '--config', conf], {
    stdin: input,
    env: venv,
    timeout
  });
  return v.error || v.code !== 0
    ? `Vector : ${v.timedOut ? 'délai dépassé' : v.error ? v.out : `code ${v.code}, ${lastLines(v.out, 3)}`}`
    : null;
}
// La référence : les événements déjà produits par le pipeline du client, ou son Logstash rejouant l’échantillon.
// Rend { ref } ou { error }
export async function verifyReference(o, parts, dirs, input, mode, id, timeout) {
  if (o.reference) {
    let st;
    try {
      st = fs.statSync(o.reference);
    } catch {
      return { error: `référence introuvable : ${o.reference}` };
    }
    if (st.isDirectory())
      return {
        ref: Object.fromEntries(
          parts.outputNames.map(name => [name, verifyEvents(path.join(o.reference, `${name}.ndjson`))])
        )
      };
    if (parts.outputNames.length === 1) return { ref: { [parts.outputNames[0]]: verifyEvents(o.reference) } };
    return {
      error: `le pipeline a ${parts.outputNames.length} sorties (${parts.outputNames.join(', ')}) : --reference attend un dossier avec un <sortie>.ndjson par sortie`
    };
  }
  const lsConf = path.join(dirs.ls, 'replay.conf');
  fs.writeFileSync(lsConf, eqLogstashSource(parts, mode, input, path.join(dirs.ls, 'out'), id));
  const l = await verifyRun(
    o['logstash-bin'],
    [
      '--path.data',
      path.join(dirs.ls, 'data'),
      '--path.logs',
      path.join(dirs.ls, 'logs'),
      '--pipeline.workers',
      '1',
      '--pipeline.ecs_compatibility',
      mode,
      '--log.level',
      'warn',
      '-f',
      lsConf
    ],
    { timeout }
  );
  if (l.error || l.code !== 0)
    return {
      error: `Logstash : ${l.timedOut ? 'délai dépassé' : l.error ? l.out : `code ${l.code}, ${lastLines(l.out, 3)}`}`
    };
  return { ref: verifyOutputs(path.join(dirs.ls, 'out'), id, parts.outputNames) };
}

async function verifyPipelines(o) {
  if (!o._.length)
    fail(
      'aucun pipeline à comparer. Exemple : passerelle verify pipelines pipelines/web.conf --sample echantillon.ndjson --logstash-bin /usr/share/logstash/bin/logstash'
    );
  if (!o.sample)
    fail('--sample FICHIER est nécessaire : les événements d’entrée, un par ligne (un export du topic Kafka d’entrée)');
  if (!fs.existsSync(o.sample)) fail(`échantillon introuvable : ${o.sample}`);
  const mode = o.ecs || 'v8';
  if (!EQ_ECS_MODES.includes(mode)) fail(`--ecs attend ${EQ_ECS_MODES.join(' ou ')}, pas « ${mode} »`);
  if (!o['logstash-bin'] && !o.reference)
    fail(
      'la référence manque : --logstash-bin (le Logstash du client rejoue l’échantillon) ou --reference (les événements que son pipeline a produits)'
    );
  const cfg0 = loadCfgOrFail(o);
  const cfg = mergeConfig(cfg0, { vector: { ecs_compatibility: mode } });
  const files = collect(o._, /\.(conf|cfg|logstash)$/i);
  if (!files.length) fail('aucun fichier .conf trouvé');
  const vectorBin = o['vector-bin'] || process.env.PASSERELLE_VECTOR_BIN || 'vector';
  const sample = fs
    .readFileSync(o.sample, 'utf8')
    .split('\n')
    .filter(l => l.trim());
  const timeout = (Number(o.timeout) || 600) * 1000;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-verify-'));
  const now = Date.now();
  const items = [];
  const notes = new Set();
  try {
    for (const [n, file] of files.entries()) {
      const t0 = Date.now();
      const title = path.basename(file);
      const id = `p${n}`;
      const item = { title, source: file };
      items.push(item);
      const finish = (state, reason, extra) => {
        Object.assign(item, { state, reason: reason || '', elapsed_ms: Date.now() - t0 }, extra || {});
        process.stderr.write(`${VERIFY_MARK[state]} ${EQ_STATES[state]} : ${title}${reason ? ` — ${reason}` : ''}\n`);
      };
      const parts = eqPipelineParts(fs.readFileSync(file, 'utf8'));
      if (parts.error) {
        finish('not_compared', parts.error);
        continue;
      }
      parts.caveats.forEach(c => notes.add(c));
      const dir = path.join(work, id);
      const dirs = { vec: path.join(dir, 'vector'), ls: path.join(dir, 'logstash') };
      for (const d of Object.values(dirs)) fs.mkdirSync(path.join(d, 'out'), { recursive: true });
      fs.mkdirSync(path.join(dirs.vec, 'data'), { recursive: true });
      const input = path.join(dir, 'sample.ndjson');
      fs.writeFileSync(input, sample.join('\n') + '\n');
      // Vector : la configuration que produit Passerelle pour le pipeline réduit à ses filtres, sans retouche
      const t = translateLogstash(eqVectorSource(parts, path.join(dirs.vec, 'out'), id), cfg);
      if (t.error || t.empty) {
        finish('error', `traduction impossible : ${t.error || 'résultat vide'}`, {
          translation: { verdict: 'unrecognized' }
        });
        continue;
      }
      const translation = { verdict: verdictOf(t), coverage: coverage(t.stats).percent };
      const failure = await verifyPlayVector(
        verifyRetouch(t.yaml, path.join(dirs.vec, 'data')),
        dirs.vec,
        input,
        vectorBin,
        timeout
      );
      if (failure) {
        finish('error', failure, { translation });
        continue;
      }
      const got = await verifyReference(o, parts, dirs, input, mode, id, timeout);
      if (got.error) {
        finish('error', got.error, { translation });
        continue;
      }
      const ref = got.ref;
      const vec = verifyOutputs(path.join(dirs.vec, 'out'), id, parts.outputNames);
      // Une minute de marge de part et d’autre : l’horodatage d’ingestion tombe pendant l’exécution
      const cmp = eqComparePipelineOutputs(ref, vec, parts.outputNames, [now - 60000, Date.now() + 60000], {
        labels: { ref: o.reference ? 'référence' : 'Logstash', vec: 'Vector' }
      });
      const shown = verifyDiffs(cmp.diffs, cfg, o);
      if (!cmp.events && !Object.values(vec).some(l => l.length))
        finish(
          'inconclusive',
          'aucun événement en sortie : l’échantillon est vide ou entièrement écarté par le pipeline',
          { translation, docs: 0 }
        );
      else if (cmp.diffs.length)
        finish('different', `${cmp.events - cmp.identical} événement(s) sur ${cmp.events} diffèrent`, {
          translation,
          docs: cmp.events,
          diffs: shown
        });
      else finish('identical', '', { translation, docs: cmp.events });
    }
  } finally {
    if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
    else process.stderr.write(`fichiers de travail conservés : ${work}\n`);
  }
  const rep = {
    kind: 'pipelines',
    generated_at: new Date(now).toISOString(),
    passerelle: VERSION,
    conditions: {
      window: null,
      engines: {
        Référence: o.reference
          ? `événements déjà produits (${path.basename(o.reference)})`
          : `Logstash ${path.basename(o['logstash-bin'])}, ecs_compatibility ${mode}`,
        Vector: `${vectorBin}, ecs_compatibility ${mode}`
      },
      sample: `${sample.length} événement${sample.length > 1 ? 's' : ''} (${path.basename(o.sample)})`,
      notes: [...notes].concat(
        sample.length < 100
          ? ['Un échantillon de moins de 100 événements ne dit rien des cas rares : élargissez-le avant de conclure.']
          : []
      )
    },
    values_hidden: !!o['no-values'],
    items
  };
  rep.summary = eqSummarize(items);
  process.stderr.write(`${eqSentence(rep.summary, 'pipeline')}\n`);
  verifyWriteReport(rep, o);
  verifyExit(rep, o);
}

export function verifyCommand(o) {
  const sub = o._.shift();
  if (sub === 'queries') return verifyQueries(o).catch(e => fail(e.message));
  if (sub === 'pipelines') return verifyPipelines(o).catch(e => fail(e.message));
  return fail(`sous-commande inconnue : verify ${sub || ''}`.trim() + ' (queries ou pipelines)');
}
