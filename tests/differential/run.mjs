#!/usr/bin/env node
/*
 * Banc différentiel : chaque requête DSL est exécutée sur Elasticsearch, sa traduction sur ClickHouse,
 * et les deux résultats sont comparés ligne à ligne.
 *
 *   node tests/differential/run.mjs [--es=URL] [--variant=N|D] [--only=regex] [--verbose] [--sql]
 *
 *   ES_URL             adresse d’Elasticsearch (défaut http://127.0.0.1:9200 ; voir es.sh)
 *   CLICKHOUSE_LOCAL   commande ClickHouse locale (défaut clickhouse-local ; « clickhouse local » convient)
 *   PASSERELLE_DIFF_WORK   dossier de travail, sur un système de fichiers Linux
 *
 * Code de sortie : 0 si chaque cas se comporte comme annoncé dans cases.mjs, 1 sinon
 * (régression, ou écart connu qui a disparu sans que cases.mjs soit mis à jour).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset, ES_INDEX, INDEX, VARIANTS, clickhouseDDL, clickhouseRow, esDocument, configOverride } from './dataset.mjs';
import { CASES } from './cases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ES = (args.es || process.env.ES_URL || 'http://127.0.0.1:9200').replace(/\/+$/, '');
const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const WORK = process.env.PASSERELLE_DIFF_WORK || join(tmpdir(), 'passerelle-diff');
const ONLY = args.only ? new RegExp(args.only) : null;
const variants = args.variant ? [args.variant] : Object.keys(VARIANTS);

const rd = p => readFileSync(join(ROOT, p), 'utf8');
const engine = ['src/engine/base.js', 'src/engine/dsl.js', 'src/engine/logstash.js'].map(rd).join('');
const E = new Function(`'use strict';\n${engine}\nreturn { translateDSL, DEFAULT_CONFIG, mergeConfig };`)();

/* ---------- Accès aux deux moteurs ---------- */
async function es(path, body, method) {
  const bulk = typeof body === 'string';
  const r = await fetch(ES + path, {
    method: method || 'POST',
    headers: { 'content-type': bulk ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : bulk ? body : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function esError(r) {
  const e = r.body.error || {};
  const cause = (e.root_cause && e.root_cause[0]) || e;
  return `HTTP ${r.status} ${cause.type || ''} : ${String(cause.reason || '').slice(0, 160)}`;
}

// Le fuseau du serveur ClickHouse est simulé par la variable TZ.
function clickhouse(dir, argv, tz) {
  return execFileSync(CH_BIN, [...CH_PRE, '--path', dir, ...argv], {
    encoding: 'utf8', maxBuffer: 256e6, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TZ: tz || 'UTC' })
  });
}
function query(dir, sql, tz) {
  try {
    const out = clickhouse(dir, [
      '--format=JSONEachRow', '--date_time_output_format=iso',
      '--output_format_json_quote_64bit_integers=0', '--output_format_json_quote_denormals=1',
      '--query', sql
    ], tz);
    return { rows: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    const m = /Code: \d+\. DB::Exception: [^\n]*/.exec(msg);
    return { error: (m ? m[0] : msg).slice(0, 260) };
  }
}

async function loadElasticsearch(docs) {
  await es(`/${INDEX}`, undefined, 'DELETE');
  const created = await es(`/${INDEX}`, ES_INDEX, 'PUT');
  if (created.status !== 200) throw new Error(`création de l’index : ${esError(created)}`);
  const bulk = docs.map(d => JSON.stringify({ index: { _index: INDEX, _id: d._id } }) + '\n' + JSON.stringify(esDocument(d)) + '\n').join('');
  const loaded = await es('/_bulk?refresh=true', bulk);
  if (loaded.status !== 200 || loaded.body.errors) throw new Error(`chargement Elasticsearch : ${JSON.stringify(loaded.body).slice(0, 300)}`);
}
function loadClickHouse(docs, variant) {
  const dir = join(WORK, `clickhouse-${variant}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(WORK, `rows-${variant}.jsonl`);
  writeFileSync(file, docs.map(d => JSON.stringify(clickhouseRow(d))).join('\n') + '\n');
  clickhouse(dir, ['--multiquery', '--query', `SET date_time_input_format = 'best_effort';\n${clickhouseDDL(variant)}\nINSERT INTO logs.events FROM INFILE '${file}' FORMAT JSONEachRow;`]);
  const n = query(dir, 'SELECT count() AS n FROM logs.events').rows[0].n;
  if (n !== docs.length) throw new Error(`chargement ClickHouse incomplet : ${n} lignes sur ${docs.length}`);
  return dir;
}

/* ---------- Normalisation des résultats ---------- */
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(v);
const normKey = v => (v === undefined ? null : isDate(v) ? Date.parse(v) : v);
function same(a, b, tol) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (isDate(b)) b = Date.parse(b);
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}
const BUCKET_FIELDS = new Set(['key', 'key_as_string', 'doc_count', 'from', 'to', 'from_as_string', 'to_as_string', 'doc_count_error_upper_bound', 'sum_other_doc_count', 'meta']);

// Colonnes attendues côté ClickHouse pour une mesure Elasticsearch (null : ce n’est pas une mesure)
function metricColumns(name, a, type) {
  if (a === null || typeof a !== 'object') return {};
  if ('buckets' in a) return null;
  if ('values' in a) {
    const keys = Object.keys(a.values);
    if (type === 'percentile_ranks') return Object.fromEntries(keys.map(k => [`${name}_${String(Number(k)).replace(/\W/g, '_')}`, a.values[k]]));
    return { [name]: keys.map(k => a.values[k]) };
  }
  if ('count' in a && 'min' in a && 'avg' in a) {
    const o = { [`${name}_count`]: a.count, [`${name}_min`]: a.min, [`${name}_max`]: a.max, [`${name}_avg`]: a.avg, [`${name}_sum`]: a.sum };
    if ('variance' in a) Object.assign(o, { [`${name}_variance`]: a.variance, [`${name}_std_deviation`]: a.std_deviation, [`${name}_sum_of_squares`]: a.sum_of_squares });
    return o;
  }
  if ('value' in a) {
    const o = { [name]: a.value };
    if (Array.isArray(a.keys)) o[`${name}_key`] = a.keys[0];
    return o;
  }
  if ('hits' in a || 'doc_count' in a) return null;
  return {};
}
function leafMetrics(bucket, defs) {
  const typeOf = n => { const d = defs && defs[n]; return d ? Object.keys(d).find(k => k !== 'aggs' && k !== 'aggregations') : null; };
  const m = {};
  for (const [name, a] of Object.entries(bucket)) {
    if (BUCKET_FIELDS.has(name)) continue;
    const cols = metricColumns(name, a, typeOf(name));
    if (cols) { Object.assign(m, cols); continue; }
    // Sous-filtre sans regroupement : la traduction le fusionne en colonnes <nom>_doc_count, <nom>_<mesure>
    if (a && typeof a === 'object' && !('buckets' in a) && !('hits' in a) && 'doc_count' in a) {
      m[`${name}_doc_count`] = a.doc_count;
      for (const [sub, v] of Object.entries(a)) {
        if (BUCKET_FIELDS.has(sub)) continue;
        const c = metricColumns(`${name}_${sub}`, v, null);
        if (c) Object.assign(m, c);
      }
    }
  }
  return m;
}
const subAggs = def => (def && (def.aggs || def.aggregations)) || {};
// Parcourt l’arbre d’agrégations d’Elasticsearch le long d’un chemin et appelle onLeaf(bucket, clés, définitions enfants)
function walkBuckets(aggs, defs, path, onLeaf) {
  (function walk(cur, curDefs, i, keys) {
    const name = path[i];
    const a = cur && cur[name];
    if (!a) return;
    const children = subAggs(curDefs && curDefs[name]);
    let buckets;
    if (Array.isArray(a.buckets)) buckets = a.buckets.map(b => [b.key, b]);
    else if (a.buckets && typeof a.buckets === 'object') buckets = Object.entries(a.buckets);
    else buckets = [[undefined, a]];
    for (const [k, b] of buckets) {
      const next = Object.assign({}, keys);
      if (k !== undefined) {
        if (k !== null && typeof k === 'object' && !Array.isArray(k)) Object.assign(next, k);
        else next[name] = k;
      }
      if (i < path.length - 1) walk(b, children, i + 1, next);
      else onLeaf(b, next, children);
    }
  })(aggs, defs, 0, {});
}
function esBucketRows(aggs, defs, path) {
  const rows = [];
  walkBuckets(aggs, defs, path, (b, keys, children) => rows.push({ keys, doc_count: b.doc_count, m: leafMetrics(b, children) }));
  return rows;
}
const short = v => { const s = JSON.stringify(v === undefined ? null : v); return s.length > 120 ? s.slice(0, 120) + '…' : s; };

// Compare des lignes Elasticsearch { keys, doc_count, m } aux lignes ClickHouse ; renvoie la liste des écarts
function compareRows(esRows, chRows, tol) {
  const keyNames = [...new Set(esRows.flatMap(r => Object.keys(r.keys)))];
  const metricNames = [...new Set(esRows.flatMap(r => Object.keys(r.m)))];
  const keyOf = get => JSON.stringify(keyNames.map(k => normKey(get(k))));
  // Une agrégation qui porte le nom d’une colonne citée par la requête est suffixée _agg par la traduction
  const col = (row, name) => (name in row || !(`${name}_agg` in row) ? row[name] : row[`${name}_agg`]);
  const esKeys = esRows.map(r => keyOf(k => r.keys[k]));
  const chKeys = chRows.map(r => keyOf(k => col(r, k)));
  const chByKey = new Map(chKeys.map((k, i) => [k, chRows[i]]));
  const esSet = new Set(esKeys);
  const missing = esKeys.filter(k => !chByKey.has(k));
  const extra = chKeys.filter(k => !esSet.has(k));
  const diffs = [];
  esRows.forEach((r, i) => {
    const c = chByKey.get(esKeys[i]);
    if (!c) return;
    if (!same(r.doc_count, c.doc_count)) diffs.push(`${esKeys[i]} doc_count ES ${r.doc_count} / CH ${c.doc_count}`);
    for (const m of metricNames) if (!same(r.m[m], col(c, m), tol)) diffs.push(`${esKeys[i]} ${m} ES ${short(r.m[m])} / CH ${short(col(c, m))}`);
  });
  const common = new Set(esKeys.filter(k => chByKey.has(k)));
  const sameOrder = JSON.stringify(esKeys.filter(k => common.has(k))) === JSON.stringify(chKeys.filter(k => common.has(k)));
  const out = [];
  if (esRows.length !== chRows.length) out.push(`ES ${esRows.length} lignes / CH ${chRows.length}`);
  if (missing.length) out.push(`${missing.length} absentes côté CH, ex. ${missing.slice(0, 3).join(' ')}`);
  if (extra.length) out.push(`${extra.length} en trop côté CH, ex. ${extra.slice(0, 3).join(' ')}`);
  if (diffs.length) out.push(`${diffs.length} valeurs ≠, ex. ${diffs.slice(0, 2).join(' ; ')}`);
  if (!sameOrder) out.push('ordre différent');
  return out;
}
function compareIds(label, esIds, chIds) {
  if (JSON.stringify(esIds) === JSON.stringify(chIds)) return [];
  const sameSet = esIds.length === chIds.length && [...esIds].sort().join() === [...chIds].sort().join();
  return [`[${label}] ${sameSet ? 'mêmes documents, ordre différent' : 'documents différents'} : ES ${esIds.slice(0, 6).join(',')}… / CH ${chIds.slice(0, 6).join(',')}…`];
}

/* ---------- Exécution d’un cas ---------- */
async function runComposite(c, ctx) {
  const name = c.composite;
  const sources = c.dsl.aggs[name].composite.sources.map(s => Object.keys(s)[0]);
  const size = c.dsl.aggs[name].composite.size;
  const page = after => { const d = structuredClone(c.dsl); if (after) d.aggs[name].composite.after = after; return d; };

  const esRows = [];
  for (let p = 0, after; p < 500; p++) {
    const r = await es(`/${INDEX}/_search`, page(after));
    if (r.status !== 200) return { verdict: 'ES✗', detail: esError(r) };
    const a = r.body.aggregations[name];
    a.buckets.forEach(b => esRows.push({ keys: b.key, doc_count: b.doc_count, m: leafMetrics(b, subAggs(c.dsl.aggs[name])) }));
    if (!a.after_key || !a.buckets.length) break;
    after = a.after_key;
  }

  const chRows = [];
  let t = null; let pages = 0; let firstKey = null;
  for (let p = 0, after; p < 500; p++) {
    t = ctx.translate(page(after));
    if (t.error) return { verdict: 'TR✗', detail: t.error };
    const r = query(ctx.dir, t.statements[0].sql, ctx.tz);
    if (r.error) return { verdict: 'CH✗', detail: r.error, t };
    pages++;
    if (!r.rows.length) break;
    const key = JSON.stringify(sources.map(s => r.rows[0][s]));
    if (p > 0 && key === firstKey) return { verdict: '≠', detail: `pagination bouclée : la page ${p + 1} recommence à la première clé ${key}`, t };
    if (p === 0) firstKey = key;
    chRows.push(...r.rows);
    // Le client reprend les clés de la dernière ligne, au format d’Elasticsearch (dates en epoch millis)
    const last = r.rows[r.rows.length - 1];
    after = Object.fromEntries(sources.map(s => [s, normKey(last[s])]));
    if (r.rows.length < size) break;
  }
  const diffs = compareRows(esRows, chRows, c.tol);
  return { verdict: diffs.length ? '≠' : '=', detail: `${diffs.join(' | ')} (${esRows.length} groupes ES, ${pages} pages CH)`, t };
}

async function runCase(c, ctx) {
  if (c.composite) return runComposite(c, ctx);
  const t = ctx.translate(c.dsl);
  const r = await es(`/${INDEX}/_search`, c.dsl);
  if (t.error) return { verdict: r.status === 200 ? 'TR✗' : '=', detail: `traducteur : ${t.error}${r.status === 200 ? '' : ` ; Elasticsearch refuse aussi (${esError(r)})`}` };
  if (r.status !== 200) {
    // Elasticsearch refuse la requête : la traduction doit le signaler (« à reprendre »), pas produire un SQL silencieux
    return t.stats.ko ? { verdict: '=', detail: `refusée des deux côtés : ${esError(r)}`, t } : { verdict: 'ES✗', detail: `${esError(r)} — la traduction produit pourtant du SQL sans rien signaler`, t };
  }
  if (c.unsupported) {
    // Construction hors de portée : la traduction doit la déclarer « à reprendre » et le SQL doit s’arrêter
    // sur le message de Passerelle, au lieu de renvoyer un résultat.
    const errors = t.statements.map(s => query(ctx.dir, s.sql, ctx.tz).error || '');
    const stopped = t.stats.ko > 0 && errors.some(e => /Passerelle : .* à traduire/.test(e));
    return { verdict: stopped ? '=' : '≠', detail: stopped ? 'déclarée à reprendre, le SQL s’arrête' : `attendu : à reprendre et SQL arrêté ; obtenu ko=${t.stats.ko}, ${errors.join(' | ') || 'exécution sans erreur'}`, t };
  }
  const defs = c.dsl.aggs || c.dsl.aggregations || {};
  const diffs = [];
  let failed = false;
  for (const s of t.statements) {
    const q = query(ctx.dir, s.sql, ctx.tz);
    if (q.error) { failed = true; diffs.push(`[${s.title}] ClickHouse : ${q.error}`); continue; }
    let m;
    if ((m = /^Agrégation (.+)$/.exec(s.title))) {
      const d = compareRows(esBucketRows(r.body.aggregations, defs, m[1].split(' › ')), q.rows, c.tol);
      if (d.length) diffs.push(`[${m[1]}] ${d.join(' | ')}`);
    } else if ((m = /^Top hits (.+)$/.exec(s.title))) {
      // Les documents sont comparés groupe par groupe, dans l’ordre ; l’ordre des groupes entre eux
      // est celui du regroupement parent, déjà vérifié par sa propre requête.
      const path = m[1].split(' › ');
      const keyNames = path.slice(0, -1);
      const esGroups = new Map();
      walkBuckets(r.body.aggregations, defs, keyNames, (b, keys) => esGroups.set(JSON.stringify(Object.values(keys).map(normKey)), b[path[path.length - 1]].hits.hits.map(h => h._id)));
      const chGroups = new Map();
      for (const x of q.rows) {
        const k = JSON.stringify(keyNames.filter(n => n in x).map(n => normKey(x[n])));
        if (!chGroups.has(k)) chGroups.set(k, []);
        chGroups.get(k).push(x._id);
      }
      for (const k of new Set([...esGroups.keys(), ...chGroups.keys()])) diffs.push(...compareIds(`${m[1]} ${k}`, esGroups.get(k) || [], chGroups.get(k) || []));
    } else if (s.title === 'Mesures globales') {
      const d = compareRows([{ keys: {}, m: leafMetrics(r.body.aggregations, defs) }], q.rows, c.tol);
      if (d.length) diffs.push(`[mesures] ${d.join(' | ')}`);
    } else if ((m = /^Pipeline (.+)$/.exec(s.title))) {
      const d = compareRows([{ keys: {}, m: metricColumns(m[1], r.body.aggregations[m[1]], null) || {} }], q.rows, c.tol);
      if (d.length) diffs.push(`[${m[1]}] ${d.join(' | ')}`);
    } else if (s.title === 'Documents') {
      diffs.push(...compareIds('documents', r.body.hits.hits.map(h => h._id), q.rows.map(x => x._id)));
    } else if (/^Total|^Comptage/.test(s.title)) {
      const row = q.rows[0] || {};
      const n = row.total !== undefined ? row.total : row.count;
      if (r.body.hits.total.value !== n) diffs.push(`[total] ES ${r.body.hits.total.value} / CH ${n}`);
    }
  }
  return { verdict: failed ? 'CH✗' : diffs.length ? '≠' : '=', detail: diffs.join(' || '), t };
}

function knownFor(c, variant, tz) {
  const k = c.known;
  if (!k) return null;
  if (typeof k === 'string') return k;
  return k[`${variant}@${tz}`] || k[`@${tz}`] || k[variant] || null;
}

/* ---------- Principal ---------- */
const info = await es('/', undefined, 'GET').catch(() => null);
if (!info || info.status !== 200) {
  console.error(`Elasticsearch injoignable sur ${ES}. Lancez « tests/differential/es.sh up » ou définissez ES_URL.`);
  process.exit(1);
}
const chVersion = execFileSync(CH_BIN, [...CH_PRE, '--version'], { encoding: 'utf8' }).trim().replace(/^ClickHouse local version /, '').replace(/ \(.*/, '');
// Le SQL généré vise ClickHouse 26.9 et les versions suivantes : une version plus ancienne fausserait le banc
const [chMajor, chMinor] = chVersion.split('.').map(Number);
if (chMajor < 26 || (chMajor === 26 && chMinor < 9)) {
  console.error(`ClickHouse 26.9 ou plus récent est requis (trouvé ${chVersion}). tests/differential/clickhouse.sh extrait le binaire d’une version précise.`);
  process.exit(1);
}
console.log(`Elasticsearch ${info.body.version.number} / ClickHouse ${chVersion} / Node.js ${process.versions.node}\n`);

const docs = dataset();
mkdirSync(WORK, { recursive: true });
await loadElasticsearch(docs);
const cfg = E.mergeConfig(E.DEFAULT_CONFIG, configOverride());
const totals = { same: 0, known: 0, failed: 0 };
const failures = [];
for (const variant of variants) {
  const dir = loadClickHouse(docs, variant);
  console.log(`--- Schéma ${variant} : ${VARIANTS[variant]}`);
  for (const c of CASES) {
    if (ONLY && !ONLY.test(c.id)) continue;
    for (const tz of c.tz || ['UTC']) {
      const ctx = { dir, tz, variant, translate: dsl => E.translateDSL(JSON.stringify(dsl), cfg, { index: INDEX }) };
      const res = await runCase(c, ctx);
      const known = knownFor(c, variant, tz);
      const label = `${c.id}${c.tz ? ` @${tz}` : ''}`;
      const stats = res.t && res.t.stats;
      const flagged = !!(res.t && ((stats && (stats.approx || stats.ko)) || (res.t.notes || []).some(n => n.level === 'warn' || n.level === 'err')));
      let status;
      if (res.verdict === '=' && !known) { status = 'ok   '; totals.same++; }
      else if (res.verdict !== '=' && known) { status = 'connu'; totals.known++; }
      else { status = 'ÉCHEC'; totals.failed++; failures.push(`${label} [${variant}]`); }
      const why = res.verdict === '=' ? (known ? ' — écart connu disparu : retirez « known » dans cases.mjs' : '') : known ? ` — ${known}${flagged ? '' : ' (non signalé par la traduction)'}` : ' — RÉGRESSION';
      console.log(`${status} ${res.verdict.padEnd(3)} ${label}${why}`);
      if (res.detail && (status === 'ÉCHEC' || args.verbose)) console.log(`          ${res.detail}`);
      if (args.sql && res.t && res.t.sql) console.log(res.t.sql.split('\n').map(l => `          | ${l}`).join('\n'));
    }
  }
  console.log('');
}
console.log(`Bilan : ${totals.same} identiques, ${totals.known} écarts connus, ${totals.failed} échecs.`);
if (failures.length) console.log(`Échecs : ${failures.join(', ')}`);
process.exit(totals.failed ? 1 : 0);
