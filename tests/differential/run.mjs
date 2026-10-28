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
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataset, ES_INDEX, INDEX, VARIANTS, clickhouseDDL, clickhouseRow, esDocument, configOverride } from './dataset.mjs';
import { CASES } from './cases.mjs';
import { loadEngine } from '../../scripts/engine.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ES = (args.es || process.env.ES_URL || 'http://127.0.0.1:9200').replace(/\/+$/, '');
const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const WORK = process.env.PASSERELLE_DIFF_WORK || join(tmpdir(), 'passerelle-diff');
const ONLY = args.only ? new RegExp(args.only) : null;
const variants = args.variant ? [args.variant] : Object.keys(VARIANTS);

const E = loadEngine();

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
// Requête jouée sous un point-in-time, comme l’exige un tri sur _shard_doc ; la traduction reçoit la requête sans « pit »
async function esWithPit(dsl) {
  const open = await es(`/${INDEX}/_pit?keep_alive=1m`);
  if (open.status !== 200) return open;
  try { return await es('/_search', Object.assign({}, dsl, { pit: { id: open.body.id, keep_alive: '1m' } })); }
  finally { await es('/_pit', { id: open.body.id }, 'DELETE'); }
}
const esError = E.eqEsError;

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

/* ---------- Comparaison et exécution d’un cas ---------- */
// Le comparateur est celui de « passerelle verify » (src/engine/equivalence.js) : le banc l’alimente avec son jeu de
// données, la commande avec les données du client. Le banc ne fournit que l’accès à ses deux moteurs.
const runCase = (c, ctx) => E.eqRunCase(c, {
  translate: ctx.translate,
  search: dsl => es(`/${INDEX}/_search`, dsl),
  searchPit: dsl => esWithPit(dsl),
  sql: sql => query(ctx.dir, sql, ctx.tz),
  // Listes nommées : la table et ses lignes sont créées avant la requête, comme le fera l’utilisateur
  setup: list => {
    try { clickhouse(ctx.dir, ['--multiquery', '--query', list.sql]); return null; }
    catch (e) { return String(e.stderr || e.message).slice(0, 200); }
  }
});

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
const totals = { same: 0, known: 0, failed: 0 };
const failures = [];
for (const variant of variants) {
  const dir = loadClickHouse(docs, variant);
  const cfg = E.mergeConfig(E.DEFAULT_CONFIG, configOverride(variant));
  console.log(`--- Schéma ${variant} : ${VARIANTS[variant]}`);
  for (const c of CASES) {
    if (ONLY && !ONLY.test(c.id)) continue;
    for (const tz of c.tz || ['UTC']) {
      const caseCfg = c.config ? E.mergeConfig(cfg, c.config) : cfg;
      const ctx = { dir, tz, variant, translate: dsl => E.translateDSL(JSON.stringify(dsl), caseCfg, { index: INDEX }) };
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
