#!/usr/bin/env node
/*
 * Compile le VRL de la traduction des pipelines d’ingestion avec vector validate : un VRL que Vector refuse ne
 * s’exécute pas, quel que soit le verdict de Passerelle.
 *
 *   - examples/ingest/*.yml et tests/ingest/cas/*.yml (cas écrits pour les constructions qui ont déjà fait échouer la compilation) ;
 *   - avec ELASTIC_INTEGRATIONS, les data streams donnés après --only= (expression régulière sur « paquet/flux »),
 *     ou ceux de tests/ingest/integrations.txt.
 *
 *   VECTOR_BIN=vector MAXMIND_TEST_DATA=… node tests/ingest/valider.mjs [--only=regex] [--clickhouse]
 *
 * --clickhouse : sortie ClickHouse (vector.elasticsearch_output: clickhouse). Code de sortie : 0 si tout compile.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E, VECTOR, WORK, INTEGRATIONS, geoPath, pipelineInputs } from './commun.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const flags = process.argv.slice(2);
const only = (flags.find(a => a.startsWith('--only=')) || '').slice(7);
const cfg = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG));
if (flags.includes('--clickhouse')) cfg.vector.elasticsearch_output = 'clickhouse';
const dir = join(WORK, 'valider'); rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'data'), { recursive: true });

const jobs = [];   // { name, inputs: [{ name, text }] }
for (const d of ['examples/ingest', 'tests/ingest/cas']) {
  for (const f of readdirSync(join(ROOT, d)).filter(x => /\.ya?ml$/.test(x)).sort()) {
    if (only && !new RegExp(only).test(`${d}/${f}`)) continue;
    jobs.push({ name: `${d}/${f}`, inputs: [{ name: basename(f).replace(/\.ya?ml$/, ''), text: readFileSync(join(ROOT, d, f), 'utf8') }] });
  }
}
if (INTEGRATIONS) {
  const listed = existsSync(join(ROOT, 'tests/ingest/integrations.txt')) ? readFileSync(join(ROOT, 'tests/ingest/integrations.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
  const re = only ? new RegExp(only) : null;
  // Avec --only, tous les data streams des intégrations sont candidats, pas seulement la sélection de la CI
  const all = [];
  if (re) for (const pkg of readdirSync(join(INTEGRATIONS, 'packages')).sort()) {
    const dsd = join(INTEGRATIONS, 'packages', pkg, 'data_stream');
    if (existsSync(dsd)) for (const ds of readdirSync(dsd).sort()) all.push(`${pkg}/${ds}`);
  }
  for (const ds of re ? all : listed) {
    if (re && !re.test(ds)) continue;
    const pd = join(INTEGRATIONS, 'packages', ds.split('/')[0], 'data_stream', ds.split('/')[1], 'elasticsearch', 'ingest_pipeline');
    if (!existsSync(pd)) { console.log(`✗ ${ds} — introuvable dans ELASTIC_INTEGRATIONS`); process.exitCode = 1; continue; }
    jobs.push({ name: ds, inputs: pipelineInputs(pd) });
  }
}

let bad = 0;
for (const j of jobs) {
  const r = E.translateIngest(j.inputs, cfg);
  if (r.error) { console.log(`✗ ${j.name} — traduction impossible : ${r.error}`); bad++; continue; }
  const conf = JSON.parse(JSON.stringify(r.config));
  conf.data_dir = join(dir, 'data');
  for (const t of Object.values(conf.enrichment_tables || {})) if (t.type === 'geoip') t.path = geoPath(t.path);
  const file = join(dir, 'conf.json'); writeFileSync(file, JSON.stringify(conf));
  const verdicts = r.pipelines.map(p => p.verdict).join('/');
  try {
    execFileSync(VECTOR, ['--color', 'never', 'validate', '--skip-healthchecks', file], {
      env: Object.assign({}, process.env, { VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION: 'true', CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p', KAFKA_USERNAME: 'u', KAFKA_PASSWORD: 'p' }), timeout: 900000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`✓ ${j.name} (${verdicts})`);
  } catch (e) {
    bad++;
    const out = String(e.stdout || '') + String(e.stderr || '') + (e.code ? ' ' + e.code : '') + (e.status !== undefined ? ' statut ' + e.status : '');
    console.log(`✗ ${j.name} (${verdicts}) — Vector refuse la configuration :\n${out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => l.trim() && !/INFO|WARN/.test(l)).slice(0, 8).join('\n')}`);
  }
}
if (!jobs.length) { console.log('rien à valider'); process.exit(2); }
console.log(bad ? `${bad} configuration(s) refusée(s) sur ${jobs.length}` : `${jobs.length} configuration(s) compilées par Vector`);
process.exit(bad ? 1 : 0);
