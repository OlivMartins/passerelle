#!/usr/bin/env node
/*
 * Joue les tests de pipeline d’un data stream des intégrations Elastic (entrées .log ou .json, attendus
 * *-expected.json produits par Elasticsearch) dans la traduction Vector, et compare champ par champ.
 * Les champs déclarés dynamic_fields sont ignorés, comme le fait elastic-package.
 *
 *   ELASTIC_INTEGRATIONS=… node tests/ingest/integration.mjs packages/nginx/data_stream/access [--notes]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { E, INTEGRATIONS, needs, play, flat } from './commun.mjs';

needs('ELASTIC_INTEGRATIONS', INTEGRATIONS);
const [ds, ...flags] = process.argv.slice(2);
if (!ds) { console.error('usage : node tests/ingest/integration.mjs packages/<paquet>/data_stream/<flux>'); process.exit(2); }
const root = join(INTEGRATIONS, ds);
const pdir = join(root, 'elasticsearch', 'ingest_pipeline');
const inputs = readdirSync(pdir).filter(f => /\.(yml|yaml|json)$/.test(f))
  .map(f => ({ name: f === 'default.yml' ? 'default' : f.replace(/\.(yml|yaml|json)$/, ''), text: readFileSync(join(pdir, f), 'utf8') }));
const r = E.translateIngest(inputs, E.DEFAULT_CONFIG);
if (r.error) { console.error(`Erreur : ${r.error}`); process.exit(1); }
console.log(r.pipelines.map(p => `${p.name} : ${p.verdict}, ${p.stats.ok} ok, ${p.stats.approx} approx, ${p.stats.ko} ko`).join('\n'));
if (flags.includes('--notes')) console.log(r.notes.filter(n => n.level === 'err' || n.level === 'warn').map(n => `  [${n.level}] ${n.title} — ${n.detail}`).join('\n'));

const tdir = join(root, '_dev', 'test', 'pipeline');
if (!existsSync(tdir)) { console.log('Ce data stream n’a pas de tests de pipeline.'); process.exit(0); }
const yml = f => (existsSync(f) ? E.yamlLoad(readFileSync(f, 'utf8')) || {} : {});
const common = yml(join(tdir, 'test-common-config.yml'));
let total = 0, same = 0; const diffs = {};
for (const f of readdirSync(tdir).filter(x => /\.(log|json)$/.test(x) && !/expected|config/.test(x))) {
  const exp = JSON.parse(readFileSync(join(tdir, `${f}-expected.json`), 'utf8')).expected;
  const own = yml(join(tdir, `${f.replace(/\.(log|json)$/, '')}-config.yml`)); const own2 = yml(join(tdir, `${f}-config.yml`));
  const conf = Object.assign({}, common, own, own2);
  const fields = Object.assign({}, common.fields || {}, own.fields || {}, own2.fields || {});
  const dyn = Object.assign({}, common.dynamic_fields || {}, own.dynamic_fields || {}, own2.dynamic_fields || {});
  let docs;
  if (f.endsWith('.json')) docs = JSON.parse(readFileSync(join(tdir, f), 'utf8')).events.map(d => Object.assign(JSON.parse(JSON.stringify(fields)), d));
  else {
    // Une ligne par document, ou des événements multilignes selon multiline.first_line_pattern
    const lines = readFileSync(join(tdir, f), 'utf8').split('\n').filter(l => l.length);
    const ml = conf.multiline && conf.multiline.first_line_pattern ? new RegExp(conf.multiline.first_line_pattern) : null;
    const msgs = []; for (const l of lines) { if (ml && msgs.length && !ml.test(l)) msgs[msgs.length - 1] += '\n' + l; else msgs.push(l); }
    docs = msgs.map(m => Object.assign({ message: m }, JSON.parse(JSON.stringify(fields))));
  }
  const got = play(r, docs);
  exp.forEach((e, k) => {
    total++;
    const a = flat(e); const b = flat(got[k] || {});
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(x => !Object.keys(dyn).some(d => x === d || x.startsWith(d + '.')));
    const bad = keys.filter(x => a[x] !== b[x]);
    if (!bad.length) same++;
    for (const x of bad) (diffs[x.replace(/\.\d+$/, '')] = diffs[x.replace(/\.\d+$/, '')] || []).push(`${f}#${k} : ES ${a[x] === undefined ? 'absent' : a[x]} / Vector ${b[x] === undefined ? 'absent' : b[x]}`);
  });
}
console.log(`${same}/${total} documents identiques`);
for (const [k, v] of Object.entries(diffs).sort((x, y) => y[1].length - x[1].length)) console.log(`  ${k} (${v.length}) : ${v[0].slice(0, 220)}`);
process.exit(same === total ? 0 : 1);
