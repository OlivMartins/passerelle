#!/usr/bin/env node
/*
 * Banc « Log vers Vector » dans un vrai Vector : pour chaque échantillon de examples/logs (tests/logs/cases.mjs) et
 * chaque convention (OpenTelemetry, ECS), la configuration générée par Passerelle est
 *
 *   1. éprouvée par « vector test », en YAML et en TOML : les tests unitaires qu’elle contient rejouent les lignes de
 *      l’échantillon et vérifient chaque champ annoncé (aucun avertissement de compilation n’est toléré) ;
 *   2. comparée en entier : un second jeu de tests exige que chaque événement produit par Vector soit exactement
 *      celui que Passerelle a prédit (assert_eq!(., …)), types compris : un champ en trop ou en moins est un écart,
 *      ce que les tests unitaires, qui ne vérifient que les champs annoncés, ne voient pas.
 *
 *   VECTOR_BIN=vector node tests/logs/vector.mjs [--require] [--only=regex] [--jobs=4]
 *
 * Sans Vector, le banc est ignoré (sortie 0) ; --require le rend obligatoire (la CI). Code de sortie : 0 si tout passe.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../../src/engine/index.js';
import { CASES } from './cases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const VECTOR = process.env.VECTOR_BIN || 'vector';
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const jobs = Number((args.find(a => a.startsWith('--jobs=')) || '--jobs=4').slice(7)) || 4;
const WORK = join(process.env.PASSERELLE_LOGS_WORK || tmpdir(), 'passerelle-logs');

const probe = spawnSync(VECTOR, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(`Vector introuvable (${VECTOR}) : banc ignoré. VECTOR_BIN désigne le binaire.`);
  process.exit(args.includes('--require') ? 2 : 0);
}
console.log(probe.stdout.trim());
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

function run(cmd, argv, input) {
  return new Promise(resolve => {
    const p = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(input || '');
  });
}

// Chemins VRL des horodatages sans année d’un événement prédit, et l’événement sans eux
function hasYearless(ev) {
  const out = [];
  (function walk(o, path) {
    for (const [k, v] of Object.entries(o)) {
      const p = `${path}.${JSON.stringify(k)}`;
      if (v instanceof E.LogTime) {
        if (v.yearless) out.push(p);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof E.LogFloat)) walk(v, p);
    }
  })(ev, '');
  return out.length ? out : null;
}
function stripYearless(ev) {
  const copy = o =>
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => !(v instanceof E.LogTime && v.yearless))
        .map(([k, v]) => [
          k,
          v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof E.LogTime) && !(v instanceof E.LogFloat)
            ? copy(v)
            : v
        ])
    );
  return copy(ev);
}

async function oneCase(c, conv) {
  const name = `${c.file.replace(/\.log$/, '')}.${conv}`;
  const text = readFileSync(join(ROOT, 'examples/logs', c.file), 'utf8');
  const r = E.logToVRL(text, E.DEFAULT_CONFIG, { convention: conv, name: c.file });
  const problems = [];
  // 1. vector test, en YAML puis en TOML
  for (const fmt of ['yaml', 'toml']) {
    const f = join(WORK, `${name}.${fmt}`);
    writeFileSync(f, r[fmt]);
    const t = await run(VECTOR, ['test', f]);
    const all = t.out + t.err;
    const failed = all.split('\n').filter(l => / failed$/.test(l));
    if (t.code !== 0 || failed.length || /warning\[|error\[/.test(all))
      problems.push(
        `vector test (${fmt}) : ${failed.join(' | ') || all.split('\n').filter(Boolean).slice(-12).join('\n      ')}`
      );
  }
  // 2. Égalité complète : chaque événement doit valoir exactement l’événement prédit (aucun champ en plus ni en
  //    moins, types compris). Le test d’entrée porte message et l’heure d’arrivée : le message reste tel quel quand le
  //    VRL ne le récrit pas, l’heure d’arrivée est retirée quand le VRL ne pose pas de timestamp.
  const full = JSON.parse(JSON.stringify({ sources: r.config.sources, sinks: r.config.sinks }));
  full.transforms = { [r.transform]: { type: 'remap', inputs: ['journaux'], source: r.vrl } };
  full.tests = r.events.map((e, i) => {
    const want = Object.assign({}, e.event);
    if (!('message' in want)) want.message = e.text;
    const lit = E.logLiteral(want);
    const asserts = ['evenement = .'];
    if (!('timestamp' in want)) asserts.push('del(evenement.timestamp)');
    // Un horodatage sans année dépend du jour : comparé par les tests unitaires (mois, jour, heure), écarté ici
    const yearless = hasYearless(want);
    if (yearless) for (const p of yearless) asserts.push(`del(evenement${p})`);
    asserts.push(
      lit === null
        ? 'assert!(is_object(evenement))'
        : `assert_eq!(evenement, ${yearless ? E.logLiteral(stripYearless(want)) : lit})`
    );
    return {
      name: `événement ${i} complet`,
      inputs: [{ insert_at: r.transform, type: 'log', log_fields: { message: e.text } }],
      outputs: [{ extract_from: r.transform, conditions: [{ type: 'vrl', source: asserts.join('\n') + '\n' }] }]
    };
  });
  if (full.sources.journaux.type === 'file') delete full.data_dir;
  const ff = join(WORK, `${name}.complet.yaml`);
  writeFileSync(ff, E.toYAML(full) + '\n');
  const t = await run(VECTOR, ['test', ff]);
  const all = t.out + t.err;
  if (t.code !== 0 || /warning\[|error\[/.test(all.replace(/error\[E000\]/g, ''))) {
    const fails = all
      .split('\n')
      .filter(l => /assertion failed|^test .* failed$/.test(l))
      .slice(0, 6);
    problems.push(`égalité complète : ${fails.join('\n      ') || all.split('\n').slice(-10).join('\n      ')}`);
  }
  return { name, problems };
}

const todo = [];
for (const c of CASES)
  for (const conv of ['otel', 'ecs']) if (!only || new RegExp(only).test(`${c.file} ${conv}`)) todo.push([c, conv]);
let failed = 0;
let i = 0;
async function worker() {
  while (i < todo.length) {
    const [c, conv] = todo[i++];
    const res = await oneCase(c, conv);
    if (res.problems.length) {
      failed++;
      console.log(`✗ ${res.name}\n    ${res.problems.join('\n    ')}`);
    } else console.log(`✓ ${res.name} : vector test (YAML, TOML) et événements identiques à la prédiction`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));
console.log(
  `\nBilan : ${todo.length - failed}/${todo.length} configurations conformes${failed ? `, ${failed} en écart` : ''}.`
);
process.exit(failed ? 1 : 0);
