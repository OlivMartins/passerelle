#!/usr/bin/env node
/*
 * Tests de non-régression : chaque exemple doit se traduire sans erreur,
 * avec au moins la couverture attendue, et sans recopier de secret.
 * La sortie de chaque exemple et de chaque cas du banc différentiel est aussi comparée
 * à son instantané (tests/snapshots) : tout changement du SQL ou du YAML généré se voit en revue.
 *   node scripts/test.mjs            compare
 *   node scripts/test.mjs --update   réécrit les instantanés après un changement voulu
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from '../tests/differential/cases.mjs';
import { INDEX, configOverride } from '../tests/differential/dataset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.argv.includes('--update');
const rd = p => readFileSync(join(ROOT, p), 'utf8');
const engine = ['src/engine/base.js', 'src/engine/dsl.js', 'src/engine/logstash.js'].map(rd).join('');
const E = new Function(`'use strict';\n${engine}\nreturn { translateDSL, translateLogstash, DEFAULT_CONFIG, mergeConfig };`)();

// Éléments « à reprendre » attendus : le filtre ruby de batch.conf n’a pas d’équivalent automatique
const EXPECTED_TODO = { 'logstash/batch.conf': 1 };
const index = JSON.parse(rd('examples/index.json'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
};

/* ---------- Instantanés ---------- */
const snapshots = { total: 0, different: 0, seen: new Set() };
// En-tête d’un instantané : la couverture annoncée et les remarques « à vérifier » / « à reprendre »
function withHeader(r, mark) {
  const lines = [`${mark} Couverture : ${r.stats.ok} directs, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre`];
  for (const n of r.notes) if (n.level === 'warn' || n.level === 'err') lines.push(`${mark} ${n.level === 'err' ? 'À reprendre' : 'À vérifier'} : ${n.title}`);
  return lines.join('\n') + '\n\n';
}
function snapshot(rel, content) {
  const file = join(ROOT, 'tests/snapshots', rel);
  snapshots.total++;
  snapshots.seen.add(rel);
  if (UPDATE) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); return; }
  const expected = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (expected === content) return;
  snapshots.different++;
  if (expected === null) { check(false, `instantané ${rel}`, 'fichier absent'); return; }
  const a = expected.split('\n'); const b = content.split('\n');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  check(false, `instantané ${rel}`, `ligne ${i + 1}\n    attendu : ${a[i] === undefined ? '(fin)' : a[i]}\n    obtenu  : ${b[i] === undefined ? '(fin)' : b[i]}`);
}

for (const [kind, list] of Object.entries(index)) {
  for (const ex of list) {
    const text = rd(join('examples', ex.file));
    const r = kind === 'dsl' ? E.translateDSL(text, E.DEFAULT_CONFIG, { index: 'logs-*' }) : E.translateLogstash(text, E.DEFAULT_CONFIG);
    if (r.error || r.empty) { check(false, ex.file, r.error || 'résultat vide'); continue; }
    const out = kind === 'dsl' ? r.sql : r.yaml + r.toml;
    const todo = EXPECTED_TODO[ex.file] || 0;
    check(r.stats.ko === todo, ex.file, `${r.stats.ok} directs, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre (attendu ${todo})`);
    check(!/password\s*[=:]\s*['"][^'"$]/i.test(out), `${ex.file} : aucun mot de passe en clair dans la sortie`);
    snapshot(`examples/${ex.file}.${kind === 'dsl' ? 'sql' : 'yaml'}`, kind === 'dsl' ? withHeader(r, '--') + r.sql + '\n' : withHeader(r, '#') + r.yaml);
  }
}

// Cas du banc différentiel : le SQL est figé ici, son résultat est comparé à Elasticsearch par « npm run test:diff »
const benchConfig = E.mergeConfig(E.DEFAULT_CONFIG, configOverride());
for (const c of CASES) {
  const r = E.translateDSL(JSON.stringify(c.dsl), benchConfig, { index: INDEX });
  snapshot(`cases/${c.id}.sql`, r.error ? `-- Erreur : ${r.error}\n` : withHeader(r, '--') + r.sql + '\n');
}
// Un instantané sans cas ni exemple correspondant est un reste : supprimé par --update, signalé sinon
for (const rel of readdirSync(join(ROOT, 'tests/snapshots'), { recursive: true }).map(p => p.split(sep).join('/'))) {
  if (!/\.(sql|yaml)$/.test(rel) || snapshots.seen.has(rel)) continue;
  if (UPDATE) rmSync(join(ROOT, 'tests/snapshots', rel));
  else { snapshots.different++; check(false, `instantané ${rel}`, 'aucun cas ni exemple ne lui correspond'); }
}
if (!UPDATE) check(snapshots.different === 0, `${snapshots.total} instantanés comparés`, snapshots.different ? `${snapshots.different} différents (détail ci-dessus) ; si le changement est voulu : npm run test:update` : '');
else process.stdout.write(`${snapshots.total} instantanés écrits dans tests/snapshots\n`);

/* ---------- Garde-fous ---------- */
const tr = dsl => E.translateDSL(JSON.stringify(dsl), benchConfig, { index: INDEX });
// Des conditions successives doublent le SQL à chaque « if » : le script doit être déclaré à reprendre, vite et sans SQL démesuré
const branchy = 'def x = 0; ' + Array.from({ length: 30 }, (_, i) => `if (doc['a'].value > ${i}) { x = x + ${i}; }`).join(' ') + ' emit(x);';
const started = Date.now();
const capped = tr({ size: 0, runtime_mappings: { r: { type: 'long', script: branchy } }, aggs: { b: { terms: { field: 'r' } } } });
check(capped.stats.ko === 1 && Date.now() - started < 2000 && capped.sql.length < 5000, 'script Painless trop ramifié : déclaré à reprendre, sans explosion du SQL');
// Un nombre invalide est refusé, jamais recopié dans le SQL
check(/size/.test(tr({ size: '10; DROP TABLE x' }).error || ''), 'size invalide : traduction refusée');
const badInterval = tr({ size: 0, aggs: { h: { histogram: { field: 'latency_ms', interval: '1) + sleep(3' } } } });
check(badInterval.stats.ko === 1 && !/sleep/.test(badInterval.sql), 'intervalle invalide : agrégation à reprendre, rien n’est recopié');
const badPoint = tr({ query: { geo_distance: { distance: '5km', loc: { lat: '0) OR 1=1 --', lon: 2 } } } });
check(/latitude/.test(badPoint.error || ''), 'coordonnée invalide : traduction refusée');
// Un nom de clause inconnu reste dans une chaîne SQL échappée
const odd = tr({ query: { "x') OR 1=1 --": {} } });
check(odd.stats.ko === 1 && odd.sql.includes("throwIf(1, 'Passerelle : x\\') OR 1=1 -- à traduire')"), 'clause inconnue : nom échappé, requête arrêtée par throwIf');
// query_string mal formée : à reprendre, comme Elasticsearch la refuse
for (const q of ['status:500) AND service:api', 'status:(500', '(status:500', 'status:500 OR OR status:404', '"connection reset', 'status:[500 TO', 'timeout AND']) {
  check(tr({ query: { query_string: { query: q } } }).stats.ko === 1, `query_string mal formée déclarée à reprendre : ${q}`);
}

// Les secrets passent par des variables d’environnement, jamais par la configuration générée
const ls = E.translateLogstash(rd('examples/logstash/routage.conf'), E.DEFAULT_CONFIG);
check(ls.yaml.includes("'${KAFKA_PASSWORD}'") && ls.env.includes('KAFKA_PASSWORD'), 'routage.conf : identifiants Kafka référencés par variable d’environnement');

process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests passent.\n');
process.exit(failures ? 1 : 0);
