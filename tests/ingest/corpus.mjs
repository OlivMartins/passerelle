#!/usr/bin/env node
/*
 * Traduit chaque data stream des intégrations Elastic et fait le bilan : verdicts, causes des « à reprendre ».
 * Les traductions sont écrites dans $PASSERELLE_INGEST_WORK/corpus (un fichier YAML par data stream).
 *
 *   ELASTIC_INTEGRATIONS=… node tests/ingest/corpus.mjs [--only=regex]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { E, INTEGRATIONS, WORK, needs } from './commun.mjs';

needs('ELASTIC_INTEGRATIONS', INTEGRATIONS);
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const ONLY = only ? new RegExp(only) : null;
const base = join(INTEGRATIONS, 'packages');
const out = join(WORK, 'corpus'); mkdirSync(out, { recursive: true });
const reasons = {}; const verdicts = {}; const errors = []; let streams = 0, procs = 0, bytes = 0;
for (const pkg of readdirSync(base).sort()) {
  const dsd = join(base, pkg, 'data_stream'); if (!existsSync(dsd)) continue;
  for (const ds of readdirSync(dsd).sort()) {
    if (ONLY && !ONLY.test(`${pkg}/${ds}`)) continue;
    const pd = join(dsd, ds, 'elasticsearch', 'ingest_pipeline'); if (!existsSync(pd)) continue;
    const inputs = readdirSync(pd).filter(f => /\.(yml|yaml|json)$/.test(f)).map(f => ({ name: f.replace(/\.(yml|yaml|json)$/, ''), text: readFileSync(join(pd, f), 'utf8') }));
    streams++;
    let r;
    try { r = E.translateIngest(inputs, E.DEFAULT_CONFIG); } catch (e) { errors.push(`${pkg}/${ds} : exception ${e.stack.split('\n').slice(0, 3).join(' | ')}`); continue; }
    if (r.error) { errors.push(`${pkg}/${ds} : ${r.error}`); continue; }
    for (const n of r.notes) if (n.level === 'err') { const why = n.detail.replace(/« [^»]*»/g, '«…»').slice(0, 110); reasons[why] = (reasons[why] || 0) + 1; }
    for (const p of r.pipelines) { verdicts[p.verdict] = (verdicts[p.verdict] || 0) + 1; procs += p.processors; }
    writeFileSync(join(out, `${pkg}__${ds}.yaml`), r.yaml); bytes += r.yaml.length;
  }
}
console.log(`${streams} data streams, ${procs} processeurs, ${(bytes / 1048576).toFixed(0)} Mo de configuration, verdicts`, verdicts);
console.log(`${errors.length} data streams sans traduction :`); errors.forEach(e => console.log(`  ${e}`));
console.log('Causes des « à reprendre » (40 premières) :');
Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, v]) => console.log(`  ${v}\t${k}`));
