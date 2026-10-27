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
import { translatedPipeline, translatedChain } from '../tests/pipelines/transport.mjs';
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
  // Pipelines reliés : la configuration de l’ensemble, liaisons comprises
  if (c.chain) {
    const t = E.translatePipelines(translatedChain(c, 'v8'), E.DEFAULT_CONFIG);
    snapshot(`pipelines/${c.id}.yaml`, t.error ? `# Erreur : ${t.error}\n` : withHeader(t, '#') + t.yaml);
    continue;
  }
  const r = E.translateLogstash(translatedPipeline(c), E.DEFAULT_CONFIG);
  if (r.error) { snapshot(`pipelines/${c.id}.yaml`, `# Erreur : ${r.error}\n`); continue; }
  const own = Object.fromEntries(Object.entries(r.config.transforms).filter(([name]) => !isTransport(name)));
  snapshot(`pipelines/${c.id}.yaml`, withHeader(r, '#') + (Object.keys(own).length ? E.toYAML({ transforms: own }) : r.yaml).trimEnd() + '\n');
}
// Inventaire Kibana des exemples : le rapport complet (verdicts, effort, SQL de chaque objet) est figé ici ;
// le banc ClickHouse (npm run test:clickhouse) exécute chacune de ses requêtes et contrôle des valeurs
const kibanaCfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/kibana/passerelle.yaml')));
const kibanaFiles = readdirSync(join(ROOT, 'examples/kibana')).filter(n => n.endsWith('.ndjson')).sort();
const kibanaInv = E.kibanaInventory(kibanaFiles.map(f => rd(`examples/kibana/${f}`)), kibanaCfg, { names: kibanaFiles });
snapshot('kibana/inventaire.md', E.inventoryMarkdown(kibanaInv));

// Tableau de bord Grafana de l’exemple : le tableau converti et son rapport sont figés ici ; le banc ClickHouse
// interpole et exécute chacune de ses requêtes
const grafanaCfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/grafana/passerelle.yaml')));
const grafanaOut = E.grafanaDashboard(rd('examples/grafana/supervision_es.json'), grafanaCfg, { index: 'logs-web-*' });
snapshot('grafana/supervision_es.clickhouse.json', JSON.stringify(grafanaOut.dashboard, null, 2) + '\n');
snapshot('grafana/supervision_es.rapport.md', E.grafanaReportMarkdown(grafanaOut, 'supervision_es.json'));

// pipelines.yml : lecture, fichiers de path.config, liaisons pipeline { send_to }
{
  const yml = [
    '# commentaire', '- pipeline.id: "a # pas un commentaire"', '  pipeline.workers: 2 # commentaire', "  config.string: 'input { stdin {} } output { pipeline { send_to => [b] } }'",
    '- pipeline:', '    id: b', '    ecs_compatibility: disabled', '  config.string: |', '    input { pipeline { address => "b" } }', '', '    output { null {} }',
    '- pipeline.id: c', '  path.config: >-', '    /etc/logstash/conf.d/c/*.conf', '  queue.type: persisted'
  ].join('\n');
  const e = E.parsePipelinesYML(yml);
  check(e.length === 3 && e[0].settings['pipeline.id'] === 'a # pas un commentaire' && e[0].settings['pipeline.workers'] === 2, 'pipelines.yml : liste de pipelines, guillemets, commentaires, nombres');
  check(e[1].settings['pipeline.id'] === 'b' && e[1].settings['pipeline.ecs_compatibility'] === 'disabled' && e[1].settings['config.string'] === 'input { pipeline { address => "b" } }\n\noutput { null {} }\n', 'pipelines.yml : tables imbriquées aplaties, bloc | avec ligne vide');
  check(e[2].settings['path.config'] === '/etc/logstash/conf.d/c/*.conf', 'pipelines.yml : bloc >-');
  let bad = ''; try { E.parsePipelinesYML('pipeline.id: x'); } catch (err) { bad = err.message; }
  check(/ligne 1/.test(bad), 'pipelines.yml : une table seule est refusée avec sa ligne', bad);
  const files = ['conf.d/c/2.conf', 'conf.d/c/1.conf', 'conf.d/c/1.conf~', 'conf.d/c/sous/3.conf', 'web.conf', 'd/x.conf'];
  const f1 = E.pipelineConfigFiles('/etc/logstash/conf.d/c/*.conf', files);
  check(JSON.stringify(f1.files) === '["conf.d/c/1.conf","conf.d/c/2.conf"]' && f1.matched === 'conf.d/c/*.conf', 'path.config absolu : retrouvé par sa fin, ordre alphabétique, sauvegardes ~ écartées', JSON.stringify(f1));
  check(E.pipelineConfigFiles('/etc/logstash/web.conf', files).files[0] === 'web.conf', 'path.config absolu : retrouvé par son seul nom');
  check(JSON.stringify(E.pipelineConfigFiles('conf.d/c', files).files) === '["conf.d/c/1.conf","conf.d/c/2.conf"]', 'path.config dossier : ses fichiers, sans les sous-dossiers');
  check(E.pipelineConfigFiles('conf.d/**/*.conf', files).files.length === 3 && E.pipelineConfigFiles('{web,d/x}.conf', files).files.length === 2, 'path.config : motifs ** et {a,b}');
  check(!E.pipelineConfigFiles('autre/*.conf', files).files.length, 'path.config relatif introuvable : rien, pas de recherche par la fin');
  const set = (...p) => E.translatePipelines(p.map(([id, config]) => ({ id, config })), E.DEFAULT_CONFIG);
  const ok = set(['a', 'input { stdin {} } output { if [x] { pipeline { send_to => ["b"] } } else { stdout {} } }'], ['b', 'input { pipeline { address => "b" } } filter { mutate { add_tag => ["b"] } } output { stdout {} }']);
  const bIn = Object.entries(ok.config.transforms).find(([n]) => n.startsWith('b_'));
  check(!ok.error && !!bIn && JSON.stringify(bIn[1].inputs) === '["a_routage.pipeline_b"]', 'send_to sous condition : l’entrée du destinataire est la branche du routage', bIn && JSON.stringify(bIn[1].inputs));
  check(!Object.values(ok.config.sources).some(x => x.type === '__pipeline') && !Object.values(ok.config.sinks).some(x => x.type === '__pipeline'), 'liaisons : aucun composant fictif dans la configuration');
  check(Object.keys(ok.config.sinks).every(n => /^(a|b)_/.test(n)), 'composants préfixés par l’identifiant du pipeline');
  const lost = set(['a', 'input { stdin {} } output { pipeline { send_to => ["nulle_part"] } stdout {} }'], ['b', 'input { pipeline { address => "seul" } } output { stdout {} }']);
  check(lost.notes.some(n => n.level === 'err' && /sans destinataire/.test(n.title)) && lost.notes.some(n => n.level === 'err' && /sans expéditeur/.test(n.title)) && !Object.keys(lost.config.sinks).some(n => n.startsWith('b_')), 'adresse sans destinataire ou sans expéditeur : à reprendre, étapes orphelines retirées');
  check(lost.pipelines.every(x => x.verdict === 'todo'), 'liaison cassée : les deux pipelines sont à reprendre');
  const loop = set(['a', 'input { stdin {} pipeline { address => "a" } } output { pipeline { send_to => ["b"] } }'], ['b', 'input { pipeline { address => "b" } } output { pipeline { send_to => ["a"] } stdout {} }']);
  check(loop.notes.some(n => /Boucle entre pipelines/.test(n.title)), 'boucle entre pipelines : signalée, Vector la refuserait');
  const dup = set(['a', 'input { stdin {} } output { stdout {} }'], ['a', 'input { stdin {} } output { stdout {} }'], ['c', 'input { pipeline { address => "x" } } output { stdout {} }'], ['d', 'input { pipeline { address => "x" } } output { stdout {} }']);
  check(dup.notes.some(n => /déclaré deux fois/.test(n.title)) && dup.notes.some(n => /plusieurs pipelines/.test(n.title)), 'identifiant ou adresse en double : refusés comme par Logstash');
  const alone = E.translateLogstash('input { pipeline { address => "x" } } output { pipeline { send_to => ["y"] } }', E.DEFAULT_CONFIG);
  check(alone.notes.filter(n => n.level === 'err' && /pipelines\.yml/.test(n.detail)).length === 2, 'fichier seul : entrée et sortie pipeline renvoient vers pipelines.yml');
  const kafka = E.translatePipelines([{ id: 'a', config: 'input { kafka { topics => ["t1"] } } output { kafka { topic_id => "o1" } }' }, { id: 'b', config: 'input { kafka { topics => ["t2"] } } output { kafka { topic_id => "o2" } }' }], E.mergeConfig(E.DEFAULT_CONFIG, { kafka: { output_topic: 'force', input_topics: ['forcé'] } }));
  check(JSON.stringify(Object.values(kafka.config.sinks).map(x => x.topic)) === '["o1","o2"]' && JSON.stringify(Object.values(kafka.config.sources).map(x => x.topics[0])) === '["t1","t2"]', 'plusieurs entrées et sorties Kafka : output_topic et input_topics ne s’imposent pas à toutes');
  const ex = rd('examples/logstash/pipelines/pipelines.yml');
  const exFiles = ['conf.d/entree.conf', 'conf.d/systeme.conf', 'conf.d/web/10-entree.conf', 'conf.d/web/20-filtres.conf', 'conf.d/web/30-sorties.conf'];
  const exList = E.pipelinesFromYML(ex, exFiles, f => rd(`examples/logstash/pipelines/${f}`));
  const exR = E.translatePipelines(exList, E.DEFAULT_CONFIG);
  check(!exR.error && exR.pipelines.length === 4 && exR.pipelines.every(x => !x.error) && !exR.notes.some(n => n.level === 'err'), 'exemple pipelines.yml : quatre pipelines reliés, rien à reprendre', exR.sentence);
  snapshot('examples/logstash/pipelines.yaml', withHeader(exR, '#') + exR.yaml);
}
// Pipelines d’ingestion Elasticsearch : lecture, appel de pipeline, chemins, découpage en transforms
{
  const one = (text, name) => E.translateIngest([{ name: name || 'p', text }], E.DEFAULT_CONFIG);
  const vrlOf = r => r.pipelines.map(p => p.vrls.join('\n')).join('\n');
  const gen = n => ({ name: 'long', text: 'processors:\n' + Array.from({ length: n }, (_, i) => `  - set:\n      field: champ_${i}.valeur\n      value: "{{ message }} ${i}"\n`).join('') });
  const r1 = one('processors:\n  - set: { field: a.b, value: 1 }\n  - lowercase: { field: a.c }');
  check(!r1.error && r1.pipelines.length === 1 && r1.pipelines[0].verdict === 'ready' && r1.pipelines[0].chain.length === 1, 'ingest : un pipeline court est un seul transform remap, prêt');
  check(!!r1.config.transforms.aiguillage === false && !!r1.config.transforms.bilan && !!r1.config.sinks.echecs, 'ingest : bilan des échecs et sortie dédiée');
  const rj = one(JSON.stringify({ description: 'x', processors: [{ set: { field: 'a', value: 1 } }] }));
  const rc = one('PUT _ingest/pipeline/mon-pipeline\n{ "processors": [ { "set": { "field": "a", "value": 1 } } ] }', 'ignoré');
  check(!rj.error && !rc.error && rc.pipelines[0].name === 'mon-pipeline', 'ingest : JSON et requête PUT de la console Kibana lus, nom pris dans la requête', rc.error);
  const lit = one("processors:\n  - set: { field: a, value: 'x{{y' }");
  check(!lit.error && vrlOf(lit).includes('"x\\{{y"'), 'ingest : « {{ » littéral dans une valeur est échappé, VRL l’interpolerait en silence', vrlOf(lit).split('\n').find(l => /x.*\{\{y/.test(l)));
  const bad = one('processors:\n  - grok: { field: m, patterns: ["(?=a)%{WORD:w}"] }\n  - gsub: { field: m, pattern: "(?<=a)b", replacement: "c" }');
  check(bad.pipelines[0].verdict === 'todo' && bad.notes.some(n => n.level === 'err' && /rétrospection/.test(n.detail)), 'ingest : une rétrospection (?<=…) est à reprendre avec sa raison, pas un VRL qui ne compile pas', JSON.stringify(bad.notes.filter(n => n.level === 'err').map(n => n.detail)));
  // F99 : analyseurs personnalisés
  {
    const { ATTENDUS } = await import('../tests/clickhouse/analyseurs.cas.mjs');
    for (const [spec, texte, attendu] of ATTENDUS) {
      const r = E.anAnalyze(spec, texte);
      check(r.tokens && JSON.stringify(r.tokens.map(x => x.t)) === JSON.stringify(attendu), `analyseur : l’aperçu reproduit la documentation d’Elasticsearch (${JSON.stringify(spec).slice(0, 70)})`, r.error || JSON.stringify(r.tokens && r.tokens.map(x => x.t)));
    }
    const st = E.anAnalyze({ tokenizer: 'standard', filter: ['stemmer'] }, 'running');
    check(st.tokens === null && /pas d’aperçu/.test(st.error), 'analyseur : un stemmer n’a pas d’aperçu, aucun mot n’est inventé');
    const bad = E.anPlan({ tokenizer: 'pattern', filter: [] }, "'x'");
    check(bad.expr && bad.verdict === 'ready', 'analyseur : le tokenizer pattern par défaut a un plan exact');
    const la = E.anPlan({ tokenizer: { type: 'pattern', pattern: '(?<=a)b' } }, "'x'");
    check(la.expr === null && la.verdict === 'todo' && /anticipation/.test(la.notes[0].detail), 'analyseur : une rétrospection est à reprendre avec sa raison');
    const lang = E.anPlan('english', "'x'");
    check(lang.expr === null && lang.verdict === 'todo', 'analyseur : un analyseur de langue prédéfini est à reprendre');
    const ex = rd('examples/analyseurs/catalogue.txt').trim();
    const sc = E.schemaFromElastic(ex, E.DEFAULT_CONFIG, {});
    const rep = E.anReport(sc.tables, 'Les téléviseurs d’été');
    check(rep.plans.length === 5 && rep.plans.some(p => p.plan.field === 'titre.debut' && p.plan.column === 'titre') && rep.plans.find(p => p.plan.field === 'tags').plan.expr.startsWith('arrayFlatten(arrayMap(v ->'), 'analyseur : sous-champ calculé depuis sa colonne, valeurs multiples analysées une à une');
    check(/idx_tags_text tags TYPE text\(tokenizer = splitByNonAlpha, preprocessor = lowerUTF8\(tags\)\)/.test(sc.sql), 'schéma : l’index text d’une colonne Array(String) passe par preprocessor, pas par lowerUTF8');
    snapshot('examples/analyseurs/catalogue.md', rep.markdown);
  }
  {
    const c2 = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG)); c2.vector.elasticsearch_output = 'clickhouse';
    c2.clickhouse.index_mapping = { 'app-*': 'logs.app' };
    const ls = E.translateLogstash('input { kafka { topics => ["a"] } }\noutput { elasticsearch { hosts => ["http://es:9200"] index => "app-events" action => "create" } }', c2, {});
    check(ls.config.sinks.elasticsearch_out && ls.config.sinks.elasticsearch_out.type === 'clickhouse' && ls.config.sinks.elasticsearch_out.table === 'app' && ls.config.transforms.elasticsearch_out_lignes, 'F10 : une sortie elasticsearch devient un sink clickhouse précédé de sa mise en forme');
    check(ls.notes.some(n => n.level === 'warn' && /action/.test(n.title)), 'F10 : une option sans équivalent (action) est signalée');
    const dyn = E.translateLogstash('input { kafka { topics => ["a"] } }\noutput { elasticsearch { hosts => ["http://es:9200"] index => "%{idx}-%{+YYYY.MM.dd}" } }', c2, {});
    check(/%clickhouse\.table/.test(dyn.yaml) && dyn.config.sinks.elasticsearch_out.dangerously_allow_unconfined_template_resolution === true, 'F10 : un index calculé choisit la table pour chaque événement');
    const ig = E.translateIngest([{ name: 'p', text: JSON.stringify({ processors: [{ set: { field: 'a', value: 1 } }] }) }], c2);
    check(ig.config.sinks.sortie.type === 'clickhouse' && ig.config.transforms.sortie_lignes, 'F10 : la sortie d’un pipeline d’ingestion peut être ClickHouse');
  }
  {
    const src = 'boolean prive(String ip) { if (ip == null) { return false; } return ip.startsWith("10."); }\nString lib(boolean b) { return b ? "privee" : "publique"; }\nctx.net = lib(prive(ctx.ip));';
    const fn = E.translateIngest([{ name: 'f', text: JSON.stringify({ processors: [{ script: { source: src } }] }) }], E.DEFAULT_CONFIG);
    check(fn.pipelines[0].verdict !== 'todo' && /privee/.test(fn.yaml), 'ingest : les fonctions déclarées dans un script Painless sont recopiées sur place', JSON.stringify(fn.notes.filter(n => n.level === 'err').map(n => n.detail)));
    const rec = E.translateIngest([{ name: 'r', text: JSON.stringify({ processors: [{ script: { source: 'int f(int n) { return f(n); }\nctx.a = f(1);' } }] }) }], E.DEFAULT_CONFIG);
    check(rec.pipelines[0].verdict === 'todo' && rec.notes.some(n => /récursive/.test(n.detail)), 'ingest : une fonction récursive est à reprendre avec sa raison');
  }
  const sub = E.translateIngest([{ name: 'haut', text: 'processors:\n  - pipeline: { name: bas }\n  - set: { field: z, value: 1 }' }, { name: 'bas', text: 'processors:\n  - set: { field: y, value: 1 }' }], E.DEFAULT_CONFIG);
  check(sub.pipelines.length === 1 && sub.pipelines[0].name === 'haut' && sub.pipelines[0].calls.includes('bas') && /\.y = 1/.test(vrlOf(sub)), 'ingest : un pipeline appelé est traduit en place, seul le pipeline principal a son transform');
  const manquant = one('processors:\n  - pipeline: { name: absent }');
  check(manquant.pipelines[0].verdict === 'todo' && manquant.notes.some(n => /absent/.test(n.detail)), 'ingest : pipeline appelé absent des fichiers : à reprendre');
  const long = E.translateIngest([gen(400)], E.DEFAULT_CONFIG);
  const lp = long.pipelines[0];
  check(lp.chain.length > 1 && lp.vrls.every(v => v.length < 60000), 'ingest : un pipeline long est coupé en plusieurs transforms de taille bornée', `${lp.chain.length} transforms`);
  check(lp.chain.every((id, k) => long.config.transforms[id].inputs[0] === (k ? lp.chain[k - 1] : 'agent_in')) && long.config.transforms.bilan.inputs[0] === lp.chain[lp.chain.length - 1], 'ingest : les transforms se suivent, le dernier alimente le bilan');
  check(lp.vrls[0].includes('%ingest_etat = {') && lp.vrls[1].includes('ok = bool!(%ingest_etat.ok)') && lp.vrls[lp.vrls.length - 1].includes('del(%ingest_etat)'), 'ingest : l’état passe d’un transform à l’autre par les métadonnées');
  const fixtures = ['acces-web', 'navigateur'].map(n => ({ name: n, text: rd(`examples/ingest/${n}.yml`) }));
  const ex = E.translateIngest(fixtures, E.DEFAULT_CONFIG);
  check(!ex.error && ex.pipelines.length === 1 && ex.pipelines[0].verdict !== 'todo' && !ex.notes.some(n => n.level === 'err'), 'exemple ingest : un pipeline et son sous-pipeline, rien à reprendre', ex.sentence);
  snapshot('examples/ingest/acces-web.yaml', withHeader(ex, '#') + ex.yaml);
}
// Un instantané sans cas ni exemple correspondant est un reste : supprimé par --update, signalé sinon
for (const rel of readdirSync(join(ROOT, 'tests/snapshots'), { recursive: true }).map(p => p.split(sep).join('/'))) {
  if (!/\.(sql|yaml|md|json)$/.test(rel) || snapshots.seen.has(rel)) continue;
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
// geo_distance : une unité inconnue est refusée, comme par Elasticsearch, au lieu d’une distance nulle
check(/distance illisible/.test(tr({ query: { geo_distance: { distance: '3furlongs', loc: { lat: 48.8, lon: 2.3 } } } }).error || ''), 'geo_distance, unité inconnue : traduction refusée');
check(/<= 0\.4572$/m.test(tr({ query: { geo_distance: { distance: '1.5ft', loc: { lat: 48.8, lon: 2.3 } } } }).sql), 'geo_distance : distance en mètres sans arrondi à l’entier');
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
// _source excludes : un parent exclut ses sous-champs, un motif s’applique, includes ne fait pas oublier excludes
// (formes exécutées sur ClickHouse 26.9 : un nom absent dans EXCEPT (…) n’exclut rien, sans erreur)
const selected = src => tr({ _source: src }).sql.match(/^SELECT\n([\s\S]*?)\nFROM/m)[1].trim();
check(selected({ excludes: ['http'] }) === "* EXCEPT ('^(?:http)(?:\\\\..*)?$')", '_source excludes d’un parent : sous-champs exclus');
check(selected({ excludes: ['http.*'] }) === "* EXCEPT ('^(?:http\\\\..*)(?:\\\\..*)?$')", '_source excludes à motif : expression régulière');
check(selected({ includes: ['http.*'], excludes: ['http.body'] }) === "COLUMNS('^http\\\\..*$') EXCEPT ('^(?:http\\\\.body)(?:\\\\..*)?$')", '_source includes et excludes à la fois : exclusions gardées');
check(selected({ includes: ['service', 'http.method'], excludes: 'http' }) === 'service', '_source excludes écrit en chaîne : champ inclus retiré');
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

/* ---------- KQL : la grammaire et les conversions de Kibana (kbn-es-query) ---------- */
const KQL_TYPES = { status: 'number', host: 'keyword', '@timestamp': 'date', message: 'text', service: 'keyword' };
const kql = (q, fields) => { const issues = []; try { return { dsl: E.kqlTranslate(q, { fieldType: f => KQL_TYPES[f] || null, fields: fields || [], issues }), issues }; } catch (e) { return { error: e.message, issues }; } };
const kqlIs = (q, expected, label, fields) => { const r = kql(q, fields); const ok = JSON.stringify(r.dsl) === JSON.stringify(expected); check(ok, `KQL ${label}`, ok ? '' : r.error || JSON.stringify(r.dsl)); };
kqlIs('message: connexion refusée', { match: { message: 'connexion refusée' } }, 'valeur sans guillemets à plusieurs mots : match, pas une phrase');
kqlIs('message: "connexion refusée"', { match_phrase: { message: 'connexion refusée' } }, 'valeur entre guillemets : match_phrase');
kqlIs('host:a or host:b and not status >= 500', { bool: { should: [{ term: { host: { value: 'a' } } }, { bool: { filter: [{ term: { host: { value: 'b' } } }, { bool: { must_not: { range: { status: { gte: 500 } } } } }] } }], minimum_should_match: 1 } }, 'priorité : not, puis and, puis or');
kqlIs('NOT host:a', { bool: { must_not: { term: { host: { value: 'a' } } } } }, 'mots-clés sans distinction de casse');
kqlIs('message: cannot', { match: { message: 'cannot' } }, '« not » dans un mot n’est pas un mot-clé');
kqlIs('host: *', { exists: { field: 'host' } }, 'champ: * vaut exists');
kqlIs('*:*', { match_all: {} }, '*:* vaut tous les documents');
kqlIs('host: web-*', { wildcard: { host: { value: 'web-*' } } }, 'joker sur un keyword : wildcard');
kqlIs('host: "web-*"', { term: { host: { value: 'web-*' } } }, 'joker entre guillemets : caractère ordinaire');
kqlIs('@timestamp: "2026-01-01"', { range: { '@timestamp': { gte: '2026-01-01', lte: '2026-01-01' } } }, 'valeur sur un champ date : plage [valeur, valeur]');
kqlIs('service: (a or b)', { bool: { should: [{ term: { service: { value: 'a' } } }, { term: { service: { value: 'b' } } }], minimum_should_match: 1 } }, 'liste de valeurs sur un champ');
kqlIs('items:{ name: x and qty > 2 }', { nested: { path: 'items', query: { bool: { filter: [{ match: { 'items.name': 'x' } }, { range: { 'items.qty': { gt: 2 } } }] } }, score_mode: 'none' } }, 'requête imbriquée (nested)');
kqlIs('http.*: 500', { bool: { should: [{ match: { 'http.method': '500' } }, { match: { 'http.status': '500' } }], minimum_should_match: 1 } }, 'champ à motif : les champs connus qui y correspondent', ['http.method', 'http.status', 'host']);
check(kql('connexion').issues.some(i => i.kind === 'review'), 'KQL sans nom de champ : multi_match, à vérifier');
check(/fin de requête attendue/.test(kql('a:b not c:d').error || ''), 'KQL « a:b not c:d » refusé, comme Kibana le refuse');
check(/valeur attendue/.test(kql('url: \\/admin').error || ''), 'KQL échappement inconnu refusé, comme Kibana le refuse');
check(/imbriquée/.test(kql('('.repeat(100) + 'a:b' + ')'.repeat(100)).error || ''), 'KQL imbriqué à l’excès : refus, pas de pile épuisée');

/* ---------- Inventaire Kibana : rien de faux annoncé comme juste ---------- */
const kbEntry = title => kibanaInv.entries.find(x => x.title === title) || { issues: [], queries: [] };
check(kbEntry('Carte des sessions (Vega)').verdict === 'todo' && kbEntry('Enquête délais d’attente').verdict === 'todo', 'Vega et ES|QL : à reprendre, jamais traduits en silence');
check(kbEntry('Erreurs : aujourd’hui contre hier').issues.some(i => /décalage temporel/.test(i.label)), 'Lens, décalage temporel (time shift) : à reprendre');
check(kbEntry('Supervision du site web').verdict === 'todo', 'tableau de bord : verdict de son plus mauvais panneau');
const byValue = kibanaInv.entries.find(x => x.parent && x.title === 'Codes d’erreur');
check(byValue && /service\.environment = 'production'/.test(byValue.queries[0].sql) && /`?url\.path`? != '\/health'/.test(byValue.queries[0].sql), 'panneau par valeur : requête et filtres du tableau de bord inclus');
check(kibanaInv.summary.effort.hours === kibanaInv.entries.reduce((n, x) => n + x.effort, 0), 'effort total : somme des objets, chaque objet compté une fois');
const kbTsvb = kbEntry('Débit sortant par hôte (TSVB)');
check(/ORDER BY sum\(`?http\.response\.bytes`?\) DESC/.test(kbTsvb.queries[0].sql), 'TSVB trié par une mesure : la mesure est recalculée sous le terms, comme dans TSVB');
check(kbEntry('Latence moyenne et p95 par heure').queries[0].sql.includes("'Europe/Paris'"), 'fuseau de Kibana (dateFormat:tz exporté) : tranches dans ce fuseau');
const kbNoTz = E.kibanaInventory(rd('examples/kibana/supervision_web.ndjson').split('\n').filter(l => !/"type":"config"/.test(l)).join('\n'), kibanaCfg);
check(kbNoTz.entries.find(x => x.title === 'Latence moyenne et p95 par heure').verdict === 'ready' && kbNoTz.entries.find(x => x.title === 'Requêtes par service').issues.some(i => i.label === 'intervalle automatique'), 'sans fuseau exporté : tranches horaires exactes, intervalle automatique signalé');
const kbDay = E.kibanaInventory(JSON.stringify({ type: 'visualization', id: 'v', attributes: { title: 'jour', visState: JSON.stringify({ type: 'line', aggs: [{ id: '1', type: 'count', schema: 'metric' }, { id: '2', type: 'date_histogram', params: { field: '@timestamp', interval: 'd' }, schema: 'segment' }] }), kibanaSavedObjectMeta: { searchSourceJSON: '{}' } } }), kibanaCfg);
check(kbDay.entries[0].issues.some(i => /fuseau/.test(i.label)), 'tranches de jours sans fuseau connu : à vérifier (Kibana découpe dans le fuseau du navigateur)');
const kbMissing = E.kibanaInventory(JSON.stringify({ type: 'dashboard', id: 'd', attributes: { title: 'd', panelsJSON: JSON.stringify([{ panelIndex: '1', panelRefName: 'panel_0', type: 'visualization' }]), kibanaSavedObjectMeta: { searchSourceJSON: '{}' } }, references: [{ name: 'panel_0', type: 'visualization', id: 'absent' }] }), kibanaCfg);
check(kbMissing.prerequisites.some(p => p.label === 'Objets liés absents') && kbMissing.entries[0].verdict === 'review', 'panneau absent de l’export : signalé, jamais compté comme prêt');
check(E.kibanaInventory('{"type":"canvas-workpad","id":"c","attributes":{"name":"c"}}\n{"type":"osquery-pack","id":"o","attributes":{"name":"o"}}', kibanaCfg).entries.every(x => x.verdict === 'todo' || x.verdict === 'unrecognized'), 'Canvas et type inconnu : à reprendre ou non reconnu');
const kbBad = E.kibanaInventory('{"type":"search","id":"s","attributes":{"title":"s","kibanaSavedObjectMeta":{"searchSourceJSON":"{\\"query\\":{\\"query\\":\\"a:b not c:d\\",\\"language\\":\\"kuery\\"},\\"filter\\":[]}"}}}\nligne illisible', kibanaCfg);
check(kbBad.entries[0].verdict === 'todo' && kbBad.source.errors.length === 1, 'KQL invalide : à reprendre ; ligne illisible : signalée');

/* ---------- Tableaux de bord Grafana ---------- */
const gDash = JSON.stringify(grafanaOut.dashboard);
const gPanel = title => grafanaOut.dashboard.panels.find(p => p.title === title) || { targets: [] };
check(!/"elasticsearch"/.test(gDash) && !/DS_ELASTICSEARCH/.test(gDash) && grafanaOut.dashboard.__inputs.some(i => i.pluginId === 'grafana-clickhouse-datasource'), 'Grafana : plus aucune référence à Elasticsearch, entrée DS_CLICKHOUSE à l’import');
const gSeries = gPanel('Requêtes par service').targets[0];
check(gSeries.format === 0 && /WHERE \$__timeFilter_ms\(timestamp\)/.test(gSeries.rawSql) && /INTERVAL \$__interval_s SECOND/.test(gSeries.rawSql) && gSeries.rawSql.includes('$__conditionalAll(service.name IN (${service:singlequote}), $service)'), 'Grafana : $__timeFilter, $__interval_s et $__conditionalAll pour une variable « All »');
check(/FROM \$__fromTime_ms|toStartOfInterval\(\$__fromTime_ms/.test(gSeries.rawSql) && /\nORDER BY time, service_name$/.test(gSeries.rawSql), 'Grafana : tranches vides comblées sur la période du tableau de bord, résultat trié par temps');
check(JSON.stringify(gPanel('Requêtes par service').fieldConfig.overrides).includes('${__field.labels.service_name}'), 'Grafana : alias {{term service.name}} → nom d’affichage des séries');
const gMixed = gPanel('Requêtes × 1000 (expression)');
check(gMixed.datasource.uid === '-- Mixed --' && gMixed.targets[1].datasource.type === '__expr__' && gMixed.targets[1].expression === '$A * 1000', 'Grafana : expression du panneau mixte gardée telle quelle');
check(grafanaOut.report.panels.find(p => p.title === 'Pic de 5xx (ancienne alerte)').verdict === 'todo' && /Passerelle : à reprendre/.test(gPanel('Pic de 5xx (ancienne alerte)').description), 'Grafana : ancienne alerte de panneau à reprendre, signalée dans la description');
const gVar = grafanaOut.dashboard.templating.list.find(v => v.name === 'service');
check(gVar.query.editorType === 'sql' && /^SELECT valeur\n/.test(gVar.query.rawSql) && gVar.allValue === null && gVar.includeAll, 'Grafana : variable terms → SELECT d’une colonne, « All » géré par $__conditionalAll');
check(/fromUnixTimestamp64Milli|\$__fromTime_ms/.test(E.translateDSL(JSON.stringify({ size: 0, aggs: { t: { date_histogram: { field: '@timestamp', fixed_interval: '1h', min_doc_count: 0, extended_bounds: { min: '$__from', max: '$__to' } } } } }), E.DEFAULT_CONFIG, { grafana: true }).sql), 'Grafana : bornes $__from et $__to → macros du plugin');
check(/statut IN \(\$\{statut:singlequote\}\)/.test(E.translateDSL(JSON.stringify({ query: { term: { statut: '$statut' } } }), E.DEFAULT_CONFIG, { grafana: true }).sql) && /statut NOT IN/.test(E.translateDSL(JSON.stringify({ query: { bool: { must_not: { term: { statut: '$statut' } } } } }), E.DEFAULT_CONFIG, { grafana: true, variables: { statut: { includeAll: true } } }).sql), 'Grafana : égalité → IN, exclusion → NOT IN jamais levée par « All »');
check(/schéma v2/.test(E.grafanaDashboard(JSON.stringify({ apiVersion: 'dashboard.grafana.app/v2beta1', kind: 'Dashboard', spec: {} }), E.DEFAULT_CONFIG).error || ''), 'Grafana : schéma v2 refusé avec la marche à suivre');
const gNoIndex = E.grafanaDashboard(rd('examples/grafana/supervision_es.json'), grafanaCfg, {});
check(gNoIndex.report.notes.some(n => /Aucun index précisé/.test(n)), 'Grafana : sans --index, la table par défaut est signalée');
const unknownCol = E.translateDSL(JSON.stringify({ query: { term: { inconnue: 'x' } } }), grafanaCfg, { index: 'logs-web-*' });
check(E.verdictOf(unknownCol) === 'review' && unknownCol.notes.some(n => /absente du schéma/.test(n.title)), 'schéma déclaré : une colonne qu’il ne connaît pas est à vérifier, pas prête');

// Les fichiers du moteur et le serveur partagent une portée : un nom déclaré deux fois casserait le binaire
const declared = (engineSource() + rd('src/server.js')).match(/^(?:function|const|let|class) +[A-Za-z_$][\w$]*/gm).map(d => d.split(/ +/)[1]);
const twice = [...new Set(declared.filter((d, i) => declared.indexOf(d) !== i))];
check(!twice.length, 'aucun nom déclaré deux fois dans le binaire assemblé', twice.join(', '));

process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests passent.\n');
process.exit(failures ? 1 : 0);
