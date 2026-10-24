#!/usr/bin/env node
/*
 * Tests de non-régression : chaque exemple doit se traduire sans erreur,
 * avec au moins la couverture attendue, et sans recopier de secret.
 * La sortie de chaque exemple et de chaque cas des deux bancs est aussi comparée
 * à son instantané (tests/snapshots) : tout changement du SQL ou du YAML généré se voit en revue.
 *   node scripts/test.mjs            compare
 *   node scripts/test.mjs --update   réécrit les instantanés après un changement voulu
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from '../tests/differential/cases.mjs';
import { INDEX, configOverride } from '../tests/differential/dataset.mjs';
import { CASES as PIPELINE_CASES } from '../tests/pipelines/cases.mjs';
import { translatedPipeline } from '../tests/pipelines/transport.mjs';
import { loadEngine, engineSource } from './engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.argv.includes('--update');
const rd = p => readFileSync(join(ROOT, p), 'utf8');
const E = loadEngine();

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
  const r = E.translateDSL(JSON.stringify(c.dsl), c.config ? E.mergeConfig(benchConfig, c.config) : benchConfig, { index: INDEX });
  snapshot(`cases/${c.id}.sql`, r.error ? `-- Erreur : ${r.error}\n` : withHeader(r, '--') + r.sql + '\n');
}
// Cas du banc d’équivalence Logstash / Vector : la traduction de leurs filtres est figée ici, les événements qu’elle produit
// sont comparés à ceux de Logstash par « npm run test:pipelines ». Le transport du banc, le même dans chaque configuration,
// n’est gardé que pour les cas qui n’ont rien d’autre.
const isTransport = name => name === 'stdin_in_init' || name === 'logstash_finalize';
for (const c of PIPELINE_CASES) {
  const r = E.translateLogstash(translatedPipeline(c), E.DEFAULT_CONFIG);
  if (r.error) { snapshot(`pipelines/${c.id}.yaml`, `# Erreur : ${r.error}\n`); continue; }
  const own = Object.fromEntries(Object.entries(r.config.transforms).filter(([name]) => !isTransport(name)));
  snapshot(`pipelines/${c.id}.yaml`, withHeader(r, '#') + (Object.keys(own).length ? E.toYAML({ transforms: own }) : r.yaml).trimEnd() + '\n');
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
// ids : la colonne est celle de field_mapping._id, comme pour term sur _id
const renamedId = E.mergeConfig(benchConfig, { clickhouse: { field_mapping: { _id: 'doc_id' } } });
check(/doc_id IN \('a', 'b'\)/.test(E.translateDSL(JSON.stringify({ query: { ids: { values: ['a', 'b'] } } }), renamedId, { index: INDEX }).sql), 'ids : colonne renommée par field_mapping._id');
// Une expression de date illisible est refusée, pas comparée comme une chaîne
check(/date non reconnue/.test(tr({ query: { range: { '@timestamp': { gte: 'now-1x' } } } }).error || ''), 'date math illisible : traduction refusée');
// Avec timezone: UTC, les fonctions de date ne reçoivent pas de fuseau ; sans, il est explicite
const dated = { size: 0, query: { range: { '@timestamp': { gte: 'now-7d/d' } } }, aggs: { d: { date_histogram: { field: '@timestamp', calendar_interval: 'day' } } } };
const utcConfig = E.mergeConfig(benchConfig, { clickhouse: { timezone: 'UTC' } });
check(!/'UTC'/.test(E.translateDSL(JSON.stringify(dated), utcConfig, { index: INDEX }).sql) && /toStartOfDay\(now\('UTC'\) - INTERVAL 7 DAY\)/.test(tr(dated).sql), 'fuseau : explicite par défaut, omis avec timezone: UTC');
// Le README montre la sortie réelle du moteur pour son exemple « Avant, après »
const readme = rd('README.md');
const readmeOut = E.translateDSL(readme.match(/```json\n([\s\S]*?)```/)[1], E.DEFAULT_CONFIG, { index: 'logs-*' });
check(readmeOut.sql.replace(/^-- .*\n/, '').trim() === readme.match(/```sql\n([\s\S]*?)```/)[1].trim(), 'README : le SQL de l’exemple est celui que produit le moteur');
// Sans schéma des colonnes, la traduction garde ses formes simples mais signale ce qui en dépend
const noSchema = E.mergeConfig(benchConfig, { clickhouse: { columns: {} } });
const blind = E.translateDSL(JSON.stringify({ query: { bool: { must_not: [{ term: { env: 'staging' } }], filter: [{ exists: { field: 'user' } }] } } }), noSchema, { index: INDEX });
check(/env != 'staging'\n/.test(blind.sql) && blind.notes.some(n => n.level === 'warn' && n.title === 'Schéma des colonnes non fourni'), 'sans schéma : must_not et exists traduits simplement, avec une remarque « à vérifier »');
const blindDiv = E.translateDSL(JSON.stringify({ size: 0, runtime_mappings: { t: { type: 'long', script: "emit(doc['latency_ms'].value / 100)" } }, aggs: { b: { terms: { field: 't' } } } }), noSchema, { index: INDEX });
check(/latency_ms \/ 100/.test(blindDiv.sql) && blindDiv.notes.some(n => n.level === 'warn' && n.title === 'Division dans un script'), 'sans schéma : division Painless signalée, type des opérandes inconnu');
check(/intDiv\(latency_ms, 100\)/.test(tr({ size: 0, runtime_mappings: { t: { type: 'long', script: "emit(doc['latency_ms'].value / 100)" } }, aggs: { b: { terms: { field: 't' } } } }).sql), 'avec schéma : division de deux entiers traduite par intDiv');
// Une liste de 60 000 valeurs : ClickHouse refuse le SQL en clair (plus de 256 Kio), la liste nommée le garde court
const blacklist = { size: 0, query: { bool: { must_not: [{ terms: { host: Array.from({ length: 60000 }, (_, i) => `host-${i}`) } }] } }, aggs: { s: { terms: { field: 'service' }, aggs: { e: { terms: { field: 'level' } } } } } };
const inline = tr(blacklist);
check(inline.notes.some(n => n.level === 'warn' && n.title === 'Requête trop longue pour ClickHouse'), 'longue liste en clair : requête de plus de 256 Kio signalée');
const named = E.translateDSL(JSON.stringify(blacklist), E.mergeConfig(benchConfig, { clickhouse: { lists: { threshold: 1000 } } }), { index: INDEX });
check(named.sql.length < 2000 && named.lists.length === 1 && named.lists[0].count === 60000 && /host NOT IN \(SELECT value FROM logs\.passerelle_lists WHERE name = 'l_[0-9a-f]{12}'\)/.test(named.sql), 'longue liste nommée : SQL court, une seule liste malgré ses deux emplois');
const shuffled = structuredClone(blacklist); shuffled.query.bool.must_not[0].terms.host.reverse();
check(E.translateDSL(JSON.stringify(shuffled), E.mergeConfig(benchConfig, { clickhouse: { lists: { threshold: 1000 } } }), { index: INDEX }).lists[0].name === named.lists[0].name, 'liste nommée : même nom quel que soit l’ordre des valeurs');
// Un nom de clause inconnu reste dans une chaîne SQL échappée
const odd = tr({ query: { "x') OR 1=1 --": {} } });
check(odd.stats.ko === 1 && odd.sql.includes("throwIf(1, 'Passerelle : x\\') OR 1=1 -- à traduire')"), 'clause inconnue : nom échappé, requête arrêtée par throwIf');
// regexp insensible à la casse : les échappements sont respectés, et une classe non fermée n’est pas réparée en passant
const folded = v => tr({ query: { regexp: { host: { value: v, case_insensitive: true } } } }).sql;
check(folded('a\\[b[]x-zQ]+').includes("(?i)a\\\\[b(?-i:[]x-zqQ])+") && folded('web-[a').includes("'^(?:(?i)web-[a)$'"), 'regexp insensible à la casse : échappements respectés, classe non fermée laissée telle quelle');
// query_string mal formée : à reprendre, comme Elasticsearch la refuse
for (const q of ['status:500) AND service:api', 'status:(500', '(status:500', 'status:500 OR OR status:404', '"connection reset', 'status:[500 TO', 'timeout AND']) {
  check(tr({ query: { query_string: { query: q } } }).stats.ko === 1, `query_string mal formée déclarée à reprendre : ${q}`);
}

// Les secrets passent par des variables d’environnement, jamais par la configuration générée
const ls = E.translateLogstash(rd('examples/logstash/routage.conf'), E.DEFAULT_CONFIG);
check(ls.yaml.includes("'${KAFKA_PASSWORD}'") && ls.env.includes('KAFKA_PASSWORD'), 'routage.conf : identifiants Kafka référencés par variable d’environnement');
// Vector 0.57 et suivants : interpolation à demander, et pas de ${…} dans les commentaires, que Vector interpole aussi
check(/^# .*--dangerously-allow-env-var-interpolation/m.test(ls.yaml) && !/^#.*\$\{/m.test(ls.yaml), 'routage.conf : en-tête qui demande l’interpolation, sans ${…} dans les commentaires');
// Topic tiré entièrement d’un champ : Vector 0.57 et suivants l’exigent explicitement
const topicDyn = E.translateLogstash('input { stdin {} } output { kafka { topic_id => "%{type}" } }', E.DEFAULT_CONFIG);
check(/topic: '\{\{ type \}\}'\n\s+dangerously_allow_unconfined_template_resolution: true/.test(topicDyn.yaml), 'topic_id « %{type} » : dangerously_allow_unconfined_template_resolution posé');
// Le VRL de préparation suppose le namespace de logs : chaque source doit le déclarer, Kafka ou non
const everyInput = 'input { kafka { topics => ["t"] } stdin { } file { path => "/var/log/app.log" } tcp { port => 5000 } udp { port => 5001 } http { port => 8080 } beats { port => 5044 } generator { } } output { stdout { } }';
const namespaced = cfg => Object.values(E.translateLogstash(everyInput, cfg).config.sources).filter(s => s.log_namespace === true).length;
check(namespaced(E.DEFAULT_CONFIG) === 8 && namespaced(E.mergeConfig(E.DEFAULT_CONFIG, { vector: { log_namespace: false } })) === 0, 'entrées : chaque source déclare le namespace de logs que suppose le VRL généré');

/* ---------- Contrat de confiance : rien de faux annoncé comme juste ---------- */
const refused = (dsl, re) => { const r = tr(dsl); return E.verdictOf(r) === 'unrecognized' && re.test(r.error || ''); };
const guarded = (dsl, re) => { const r = tr(dsl); return E.verdictOf(r) === 'todo' && re.test(r.sql) && r.statements.every(s => /throwIf\(1, /.test(s.sql)); };
// Discover demande fields: ["*"] avec _source: false : toutes les colonnes, jamais une colonne nommée « * »
const discover = tr({ _source: false, fields: [{ field: '*', include_unmapped: 'true' }, { field: '@timestamp', format: 'strict_date_optional_time' }], stored_fields: ['*'], size: 5 });
check(/SELECT\n {4}\*\nFROM/.test(discover.sql) && !discover.sql.includes('`*`'), 'fields ["*"] de Discover : SELECT *');
check(/COLUMNS\('\^http\\\\\.\.\*\$'\)/.test(tr({ _source: false, fields: ['http.*'] }).sql), 'fields à motif : COLUMNS(regex)');
// Clés inconnues : la requête est refusée, comme Elasticsearch la refuserait
check(refused({ qeury: { term: { service: 'api' } } }, /qeury/), 'clé inconnue du corps de recherche : refus');
check(refused({ query: { bool: { filtre: [{ term: { service: 'api' } }] } } }, /filtre/), 'clé inconnue de bool : refus');
check(refused({ query: { term: { service: 'api' }, range: { status: { gte: 500 } } } }, /une clause par objet/), 'deux clauses dans un objet : refus');
check(refused({ query: { term: { service: 'api', host: 'a' } } }, /un seul champ/), 'deux champs dans term : refus');
check(refused({ size: 0, aggs: { a: { terms: { field: 'service' }, avg: { field: 'latency_ms' } } } }, /deux types/), 'deux types dans une agrégation : refus');
check(refused({ attributes: { title: 't' }, type: 'search', id: 'x' }, /Inspect/), 'objet sauvegardé Kibana : refus qui dit quoi copier');
check(refused(JSON.parse('{"query":' + '{"bool":{"must":['.repeat(400) + '{"match_all":{}}' + ']}}'.repeat(400) + '}'), /imbriquée/), 'requête imbriquée à l’excès : refus, pas de pile épuisée');
// Paramètre inconnu ou option non traduite : à reprendre, et le SQL s’arrête sur throwIf
check(guarded({ size: 0, aggs: { a: { terms: { field: 'service', sise: 5 } } } }, /sise/), 'paramètre inconnu d’agrégation : à reprendre, SQL arrêté');
check(guarded({ query: { term: { service: 'api' } }, knn: { field: 'v', query_vector: [1], k: 1 } }, /knn/), 'knn : à reprendre, SQL arrêté');
check(guarded({ query: { match_bool_prefix: { message: { query: 'conn ref', operator: 'and' } } } }, /operator/), 'option qui change le résultat sans être traduite : à reprendre');
check(E.verdictOf(tr({ query: { match: { message: { query: 'x', analyzer: 'french' } } } })) === 'review', 'analyseur personnalisé : à vérifier');
const quiet = tr({ query: { term: { service: 'api' } }, highlight: { fields: { message: {} } }, version: true });
check(E.verdictOf(quiet) === 'ready' && quiet.notes.some(n => n.title === 'Options sans effet sur le résultat'), 'options sans effet (highlight, version) : signalées, verdict inchangé');
check(E.coverage({ ok: 999, approx: 0, ko: 1 }).percent === 99, 'couverture : 999 clauses sur 1 000 ne s’affichent pas 100 %');
// Modèles Watcher, Kibana et Grafana : paramètres ClickHouse
const watcher = tr({ size: 0, query: { range: { '@timestamp': { gte: '{{ctx.trigger.scheduled_time}}||-5m' } } } });
check(E.verdictOf(watcher) === 'ready' && watcher.sql.includes("parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE") && watcher.parameters[0].source === '{{ctx.trigger.scheduled_time}}', 'modèle Watcher : paramètre {scheduled_time:String}');
const grafana = tr({ size: 0, query: { bool: { filter: [{ range: { '@timestamp': { gte: '$timeFrom', format: 'epoch_millis' } } }, { query_string: { query: 'service:$service' } }] } } });
check(grafana.sql.includes('fromUnixTimestamp64Milli(toInt64({timeFrom:String}))') && grafana.sql.includes('service = {service:String}'), 'variables Grafana : bornes epoch_millis et valeurs en paramètres');
check(guarded({ query: { match: { message: '{{ctx.payload.word}}' } } }, /modèle « \{\{ctx\.payload\.word\}\} »/), 'modèle dans une recherche plein texte : à reprendre');
// Analyse Lucene : une longue liste de OR ne doit pas épuiser la pile
const longOr = tr({ query: { query_string: { query: Array.from({ length: 20000 }, (_, i) => `host:h${i}`).join(' OR ') } } });
check(!longOr.error && longOr.stats.ko === 0, 'query_string de 20 000 OR : traduite');
check(tr({ query: { query_string: { query: '('.repeat(5000) + 'a' + ')'.repeat(5000) } } }).stats.ko === 1, 'query_string imbriquée à l’excès : à reprendre, pas de pile épuisée');

// Sortie elasticsearch : identifiants en variables, index tiré d’un champ, data stream
const esOut = E.translateLogstash('input { stdin {} } output { elasticsearch { hosts => ["es:9200"] index => "%{[@metadata][index]}-%{+YYYY.MM.dd}" user => "elastic" password => "changeme" ssl_enabled => true cacert => "/etc/ca.pem" } }', E.DEFAULT_CONFIG);
check(!esOut.yaml.includes('changeme') && esOut.yaml.includes("password: '${ELASTICSEARCH_PASSWORD}'") && esOut.env.includes('ELASTICSEARCH_PASSWORD'), 'sortie elasticsearch : mot de passe lu dans une variable, jamais recopié');
check(/dangerously_allow_unconfined_template_resolution: true/.test(esOut.yaml) && /endpoints: \[https:\/\/es:9200\]/.test(esOut.yaml) && /ca_file: \/etc\/ca\.pem/.test(esOut.yaml), 'sortie elasticsearch : index tiré d’un champ autorisé, HTTPS et autorité de certification');
const dsOut = E.translateLogstash('input { stdin {} } output { elasticsearch { hosts => ["https://es:9200"] data_stream => "true" data_stream_dataset => "nginx" api_key => "${ES_API_KEY}" } }', E.DEFAULT_CONFIG);
check(/mode: data_stream/.test(dsOut.yaml) && /dataset: nginx/.test(dsOut.yaml) && dsOut.yaml.includes("Authorization: 'ApiKey ${ES_API_KEY}'"), 'sortie elasticsearch : data stream et clé d’API');
const upd = E.translateLogstash('input { stdin {} } output { elasticsearch { action => "update" doc_as_upsert => true } }', E.DEFAULT_CONFIG);
check(E.verdictOf(upd) === 'todo', 'sortie elasticsearch : mise à jour de documents à reprendre');
check(E.verdictOf(E.translateLogstash('input { stdin {} } output { file { path => "/tmp/x" flush_interval => 0 inconnue => 1 } }', E.DEFAULT_CONFIG)) === 'review', 'option de sortie non reprise : à vérifier');
check(/imbrication/.test(E.translateLogstash('input { stdin {} } filter { ' + 'if [a] { '.repeat(500) + 'drop {}' + ' }'.repeat(500) + ' } output { stdout {} }', E.DEFAULT_CONFIG).error || ''), 'pipeline imbriqué à l’excès : refus, pas de pile épuisée');

// Les fichiers du moteur et le serveur partagent une portée : un nom déclaré deux fois casserait le binaire
const declared = (engineSource() + rd('src/server.js')).match(/^(?:function|const|let|class) +[A-Za-z_$][\w$]*/gm).map(d => d.split(/ +/)[1]);
const twice = [...new Set(declared.filter((d, i) => declared.indexOf(d) !== i))];
check(!twice.length, 'aucun nom déclaré deux fois dans le binaire assemblé', twice.join(', '));

process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests passent.\n');
process.exit(failures ? 1 : 0);
