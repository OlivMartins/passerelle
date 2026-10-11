#!/usr/bin/env node
/*
 * Banc d’équivalence Logstash / Vector : chaque cas est joué dans Logstash, sa traduction dans Vector,
 * et les événements produits sont comparés champ par champ.
 *
 *   node tests/pipelines/run.mjs [--only=regex] [--ecs=v8|disabled] [--verbose] [--yaml]
 *
 *   LOGSTASH_VERSION, VECTOR_VERSION   versions des images Docker (voir logstash.sh et vector.sh)
 *   PASSERELLE_PIPELINES_WORK          dossier de travail, sur un système de fichiers Linux
 *
 * Code de sortie : 0 si chaque cas se comporte comme annoncé dans cases.mjs, 1 sinon
 * (écart non déclaré, ou écart connu qui a disparu sans que cases.mjs soit mis à jour).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';
import { ECS_MODES, inputOf, outputsOf, outputFile, translatedPipeline, logstashPipeline } from './transport.mjs';

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
  // Dix minutes au plus : un pipeline bloqué empêcherait Logstash de s’arrêter
  try { execFileSync('sh', [join(HERE, script), dir], { stdio: ['ignore', fd, fd], timeout: 600000 }); } catch (e) { status = e.status || 125; }
  closeSync(fd);
  const text = readFileSync(log, 'utf8');
  // À partir de 125, c’est Docker qui a échoué ou le délai qui est passé, pas le moteur qui a rendu un code d’erreur
  return { fatal: status >= 125, text, version: text.split('\n')[0], seconds: Math.round((Date.now() - started) / 1000) };
}

const eventsOf = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

// Événements de chaque sortie du cas, par nom de sortie
const outputsFrom = (dir, c, prefix) => Object.fromEntries(outputsOf(c).map(name => [name, eventsOf(join(dir, 'out', `${outputFile(prefix, name)}.ndjson`))]));

function logstashResult(c, mode, log) {
  if (new RegExp(`Failed to execute action.*pipeline_id:${c.id}__${mode}\\b`).test(log)) return { error: 'pipeline refusé par Logstash' };
  return { outputs: outputsFrom(LS, c, `${c.id}.${mode}`) };
}

function vectorResult(c, t, codes) {
  if (t.error || t.empty) return { error: `traduction impossible : ${t.error || 'résultat vide'}` };
  const code = codes.get(c.id);
  if (code === undefined) return { error: 'configuration non jouée' };
  if (code !== 0) {
    const log = readFileSync(join(VEC, 'log', `${c.id}.log`), 'utf8');
    const where = /(?:Transform|Source|Sink) "[^"]+"/.exec(log);
    const what = /^error\[E\d+\]: .*$/m.exec(log);
    return { error: `configuration refusée par Vector (code ${code})${where ? `, ${where[0]}` : ''}${what ? ` : ${what[0]}` : ''}` };
  }
  return { outputs: outputsFrom(VEC, c, c.id) };
}

/* ---------- Comparaison ---------- */
/*
 * Les événements sont comparés champ par champ, types compris : 42 n’est pas "42". Deux tolérances seulement,
 * chacune désactivée par le champ « exact » d’un cas qui en fait l’inventaire :
 *   original     en mode v8, les codecs de Logstash ajoutent [event][original] ; la traduction ne le pose pas
 *   horodatage   un @timestamp posé à l’ingestion ne peut pas être égal des deux côtés : il est reconnu à ce
 *                qu’il tombe pendant l’exécution du banc, et sa précision n’est pas comparée non plus
 * Un UUID, tiré au hasard par chaque moteur, n’est comparé que par sa forme.
 */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalize(event, c, window) {
  const e = JSON.parse(JSON.stringify(event), (k, v) => (typeof v === 'string' && UUID.test(v) ? '<uuid>' : v));
  const exact = c.exact || [];
  if (!exact.includes('original') && isObj(e.event)) {
    delete e.event.original;
    if (!Object.keys(e.event).length) delete e.event;
  }
  const ts = e['@timestamp'];
  if (typeof ts === 'string' && Date.parse(ts) >= window[0] && Date.parse(ts) <= window[1]) {
    const digits = (/\.(\d+)Z$/.exec(ts) || ['', ''])[1].length;
    e['@timestamp'] = exact.includes('horodatage') ? `<ingestion, ${digits} décimales>` : '<ingestion>';
  }
  return e;
}

// Aligne les deux suites sur leurs événements identiques : un événement perdu ne décale pas les suivants
function align(a, b) {
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const gaps = []; let gap = { a: [], b: [] }; let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { gaps.push(gap); gap = { a: [], b: [] }; i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) gap.a.push(i++);
    else gap.b.push(j++);
  }
  gaps.push(gap);
  return gaps.filter(g => g.a.length || g.b.length);
}

function leaves(v, path, out) {
  if (isObj(v) && Object.keys(v).length) for (const k of Object.keys(v)) leaves(v[k], path ? `${path}.${k}` : k, out);
  else out.set(path, canon(v));
  return out;
}
const short = s => (s.length > 120 ? s.slice(0, 117) + '…' : s);

function compare(c, l, v, window) {
  if (l.error) return { verdict: 'L✗', detail: l.error };
  if (v.error) return { verdict: 'V✗', detail: v.error };
  const diffs = [];
  for (const name of outputsOf(c)) {
    const where = name ? `[sortie ${name}] ` : '';
    const ln = l.outputs[name].map(e => normalize(e, c, window)); const vn = v.outputs[name].map(e => normalize(e, c, window));
    if (ln.length !== vn.length) diffs.push(`${where}${ln.length} événement(s) côté Logstash, ${vn.length} côté Vector`);
    for (const gap of align(ln.map(canon), vn.map(canon))) {
      gap.a.forEach((i, k) => {
        if (k >= gap.b.length) { diffs.push(`${where}[événement ${i + 1}] sans équivalent côté Vector : ${short(canon(ln[i]))}`); return; }
        const a = leaves(ln[i], '', new Map()); const b = leaves(vn[gap.b[k]], '', new Map());
        for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
          if (a.get(key) !== b.get(key)) diffs.push(`${where}[événement ${i + 1}] ${key} : Logstash ${a.has(key) ? short(a.get(key)) : 'absent'} / Vector ${b.has(key) ? short(b.get(key)) : 'absent'}`);
        }
      });
      for (const j of gap.b.slice(gap.a.length)) diffs.push(`${where}[Vector seul] ${short(canon(vn[j]))}`);
    }
  }
  return { verdict: diffs.length ? '≠' : '=', detail: diffs.join(' || ') };
}

function knownFor(c, mode) {
  const k = c.known;
  if (!k) return null;
  return typeof k === 'string' ? k : k[mode] || null;
}

/* ---------- Principal ---------- */
const cases = CASES.filter(c => !ONLY || ONLY.test(c.id));
const started = Date.now();
const translations = prepare(cases);
const logstash = launch('logstash.sh', LS);
const vector = launch('vector.sh', VEC);
for (const [name, run, dir] of [['Logstash', logstash, LS], ['Vector', vector, VEC]]) {
  if (!run.fatal) continue;
  console.error(`${name} n’a pas abouti (Docker indisponible, ou moteur bloqué plus de dix minutes) : voir ${dir}.log`);
  process.exit(1);
}
// Une minute de marge de part et d’autre : les horloges des conteneurs sont celles de la machine
const window = [started - 60000, Date.now() + 60000];
const codes = new Map(existsSync(join(VEC, 'codes')) ? readFileSync(join(VEC, 'codes'), 'utf8').split('\n').filter(Boolean).map(l => [l.split(' ')[0], Number(l.split(' ')[1])]) : []);
console.log(`${logstash.version} / ${vector.version.replace(/^vector (\S+).*/, 'Vector $1')} / Node.js ${process.versions.node}`);
console.log(`${cases.length * modes.length} pipelines joués par Logstash en ${logstash.seconds} s, ${cases.length} configurations par Vector en ${vector.seconds} s (${WORK})\n`);

const totals = { same: 0, known: 0, failed: 0 };
const failures = [];
for (const mode of modes) {
  console.log(`--- Logstash en ecs_compatibility ${mode}`);
  for (const c of cases) {
    const t = translations.get(c.id);
    const res = compare(c, logstashResult(c, mode, logstash.text), vectorResult(c, t, codes), window);
    const known = knownFor(c, mode);
    const flagged = !!((t.stats && (t.stats.approx || t.stats.ko)) || (t.notes || []).some(n => n.level === 'warn' || n.level === 'err'));
    let status;
    // Un pipeline que Logstash refuse est un cas mal écrit, jamais un écart connu
    if (res.verdict === '=' && !known) { status = 'ok   '; totals.same++; }
    else if (res.verdict !== '=' && res.verdict !== 'L✗' && known) { status = 'connu'; totals.known++; }
    else { status = 'ÉCHEC'; totals.failed++; failures.push(`${c.id} [${mode}]`); }
    const why = res.verdict === '=' ? (known ? ' — écart connu disparu : retirez « known » dans cases.mjs' : '')
      : res.verdict === 'L✗' ? ' — CAS À CORRIGER'
      : known ? ` — ${known}${flagged ? '' : ' (non signalé par la traduction)'}` : ' — ÉCART NON DÉCLARÉ';
    console.log(`${status} ${res.verdict.padEnd(3)} ${c.id}${why}`);
    if (res.detail && (status === 'ÉCHEC' || args.verbose)) console.log(res.detail.split(' || ').map(d => `          ${d}`).join('\n'));
    if (args.yaml && t.yaml) console.log(t.yaml.split('\n').map(l => `          | ${l}`).join('\n'));
  }
  console.log('');
}
console.log(`Bilan : ${totals.same} identiques, ${totals.known} écarts connus, ${totals.failed} échecs.`);
if (failures.length) console.log(`Échecs : ${failures.join(', ')}`);
process.exit(totals.failed ? 1 : 0);
