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
import {
  ECS_MODES,
  inputOf,
  outputsOf,
  outputFile,
  translatedPipeline,
  logstashPipeline,
  translatedChain,
  logstashChain
} from './transport.mjs';
import * as E from '../../src/engine/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const WORK = process.env.PASSERELLE_PIPELINES_WORK || join(tmpdir(), 'passerelle-pipelines');
const LS = join(WORK, 'logstash');
const VEC = join(WORK, 'vector');
const ONLY = args.only ? new RegExp(args.only) : null;
const modes = args.ecs ? [args.ecs] : ECS_MODES;

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
      const cfg = E.mergeConfig(E.DEFAULT_CONFIG, { vector: { ecs_compatibility: mode } });
      if (c.chain) {
        // Plusieurs pipelines reliés : un fichier et une entrée de pipelines.yml chacun, une configuration Vector pour l’ensemble
        for (const m of logstashChain(c, mode)) {
          writeFileSync(join(LS, 'conf', `${c.id}.${mode}.${m.id}.conf`), m.text);
          pipelines.push(
            `- pipeline.id: ${c.id}__${mode}__${m.id}\n  path.config: /work/conf/${c.id}.${mode}.${m.id}.conf\n  pipeline.workers: 1\n  pipeline.ecs_compatibility: ${mode}\n`
          );
        }
        const t = E.translatePipelines(translatedChain(c, mode), cfg);
        translations.set(`${c.id}.${mode}`, t);
        if (t.yaml && !t.error) writeFileSync(join(VEC, 'conf', `${c.id}.${mode}.yaml`), t.yaml);
        continue;
      }
      writeFileSync(join(LS, 'conf', `${c.id}.${mode}.conf`), logstashPipeline(c, mode));
      // Un seul worker : Logstash garde alors l’ordre des événements
      pipelines.push(
        `- pipeline.id: ${c.id}__${mode}\n  path.config: /work/conf/${c.id}.${mode}.conf\n  pipeline.workers: 1\n  pipeline.ecs_compatibility: ${mode}\n`
      );
      // La traduction est faite avec le même mode ECS que Logstash (vector.ecs_compatibility)
      const t = E.translateLogstash(translatedPipeline(c, mode), cfg);
      translations.set(`${c.id}.${mode}`, t);
      if (t.yaml) writeFileSync(join(VEC, 'conf', `${c.id}.${mode}.yaml`), t.yaml);
    }
  }
  writeFileSync(join(LS, 'pipelines.yml'), pipelines.join(''));
  // Greffons à installer dans Logstash avant de jouer les cas (voir logstash.sh)
  writeFileSync(join(LS, 'plugins.txt'), [...new Set(cases.flatMap(c => c.plugins || []))].join(' '));
  // Pipelines reliés : Logstash ne s’arrête pas seul, logstash.sh l’arrête quand chaque pipeline a lu son fichier
  writeFileSync(join(LS, 'chains.txt'), cases.some(c => c.chain) ? String(cases.length * modes.length) : '');
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
  try {
    execFileSync('sh', [join(HERE, script), dir], { stdio: ['ignore', fd, fd], timeout: 600000 });
  } catch (e) {
    status = e.status || 125;
  }
  closeSync(fd);
  const text = readFileSync(log, 'utf8');
  // À partir de 125, c’est Docker qui a échoué ou le délai qui est passé, pas le moteur qui a rendu un code d’erreur
  return {
    fatal: status >= 125,
    text,
    version: text.split('\n')[0],
    seconds: Math.round((Date.now() - started) / 1000)
  };
}

const eventsOf = file =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];

// Événements de chaque sortie du cas, par nom de sortie
const outputsFrom = (dir, c, prefix) =>
  Object.fromEntries(
    outputsOf(c).map(name => [name, eventsOf(join(dir, 'out', `${outputFile(prefix, name)}.ndjson`))])
  );

function logstashResult(c, mode, log) {
  if (new RegExp(`Failed to execute action.*pipeline_id:${c.id}__${mode}(__[A-Za-z0-9_-]+)?\\b`).test(log))
    return { error: 'pipeline refusé par Logstash' };
  return { outputs: outputsFrom(LS, c, `${c.id}.${mode}`) };
}

function vectorResult(c, mode, t, codes) {
  const id = `${c.id}.${mode}`;
  if (t.error || t.empty) return { error: `traduction impossible : ${t.error || 'résultat vide'}` };
  const code = codes.get(id);
  if (code === undefined) return { error: 'configuration non jouée' };
  if (code !== 0) {
    const log = readFileSync(join(VEC, 'log', `${id}.log`), 'utf8');
    const where = /(?:Transform|Source|Sink) "[^"]+"/.exec(log);
    const what = /^error\[E\d+\]: .*$/m.exec(log);
    return {
      error: `configuration refusée par Vector (code ${code})${where ? `, ${where[0]}` : ''}${what ? ` : ${what[0]}` : ''}`
    };
  }
  return { outputs: outputsFrom(VEC, c, id) };
}

/* ---------- Comparaison ---------- */
/*
 * Les événements sont comparés champ par champ, types compris : 42 n’est pas "42", et [event][original] compris.
 * Le comparateur est celui de « passerelle verify pipelines » (src/engine/replay.js), avec ses deux tolérances :
 *   horodatage   un @timestamp posé à l’ingestion ne peut pas être égal des deux côtés : désactivé par le champ
 *                « exact » d’un cas qui en fait l’inventaire
 *   UUID         tiré au hasard par chaque moteur, comparé par sa forme
 */
function compare(c, l, v, window) {
  if (l.error) return { verdict: 'L✗', detail: l.error };
  if (v.error) return { verdict: 'V✗', detail: v.error };
  const diffs = [];
  for (const name of outputsOf(c)) {
    const where = name ? `[sortie ${name}] ` : '';
    // Pipelines reliés : deux pipelines qui écrivent dans une même sortie s’y entrelacent au hasard, l’ordre n’est pas comparé
    const order = list =>
      c.chain
        ? list.slice().sort((x, y) => (E.eqCanon(x) < E.eqCanon(y) ? -1 : E.eqCanon(x) > E.eqCanon(y) ? 1 : 0))
        : list;
    const ln = order(l.outputs[name].map(e => E.eqNormalizeEvent(e, window, c.exact)));
    const vn = order(v.outputs[name].map(e => E.eqNormalizeEvent(e, window, c.exact)));
    diffs.push(...E.eqEventDiffs(ln, vn, where).map(d => d.text));
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
for (const [name, run, dir] of [
  ['Logstash', logstash, LS],
  ['Vector', vector, VEC]
]) {
  if (!run.fatal) continue;
  console.error(`${name} n’a pas abouti (Docker indisponible, ou moteur bloqué plus de dix minutes) : voir ${dir}.log`);
  process.exit(1);
}
// Une minute de marge de part et d’autre : les horloges des conteneurs sont celles de la machine
const window = [started - 60000, Date.now() + 60000];
const codes = new Map(
  existsSync(join(VEC, 'codes'))
    ? readFileSync(join(VEC, 'codes'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => [l.split(' ')[0], Number(l.split(' ')[1])])
    : []
);
console.log(
  `${logstash.version} / ${vector.version.replace(/^vector (\S+).*/, 'Vector $1')} / Node.js ${process.versions.node}`
);
console.log(
  `${cases.length * modes.length} pipelines joués par Logstash en ${logstash.seconds} s, ${cases.length * modes.length} configurations par Vector en ${vector.seconds} s (${WORK})\n`
);

const totals = { same: 0, known: 0, failed: 0 };
const failures = [];
for (const mode of modes) {
  console.log(`--- Logstash en ecs_compatibility ${mode}`);
  for (const c of cases) {
    const t = translations.get(`${c.id}.${mode}`);
    const res = compare(c, logstashResult(c, mode, logstash.text), vectorResult(c, mode, t, codes), window);
    const known = knownFor(c, mode);
    const flagged = !!(
      (t.stats && (t.stats.approx || t.stats.ko)) ||
      (t.notes || []).some(n => n.level === 'warn' || n.level === 'err')
    );
    let status;
    // Un pipeline que Logstash refuse est un cas mal écrit, jamais un écart connu
    if (res.verdict === '=' && !known) {
      status = 'ok   ';
      totals.same++;
    } else if (res.verdict !== '=' && res.verdict !== 'L✗' && known) {
      status = 'connu';
      totals.known++;
    } else {
      status = 'ÉCHEC';
      totals.failed++;
      failures.push(`${c.id} [${mode}]`);
    }
    const why =
      res.verdict === '='
        ? known
          ? ' — écart connu disparu : retirez « known » dans cases.mjs'
          : ''
        : res.verdict === 'L✗'
          ? ' — CAS À CORRIGER'
          : known
            ? ` — ${known}${flagged ? '' : ' (non signalé par la traduction)'}`
            : ' — ÉCART NON DÉCLARÉ';
    console.log(`${status} ${res.verdict.padEnd(3)} ${c.id}${why}`);
    if (res.detail && (status === 'ÉCHEC' || args.verbose))
      console.log(
        res.detail
          .split(' || ')
          .map(d => `          ${d}`)
          .join('\n')
      );
    if (args.yaml && t.yaml)
      console.log(
        t.yaml
          .split('\n')
          .map(l => `          | ${l}`)
          .join('\n')
      );
  }
  console.log('');
}
console.log(`Bilan : ${totals.same} identiques, ${totals.known} écarts connus, ${totals.failed} échecs.`);
if (failures.length) console.log(`Échecs : ${failures.join(', ')}`);
process.exit(totals.failed ? 1 : 0);
