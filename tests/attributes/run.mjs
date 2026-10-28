#!/usr/bin/env node
/*
 * Banc des colonnes d’attributs (schéma OpenTelemetry de ClickStack) : sans Elasticsearch.
 *
 * Le banc différentiel prouve que la traduction vers une table plate donne le résultat d’Elasticsearch. Ce banc-ci
 * charge les mêmes documents dans le schéma otel_logs, attributs en Map de chaînes (préréglage otel) puis en colonnes
 * JSON (préréglage otel-json), traduit chaque cas du banc différentiel pour ces deux tables, et compare les résultats
 * à ceux de la table plate. Égaux, ils sont aussi ceux d’Elasticsearch.
 *
 *   node tests/attributes/run.mjs [--only=regex] [--verbose] [--sql]
 *
 *   CLICKHOUSE_LOCAL   commande ClickHouse locale (défaut clickhouse-local ; « clickhouse local » convient)
 *   PASSERELLE_ATTR_WORK   dossier de travail, sur un système de fichiers Linux
 *
 * Code de sortie : 0 si chaque cas donne le résultat de la table plate (ou l’écart inventorié dans KNOWN), 1 sinon.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataset, INDEX, clickhouseDDL, clickhouseRow, configOverride } from '../differential/dataset.mjs';
import { CASES } from '../differential/cases.mjs';
import { loadEngine } from '../../scripts/engine.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const WORK = process.env.PASSERELLE_ATTR_WORK || join(tmpdir(), 'passerelle-attributs');
const ONLY = args.only ? new RegExp(args.only) : null;
const E = loadEngine();

/*
 * Écarts inventoriés : la traduction vers les attributs ne peut pas donner le même résultat, pour une raison connue.
 * Le banc échoue si l’un d’eux disparaît, pour rappeler de retirer la mention.
 */
const KNOWN = {
  audit_top_metrics_size_chaine: 'host est un attribut sans type déclaré : la traduction le suppose numérique et le convertit, avec une remarque « à vérifier », là où Elasticsearch refuse un tri de top_metrics sur un keyword'
};
// Même inventaire, par motif d'identifiant
const KNOWN_RE = [
  [/^geo_(rayon|londres)/, 'geo_distance sur un attribut : une position n’est pas un Point dans une Map ou une colonne JSON, la traduction est « à reprendre » (throwIf) au lieu d’un SQL qui échouerait à l’exécution']
];

/* ---------- ClickHouse ---------- */
function clickhouse(dir, argv, tz) {
  return execFileSync(CH_BIN, [...CH_PRE, '--path', dir, ...argv], {
    encoding: 'utf8', maxBuffer: 256e6, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TZ: tz || 'UTC' })
  });
}
function query(dir, sql, tz) {
  try {
    const out = clickhouse(dir, ['--format=JSONEachRow', '--date_time_output_format=iso', '--output_format_json_quote_64bit_integers=0', '--output_format_json_quote_denormals=1', '--query', sql], tz);
    return { rows: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    const m = /Code: \d+\. DB::Exception: [^\n]*/.exec(msg);
    return { error: (m ? m[0] : msg).slice(0, 300) };
  }
}

/* ---------- Les trois tables ---------- */
// Champs de la table plate rangés en attributs ; les tableaux restent des colonnes (une Map de chaînes ne les garde pas)
const ATTRS = ['service', 'host', 'env', 'level', 'status', 'latency_ms', 'bytes', 'ratio', 'user', 'http.method', 'retries', 'title'];
const OTEL_DDL = (attributes, extra) => `CREATE DATABASE IF NOT EXISTS otel;
CREATE DATABASE IF NOT EXISTS logs;
CREATE TABLE otel.otel_logs (
    _id String,
    Timestamp DateTime64(9),
    TraceId String, SpanId String, TraceFlags UInt8,
    SeverityText LowCardinality(String), SeverityNumber UInt8,
    ServiceName LowCardinality(String),
    Body String,
    ResourceSchemaUrl LowCardinality(String),
    ResourceAttributes ${attributes},
    ScopeSchemaUrl LowCardinality(String), ScopeName String, ScopeVersion LowCardinality(String),
    ScopeAttributes ${attributes},
    LogAttributes ${extra || attributes},
    EventName String,
    tags Array(String),
    nums Array(Int64),
    ${attributes === 'JSON' ? 'LogAttributesKeys Array(LowCardinality(String)),' : ''}
    INDEX idx_body lowerUTF8(Body) TYPE text(tokenizer = splitByNonAlpha)
) ENGINE = MergeTree ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp);`;
// Colonne JSON : des chemins typés (dont un Nullable) et des chemins dynamiques, pour éprouver les deux lectures
const JSON_LOG = 'JSON(status UInt16, level LowCardinality(String), retries Nullable(Int64))';
function otelRow(d, json) {
  const flat = clickhouseRow(d);
  const attrs = {};
  for (const k of ATTRS) if (flat[k] !== undefined) attrs[k] = json ? flat[k] : String(flat[k]);
  const row = { _id: flat._id, Timestamp: flat.timestamp, Body: flat.message, LogAttributes: attrs, ResourceAttributes: {}, ScopeAttributes: {} };
  if (flat.tags !== undefined) row.tags = flat.tags;
  if (flat.nums !== undefined) row.nums = flat.nums;
  if (json) row.LogAttributesKeys = Object.keys(attrs);
  return row;
}
function load(name, ddl, rows) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(WORK, `${name}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const table = /CREATE TABLE (\S+)/.exec(ddl.split('\n').find(l => l.startsWith('CREATE TABLE')))[1];
  clickhouse(dir, ['--multiquery', '--query', `SET date_time_input_format = 'best_effort';\n${ddl}\nINSERT INTO ${table} FROM INFILE '${file}' FORMAT JSONEachRow;`]);
  const n = query(dir, `SELECT count() AS n FROM ${table}`).rows[0].n;
  if (n !== rows.length) throw new Error(`chargement ${name} incomplet : ${n} lignes sur ${rows.length}`);
  return dir;
}

/* ---------- Configurations ---------- */
const flatCfg = E.mergeConfig(E.DEFAULT_CONFIG, configOverride('N'));
const otelProfile = (preset, types) => ({
  clickhouse: {
    index_mapping: { 'logs-*': 'otel.otel_logs' },
    tables: { 'otel.otel_logs': {
      preset,
      text_fields: ['message', 'Body', 'title'],
      columns: { _id: 'String', tags: 'Array(String)', nums: 'Array(Int64)', ...(preset === 'otel-json' ? { LogAttributes: JSON_LOG } : {}) },
      attribute_types: types
    } }
  }
});
// Map : bytes n’est pas déclaré, il est converti à la lecture (avec remarque) ; JSON : ratio non plus
const mapCfg = E.mergeConfig(flatCfg, otelProfile('otel', { status: 'Int64', latency_ms: 'Int64', ratio: 'Float64', retries: 'Int64' }));
const jsonCfg = E.mergeConfig(flatCfg, otelProfile('otel-json', { bytes: 'Int64', latency_ms: 'Int64' }));

/* ---------- Comparaison ---------- */
// Un alias qui masquerait une colonne de la table plate y reçoit le suffixe _agg : il est retiré des deux côtés
const normRow = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_agg$/, ''), v]));
function same(a, b, tol) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) return Date.parse(a) === Date.parse(b);
  // Une clé numérique lue dans un attribut peut revenir en nombre d’un côté, en chaîne de l’autre
  if ((typeof a === 'number') !== (typeof b === 'number') && String(a) === String(b)) return true;
  return a === b;
}
// Documents (SELECT *) : les colonnes diffèrent d’un schéma à l’autre, seuls les identifiants et leur ordre comptent.
// Export composite en flux : l’ordre des groupes n’a pas de sens.
function compare(ref, got, opts) {
  opts = opts || {};
  if (ref.length !== got.length) return [`${ref.length} lignes attendues, ${got.length} obtenues`];
  if (opts.ids) { const a = ref.map(r => r._id).join(','); const b = got.map(r => r._id).join(','); return a === b ? [] : [`documents : ${a.slice(0, 80)}… / ${b.slice(0, 80)}…`]; }
  const order = rows => (opts.unordered ? rows.map(normRow).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)) : rows.map(normRow));
  const R = order(ref); const G = order(got);
  const out = [];
  R.forEach((r, i) => {
    const g = G[i];
    for (const k of Object.keys(r)) if (!same(r[k], g[k], opts.tol)) out.push(`ligne ${i + 1}, ${k} : ${JSON.stringify(r[k])} / ${JSON.stringify(g[k])}`);
  });
  return out;
}
function runStatements(dir, t, tz) {
  const res = [];
  for (const list of t.lists || []) clickhouse(dir, ['--multiquery', '--query', list.sql.replace(/logs\.passerelle_lists/g, list.table)]);
  for (const s of t.statements) res.push(Object.assign({ title: s.title }, query(dir, s.sql, tz)));
  return res;
}
// Pagination composite : la page suivante reprend les clés de la dernière ligne
function runComposite(c, dir, cfg, tz) {
  const name = c.composite; const sources = c.dsl.aggs[name].composite.sources.map(s => Object.keys(s)[0]);
  const rows = [];
  for (let p = 0, after; p < 500; p++) {
    const d = structuredClone(c.dsl); if (after) d.aggs[name].composite.after = after;
    const t = E.translateDSL(JSON.stringify(d), cfg, { index: INDEX });
    if (t.error) return { error: t.error };
    const r = query(dir, t.statements[0].sql, tz);
    if (r.error) return { error: r.error, t };
    rows.push(...r.rows);
    if (!r.rows.length || r.rows.length < c.dsl.aggs[name].composite.size || (c.config && c.config.clickhouse && c.config.clickhouse.composite_mode === 'stream')) return { rows, t };
    const last = r.rows[r.rows.length - 1];
    after = Object.fromEntries(sources.map(s => [s, typeof last[s] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(last[s]) ? Date.parse(last[s]) : last[s]]));
  }
  return { rows, error: 'pagination sans fin' };
}

/* ---------- Principal ---------- */
const chVersion = execFileSync(CH_BIN, [...CH_PRE, '--version'], { encoding: 'utf8' }).trim().replace(/^ClickHouse local version /, '').replace(/ \(.*/, '');
console.log(`ClickHouse ${chVersion} / Node.js ${process.versions.node}\n`);
const docs = dataset();
mkdirSync(WORK, { recursive: true });
const flatDir = load('plate', clickhouseDDL('N'), docs.map(clickhouseRow));
const targets = [
  { name: 'otel (Map)', dir: load('otel-map', OTEL_DDL('Map(LowCardinality(String), String)'), docs.map(d => otelRow(d, false))), cfg: mapCfg },
  { name: 'otel-json (JSON)', dir: load('otel-json', OTEL_DDL('JSON', JSON_LOG), docs.map(d => otelRow(d, true))), cfg: jsonCfg }
];
const totals = { same: 0, known: 0, failed: 0 };
const failures = [];
for (const target of targets) {
  console.log(`--- ${target.name}`);
  for (const c of CASES) {
    if (ONLY && !ONLY.test(c.id)) continue;
    for (const tz of c.tz || ['UTC']) {
      const refCfg = c.config ? E.mergeConfig(flatCfg, c.config) : flatCfg;
      const cfg = c.config ? E.mergeConfig(target.cfg, c.config) : target.cfg;
      let diffs = []; let t = null; let verdict = '=';
      if (c.composite) {
        const ref = runComposite(c, flatDir, refCfg, tz); const got = runComposite(c, target.dir, cfg, tz); t = got.t;
        if (ref.error || got.error) { verdict = ref.error && got.error ? '=' : '✗'; if (verdict === '✗') diffs = [ref.error || 'exécutée', got.error || 'exécutée']; }
        else diffs = compare(ref.rows, got.rows, { tol: c.tol, unordered: !!(c.config && c.config.clickhouse && c.config.clickhouse.composite_mode === 'stream') });
      } else {
        const tr = E.translateDSL(JSON.stringify(c.dsl), refCfg, { index: INDEX });
        t = E.translateDSL(JSON.stringify(c.dsl), cfg, { index: INDEX });
        if (tr.error || t.error) { verdict = tr.error && t.error ? '=' : '✗'; if (verdict === '✗') diffs = [tr.error || 'traduite', t.error || 'traduite']; }
        else if (tr.statements.length !== t.statements.length) { verdict = '✗'; diffs = [`${tr.statements.length} requêtes attendues, ${t.statements.length} obtenues`]; }
        else {
          const ref = runStatements(flatDir, tr, tz); const got = runStatements(target.dir, t, tz);
          ref.forEach((r, i) => {
            const g = got[i];
            if (r.error && g.error) { if (/Passerelle :/.test(r.error) !== /Passerelle :/.test(g.error)) diffs.push(`[${r.title}] ${r.error} / ${g.error}`); return; }
            if (r.error || g.error) { diffs.push(`[${r.title}] ${r.error || 'exécutée'} / ${g.error || 'exécutée'}`); return; }
            const d = compare(r.rows, g.rows, { tol: c.tol, ids: /^(Documents|Top hits)/.test(r.title) });
            if (d.length) diffs.push(`[${r.title}] ${d.slice(0, 3).join(' ; ')}${d.length > 3 ? ` (+${d.length - 3})` : ''}`);
          });
        }
      }
      if (verdict === '=' && diffs.length) verdict = '≠';
      const known = KNOWN[c.id] || (KNOWN_RE.find(([re]) => re.test(c.id)) || [])[1];
      let status;
      if (verdict === '=' && !known) { status = 'ok   '; totals.same++; }
      else if (verdict !== '=' && known) { status = 'connu'; totals.known++; }
      else { status = 'ÉCHEC'; totals.failed++; failures.push(`${c.id} [${target.name}]`); }
      const label = `${c.id}${c.tz ? ` @${tz}` : ''}`;
      console.log(`${status} ${verdict.padEnd(2)} ${label}${known ? ` — ${known}` : verdict === '=' ? '' : ' — RÉGRESSION'}`);
      if (diffs.length && (status === 'ÉCHEC' || args.verbose)) console.log(`          ${diffs.join(' || ')}`);
      if (args.sql && t && t.sql) console.log(t.sql.split('\n').map(l => `          | ${l}`).join('\n'));
    }
  }
  console.log('');
}
console.log(`Bilan : ${totals.same} identiques, ${totals.known} écarts connus, ${totals.failed} échecs.`);
if (failures.length) console.log(`Échecs : ${failures.join(', ')}`);
process.exit(totals.failed ? 1 : 0);
