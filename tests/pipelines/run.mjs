#!/usr/bin/env node
/*
 * Banc d’équivalence Logstash / Vector : chaque cas est joué dans Logstash, sa traduction dans Vector,
 * et les événements produits sont mis côte à côte.
 *
 *   node tests/pipelines/run.mjs [--only=regex] [--ecs=v8|disabled] [--verbose] [--yaml]
 *
 *   LOGSTASH_VERSION, VECTOR_VERSION   versions des images Docker (voir logstash.sh et vector.sh)
 *   PASSERELLE_PIPELINES_WORK          dossier de travail, sur un système de fichiers Linux
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';
import { ECS_MODES, inputOf, translatedPipeline, logstashPipeline } from './transport.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const WORK = process.env.PASSERELLE_PIPELINES_WORK || join(tmpdir(), 'passerelle-pipelines');
const LS = join(WORK, 'logstash');
const VEC = join(WORK, 'vector');
const ONLY = args.only ? new RegExp(args.only) : null;
const modes = args.ecs ? [args.ecs] : ECS_MODES;

const rd = p => readFileSync(join(ROOT, p), 'utf8');
const engine = ['src/engine/base.js', 'src/engine/dsl.js', 'src/engine/logstash.js'].map(rd).join('');
const E = new Function(`'use strict';\n${engine}\nreturn { translateLogstash, DEFAULT_CONFIG, mergeConfig };`)();

/* ---------- Dossier de travail ---------- */
// Chaque moteur a son dossier, monté sur /work dans son conteneur : conf/ ce qu’il joue, in/ ses entrées, out/ ses événements
function prepare(cases) {
  rmSync(WORK, { recursive: true, force: true });
  for (const d of ['conf', 'in', 'out']) mkdirSync(join(LS, d), { recursive: true });
  for (const d of ['conf', 'in', 'out', 'log', 'data']) mkdirSync(join(VEC, d), { recursive: true });
  // Logstash écrit avec l’utilisateur de son image, qui n’est pas forcément celui qui lance le banc
  chmodSync(join(LS, 'out'), 0o777);
  const pipelines = [];
  const translations = new Map();
  for (const c of cases) {
    writeFileSync(join(LS, 'in', `${c.id}.ndjson`), inputOf(c));
    writeFileSync(join(VEC, 'in', `${c.id}.ndjson`), inputOf(c));
    for (const mode of modes) {
      writeFileSync(join(LS, 'conf', `${c.id}.${mode}.conf`), logstashPipeline(c, mode));
      // Un seul worker : Logstash garde alors l’ordre des événements
      pipelines.push(`- pipeline.id: ${c.id}__${mode}\n  path.config: /work/conf/${c.id}.${mode}.conf\n  pipeline.workers: 1\n  pipeline.ecs_compatibility: ${mode}\n`);
    }
    const t = E.translateLogstash(translatedPipeline(c), E.DEFAULT_CONFIG);
    translations.set(c.id, t);
    if (t.yaml) writeFileSync(join(VEC, 'conf', `${c.id}.yaml`), t.yaml);
  }
  writeFileSync(join(LS, 'pipelines.yml'), pipelines.join(''));
  return translations;
}

/* ---------- Les deux moteurs ---------- */
// Docker est lancé par les scripts voisins. Leur sortie va dans un journal, dont la première ligne donne la version.
function launch(script, dir) {
  const log = `${dir}.log`;
  const fd = openSync(log, 'w');
  const started = Date.now();
  let status = 0;
  try { execFileSync('sh', [join(HERE, script), dir], { stdio: ['ignore', fd, fd] }); } catch (e) { status = e.status || 1; }
  closeSync(fd);
  const text = readFileSync(log, 'utf8');
  // À partir de 125, c’est Docker qui a échoué, pas le moteur
  return { fatal: status >= 125, text, version: text.split('\n')[0], seconds: Math.round((Date.now() - started) / 1000) };
}

const eventsOf = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function logstashResult(id, mode, log) {
  if (new RegExp(`Failed to execute action.*pipeline_id:${id}__${mode}\\b`).test(log)) return { error: 'pipeline refusé par Logstash' };
  return { events: eventsOf(join(LS, 'out', `${id}.${mode}.ndjson`)) };
}

function vectorResult(id, t, codes) {
  if (t.error || t.empty) return { error: `traduction impossible : ${t.error || 'résultat vide'}` };
  const code = codes.get(id);
  if (code === undefined) return { error: 'configuration non jouée' };
  if (code !== 0) {
    const log = readFileSync(join(VEC, 'log', `${id}.log`), 'utf8');
    const where = /(?:Transform|Source|Sink) "[^"]+"/.exec(log);
    const what = /^error\[E\d+\]: .*$/m.exec(log);
    return { error: `configuration refusée par Vector (code ${code})${where ? `, ${where[0]}` : ''}${what ? ` : ${what[0]}` : ''}` };
  }
  return { events: eventsOf(join(VEC, 'out', `${id}.ndjson`)) };
}

/* ---------- Principal ---------- */
const cases = CASES.filter(c => !ONLY || ONLY.test(c.id));
const translations = prepare(cases);
const logstash = launch('logstash.sh', LS);
const vector = launch('vector.sh', VEC);
for (const [name, run, dir] of [['Logstash', logstash, LS], ['Vector', vector, VEC]]) {
  if (!run.fatal) continue;
  console.error(`${name} n’a pas pu être lancé par Docker : voir ${dir}.log`);
  process.exit(1);
}
const codes = new Map(existsSync(join(VEC, 'codes')) ? readFileSync(join(VEC, 'codes'), 'utf8').split('\n').filter(Boolean).map(l => [l.split(' ')[0], Number(l.split(' ')[1])]) : []);
console.log(`${logstash.version} / ${vector.version.replace(/^vector (\S+).*/, 'Vector $1')} / Node.js ${process.versions.node}`);
console.log(`${cases.length * modes.length} pipelines joués par Logstash en ${logstash.seconds} s, ${cases.length} configurations par Vector en ${vector.seconds} s\n`);

const describe = r => r.error || `${r.events.length} événement(s)`;
const dump = r => { if (args.verbose && r.events) for (const e of r.events) console.log(`          ${JSON.stringify(e)}`); };
for (const c of cases) {
  const t = translations.get(c.id);
  console.log(c.id);
  for (const mode of modes) {
    const l = logstashResult(c.id, mode, logstash.text);
    console.log(`    Logstash ${mode.padEnd(8)} : ${describe(l)}`);
    dump(l);
  }
  const v = vectorResult(c.id, t, codes);
  console.log(`    Vector            : ${describe(v)}`);
  dump(v);
  if (args.yaml && t.yaml) console.log(t.yaml.split('\n').map(l => `          | ${l}`).join('\n'));
}
