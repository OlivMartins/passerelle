#!/usr/bin/env node
/*
 * Passe chaque data stream des intégrations Elastic qui a des tests de pipeline dans integration.mjs et résume :
 * documents identiques à ceux d’Elasticsearch, ou la cause de l’échec (VRL qui ne compile pas, Vector qui plante).
 *
 *   ELASTIC_INTEGRATIONS=… MAXMIND_TEST_DATA=… VECTOR_BIN=… node tests/ingest/tout.mjs [--only=regex] [--jobs=2]
 *
 * Le résumé est écrit dans $PASSERELLE_INGEST_WORK/tout.tsv (une ligne par data stream).
 */
import { readdirSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { INTEGRATIONS, WORK, needs } from './commun.mjs';

needs('ELASTIC_INTEGRATIONS', INTEGRATIONS);
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ONLY = arg('only') ? new RegExp(arg('only')) : null;
const JOBS = Number(arg('jobs')) || 2;
const here = dirname(fileURLToPath(import.meta.url));
const base = join(INTEGRATIONS, 'packages');
const list = [];
for (const pkg of readdirSync(base).sort()) {
  const dsd = join(base, pkg, 'data_stream'); if (!existsSync(dsd)) continue;
  for (const ds of readdirSync(dsd).sort()) {
    const id = `${pkg}/${ds}`;
    if (ONLY && !ONLY.test(id)) continue;
    if (existsSync(join(dsd, ds, '_dev', 'test', 'pipeline')) && existsSync(join(dsd, ds, 'elasticsearch', 'ingest_pipeline'))) list.push(id);
  }
}
mkdirSync(WORK, { recursive: true });
const out = join(WORK, 'tout.tsv'); writeFileSync(out, '');
let next = 0, done = 0; const tot = { same: 0, total: 0, ko: 0, streams: 0, perfect: 0 };
function one(id) {
  return new Promise(res => {
    const [pkg, ds] = id.split('/');
    const p = spawn(process.execPath, [join(here, 'integration.mjs'), `packages/${pkg}/data_stream/${ds}`], { env: Object.assign({}, process.env, { PASSERELLE_INGEST_WORK: join(WORK, `tout-${pkg}-${ds}`) }), timeout: 600000 });
    let so = '', se = '';
    p.stdout.on('data', d => { so += d; }); p.stderr.on('data', d => { se += d; });
    p.on('close', () => {
      const m = /(\d+)\/(\d+) documents identiques/.exec(so);
      let line;
      if (m) { tot.same += +m[1]; tot.total += +m[2]; tot.streams++; if (m[1] === m[2]) tot.perfect++; line = `${id}\t${m[1]}/${m[2]}\t${(so.split('\n')[0] || '').slice(0, 80)}`; }
      else if (/pas de tests de pipeline/.test(so)) line = `${id}\tsans test`;
      else { tot.ko++; const e = (se.match(/error\[E\d+\][^\n]*/) || se.match(/Erreur[^\n]*/) || [se.split('\n').find(l => l.trim()) || 'échec']); line = `${id}\tERREUR\t${e[0].slice(0, 160)}`; }
      appendFileSync(out, line + '\n'); console.log(`${++done}/${list.length} ${line}`);
      res();
    });
  });
}
async function worker() { while (next < list.length) await one(list[next++]); }
await Promise.all(Array.from({ length: JOBS }, worker));
console.log(`${tot.streams} data streams joués, ${tot.perfect} identiques à 100 %, ${tot.same}/${tot.total} documents identiques, ${tot.ko} en erreur ; détail : ${out}`);
