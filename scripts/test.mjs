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
import * as E from '../src/engine/index.js';
import { drift, playedByDifferential, playedByPipelines } from './couverture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.argv.includes('--update');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

// Éléments « à reprendre » attendus : le filtre ruby de batch.conf n’a pas d’équivalent automatique
const EXPECTED_TODO = { 'logstash/batch.conf': 1 };
const index = JSON.parse(rd('examples/index.json'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
};

// Exemples proposés par l’interface pour les autres sources : chacun doit se lire sans erreur
const SOURCES = {
  ingest: t => E.translateIngest([{ name: 'exemple', text: t }], E.DEFAULT_CONFIG),
  kibana: t => E.kibanaInventory(t, E.DEFAULT_CONFIG, {}),
  grafana: t => E.grafanaDashboard(t, E.DEFAULT_CONFIG, { index: 'logs-*' }),
  watcher: t => {
    const r = E.watcherTranslate(t, E.DEFAULT_CONFIG, {});
    return r.entries.length && !r.source.errors.length ? r : { error: r.source.errors[0] || 'aucune watch' };
  },
  schema: t => E.schemaFromElastic(t, E.DEFAULT_CONFIG, {}),
  analyzers: t => E.schemaFromElastic(t, E.DEFAULT_CONFIG, {})
};
for (const [kind, read] of Object.entries(SOURCES)) {
  for (const ex of index[kind] || []) {
    const r = read(rd(join('examples', ex.file)));
    check(
      !!r && !r.error && !r.empty,
      `exemple de l’interface (${kind}) : ${ex.file} se lit sans erreur`,
      r && (r.error || '')
    );
  }
}

/* ---------- Instantanés ---------- */
const snapshots = { total: 0, different: 0, seen: new Set() };
// En-tête d’un instantané : la couverture annoncée et les remarques « à vérifier » / « à reprendre »
function withHeader(r, mark) {
  const lines = [`${mark} Couverture : ${r.stats.ok} directs, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre`];
  for (const n of r.notes)
    if (n.level === 'warn' || n.level === 'err')
      lines.push(`${mark} ${n.level === 'err' ? 'À reprendre' : 'À vérifier'} : ${n.title}`);
  return lines.join('\n') + '\n\n';
}
function snapshot(rel, content) {
  const file = join(ROOT, 'tests/snapshots', rel);
  snapshots.total++;
  snapshots.seen.add(rel);
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return;
  }
  const expected = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (expected === content) return;
  snapshots.different++;
  if (expected === null) {
    check(false, `instantané ${rel}`, 'fichier absent');
    return;
  }
  const a = expected.split('\n');
  const b = content.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  check(
    false,
    `instantané ${rel}`,
    `ligne ${i + 1}\n    attendu : ${a[i] === undefined ? '(fin)' : a[i]}\n    obtenu  : ${b[i] === undefined ? '(fin)' : b[i]}`
  );
}

for (const [kind, list] of Object.entries(index).filter(([k]) => k === 'dsl' || k === 'ls')) {
  for (const ex of list) {
    const text = rd(join('examples', ex.file));
    const r =
      kind === 'dsl'
        ? E.translateDSL(text, E.DEFAULT_CONFIG, { index: 'logs-*' })
        : E.translateLogstash(text, E.DEFAULT_CONFIG);
    if (r.error || r.empty) {
      check(false, ex.file, r.error || 'résultat vide');
      continue;
    }
    const out = kind === 'dsl' ? r.sql : r.yaml + r.toml;
    const todo = EXPECTED_TODO[ex.file] || 0;
    check(
      r.stats.ko === todo,
      ex.file,
      `${r.stats.ok} directs, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre (attendu ${todo})`
    );
    check(!/password\s*[=:]\s*['"][^'"$]/i.test(out), `${ex.file} : aucun mot de passe en clair dans la sortie`);
    snapshot(
      `examples/${ex.file}.${kind === 'dsl' ? 'sql' : 'yaml'}`,
      kind === 'dsl' ? withHeader(r, '--') + r.sql + '\n' : withHeader(r, '#') + r.yaml
    );
  }
}

// Cas du banc différentiel : le SQL est figé ici, son résultat est comparé à Elasticsearch par « npm run test:diff »
const benchConfig = E.mergeConfig(E.DEFAULT_CONFIG, configOverride());
for (const c of CASES) {
  const r = E.translateDSL(JSON.stringify(c.dsl), c.config ? E.mergeConfig(benchConfig, c.config) : benchConfig, {
    index: INDEX
  });
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
  if (r.error) {
    snapshot(`pipelines/${c.id}.yaml`, `# Erreur : ${r.error}\n`);
    continue;
  }
  const own = Object.fromEntries(Object.entries(r.config.transforms).filter(([name]) => !isTransport(name)));
  snapshot(
    `pipelines/${c.id}.yaml`,
    withHeader(r, '#') + (Object.keys(own).length ? E.toYAML({ transforms: own }) : r.yaml).trimEnd() + '\n'
  );
}
// Inventaire Kibana des exemples : le rapport complet (verdicts, effort, SQL de chaque objet) est figé ici ;
// le banc ClickHouse (npm run test:clickhouse) exécute chacune de ses requêtes et contrôle des valeurs
const kibanaCfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/kibana/passerelle.yaml')));
const kibanaFiles = readdirSync(join(ROOT, 'examples/kibana'))
  .filter(n => n.endsWith('.ndjson'))
  .sort();
const kibanaInv = E.kibanaInventory(
  kibanaFiles.map(f => rd(`examples/kibana/${f}`)),
  kibanaCfg,
  { names: kibanaFiles }
);
snapshot('kibana/inventaire.md', E.inventoryMarkdown(kibanaInv));

// Tableau de bord Grafana de l’exemple : le tableau converti et son rapport sont figés ici ; le banc ClickHouse
// interpole et exécute chacune de ses requêtes
const grafanaCfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/grafana/passerelle.yaml')));
const grafanaOut = E.grafanaDashboard(rd('examples/grafana/supervision_es.json'), grafanaCfg, { index: 'logs-web-*' });
snapshot('grafana/supervision_es.clickhouse.json', JSON.stringify(grafanaOut.dashboard, null, 2) + '\n');
snapshot('grafana/supervision_es.rapport.md', E.grafanaReportMarkdown(grafanaOut, 'supervision_es.json'));

// Watches de l’exemple : le rapport (verdicts, planification, conditions, SQL de chaque watch) est figé ici ;
// le banc ClickHouse exécute chaque requête et contrôle la décision de chaque condition
const watcherCfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/watcher/passerelle.yaml')));
const watcherRep = E.watcherTranslate(
  [rd('examples/watcher/watches.json'), rd('examples/watcher/console.txt')],
  watcherCfg,
  { names: ['watches.json', 'console.txt'], origin: 'watches.json, console.txt' }
);
snapshot('watcher/rapport.md', E.watcherReportMarkdown(watcherRep));

// pipelines.yml : lecture, fichiers de path.config, liaisons pipeline { send_to }
{
  const yml = [
    '# commentaire',
    '- pipeline.id: "a # pas un commentaire"',
    '  pipeline.workers: 2 # commentaire',
    "  config.string: 'input { stdin {} } output { pipeline { send_to => [b] } }'",
    '- pipeline:',
    '    id: b',
    '    ecs_compatibility: disabled',
    '  config.string: |',
    '    input { pipeline { address => "b" } }',
    '',
    '    output { null {} }',
    '- pipeline.id: c',
    '  path.config: >-',
    '    /etc/logstash/conf.d/c/*.conf',
    '  queue.type: persisted'
  ].join('\n');
  const e = E.parsePipelinesYML(yml);
  check(
    e.length === 3 &&
      e[0].settings['pipeline.id'] === 'a # pas un commentaire' &&
      e[0].settings['pipeline.workers'] === 2,
    'pipelines.yml : liste de pipelines, guillemets, commentaires, nombres'
  );
  check(
    e[1].settings['pipeline.id'] === 'b' &&
      e[1].settings['pipeline.ecs_compatibility'] === 'disabled' &&
      e[1].settings['config.string'] === 'input { pipeline { address => "b" } }\n\noutput { null {} }\n',
    'pipelines.yml : tables imbriquées aplaties, bloc | avec ligne vide'
  );
  check(e[2].settings['path.config'] === '/etc/logstash/conf.d/c/*.conf', 'pipelines.yml : bloc >-');
  let bad = '';
  try {
    E.parsePipelinesYML('pipeline.id: x');
  } catch (err) {
    bad = err.message;
  }
  check(/ligne 1/.test(bad), 'pipelines.yml : une table seule est refusée avec sa ligne', bad);
  const files = [
    'conf.d/c/2.conf',
    'conf.d/c/1.conf',
    'conf.d/c/1.conf~',
    'conf.d/c/sous/3.conf',
    'web.conf',
    'd/x.conf'
  ];
  const f1 = E.pipelineConfigFiles('/etc/logstash/conf.d/c/*.conf', files);
  check(
    JSON.stringify(f1.files) === '["conf.d/c/1.conf","conf.d/c/2.conf"]' && f1.matched === 'conf.d/c/*.conf',
    'path.config absolu : retrouvé par sa fin, ordre alphabétique, sauvegardes ~ écartées',
    JSON.stringify(f1)
  );
  check(
    E.pipelineConfigFiles('/etc/logstash/web.conf', files).files[0] === 'web.conf',
    'path.config absolu : retrouvé par son seul nom'
  );
  check(
    JSON.stringify(E.pipelineConfigFiles('conf.d/c', files).files) === '["conf.d/c/1.conf","conf.d/c/2.conf"]',
    'path.config dossier : ses fichiers, sans les sous-dossiers'
  );
  check(
    E.pipelineConfigFiles('conf.d/**/*.conf', files).files.length === 3 &&
      E.pipelineConfigFiles('{web,d/x}.conf', files).files.length === 2,
    'path.config : motifs ** et {a,b}'
  );
  check(
    !E.pipelineConfigFiles('autre/*.conf', files).files.length,
    'path.config relatif introuvable : rien, pas de recherche par la fin'
  );
  const set = (...p) =>
    E.translatePipelines(
      p.map(([id, config]) => ({ id, config })),
      E.DEFAULT_CONFIG
    );
  const ok = set(
    ['a', 'input { stdin {} } output { if [x] { pipeline { send_to => ["b"] } } else { stdout {} } }'],
    ['b', 'input { pipeline { address => "b" } } filter { mutate { add_tag => ["b"] } } output { stdout {} }']
  );
  const bIn = Object.entries(ok.config.transforms).find(([n]) => n.startsWith('b_'));
  check(
    !ok.error && !!bIn && JSON.stringify(bIn[1].inputs) === '["a_routage.pipeline_b"]',
    'send_to sous condition : l’entrée du destinataire est la branche du routage',
    bIn && JSON.stringify(bIn[1].inputs)
  );
  check(
    !Object.values(ok.config.sources).some(x => x.type === '__pipeline') &&
      !Object.values(ok.config.sinks).some(x => x.type === '__pipeline'),
    'liaisons : aucun composant fictif dans la configuration'
  );
  check(
    Object.keys(ok.config.sinks).every(n => /^(a|b)_/.test(n)),
    'composants préfixés par l’identifiant du pipeline'
  );
  const lost = set(
    ['a', 'input { stdin {} } output { pipeline { send_to => ["nulle_part"] } stdout {} }'],
    ['b', 'input { pipeline { address => "seul" } } output { stdout {} }']
  );
  check(
    lost.notes.some(n => n.level === 'err' && /sans destinataire/.test(n.title)) &&
      lost.notes.some(n => n.level === 'err' && /sans expéditeur/.test(n.title)) &&
      !Object.keys(lost.config.sinks).some(n => n.startsWith('b_')),
    'adresse sans destinataire ou sans expéditeur : à reprendre, étapes orphelines retirées'
  );
  check(
    lost.pipelines.every(x => x.verdict === 'todo'),
    'liaison cassée : les deux pipelines sont à reprendre'
  );
  const loop = set(
    ['a', 'input { stdin {} pipeline { address => "a" } } output { pipeline { send_to => ["b"] } }'],
    ['b', 'input { pipeline { address => "b" } } output { pipeline { send_to => ["a"] } stdout {} }']
  );
  check(
    loop.notes.some(n => /Boucle entre pipelines/.test(n.title)),
    'boucle entre pipelines : signalée, Vector la refuserait'
  );
  const dup = set(
    ['a', 'input { stdin {} } output { stdout {} }'],
    ['a', 'input { stdin {} } output { stdout {} }'],
    ['c', 'input { pipeline { address => "x" } } output { stdout {} }'],
    ['d', 'input { pipeline { address => "x" } } output { stdout {} }']
  );
  check(
    dup.notes.some(n => /déclaré deux fois/.test(n.title)) && dup.notes.some(n => /plusieurs pipelines/.test(n.title)),
    'identifiant ou adresse en double : refusés comme par Logstash'
  );
  const alone = E.translateLogstash(
    'input { pipeline { address => "x" } } output { pipeline { send_to => ["y"] } }',
    E.DEFAULT_CONFIG
  );
  check(
    alone.notes.filter(n => n.level === 'err' && /pipelines\.yml/.test(n.detail)).length === 2,
    'fichier seul : entrée et sortie pipeline renvoient vers pipelines.yml'
  );
  const kafka = E.translatePipelines(
    [
      { id: 'a', config: 'input { kafka { topics => ["t1"] } } output { kafka { topic_id => "o1" } }' },
      { id: 'b', config: 'input { kafka { topics => ["t2"] } } output { kafka { topic_id => "o2" } }' }
    ],
    E.mergeConfig(E.DEFAULT_CONFIG, { kafka: { output_topic: 'force', input_topics: ['forcé'] } })
  );
  check(
    JSON.stringify(Object.values(kafka.config.sinks).map(x => x.topic)) === '["o1","o2"]' &&
      JSON.stringify(Object.values(kafka.config.sources).map(x => x.topics[0])) === '["t1","t2"]',
    'plusieurs entrées et sorties Kafka : output_topic et input_topics ne s’imposent pas à toutes'
  );
  const ex = rd('examples/logstash/pipelines/pipelines.yml');
  const exFiles = [
    'conf.d/entree.conf',
    'conf.d/systeme.conf',
    'conf.d/web/10-entree.conf',
    'conf.d/web/20-filtres.conf',
    'conf.d/web/30-sorties.conf'
  ];
  const exList = E.pipelinesFromYML(ex, exFiles, f => rd(`examples/logstash/pipelines/${f}`));
  const exR = E.translatePipelines(exList, E.DEFAULT_CONFIG);
  check(
    !exR.error &&
      exR.pipelines.length === 4 &&
      exR.pipelines.every(x => !x.error) &&
      !exR.notes.some(n => n.level === 'err'),
    'exemple pipelines.yml : quatre pipelines reliés, rien à reprendre',
    exR.sentence
  );
  snapshot('examples/logstash/pipelines.yaml', withHeader(exR, '#') + exR.yaml);
}
// Pipelines d’ingestion Elasticsearch : lecture, appel de pipeline, chemins, découpage en transforms
{
  const one = (text, name) => E.translateIngest([{ name: name || 'p', text }], E.DEFAULT_CONFIG);
  const vrlOf = r => r.pipelines.map(p => p.vrls.join('\n')).join('\n');
  const gen = n => ({
    name: 'long',
    text:
      'processors:\n' +
      Array.from(
        { length: n },
        (_, i) => `  - set:\n      field: champ_${i}.valeur\n      value: "{{ message }} ${i}"\n`
      ).join('')
  });
  const r1 = one('processors:\n  - set: { field: a.b, value: 1 }\n  - lowercase: { field: a.c }');
  check(
    !r1.error && r1.pipelines.length === 1 && r1.pipelines[0].verdict === 'ready' && r1.pipelines[0].chain.length === 1,
    'ingest : un pipeline court est un seul transform remap, prêt'
  );
  check(
    !!r1.config.transforms.aiguillage === false && !!r1.config.transforms.bilan && !!r1.config.sinks.echecs,
    'ingest : bilan des échecs et sortie dédiée'
  );
  const rj = one(JSON.stringify({ description: 'x', processors: [{ set: { field: 'a', value: 1 } }] }));
  const rc = one(
    'PUT _ingest/pipeline/mon-pipeline\n{ "processors": [ { "set": { "field": "a", "value": 1 } } ] }',
    'ignoré'
  );
  check(
    !rj.error && !rc.error && rc.pipelines[0].name === 'mon-pipeline',
    'ingest : JSON et requête PUT de la console Kibana lus, nom pris dans la requête',
    rc.error
  );
  const lit = one("processors:\n  - set: { field: a, value: 'x{{y' }");
  check(
    !lit.error && vrlOf(lit).includes('"x\\{{y"'),
    'ingest : « {{ » littéral dans une valeur est échappé, VRL l’interpolerait en silence',
    vrlOf(lit)
      .split('\n')
      .find(l => /x.*\{\{y/.test(l))
  );
  const bad = one(
    'processors:\n  - grok: { field: m, patterns: ["(?=a)%{WORD:w}"] }\n  - gsub: { field: m, pattern: "(?<=a)b", replacement: "c" }'
  );
  check(
    bad.pipelines[0].verdict === 'todo' && bad.notes.some(n => n.level === 'err' && /rétrospection/.test(n.detail)),
    'ingest : une rétrospection (?<=…) est à reprendre avec sa raison, pas un VRL qui ne compile pas',
    JSON.stringify(bad.notes.filter(n => n.level === 'err').map(n => n.detail))
  );
  // F99 : analyseurs personnalisés
  {
    const { ATTENDUS } = await import('../tests/clickhouse/analyseurs.cas.mjs');
    for (const [spec, texte, attendu] of ATTENDUS) {
      const r = E.anAnalyze(spec, texte);
      check(
        r.tokens && JSON.stringify(r.tokens.map(x => x.t)) === JSON.stringify(attendu),
        `analyseur : l’aperçu reproduit la documentation d’Elasticsearch (${JSON.stringify(spec).slice(0, 70)})`,
        r.error || JSON.stringify(r.tokens && r.tokens.map(x => x.t))
      );
    }
    const st = E.anAnalyze({ tokenizer: 'standard', filter: ['stemmer'] }, 'running');
    check(
      st.tokens === null && /pas d’aperçu/.test(st.error),
      'analyseur : un stemmer n’a pas d’aperçu, aucun mot n’est inventé'
    );
    const bad = E.anPlan({ tokenizer: 'pattern', filter: [] }, "'x'");
    check(bad.expr && bad.verdict === 'ready', 'analyseur : le tokenizer pattern par défaut a un plan exact');
    const la = E.anPlan({ tokenizer: { type: 'pattern', pattern: '(?<=a)b' } }, "'x'");
    check(
      la.expr === null && la.verdict === 'todo' && /anticipation/.test(la.notes[0].detail),
      'analyseur : une rétrospection est à reprendre avec sa raison'
    );
    const lang = E.anPlan('english', "'x'");
    check(
      lang.expr === null && lang.verdict === 'todo',
      'analyseur : un analyseur de langue prédéfini est à reprendre'
    );
    // elision : la casse suit articles_case (faux par défaut), un filtre défini exige ses articles, le filtre prédéfini ignore la casse
    const elis = (def, ref = 'x') => ({
      name: 'a',
      type: 'custom',
      tokenizer: 'standard',
      filter: [ref],
      definitions: { filter: def ? { x: def } : {} }
    });
    const el1 = E.anAnalyze(elis({ type: 'elision', articles: ['l'] }), 'L’avion l’oiseau');
    check(
      JSON.stringify(el1.tokens.map(x => x.t)) === JSON.stringify(['L’avion', 'oiseau']),
      'analyseur : elision sans articles_case distingue la casse (comme Elasticsearch)'
    );
    const el2 = E.anAnalyze(elis({ type: 'elision', articles: ['l'], articles_case: true }), 'L’avion l’oiseau');
    check(
      JSON.stringify(el2.tokens.map(x => x.t)) === JSON.stringify(['avion', 'oiseau']),
      'analyseur : elision avec articles_case: true ignore la casse'
    );
    check(
      /\(\?:l\)/.test(E.anPlan(elis({ type: 'elision', articles: ['l'] }), 'c').expr) &&
        /\(\?i:l\)/.test(E.anPlan(elis({ type: 'elision', articles: ['l'], articles_case: true }), 'c').expr),
      'analyseur : le plan de elision suit la même casse que l’aperçu'
    );
    check(
      E.anAnalyze(elis({ type: 'elision' }), 'L’avion').error &&
        E.anPlan(elis({ type: 'elision' }), 'c').verdict === 'todo',
      'analyseur : un filtre elision défini sans articles est refusé, comme par Elasticsearch'
    );
    check(
      JSON.stringify(E.anAnalyze(elis(null, 'elision'), 'QU’il').tokens.map(x => x.t)) === JSON.stringify(['il']),
      'analyseur : le filtre elision prédéfini retire les articles français sans tenir compte de la casse'
    );
    // stemmer : language, ou son ancien nom name ; une variante light_ ou minimal_ n’a pas d’équivalent
    const stemOf = def => (E.anPlan(elis(def), 'c').expr || '').match(/stem\(t, '(\w+)'\)/);
    check(
      stemOf({ type: 'stemmer', language: 'french' })[1] === 'fr' &&
        stemOf({ type: 'stemmer', name: 'german' })[1] === 'de' &&
        stemOf({ type: 'snowball', language: 'Spanish' })[1] === 'es',
      'analyseur : language et son alias name désignent la langue du stemmer'
    );
    check(
      stemOf({ type: 'stemmer', name: 'light_french' }) === null &&
        E.anPlan(elis({ type: 'stemmer', name: 'light_french' }), 'c').verdict === 'todo',
      'analyseur : light_french n’a pas d’équivalent, il n’est pas pris pour l’anglais'
    );
    // synonymes : la requête cherche les mots que la colonne stocke (le terme canonique), pas les synonymes développés de l’aperçu
    const sy = {
      name: 's',
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'sy'],
      definitions: { filter: { sy: { type: 'synonym', synonyms: ['tv, television'] } } }
    };
    const syq = E.anFieldPlan('t', 'titre', sy, 'Television').query;
    check(
      /'television'/.test(syq.match_and) === false ||
        /transform\(t, \['television'\], \['tv'\], t\)/.test(syq.match_and),
      'analyseur : la requête passe par la même expression que la colonne (synonymes ramenés à tv)'
    );
    check(
      JSON.stringify(syq.tokens) === JSON.stringify(['tv']),
      'analyseur : les mots de la requête sont ceux de la colonne'
    );
    const ex = rd('examples/analyseurs/catalogue.txt').trim();
    const sc = E.schemaFromElastic(ex, E.DEFAULT_CONFIG, {});
    const rep = E.anReport(sc.tables, 'Les téléviseurs d’été');
    check(
      rep.plans.length === 5 &&
        rep.plans.some(p => p.plan.field === 'titre.debut' && p.plan.column === 'titre') &&
        rep.plans.find(p => p.plan.field === 'tags').plan.expr.startsWith('arrayFlatten(arrayMap(v ->'),
      'analyseur : sous-champ calculé depuis sa colonne, valeurs multiples analysées une à une'
    );
    check(
      /idx_tags_text tags TYPE text\(tokenizer = splitByNonAlpha, preprocessor = lowerUTF8\(tags\)\)/.test(sc.sql),
      'schéma : l’index text d’une colonne Array(String) passe par preprocessor, pas par lowerUTF8'
    );
    snapshot('examples/analyseurs/catalogue.md', rep.markdown);
  }
  {
    const c2 = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG));
    c2.vector.elasticsearch_output = 'clickhouse';
    c2.clickhouse.index_mapping = { 'app-*': 'logs.app' };
    const ls = E.translateLogstash(
      'input { kafka { topics => ["a"] } }\noutput { elasticsearch { hosts => ["http://es:9200"] index => "app-events" action => "create" } }',
      c2,
      {}
    );
    check(
      ls.config.sinks.elasticsearch_out &&
        ls.config.sinks.elasticsearch_out.type === 'clickhouse' &&
        ls.config.sinks.elasticsearch_out.table === 'app' &&
        ls.config.transforms.elasticsearch_out_lignes,
      'F10 : une sortie elasticsearch devient un sink clickhouse précédé de sa mise en forme'
    );
    check(
      ls.notes.some(n => n.level === 'warn' && /action/.test(n.title)),
      'F10 : une option sans équivalent (action) est signalée'
    );
    const sk = ls.config.sinks.elasticsearch_out;
    check(
      sk.auth.user === '${CLICKHOUSE_USER}' &&
        ls.notes.some(n => n.level === 'warn' && /Compte d’écriture/.test(n.title)),
      'F10 : sans compte dédié, le puits prend clickhouse.user et le signale'
    );
    const c3 = JSON.parse(JSON.stringify(c2));
    c3.clickhouse.sink_user = '${CLICKHOUSE_SINK_USER}';
    c3.clickhouse.sink_password = '${CLICKHOUSE_SINK_PASSWORD}';
    const ls3 = E.translateLogstash(
      'input { kafka { topics => ["a"] } }\noutput { elasticsearch { hosts => ["http://es:9200"] index => "app-events" } }',
      c3,
      {}
    );
    check(
      ls3.config.sinks.elasticsearch_out.auth.user === '${CLICKHOUSE_SINK_USER}' &&
        ls3.env.includes('CLICKHOUSE_SINK_PASSWORD') &&
        !ls3.env.includes('CLICKHOUSE_USER') &&
        !ls3.notes.some(n => /Compte d’écriture/.test(n.title)),
      'F10 : le compte d’écriture dédié remplace clickhouse.user, sans avertissement'
    );
    const dyn = E.translateLogstash(
      'input { kafka { topics => ["a"] } }\noutput { elasticsearch { hosts => ["http://es:9200"] index => "%{idx}-%{+YYYY.MM.dd}" } }',
      c2,
      {}
    );
    check(
      /%clickhouse\.table/.test(dyn.yaml) &&
        dyn.config.sinks.elasticsearch_out.dangerously_allow_unconfined_template_resolution === true,
      'F10 : un index calculé choisit la table pour chaque événement'
    );
    const ig = E.translateIngest(
      [{ name: 'p', text: JSON.stringify({ processors: [{ set: { field: 'a', value: 1 } }] }) }],
      c2
    );
    check(
      ig.config.sinks.sortie.type === 'clickhouse' && ig.config.transforms.sortie_lignes,
      'F10 : la sortie d’un pipeline d’ingestion peut être ClickHouse'
    );
  }
  {
    const src =
      'boolean prive(String ip) { if (ip == null) { return false; } return ip.startsWith("10."); }\nString lib(boolean b) { return b ? "privee" : "publique"; }\nctx.net = lib(prive(ctx.ip));';
    const fn = E.translateIngest(
      [{ name: 'f', text: JSON.stringify({ processors: [{ script: { source: src } }] }) }],
      E.DEFAULT_CONFIG
    );
    check(
      fn.pipelines[0].verdict !== 'todo' && /privee/.test(fn.yaml),
      'ingest : les fonctions déclarées dans un script Painless sont recopiées sur place',
      JSON.stringify(fn.notes.filter(n => n.level === 'err').map(n => n.detail))
    );
    const rec = E.translateIngest(
      [
        {
          name: 'r',
          text: JSON.stringify({ processors: [{ script: { source: 'int f(int n) { return f(n); }\nctx.a = f(1);' } }] })
        }
      ],
      E.DEFAULT_CONFIG
    );
    check(
      rec.pipelines[0].verdict === 'review' && rec.notes.some(n => /récursion bornée/.test(n.title)),
      'ingest : une fonction récursive est recopiée sur des niveaux bornés, à vérifier'
    );
    const amb = E.translateIngest(
      [
        {
          name: 'a',
          text: JSON.stringify({
            processors: [{ script: { source: "def z = ctx.a;\nfor (def e : ctx.l) { z = e; }\nz.put('b', 1);" } }]
          })
        }
      ],
      E.DEFAULT_CONFIG
    );
    check(
      amb.pipelines[0].verdict === 'todo' && amb.notes.some(n => /objet différent selon le chemin/.test(n.detail)),
      'ingest : une variable rattachée à un objet différent selon les tours de boucle ne se modifie pas au hasard : à reprendre'
    );
    const alias = E.translateIngest(
      [{ name: 'a', text: JSON.stringify({ processors: [{ script: { source: "def x = ctx.a;\nx.put('b', 1);" } }] }) }],
      E.DEFAULT_CONFIG
    );
    check(
      /\.a = p_x/.test(alias.yaml),
      'ingest : def x = ctx.a puis x.put() modifie ctx.a (référence, pas copie)',
      alias.yaml
        .split('\n')
        .filter(l => /p_x/.test(l))
        .join(' | ')
    );
    const recCond = E.translateIngest(
      [
        {
          name: 'r',
          text: JSON.stringify({
            processors: [{ set: { field: 'a', value: 1, if: 'int f(int n) { return f(n); } f(1) == 1' } }]
          })
        }
      ],
      E.DEFAULT_CONFIG
    );
    check(
      recCond.pipelines[0].verdict === 'todo' && recCond.notes.some(n => /récursive/.test(n.detail)),
      'ingest : une fonction récursive dans une condition est à reprendre avec sa raison'
    );
  }
  {
    // TLS des sources qui écoutent
    const inp = o =>
      E.translateLogstash(`input { beats { port => 5044 ${o} } }\noutput { stdout { } }`, E.DEFAULT_CONFIG, {});
    const clair = inp('');
    check(
      clair.config.sources[Object.keys(clair.config.sources)[0]].tls === undefined &&
        E.verdictOf(clair) === 'review' &&
        clair.notes.some(n => n.level === 'warn' && /sans TLS/.test(n.title)),
      'TLS : une entrée beats en clair est signalée « à vérifier »'
    );
    const tlsOk = inp(
      'ssl_enabled => true ssl_certificate => "/c/a.crt" ssl_key => "/c/a.key" ssl_certificate_authorities => ["/c/ca.pem"] ssl_client_authentication => "required"'
    );
    const t1 = tlsOk.config.sources[Object.keys(tlsOk.config.sources)[0]].tls;
    check(
      t1 &&
        t1.enabled &&
        t1.crt_file === '/c/a.crt' &&
        t1.key_file === '/c/a.key' &&
        t1.ca_file === '/c/ca.pem' &&
        t1.verify_certificate === true &&
        !tlsOk.notes.some(n => n.level === 'warn' && /TLS/.test(n.title)),
      'TLS : certificat, clé, autorité et certificat client exigé repris sans remarque'
    );
    const opt = inp(
      'ssl_enabled => true ssl_certificate => "/c/a.crt" ssl_key => "/c/a.key" ssl_client_authentication => "optional" ssl_key_passphrase => "secret"'
    );
    const t2 = opt.config.sources[Object.keys(opt.config.sources)[0]].tls;
    check(
      t2.verify_certificate === true &&
        t2.key_pass === '${LOGSTASH_SSL_KEY_PASS}' &&
        !/secret/.test(opt.yaml) &&
        opt.notes.some(n => /Certificat client/.test(n.title)),
      'TLS : client optionnel signalé, phrase secrète lue dans une variable d’environnement'
    );
    const ks = inp('ssl_enabled => true ssl_keystore_path => "/c/k.p12"');
    check(
      ks.config.sources[Object.keys(ks.config.sources)[0]].tls.crt_file === '/etc/vector/certs/tls.crt' &&
        ks.notes.some(n => /certificat à fournir/.test(n.title)),
      'TLS : un magasin Java est signalé, chemins PEM à remplir'
    );
    const ig0 = E.translateIngest(
      [{ name: 'p', text: 'processors:\n  - set: { field: a, value: 1 }' }],
      E.DEFAULT_CONFIG
    );
    check(
      ig0.config.sources.agent_in.tls === undefined &&
        ig0.notes.some(n => n.level === 'warn' && /sans TLS/.test(n.title)),
      'TLS : la source Elastic Agent en clair est signalée'
    );
    const c4 = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG));
    c4.vector.ingest_source = {
      address: '10.0.0.5:5044',
      tls: { crt_file: '/c/a.crt', key_file: '/c/a.key', ca_file: '/c/ca.pem', verify_client: true }
    };
    const ig1 = E.translateIngest([{ name: 'p', text: 'processors:\n  - set: { field: a, value: 1 }' }], c4);
    const t3 = ig1.config.sources.agent_in;
    check(
      t3.address === '10.0.0.5:5044' &&
        t3.tls.enabled &&
        t3.tls.verify_certificate === true &&
        t3.tls.ca_file === '/c/ca.pem' &&
        !ig1.notes.some(n => /sans TLS/.test(n.title)),
      'TLS : source Elastic Agent avec certificat, adresse et certificat client configurés'
    );
  }
  const sub = E.translateIngest(
    [
      { name: 'haut', text: 'processors:\n  - pipeline: { name: bas }\n  - set: { field: z, value: 1 }' },
      { name: 'bas', text: 'processors:\n  - set: { field: y, value: 1 }' }
    ],
    E.DEFAULT_CONFIG
  );
  check(
    sub.pipelines.length === 1 &&
      sub.pipelines[0].name === 'haut' &&
      sub.pipelines[0].calls.includes('bas') &&
      /\.y = 1/.test(vrlOf(sub)),
    'ingest : un pipeline appelé est traduit en place, seul le pipeline principal a son transform'
  );
  const manquant = one('processors:\n  - pipeline: { name: absent }');
  check(
    manquant.pipelines[0].verdict === 'todo' && manquant.notes.some(n => /absent/.test(n.detail)),
    'ingest : pipeline appelé absent des fichiers : à reprendre'
  );
  const long = E.translateIngest([gen(400)], E.DEFAULT_CONFIG);
  const lp = long.pipelines[0];
  check(
    lp.chain.length > 1 && lp.vrls.every(v => v.length < 60000),
    'ingest : un pipeline long est coupé en plusieurs transforms de taille bornée',
    `${lp.chain.length} transforms`
  );
  check(
    lp.chain.every((id, k) => long.config.transforms[id].inputs[0] === (k ? lp.chain[k - 1] : 'agent_in')) &&
      long.config.transforms.bilan.inputs[0] === lp.chain[lp.chain.length - 1],
    'ingest : les transforms se suivent, le dernier alimente le bilan'
  );
  check(
    lp.vrls[0].includes('%ingest_etat = {') &&
      lp.vrls[1].includes('ok = bool!(%ingest_etat.ok)') &&
      lp.vrls[lp.vrls.length - 1].includes('del(%ingest_etat)'),
    'ingest : l’état passe d’un transform à l’autre par les métadonnées'
  );
  const fixtures = ['acces-web', 'navigateur'].map(n => ({ name: n, text: rd(`examples/ingest/${n}.yml`) }));
  const ex = E.translateIngest(fixtures, E.DEFAULT_CONFIG);
  check(
    !ex.error &&
      ex.pipelines.length === 1 &&
      ex.pipelines[0].verdict !== 'todo' &&
      !ex.notes.some(n => n.level === 'err'),
    'exemple ingest : un pipeline et son sous-pipeline, rien à reprendre',
    ex.sentence
  );
  snapshot('examples/ingest/acces-web.yaml', withHeader(ex, '#') + ex.yaml);
}
// Un instantané sans cas ni exemple correspondant est un reste : supprimé par --update, signalé sinon
for (const rel of readdirSync(join(ROOT, 'tests/snapshots'), { recursive: true }).map(p => p.split(sep).join('/'))) {
  if (!/\.(sql|yaml|md|json)$/.test(rel) || snapshots.seen.has(rel)) continue;
  if (UPDATE) rmSync(join(ROOT, 'tests/snapshots', rel));
  else {
    snapshots.different++;
    check(false, `instantané ${rel}`, 'aucun cas ni exemple ne lui correspond');
  }
}
if (!UPDATE)
  check(
    snapshots.different === 0,
    `${snapshots.total} instantanés comparés`,
    snapshots.different
      ? `${snapshots.different} différents (détail ci-dessus) ; si le changement est voulu : npm run test:update`
      : ''
  );
else process.stdout.write(`${snapshots.total} instantanés écrits dans tests/snapshots\n`);

/* ---------- Garde-fous ---------- */
const tr = dsl => E.translateDSL(JSON.stringify(dsl), benchConfig, { index: INDEX });
// Des conditions successives doublent le SQL à chaque « if » : le script doit être déclaré à reprendre, vite et sans SQL démesuré
const branchy =
  'def x = 0; ' +
  Array.from({ length: 30 }, (_, i) => `if (doc['a'].value > ${i}) { x = x + ${i}; }`).join(' ') +
  ' emit(x);';
const started = Date.now();
const capped = tr({
  size: 0,
  runtime_mappings: { r: { type: 'long', script: branchy } },
  aggs: { b: { terms: { field: 'r' } } }
});
check(
  capped.stats.ko === 1 && Date.now() - started < 2000 && capped.sql.length < 5000,
  'script Painless trop ramifié : déclaré à reprendre, sans explosion du SQL'
);
// Un nombre invalide est refusé, jamais recopié dans le SQL
check(/size/.test(tr({ size: '10; DROP TABLE x' }).error || ''), 'size invalide : traduction refusée');
const badInterval = tr({ size: 0, aggs: { h: { histogram: { field: 'latency_ms', interval: '1) + sleep(3' } } } });
check(
  badInterval.stats.ko === 1 && !/sleep/.test(badInterval.sql),
  'intervalle invalide : agrégation à reprendre, rien n’est recopié'
);
const badPoint = tr({ query: { geo_distance: { distance: '5km', loc: { lat: '0) OR 1=1 --', lon: 2 } } } });
check(/latitude/.test(badPoint.error || ''), 'coordonnée invalide : traduction refusée');
// geo_distance : une unité inconnue est refusée, comme par Elasticsearch, au lieu d’une distance nulle
check(
  /distance illisible/.test(
    tr({ query: { geo_distance: { distance: '3furlongs', loc: { lat: 48.8, lon: 2.3 } } } }).error || ''
  ),
  'geo_distance, unité inconnue : traduction refusée'
);
check(
  /<= 0\.4572$/m.test(tr({ query: { geo_distance: { distance: '1.5ft', loc: { lat: 48.8, lon: 2.3 } } } }).sql),
  'geo_distance : distance en mètres sans arrondi à l’entier'
);
// ids : la colonne est celle de field_mapping._id, comme pour term sur _id
const renamedId = E.mergeConfig(benchConfig, { clickhouse: { field_mapping: { _id: 'doc_id' } } });
check(
  /doc_id IN \('a', 'b'\)/.test(
    E.translateDSL(JSON.stringify({ query: { ids: { values: ['a', 'b'] } } }), renamedId, { index: INDEX }).sql
  ),
  'ids : colonne renommée par field_mapping._id'
);
// Une expression de date illisible est refusée, pas comparée comme une chaîne
check(
  /date non reconnue/.test(tr({ query: { range: { '@timestamp': { gte: 'now-1x' } } } }).error || ''),
  'date math illisible : traduction refusée'
);
// Avec timezone: UTC, les fonctions de date ne reçoivent pas de fuseau ; sans, il est explicite
const dated = {
  size: 0,
  query: { range: { '@timestamp': { gte: 'now-7d/d' } } },
  aggs: { d: { date_histogram: { field: '@timestamp', calendar_interval: 'day' } } }
};
const utcConfig = E.mergeConfig(benchConfig, { clickhouse: { timezone: 'UTC' } });
check(
  !/'UTC'/.test(E.translateDSL(JSON.stringify(dated), utcConfig, { index: INDEX }).sql) &&
    /toStartOfDay\(now\('UTC'\) - INTERVAL 7 DAY\)/.test(tr(dated).sql),
  'fuseau : explicite par défaut, omis avec timezone: UTC'
);
// Le README montre la sortie réelle du moteur pour son exemple « Avant, après »
const readme = rd('README.md');
const readmeOut = E.translateDSL(readme.match(/```json\n([\s\S]*?)```/)[1], E.DEFAULT_CONFIG, { index: 'logs-*' });
check(
  readmeOut.sql.replace(/^-- .*\n/, '').trim() === readme.match(/```sql\n([\s\S]*?)```/)[1].trim(),
  'README : le SQL de l’exemple est celui que produit le moteur'
);
// Sans schéma des colonnes, la traduction garde ses formes simples mais signale ce qui en dépend
const noSchema = E.mergeConfig(benchConfig, { clickhouse: { columns: {} } });
const blind = E.translateDSL(
  JSON.stringify({
    query: { bool: { must_not: [{ term: { env: 'staging' } }], filter: [{ exists: { field: 'user' } }] } }
  }),
  noSchema,
  { index: INDEX }
);
check(
  /env != 'staging'\n/.test(blind.sql) &&
    blind.notes.some(n => n.level === 'warn' && n.title === 'Schéma des colonnes non fourni'),
  'sans schéma : must_not et exists traduits simplement, avec une remarque « à vérifier »'
);
const blindDiv = E.translateDSL(
  JSON.stringify({
    size: 0,
    runtime_mappings: { t: { type: 'long', script: "emit(doc['latency_ms'].value / 100)" } },
    aggs: { b: { terms: { field: 't' } } }
  }),
  noSchema,
  { index: INDEX }
);
check(
  /latency_ms \/ 100/.test(blindDiv.sql) &&
    blindDiv.notes.some(n => n.level === 'warn' && n.title === 'Division dans un script'),
  'sans schéma : division Painless signalée, type des opérandes inconnu'
);
check(
  /intDiv\(latency_ms, 100\)/.test(
    tr({
      size: 0,
      runtime_mappings: { t: { type: 'long', script: "emit(doc['latency_ms'].value / 100)" } },
      aggs: { b: { terms: { field: 't' } } }
    }).sql
  ),
  'avec schéma : division de deux entiers traduite par intDiv'
);
// Une liste de 60 000 valeurs : ClickHouse refuse le SQL en clair (plus de 256 Kio), la liste nommée le garde court
const blacklist = {
  size: 0,
  query: { bool: { must_not: [{ terms: { host: Array.from({ length: 60000 }, (_, i) => `host-${i}`) } }] } },
  aggs: { s: { terms: { field: 'service' }, aggs: { e: { terms: { field: 'level' } } } } }
};
const inline = tr(blacklist);
check(
  inline.notes.some(n => n.level === 'warn' && n.title === 'Requête trop longue pour ClickHouse'),
  'longue liste en clair : requête de plus de 256 Kio signalée'
);
const named = E.translateDSL(
  JSON.stringify(blacklist),
  E.mergeConfig(benchConfig, { clickhouse: { lists: { threshold: 1000 } } }),
  { index: INDEX }
);
check(
  named.sql.length < 2000 &&
    named.lists.length === 1 &&
    named.lists[0].count === 60000 &&
    /host NOT IN \(SELECT value FROM logs\.passerelle_lists WHERE name = 'l_[0-9a-f]{12}'\)/.test(named.sql),
  'longue liste nommée : SQL court, une seule liste malgré ses deux emplois'
);
const shuffled = structuredClone(blacklist);
shuffled.query.bool.must_not[0].terms.host.reverse();
check(
  E.translateDSL(JSON.stringify(shuffled), E.mergeConfig(benchConfig, { clickhouse: { lists: { threshold: 1000 } } }), {
    index: INDEX
  }).lists[0].name === named.lists[0].name,
  'liste nommée : même nom quel que soit l’ordre des valeurs'
);
// Un nom de clause inconnu reste dans une chaîne SQL échappée
const odd = tr({ query: { "x') OR 1=1 --": {} } });
check(
  odd.stats.ko === 1 && odd.sql.includes("throwIf(1, 'Passerelle : x\\') OR 1=1 -- à traduire')"),
  'clause inconnue : nom échappé, requête arrêtée par throwIf'
);
// regexp insensible à la casse : les échappements sont respectés, et une classe non fermée n’est pas réparée en passant
const folded = v => tr({ query: { regexp: { host: { value: v, case_insensitive: true } } } }).sql;
check(
  folded('a\\[b[]x-zQ]+').includes('(?i)a\\\\[b(?-i:[]x-zqQ])+') && folded('web-[a').includes("'^(?:(?i)web-[a)$'"),
  'regexp insensible à la casse : échappements respectés, classe non fermée laissée telle quelle'
);
// query_string mal formée : à reprendre, comme Elasticsearch la refuse
for (const q of [
  'status:500) AND service:api',
  'status:(500',
  '(status:500',
  'status:500 OR OR status:404',
  '"connection reset',
  'status:[500 TO',
  'timeout AND'
]) {
  check(
    tr({ query: { query_string: { query: q } } }).stats.ko === 1,
    `query_string mal formée déclarée à reprendre : ${q}`
  );
}

// Les secrets passent par des variables d’environnement, jamais par la configuration générée
const ls = E.translateLogstash(rd('examples/logstash/routage.conf'), E.DEFAULT_CONFIG);
check(
  ls.yaml.includes("'${KAFKA_PASSWORD}'") && ls.env.includes('KAFKA_PASSWORD'),
  'routage.conf : identifiants Kafka référencés par variable d’environnement'
);
// Vector 0.57 et suivants : interpolation à demander, et pas de ${…} dans les commentaires, que Vector interpole aussi
check(
  /^# .*--dangerously-allow-env-var-interpolation/m.test(ls.yaml) && !/^#.*\$\{/m.test(ls.yaml),
  'routage.conf : en-tête qui demande l’interpolation, sans ${…} dans les commentaires'
);
// Topic tiré entièrement d’un champ : Vector 0.57 et suivants l’exigent explicitement
const topicDyn = E.translateLogstash('input { stdin {} } output { kafka { topic_id => "%{type}" } }', E.DEFAULT_CONFIG);
check(
  /topic: '\{\{ type \}\}'\n\s+dangerously_allow_unconfined_template_resolution: true/.test(topicDyn.yaml),
  'topic_id « %{type} » : dangerously_allow_unconfined_template_resolution posé'
);
// Le VRL de préparation suppose le namespace de logs : chaque source doit le déclarer, Kafka ou non
const everyInput =
  'input { kafka { topics => ["t"] } stdin { } file { path => "/var/log/app.log" } tcp { port => 5000 } udp { port => 5001 } http { port => 8080 } beats { port => 5044 } generator { } } output { stdout { } }';
const namespaced = cfg =>
  Object.values(E.translateLogstash(everyInput, cfg).config.sources).filter(s => s.log_namespace === true).length;
check(
  namespaced(E.DEFAULT_CONFIG) === 8 &&
    namespaced(E.mergeConfig(E.DEFAULT_CONFIG, { vector: { log_namespace: false } })) === 0,
  'entrées : chaque source déclare le namespace de logs que suppose le VRL généré'
);

/* ---------- Contrat de confiance : rien de faux annoncé comme juste ---------- */
const refused = (dsl, re) => {
  const r = tr(dsl);
  return E.verdictOf(r) === 'unrecognized' && re.test(r.error || '');
};
const guarded = (dsl, re) => {
  const r = tr(dsl);
  return E.verdictOf(r) === 'todo' && re.test(r.sql) && r.statements.every(s => /throwIf\(1, /.test(s.sql));
};
// Discover demande fields: ["*"] avec _source: false : toutes les colonnes, jamais une colonne nommée « * »
const discover = tr({
  _source: false,
  fields: [
    { field: '*', include_unmapped: 'true' },
    { field: '@timestamp', format: 'strict_date_optional_time' }
  ],
  stored_fields: ['*'],
  size: 5
});
check(
  /SELECT\n {4}\*\nFROM/.test(discover.sql) && !discover.sql.includes('`*`'),
  'fields ["*"] de Discover : SELECT *'
);
check(
  /COLUMNS\('\^http\\\\\.\.\*\$'\)/.test(tr({ _source: false, fields: ['http.*'] }).sql),
  'fields à motif : COLUMNS(regex)'
);
// _source excludes : un parent exclut ses sous-champs, un motif s’applique, includes ne fait pas oublier excludes
// (formes exécutées sur ClickHouse 26.9 : un nom absent dans EXCEPT (…) n’exclut rien, sans erreur)
const selected = src =>
  tr({ _source: src })
    .sql.match(/^SELECT\n([\s\S]*?)\nFROM/m)[1]
    .trim();
check(
  selected({ excludes: ['http'] }) === "* EXCEPT ('^(?:http)(?:\\\\..*)?$')",
  '_source excludes d’un parent : sous-champs exclus'
);
check(
  selected({ excludes: ['http.*'] }) === "* EXCEPT ('^(?:http\\\\..*)(?:\\\\..*)?$')",
  '_source excludes à motif : expression régulière'
);
check(
  selected({ includes: ['http.*'], excludes: ['http.body'] }) ===
    "COLUMNS('^http\\\\..*$') EXCEPT ('^(?:http\\\\.body)(?:\\\\..*)?$')",
  '_source includes et excludes à la fois : exclusions gardées'
);
check(
  selected({ includes: ['service', 'http.method'], excludes: 'http' }) === 'service',
  '_source excludes écrit en chaîne : champ inclus retiré'
);
// Clés inconnues : la requête est refusée, comme Elasticsearch la refuserait
check(refused({ qeury: { term: { service: 'api' } } }, /qeury/), 'clé inconnue du corps de recherche : refus');
check(
  refused({ query: { bool: { filtre: [{ term: { service: 'api' } }] } } }, /filtre/),
  'clé inconnue de bool : refus'
);
check(
  refused({ query: { term: { service: 'api' }, range: { status: { gte: 500 } } } }, /une clause par objet/),
  'deux clauses dans un objet : refus'
);
check(refused({ query: { term: { service: 'api', host: 'a' } } }, /un seul champ/), 'deux champs dans term : refus');
check(
  refused({ size: 0, aggs: { a: { terms: { field: 'service' }, avg: { field: 'latency_ms' } } } }, /deux types/),
  'deux types dans une agrégation : refus'
);
check(
  refused({ attributes: { title: 't' }, type: 'search', id: 'x' }, /Inspect/),
  'objet sauvegardé Kibana : refus qui dit quoi copier'
);
check(
  refused(
    JSON.parse('{"query":' + '{"bool":{"must":['.repeat(400) + '{"match_all":{}}' + ']}}'.repeat(400) + '}'),
    /imbriquée/
  ),
  'requête imbriquée à l’excès : refus, pas de pile épuisée'
);
// Paramètre inconnu ou option non traduite : à reprendre, et le SQL s’arrête sur throwIf
check(
  guarded({ size: 0, aggs: { a: { terms: { field: 'service', sise: 5 } } } }, /sise/),
  'paramètre inconnu d’agrégation : à reprendre, SQL arrêté'
);
check(
  guarded({ query: { term: { service: 'api' } }, knn: { field: 'v', query_vector: [1], k: 1 } }, /knn/),
  'knn : à reprendre, SQL arrêté'
);
check(
  guarded({ query: { match_bool_prefix: { message: { query: 'conn ref', operator: 'and' } } } }, /operator/),
  'option qui change le résultat sans être traduite : à reprendre'
);
check(
  E.verdictOf(tr({ query: { match: { message: { query: 'x', analyzer: 'french' } } } })) === 'review',
  'analyseur personnalisé : à vérifier'
);
const quiet = tr({ query: { term: { service: 'api' } }, highlight: { fields: { message: {} } }, version: true });
check(
  E.verdictOf(quiet) === 'ready' && quiet.notes.some(n => n.title === 'Options sans effet sur le résultat'),
  'options sans effet (highlight, version) : signalées, verdict inchangé'
);
check(
  E.coverage({ ok: 999, approx: 0, ko: 1 }).percent === 99,
  'couverture : 999 clauses sur 1 000 ne s’affichent pas 100 %'
);
// Modèles Watcher, Kibana et Grafana : paramètres ClickHouse
const watcher = tr({ size: 0, query: { range: { '@timestamp': { gte: '{{ctx.trigger.scheduled_time}}||-5m' } } } });
check(
  E.verdictOf(watcher) === 'ready' &&
    watcher.sql.includes("parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE") &&
    watcher.parameters[0].source === '{{ctx.trigger.scheduled_time}}',
  'modèle Watcher : paramètre {scheduled_time:String}'
);
const grafana = tr({
  size: 0,
  query: {
    bool: {
      filter: [
        { range: { '@timestamp': { gte: '$timeFrom', format: 'epoch_millis' } } },
        { query_string: { query: 'service:$service' } }
      ]
    }
  }
});
check(
  grafana.sql.includes('fromUnixTimestamp64Milli(toInt64({timeFrom:String}))') &&
    grafana.sql.includes('service = {service:String}'),
  'variables Grafana : bornes epoch_millis et valeurs en paramètres'
);
check(
  guarded({ query: { match: { message: '{{ctx.payload.word}}' } } }, /modèle « \{\{ctx\.payload\.word\}\} »/),
  'modèle dans une recherche plein texte : à reprendre'
);
// Analyse Lucene : une longue liste de OR ne doit pas épuiser la pile
const longOr = tr({
  query: { query_string: { query: Array.from({ length: 20000 }, (_, i) => `host:h${i}`).join(' OR ') } }
});
check(!longOr.error && longOr.stats.ko === 0, 'query_string de 20 000 OR : traduite');
check(
  tr({ query: { query_string: { query: '('.repeat(5000) + 'a' + ')'.repeat(5000) } } }).stats.ko === 1,
  'query_string imbriquée à l’excès : à reprendre, pas de pile épuisée'
);

// Sortie elasticsearch : identifiants en variables, index tiré d’un champ, data stream
const esOut = E.translateLogstash(
  'input { stdin {} } output { elasticsearch { hosts => ["es:9200"] index => "%{[@metadata][index]}-%{+YYYY.MM.dd}" user => "elastic" password => "changeme" ssl_enabled => true cacert => "/etc/ca.pem" } }',
  E.DEFAULT_CONFIG
);
check(
  !esOut.yaml.includes('changeme') &&
    esOut.yaml.includes("password: '${ELASTICSEARCH_PASSWORD}'") &&
    esOut.env.includes('ELASTICSEARCH_PASSWORD'),
  'sortie elasticsearch : mot de passe lu dans une variable, jamais recopié'
);
check(
  /dangerously_allow_unconfined_template_resolution: true/.test(esOut.yaml) &&
    /endpoints: \[https:\/\/es:9200\]/.test(esOut.yaml) &&
    /ca_file: \/etc\/ca\.pem/.test(esOut.yaml),
  'sortie elasticsearch : index tiré d’un champ autorisé, HTTPS et autorité de certification'
);
const dsOut = E.translateLogstash(
  'input { stdin {} } output { elasticsearch { hosts => ["https://es:9200"] data_stream => "true" data_stream_dataset => "nginx" api_key => "${ES_API_KEY}" } }',
  E.DEFAULT_CONFIG
);
check(
  /mode: data_stream/.test(dsOut.yaml) &&
    /dataset: nginx/.test(dsOut.yaml) &&
    dsOut.yaml.includes("Authorization: 'ApiKey ${ES_API_KEY}'"),
  'sortie elasticsearch : data stream et clé d’API'
);
const upd = E.translateLogstash(
  'input { stdin {} } output { elasticsearch { action => "update" doc_as_upsert => true } }',
  E.DEFAULT_CONFIG
);
check(E.verdictOf(upd) === 'todo', 'sortie elasticsearch : mise à jour de documents à reprendre');
check(
  E.verdictOf(
    E.translateLogstash(
      'input { stdin {} } output { file { path => "/tmp/x" flush_interval => 0 inconnue => 1 } }',
      E.DEFAULT_CONFIG
    )
  ) === 'review',
  'option de sortie non reprise : à vérifier'
);
check(
  /imbrication/.test(
    E.translateLogstash(
      'input { stdin {} } filter { ' +
        'if [a] { '.repeat(500) +
        'drop {}' +
        ' }'.repeat(500) +
        ' } output { stdout {} }',
      E.DEFAULT_CONFIG
    ).error || ''
  ),
  'pipeline imbriqué à l’excès : refus, pas de pile épuisée'
);

/* ---------- KQL : la grammaire et les conversions de Kibana (kbn-es-query) ---------- */
const KQL_TYPES = { status: 'number', host: 'keyword', '@timestamp': 'date', message: 'text', service: 'keyword' };
const kql = (q, fields) => {
  const issues = [];
  try {
    return { dsl: E.kqlTranslate(q, { fieldType: f => KQL_TYPES[f] || null, fields: fields || [], issues }), issues };
  } catch (e) {
    return { error: e.message, issues };
  }
};
const kqlIs = (q, expected, label, fields) => {
  const r = kql(q, fields);
  const ok = JSON.stringify(r.dsl) === JSON.stringify(expected);
  check(ok, `KQL ${label}`, ok ? '' : r.error || JSON.stringify(r.dsl));
};
kqlIs(
  'message: connexion refusée',
  { match: { message: 'connexion refusée' } },
  'valeur sans guillemets à plusieurs mots : match, pas une phrase'
);
kqlIs(
  'message: "connexion refusée"',
  { match_phrase: { message: 'connexion refusée' } },
  'valeur entre guillemets : match_phrase'
);
kqlIs(
  'host:a or host:b and not status >= 500',
  {
    bool: {
      should: [
        { term: { host: { value: 'a' } } },
        {
          bool: {
            filter: [{ term: { host: { value: 'b' } } }, { bool: { must_not: { range: { status: { gte: 500 } } } } }]
          }
        }
      ],
      minimum_should_match: 1
    }
  },
  'priorité : not, puis and, puis or'
);
kqlIs('NOT host:a', { bool: { must_not: { term: { host: { value: 'a' } } } } }, 'mots-clés sans distinction de casse');
kqlIs('message: cannot', { match: { message: 'cannot' } }, '« not » dans un mot n’est pas un mot-clé');
kqlIs('host: *', { exists: { field: 'host' } }, 'champ: * vaut exists');
kqlIs('*:*', { match_all: {} }, '*:* vaut tous les documents');
kqlIs('host: web-*', { wildcard: { host: { value: 'web-*' } } }, 'joker sur un keyword : wildcard');
kqlIs('host: "web-*"', { term: { host: { value: 'web-*' } } }, 'joker entre guillemets : caractère ordinaire');
kqlIs(
  '@timestamp: "2026-01-01"',
  { range: { '@timestamp': { gte: '2026-01-01', lte: '2026-01-01' } } },
  'valeur sur un champ date : plage [valeur, valeur]'
);
kqlIs(
  'service: (a or b)',
  {
    bool: {
      should: [{ term: { service: { value: 'a' } } }, { term: { service: { value: 'b' } } }],
      minimum_should_match: 1
    }
  },
  'liste de valeurs sur un champ'
);
kqlIs(
  'items:{ name: x and qty > 2 }',
  {
    nested: {
      path: 'items',
      query: { bool: { filter: [{ match: { 'items.name': 'x' } }, { range: { 'items.qty': { gt: 2 } } }] } },
      score_mode: 'none'
    }
  },
  'requête imbriquée (nested)'
);
kqlIs(
  'http.*: 500',
  {
    bool: {
      should: [{ match: { 'http.method': '500' } }, { match: { 'http.status': '500' } }],
      minimum_should_match: 1
    }
  },
  'champ à motif : les champs connus qui y correspondent',
  ['http.method', 'http.status', 'host']
);
check(
  kql('connexion').issues.some(i => i.kind === 'review'),
  'KQL sans nom de champ : multi_match, à vérifier'
);
check(
  /fin de requête attendue/.test(kql('a:b not c:d').error || ''),
  'KQL « a:b not c:d » refusé, comme Kibana le refuse'
);
check(
  /valeur attendue/.test(kql('url: \\/admin').error || ''),
  'KQL échappement inconnu refusé, comme Kibana le refuse'
);
check(
  /imbriquée/.test(kql('('.repeat(100) + 'a:b' + ')'.repeat(100)).error || ''),
  'KQL imbriqué à l’excès : refus, pas de pile épuisée'
);

/* ---------- Inventaire Kibana : rien de faux annoncé comme juste ---------- */
const kbEntry = title => kibanaInv.entries.find(x => x.title === title) || { issues: [], queries: [] };
check(
  kbEntry('Carte des sessions (Vega)').verdict === 'todo' && kbEntry('Enquête délais d’attente').verdict === 'todo',
  'Vega et ES|QL : à reprendre, jamais traduits en silence'
);
check(
  kbEntry('Erreurs : aujourd’hui contre hier').issues.some(i => /décalage temporel/.test(i.label)),
  'Lens, décalage temporel (time shift) : à reprendre'
);
check(kbEntry('Supervision du site web').verdict === 'todo', 'tableau de bord : verdict de son plus mauvais panneau');
const byValue = kibanaInv.entries.find(x => x.parent && x.title === 'Codes d’erreur');
check(
  byValue &&
    /service\.environment = 'production'/.test(byValue.queries[0].sql) &&
    /`?url\.path`? != '\/health'/.test(byValue.queries[0].sql),
  'panneau par valeur : requête et filtres du tableau de bord inclus'
);
check(
  kibanaInv.summary.effort.hours === kibanaInv.entries.reduce((n, x) => n + x.effort, 0),
  'effort total : somme des objets, chaque objet compté une fois'
);
const kbTsvb = kbEntry('Débit sortant par hôte (TSVB)');
check(
  /ORDER BY sum\(`?http\.response\.bytes`?\) DESC/.test(kbTsvb.queries[0].sql),
  'TSVB trié par une mesure : la mesure est recalculée sous le terms, comme dans TSVB'
);
check(
  kbEntry('Latence moyenne et p95 par heure').queries[0].sql.includes("'Europe/Paris'"),
  'fuseau de Kibana (dateFormat:tz exporté) : tranches dans ce fuseau'
);
const kbNoTz = E.kibanaInventory(
  rd('examples/kibana/supervision_web.ndjson')
    .split('\n')
    .filter(l => !/"type":"config"/.test(l))
    .join('\n'),
  kibanaCfg
);
check(
  kbNoTz.entries.find(x => x.title === 'Latence moyenne et p95 par heure').verdict === 'ready' &&
    kbNoTz.entries.find(x => x.title === 'Requêtes par service').issues.some(i => i.label === 'intervalle automatique'),
  'sans fuseau exporté : tranches horaires exactes, intervalle automatique signalé'
);
const kbDay = E.kibanaInventory(
  JSON.stringify({
    type: 'visualization',
    id: 'v',
    attributes: {
      title: 'jour',
      visState: JSON.stringify({
        type: 'line',
        aggs: [
          { id: '1', type: 'count', schema: 'metric' },
          { id: '2', type: 'date_histogram', params: { field: '@timestamp', interval: 'd' }, schema: 'segment' }
        ]
      }),
      kibanaSavedObjectMeta: { searchSourceJSON: '{}' }
    }
  }),
  kibanaCfg
);
check(
  kbDay.entries[0].issues.some(i => /fuseau/.test(i.label)),
  'tranches de jours sans fuseau connu : à vérifier (Kibana découpe dans le fuseau du navigateur)'
);
const kbMissing = E.kibanaInventory(
  JSON.stringify({
    type: 'dashboard',
    id: 'd',
    attributes: {
      title: 'd',
      panelsJSON: JSON.stringify([{ panelIndex: '1', panelRefName: 'panel_0', type: 'visualization' }]),
      kibanaSavedObjectMeta: { searchSourceJSON: '{}' }
    },
    references: [{ name: 'panel_0', type: 'visualization', id: 'absent' }]
  }),
  kibanaCfg
);
check(
  kbMissing.prerequisites.some(p => p.label === 'Objets liés absents') && kbMissing.entries[0].verdict === 'review',
  'panneau absent de l’export : signalé, jamais compté comme prêt'
);
check(
  E.kibanaInventory(
    '{"type":"canvas-workpad","id":"c","attributes":{"name":"c"}}\n{"type":"osquery-pack","id":"o","attributes":{"name":"o"}}',
    kibanaCfg
  ).entries.every(x => x.verdict === 'todo' || x.verdict === 'unrecognized'),
  'Canvas et type inconnu : à reprendre ou non reconnu'
);
const kbBad = E.kibanaInventory(
  '{"type":"search","id":"s","attributes":{"title":"s","kibanaSavedObjectMeta":{"searchSourceJSON":"{\\"query\\":{\\"query\\":\\"a:b not c:d\\",\\"language\\":\\"kuery\\"},\\"filter\\":[]}"}}}\nligne illisible',
  kibanaCfg
);
check(
  kbBad.entries[0].verdict === 'todo' && kbBad.source.errors.length === 1,
  'KQL invalide : à reprendre ; ligne illisible : signalée'
);

/* ---------- Tableaux de bord Kibana 9.4+ : nouveaux noms de panneaux, forme de l’API, sections ---------- */
check(
  Object.keys(E.KB_PANEL_ALIASES).length === 21 && new Set(Object.values(E.KB_PANEL_ALIASES)).size === 21,
  'panneaux 9.4+ : les 21 types renommés par Kibana ont chacun leur ancien nom'
);
check(
  E.kbPanelType('legacy_vis') === 'visualization' &&
    E.kbPanelType('vis') === 'lens' &&
    E.kbPanelType('discover_session') === 'search' &&
    E.kbPanelType('visualization') === 'visualization' &&
    E.kbPanelType('constructor') === 'constructor' &&
    E.kbPanelType(undefined) === undefined,
  'panneaux 9.4+ : nom canonique, ancien nom inchangé, type forgé ou absent laissé tel quel'
);
const kbWeb = rd('examples/kibana/supervision_web.ndjson');
const kbOldNames = Object.fromEntries(Object.entries(E.KB_PANEL_ALIASES).map(([nouveau, ancien]) => [ancien, nouveau]));
// Le tableau de bord de l’exemple, ses panneaux transformés par `mutate(objet, panneaux)`
const kbWebWith = mutate =>
  kbWeb
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const o = JSON.parse(l);
      return JSON.stringify(o.type === 'dashboard' ? mutate(o, JSON.parse(o.attributes.panelsJSON)) : o);
    })
    .join('\n');
const kbSig = text =>
  JSON.stringify(
    E.kibanaInventory(text, kibanaCfg, {}).entries.map(x => [
      x.key,
      x.verdict,
      x.effort,
      x.queries.map(q => [q.title, q.verdict, q.sql])
    ])
  );
const kbRef = kbSig(kbWeb);
check(
  JSON.parse(kbRef).reduce((n, x) => n + x[3].length, 0) >= 19,
  'panneaux 9.4+ : la comparaison porte sur toutes les requêtes de l’exemple'
);
// Lens : un terms trié sur une colonne « comptage filtré » trie sur « filtre » (« filtre._count » est refusé dans un tri)
{
  const lensFiltre = kbWeb
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const o = JSON.parse(l);
      if (o.type === 'lens' && o.id.endsWith('l001')) {
        const colonne = o.attributes.state.datasourceStates.formBased.layers.lay1.columns['c-count'];
        delete colonne.timeScale;
        colonne.filter = { query: 'http.response.status_code >= 500', language: 'kuery' };
        colonne.label = 'Erreurs';
      }
      return JSON.stringify(o);
    })
    .join('\n');
  const entree = E.kibanaInventory(lensFiltre, kibanaCfg, {}).entries.find(
    x => x.title === 'Requêtes par seconde et par méthode'
  );
  const sql = entree ? entree.queries.map(q => q.sql).join('\n') : '';
  check(
    entree &&
      entree.verdict !== 'todo' &&
      /ORDER BY periode ASC, filtre_Erreurs_doc_count DESC, http_request_method ASC/.test(sql),
    'Lens, tri des groupes sur un comptage filtré : trié sur le nombre de documents du filtre, pas « à reprendre »',
    sql
  );
}
// Forme stockée, panneaux sous leurs nouveaux noms (legacy_vis, vis, discover_session…)
const kbStored = kbWebWith((o, panels) => {
  o.attributes.panelsJSON = JSON.stringify(
    panels.map(p => Object.assign({}, p, { type: kbOldNames[p.type] || p.type }))
  );
  return o;
});
// Types des panneaux du tableau de bord de test (le mot « lens » reste dans les attributs d’un panneau Lens par valeur)
const kbPanelTypes = new Set(
  JSON.parse(
    kbStored
      .split('\n')
      .map(l => JSON.parse(l))
      .find(o => o.type === 'dashboard').attributes.panelsJSON
  ).map(p => p.type)
);
check(
  ['legacy_vis', 'vis', 'discover_session'].every(t => kbPanelTypes.has(t)) &&
    ['visualization', 'lens', 'search'].every(t => !kbPanelTypes.has(t)),
  'panneaux 9.4+ : le tableau de bord de test ne porte plus que les nouveaux noms'
);
check(
  kbSig(kbStored) === kbRef,
  'panneaux 9.4+ (nouveaux noms) : SQL, verdicts et effort identiques à ceux de l’export 8.x'
);
// Forme de l’API : { type, grid, id, config }, références dans config.ref_id, une section qui range des panneaux
const kbApi = kbWebWith((o, panels) => {
  const refs = o.references;
  const toApi = p => {
    const { gridData, panelIndex, embeddableConfig, panelRefName } = p;
    const config = Object.assign({}, embeddableConfig);
    if (panelRefName) config.ref_id = refs.find(r => r.name === `${panelIndex}:${panelRefName}`).id;
    return {
      type: kbOldNames[p.type] || p.type,
      grid: { x: gridData.x, y: gridData.y, w: gridData.w, h: gridData.h },
      id: panelIndex,
      config
    };
  };
  const list = panels.map(toApi);
  delete o.attributes.panelsJSON;
  o.attributes.panels = [
    ...list.slice(0, 3),
    { title: 'Détails', collapsed: false, grid: { y: 99 }, id: 'sec1', panels: list.slice(3) }
  ];
  o.references = refs.filter(r => !/:panel_/.test(r.name));
  return o;
});
const kbApiDash = E.kibanaInventory(kbApi, kibanaCfg, {}).entries.find(x => x.type === 'dashboard');
check(
  kbSig(kbApi) === kbRef && kbApiDash.panels === 11 && kbApiDash.children.length === 11,
  'forme de l’API (type, grid, id, config) avec une section : mêmes panneaux, même SQL, section aplatie'
);
check(
  !kbApiDash.issues.some(i => /absent de l’export/.test(i.label)),
  'forme de l’API : l’id d’un panneau n’est pas pris pour celui d’un objet absent de l’export'
);
// Cas synthétiques : un export réduit à ce que le cas demande
const kbObjs = (...list) => list.map(o => JSON.stringify(o)).join('\n');
const kbSearch = (id, title) => ({
  type: 'search',
  id,
  attributes: {
    title,
    kibanaSavedObjectMeta: {
      searchSourceJSON: JSON.stringify({ query: { query: 'a:b', language: 'kuery' }, filter: [] })
    }
  }
});
const kbDashOf = (panels, refs) => ({
  type: 'dashboard',
  id: 'd9',
  attributes: { title: 'Tableau 9.x', panels, kibanaSavedObjectMeta: { searchSourceJSON: '{}' } },
  references: refs || []
});
const kbRun = (...list) => E.kibanaInventory(kbObjs(...list), kibanaCfg, {});
// Panneaux qui citent un objet : savedObjectId et ref_id dans la configuration, id et type de la forme 6.x
const kbCited = kbRun(
  kbSearch('s1', 'Recherche S1'),
  kbSearch('s2', 'Recherche S2'),
  kbSearch('s3', 'Recherche S3'),
  kbDashOf(
    [
      { type: 'discover_session', panelIndex: 'a', gridData: { i: 'a' }, embeddableConfig: { savedObjectId: 's1' } },
      { type: 'discover_session', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'b', config: { ref_id: 's2' } },
      { type: 'search', panelIndex: 'c', gridData: { i: 'c' }, id: 's3', version: '6.5.0', embeddableConfig: {} },
      { type: 'discover_session', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'd', config: { ref_id: 'absente' } }
    ],
    []
  )
);
const kbCitedDash = kbCited.entries.find(x => x.type === 'dashboard');
check(
  ['search:s1', 'search:s2', 'search:s3'].every(k => kbCitedDash.children.includes(k)),
  'panneau qui cite un objet : savedObjectId, ref_id (API) et id + type (6.x) sont résolus'
);
check(
  kbCitedDash.issues.filter(i => /absent de l’export/.test(i.label)).length === 1 &&
    /search absente/.test(kbCitedDash.issues.find(i => /absent de l’export/.test(i.label)).detail),
  'panneau dont l’objet cité manque : toujours signalé « absent de l’export », jamais compté comme prêt'
);
// Contenu illisible d’un type connu : à reprendre, jamais « non reconnu »
const kbUnread = kbRun(
  kbDashOf([
    {
      type: 'vis',
      grid: { x: 0, y: 0, w: 24, h: 10 },
      id: 'p1',
      config: { title: 'Lens aplati', type: 'xy', layers: [] }
    },
    { type: 'legacy_vis', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'p2', config: { title: 'Visualisation plate' } },
    { type: 'discover_session', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'p3', config: { title: 'Session plate' } },
    { type: 'slo_overview', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'p4', config: { title: 'SLO' } },
    { type: 'constructor', grid: { x: 0, y: 0, w: 24, h: 10 }, id: 'p5', config: { title: 'Forgé' } }
  ])
);
const kbU = title =>
  kbUnread.entries.find(x => x.title === title) || { verdict: '?', type: '?', issues: [{ label: '', detail: '' }] };
check(
  ['Lens aplati', 'Visualisation plate', 'Session plate'].every(t => kbU(t).verdict === 'todo'),
  'vis, legacy_vis et discover_session sans contenu lisible : à reprendre, pas « non reconnu »'
);
check(
  /panneau Lens au format non lu/.test(kbU('Lens aplati').issues[0].label) &&
    /attributes/.test(kbU('Lens aplati').issues[0].detail) &&
    kbU('Lens aplati').type === 'lens',
  'Lens au format aplati de l’API : remarque claire, objet rangé comme Lens'
);
check(
  kbU('SLO').verdict === 'unrecognized' &&
    kbU('SLO').issues[0].label === 'panneau slo_overview' &&
    kbU('Forgé').verdict === 'unrecognized',
  'type de panneau sans traduction (ou forgé) : « non reconnu », sous le nom écrit dans le fichier'
);
// Visualisation par valeur bâtie sur une recherche enregistrée (savedSearchId)
const kbOnSearch = kbRun(
  kbSearch('s1', 'Recherche S1'),
  kbDashOf([
    {
      type: 'legacy_vis',
      panelIndex: 'g1',
      gridData: { i: 'g1' },
      embeddableConfig: {
        savedVis: {
          title: 'Depuis une recherche',
          type: 'line',
          params: {},
          data: { aggs: [{ id: '1', type: 'count', schema: 'metric' }], searchSource: {}, savedSearchId: 's1' }
        }
      }
    }
  ])
);
const kbOnS = kbOnSearch.entries.find(x => x.title === 'Depuis une recherche');
check(
  kbOnS &&
    /depuis une recherche/.test(kbOnS.kind) &&
    !kbOnS.issues.some(i => /recherche enregistrée absente/.test(i.label)),
  'visualisation par valeur : savedSearchId lu, requête de la recherche enregistrée reprise'
);
// Objets markdown et vega enregistrés sous leur propre type
const kbTop = kbRun(
  { type: 'markdown', id: 'm1', attributes: { title: 'Mode d’emploi' } },
  { type: 'vega', id: 'v1', attributes: { title: 'Carte Vega' } },
  kbDashOf(
    [
      { type: 'legacy_vis', panelIndex: 'pm', gridData: { i: 'pm' }, panelRefName: 'panel_pm', embeddableConfig: {} },
      { type: 'legacy_vis', panelIndex: 'pv', gridData: { i: 'pv' }, panelRefName: 'panel_pv', embeddableConfig: {} }
    ],
    [
      { name: 'pm:panel_pm', type: 'markdown', id: 'm1' },
      { name: 'pv:panel_pv', type: 'vega', id: 'v1' }
    ]
  )
);
const kbMd = kbTop.entries.find(x => x.key === 'markdown:m1');
const kbVg = kbTop.entries.find(x => x.key === 'vega:v1');
const kbTopDash = kbTop.entries.find(x => x.type === 'dashboard');
check(
  kbMd &&
    kbMd.type === 'visualization' &&
    kbMd.verdict === 'ready' &&
    kbVg &&
    kbVg.type === 'visualization' &&
    kbVg.verdict === 'todo',
  'objets markdown et vega de premier niveau : lus comme des visualisations (Markdown prêt, Vega à reprendre)'
);
check(
  kbTopDash.children.includes('markdown:m1') &&
    kbTopDash.children.includes('vega:v1') &&
    kbTopDash.verdict === 'todo' &&
    !kbTop.entries.some(x => x.verdict === 'unrecognized'),
  'tableau de bord qui cite ces objets : enfants reliés, verdict du plus mauvais panneau, rien de « non reconnu »'
);

/* ---------- Contrôles des tableaux de bord Kibana 9.4+ (pinned_panels) ---------- */
// Les deux contrôles de l’exemple (controlGroupInput, 8.x), rangés comme Kibana 9.4+ les stocke ou les sert par l’API
const kbCtlOld = o => JSON.parse(o.attributes.controlGroupInput.panelsJSON);
const kbCtlNewType = { optionsListControl: 'options_list_control', rangeSliderControl: 'range_slider_control' };
const kbCtlConfig = c => {
  const cfg = Object.assign({}, c.explicitInput);
  delete cfg.id;
  delete cfg.enhancements;
  return cfg;
};
// Stocké : { pinned_panels: { panels: { <id>: { order, grow, width, type, config } } } }, références préfixées par l’id
const kbPinnedStored = kbWebWith(o => {
  const panels = {};
  for (const [id, c] of Object.entries(kbCtlOld(o)))
    panels[id] = { order: c.order, grow: c.grow, width: c.width, type: kbCtlNewType[c.type], config: kbCtlConfig(c) };
  delete o.attributes.controlGroupInput;
  o.attributes.pinned_panels = { panels };
  o.references = o.references.map(r => Object.assign({}, r, { name: r.name.replace(/^controlGroup_/, '') }));
  return o;
});
// API : une liste { id, type, config } en snake_case, la vue de données citée par son identifiant (data_view_id)
const kbPinnedApi = kbWebWith(o => {
  const viewOf = Object.fromEntries(
    o.references.filter(r => /^controlGroup_/.test(r.name)).map(r => [r.name.split(':')[0].slice(13), r.id])
  );
  o.attributes.pinned_panels = Object.entries(kbCtlOld(o)).map(([id, c]) => ({
    id,
    type: kbCtlNewType[c.type],
    config: Object.fromEntries(
      Object.entries(Object.assign({ dataViewId: viewOf[id] }, kbCtlConfig(c))).map(([k, v]) => [
        k.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`),
        v
      ])
    )
  }));
  delete o.attributes.controlGroupInput;
  o.references = o.references.filter(r => !/^controlGroup_/.test(r.name));
  return o;
});
const kbCtlOf = text => E.kibanaInventory(text, kibanaCfg, {}).entries.find(x => x.type === 'dashboard');
check(
  kbCtlOf(kbWeb).controls === 2 && kbCtlOf(kbWeb).queries.filter(q => /^Contrôle/.test(q.title)).length === 2,
  'contrôles de l’exemple (controlGroupInput) : deux contrôles, deux requêtes'
);
check(
  kbCtlOf(kbPinnedStored).controls === 2 && kbSig(kbPinnedStored) === kbRef,
  'contrôles 9.4+ (pinned_panels stocké, options_list_control…) : mêmes requêtes et mêmes verdicts que controlGroupInput'
);
check(
  kbCtlOf(kbPinnedApi).controls === 2 && kbSig(kbPinnedApi) === kbRef,
  'contrôles 9.4+ (liste de l’API, snake_case, data_view_id) : mêmes requêtes et mêmes verdicts que controlGroupInput'
);
// Cas synthétiques : un tableau de bord réduit à ses contrôles
const kbCtlView = {
  type: 'index-pattern',
  id: 'dv1',
  attributes: { title: 'logs-web*', timeFieldName: '@timestamp', fields: '[]' }
};
const kbPinnedDash = (pinned, refs) => {
  const d = kbDashOf([], refs);
  d.attributes.pinned_panels = pinned;
  return d;
};
const kbCtlRun = (pinned, refs) => {
  const d = E.kibanaInventory(kbObjs(kbCtlView, kbPinnedDash(pinned, refs)), kibanaCfg, {}).entries.find(
    x => x.type === 'dashboard'
  );
  return { d, queries: d.queries.map(q => q.title), labels: d.issues.map(i => `${i.kind}:${i.label}`) };
};
const kbCtlMixed = kbCtlRun({
  panels: {
    a: { order: 2, type: 'time_slider_control', config: {} },
    b: {
      order: 0,
      type: 'esql_control',
      config: { variable_name: 'hote', esql_query: 'FROM logs-* | STATS BY host.name', title: 'Hôte' }
    },
    c: {
      order: 1,
      type: 'options_list_control',
      config: { data_view_id: 'dv1', field_name: 'service.name', title: 'Service' }
    },
    d: { order: 3, type: 'future_control', config: { field_name: 'x', title: 'Futur' } },
    e: { order: 4, type: 'options_list_control', config: { data_view_id: 'dv1', title: 'Sans champ' } },
    f: {
      order: 5,
      type: 'options_list_control',
      config: { data_view_id: 'dv1', field_name: 'host.name', title: 'Source ES|QL', values_source: 'esql' }
    }
  }
});
check(
  kbCtlMixed.d.controls === 6 && kbCtlMixed.queries.length === 1 && kbCtlMixed.queries[0] === 'Contrôle « Service »',
  'contrôles 9.4+ : tous comptés, seule la liste d’options sur un champ donne une requête'
);
check(
  kbCtlMixed.labels.includes('review:curseur de temps') &&
    kbCtlMixed.labels.includes('todo:contrôle ES|QL « Hôte »') &&
    kbCtlMixed.labels.includes('todo:contrôle ES|QL « Source ES|QL »'),
  'contrôles 9.4+ : curseur de temps, contrôle ES|QL et liste dont les valeurs viennent d’ES|QL sont signalés'
);
const kbCtlEsql = kbCtlMixed.d.issues.find(i => i.label === 'contrôle ES|QL « Hôte »');
check(
  /Variable : hote\./.test(kbCtlEsql.detail) && /STATS BY host\.name/.test(kbCtlEsql.detail),
  'contrôle ES|QL : la variable et la requête sont reprises dans la remarque'
);
check(
  kbCtlMixed.labels.includes('todo:contrôle future_control') &&
    kbCtlMixed.labels.includes('review:contrôle « Sans champ » sans champ lisible'),
  'contrôle de type inconnu ou sans champ : signalé sous son nom, jamais perdu en silence'
);
check(
  kbCtlMixed.d.issues.findIndex(i => /contrôle ES\|QL « Hôte »/.test(i.label)) <
    kbCtlMixed.d.issues.findIndex(i => /curseur de temps/.test(i.label)),
  'contrôles 9.4+ : lus dans l’ordre de « order », pas dans celui du fichier'
);
// Vue de données retrouvée par une référence : nom donné dans la configuration, suffixe connu, ou préfixe de l’identifiant
const kbCtlViaRef = (config, refName) =>
  kbCtlRun({ panels: { c1: { type: 'options_list_control', config: Object.assign({ title: 'Service' }, config) } } }, [
    { name: refName, type: 'index-pattern', id: 'dv1' }
  ]).d.queries[0].pattern;
check(
  kbCtlViaRef(
    { field_name: 'service.name', data_view_ref_name: 'c1:optionsListDataView' },
    'c1:optionsListDataView'
  ) === 'logs-web*' &&
    kbCtlViaRef({ fieldName: 'service.name', dataViewRefName: 'maVue' }, 'c1:maVue') === 'logs-web*' &&
    kbCtlViaRef({ fieldName: 'service.name' }, 'c1:optionsListControlDataView') === 'logs-web*' &&
    kbCtlViaRef({ fieldName: 'service.name' }, 'c1:nomInattendu') === 'logs-web*',
  'contrôles 9.4+ : la vue de données se retrouve par son nom de référence (configuration, suffixe connu, préfixe de l’id)'
);
check(
  kbCtlRun({}).d.controls === undefined &&
    kbCtlRun({ panels: {} }).d.controls === undefined &&
    kbCtlRun({ panels: { x: 'illisible' } }).d.controls === undefined,
  'contrôles : un pinned_panels vide ou illisible ne crée aucun contrôle'
);

/* ---------- Agrégations des visualisations Kibana (visState) : regroupements, mesures, pipelines frères ---------- */
// Une visualisation par agrégations sur la vue « logs-web-* » de l’exemple (table logs.web), traduite avec sa configuration
const kbVView = {
  type: 'index-pattern',
  id: 'dv1',
  attributes: { title: 'logs-web-*', timeFieldName: '@timestamp', fields: '[]' }
};
const kbVis = (title, type, aggs) => ({
  type: 'visualization',
  id: title,
  attributes: {
    title,
    visState: JSON.stringify({ title, type, params: {}, aggs }),
    kibanaSavedObjectMeta: {
      searchSourceJSON: JSON.stringify({
        indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        query: { query: '', language: 'kuery' },
        filter: []
      })
    }
  },
  references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'dv1' }]
});
const kbVRun = (...list) =>
  E.kibanaInventory(kbObjs(kbVView, ...list), kibanaCfg, {}).entries.filter(x => x.type === 'visualization');
const kbVOne = vis => kbVRun(vis)[0];
const kbVSql = e => e.queries.map(q => q.sql).join('\n');
const kbVLabels = e => e.issues.map(i => `${i.kind}:${i.label}`);
const kbVCount = { id: '1', enabled: true, type: 'count', schema: 'metric' };
const kbVTerms = (id, field, orderBy) => ({
  id,
  enabled: true,
  type: 'terms',
  schema: 'bucket',
  params: { field, size: 3, orderBy, order: 'desc' }
});
const kbVFiltered = (id, query, metric) => ({
  id,
  enabled: true,
  type: 'filtered_metric',
  schema: 'metric',
  params: {
    customBucket: {
      id: `${id}-filter`,
      enabled: true,
      type: 'filter',
      params: { filter: { query, language: 'kuery' } },
      schema: 'bucket'
    },
    customMetric: Object.assign({ id: `${id}-metric`, enabled: true, schema: 'metric' }, metric)
  }
});
const kbVSibling = (type, bucket, metric) => ({
  id: '1',
  enabled: true,
  type,
  schema: 'metric',
  params: {
    customBucket: Object.assign({ id: '1-bucket', enabled: true, schema: 'bucketAgg' }, bucket),
    customMetric: Object.assign({ id: '1-metric', enabled: true, schema: 'metricAgg' }, metric)
  }
});
const kbVAvgDuration = { type: 'avg', params: { field: 'event.duration' } };
const kbVByService = { type: 'terms', params: { field: 'service.name', size: 5, orderBy: '_key', order: 'desc' } };
const kbVByHour = { type: 'date_histogram', params: { field: '@timestamp', interval: '1h', min_doc_count: 1 } };

// Regroupements : jamais lus comme des mesures
const kbVFilter = kbVOne(
  kbVis('Filtre', 'histogram', [
    kbVCount,
    {
      id: '2',
      enabled: true,
      type: 'filter',
      schema: 'segment',
      params: { filter: { query: 'service.name:api', language: 'kuery' } }
    },
    kbVTerms('3', 'host.name', '_key')
  ])
);
check(
  kbVFilter.verdict === 'ready' &&
    !kbVLabels(kbVFilter).some(l => /mesure/.test(l)) &&
    /AND service\.name = 'api'\nGROUP BY host_name/.test(kbVSql(kbVFilter)),
  'visualisation : un regroupement « filter » devient une condition du SQL, pas une « mesure sans traduction »'
);
const kbVSamplers = kbVRun(
  kbVis('Echantillon', 'table', [
    kbVCount,
    { id: '2', enabled: true, type: 'sampler', schema: 'bucket', params: { shard_size: 500 } },
    kbVTerms('3', 'host.name', '_key')
  ]),
  kbVis('Echantillon diversifié', 'table', [
    kbVCount,
    {
      id: '2',
      enabled: true,
      type: 'diversified_sampler',
      schema: 'bucket',
      params: { shard_size: 500, field: 'host.name', max_docs_per_value: 2 }
    },
    kbVTerms('3', 'service.name', '_key')
  ])
);
check(
  kbVSamplers.every(
    e =>
      e.verdict === 'review' &&
      !kbVLabels(e).some(l => /mesure/.test(l)) &&
      /GROUP BY (host|service)_name/.test(kbVSql(e)) &&
      e.queries[0].notes.some(n => /sampler ignoré/.test(n.title || n.label || ''))
  ),
  'visualisation : sampler et diversified_sampler sont des regroupements, traduits sans l’échantillonnage et à vérifier'
);
const kbVUnknownBuckets = kbVRun(
  kbVis('IP', 'table', [
    kbVCount,
    {
      id: '2',
      enabled: true,
      type: 'ip_prefix',
      schema: 'bucket',
      params: { field: 'source.ip', ipPrefix: { prefix_length: 16 } }
    }
  ]),
  kbVis('Séries', 'table', [kbVCount, { id: '2', enabled: true, type: 'time_series', schema: 'bucket', params: {} }])
);
check(
  kbVUnknownBuckets.every(e => e.verdict === 'todo') &&
    kbVLabels(kbVUnknownBuckets.find(e => e.title === 'IP')).includes('todo:regroupement ip_prefix') &&
    kbVLabels(kbVUnknownBuckets.find(e => e.title === 'Séries')).includes('todo:regroupement time_series') &&
    kbVUnknownBuckets.every(e => !kbVLabels(e).some(l => /mesure/.test(l))),
  'visualisation : ip_prefix et time_series sont reconnus comme regroupements, à reprendre sous leur nom exact'
);

// Mesures : filtered_metric et single_percentile_rank
const kbVFiltAvg = kbVOne(
  kbVis('Mesure filtrée', 'table', [
    kbVFiltered('1', 'http.response.status_code >= 500', kbVAvgDuration),
    kbVFiltered('2', 'event.outcome:failure', { type: 'count', params: {} }),
    kbVTerms('3', 'service.name', '_key')
  ])
);
check(
  kbVFiltAvg.verdict === 'ready' &&
    kbVLabels(kbVFiltAvg).length === 0 &&
    kbVSql(kbVFiltAvg).includes(
      'avgIfOrNull(event.duration, http.response.status_code >= 500) AS filtre_avg_event_duration'
    ) &&
    kbVSql(kbVFiltAvg).includes('countIf(http.response.status_code >= 500) AS filtre_doc_count') &&
    kbVSql(kbVFiltAvg).includes("countIf(event.outcome = 'failure') AS filtre_2_doc_count"),
  'visualisation : filtered_metric (moyenne et comptage) → avgIf et countIf dans la même passe, une colonne par mesure'
);
const kbVFiltBad = kbVRun(
  kbVis('Sans filtre', 'table', [
    {
      id: '1',
      enabled: true,
      type: 'filtered_metric',
      schema: 'metric',
      params: { customMetric: { id: '1-metric', type: 'count' } }
    }
  ]),
  kbVis('Mesure interne refusée', 'table', [kbVFiltered('1', 'a:b', { type: 'geo_bounds', params: { field: 'geo' } })])
);
// L’inventaire trie les objets par titre : on les retrouve par leur titre, pas par leur rang
const kbVBad = title => kbVFiltBad.find(e => e.title === title);
check(
  kbVBad('Sans filtre').verdict === 'todo' &&
    kbVLabels(kbVBad('Sans filtre')).includes('todo:mesure filtered_metric illisible') &&
    kbVBad('Mesure interne refusée').verdict === 'todo' &&
    kbVLabels(kbVBad('Mesure interne refusée')).includes('todo:mesure geo_bounds'),
  'visualisation : filtered_metric sans filtre ou dont la mesure est refusée → à reprendre, avec la raison'
);
const kbVOrdered = kbVOne(
  kbVis('Tri sur mesure filtrée', 'table', [
    kbVFiltered('1', 'http.response.status_code >= 500', kbVAvgDuration),
    kbVTerms('3', 'service.name', '1')
  ])
);
check(
  kbVOrdered.verdict === 'ready' &&
    kbVLabels(kbVOrdered).length === 0 &&
    /ORDER BY filtre_avg_event_duration DESC NULLS FIRST, service_name ASC/.test(kbVSql(kbVOrdered)),
  'visualisation : tri sur une mesure filtrée → sur la colonne de la mesure, sans remarque'
);
const kbVOrderedCount = kbVOne(
  kbVis('Tri sur un comptage filtré', 'table', [
    kbVFiltered('1', 'event.outcome:failure', { type: 'count', params: {} }),
    kbVTerms('3', 'service.name', '1')
  ])
);
check(
  kbVLabels(kbVOrderedCount).length === 0 &&
    /ORDER BY filtre_doc_count DESC, service_name ASC/.test(kbVSql(kbVOrderedCount)),
  'visualisation : tri sur un comptage filtré → sur le nombre de documents du filtre'
);
const kbVOrderedCustom = kbVOne(
  kbVis('Tri personnalisé', 'table', [
    kbVCount,
    {
      id: '3',
      enabled: true,
      type: 'terms',
      schema: 'bucket',
      params: {
        field: 'service.name',
        size: 3,
        order: 'asc',
        orderBy: 'custom',
        orderAgg: kbVFiltered('3-orderAgg', 'event.outcome:failure', {
          type: 'max',
          params: { field: 'event.duration' }
        })
      }
    }
  ])
);
check(
  kbVLabels(kbVOrderedCustom).length === 0 &&
    /ORDER BY filtre_max_event_duration ASC NULLS FIRST, service_name ASC/.test(kbVSql(kbVOrderedCustom)),
  'visualisation : tri personnalisé sur une mesure filtrée → la mesure est calculée, un groupe vide suit Elasticsearch'
);
const kbVOrderedParent = kbVOne(
  kbVis('Tri du niveau parent', 'table', [
    kbVFiltered('1', 'http.response.status_code >= 500', kbVAvgDuration),
    kbVTerms('3', 'service.name', '1'),
    kbVTerms('4', 'host.name', '_key')
  ])
);
check(
  kbVOrderedParent.verdict === 'ready' &&
    /ORDER BY filtre_avg_event_duration DESC NULLS FIRST, service_name ASC/.test(kbVSql(kbVOrderedParent)) &&
    /ORDER BY avgIfOrNull\(event\.duration, http\.response\.status_code >= 500\) DESC NULLS FIRST, service_name ASC\n\s+LIMIT 3/.test(
      kbVSql(kbVOrderedParent)
    ),
  'visualisation : mesure qui trie un niveau parent → calculée aussi sur ce niveau, et le top N la lit (jamais de colonne absente)'
);
const kbVOrderedPlainParent = kbVOne(
  kbVis('Tri du niveau parent, mesure simple', 'table', [
    { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'event.duration' } },
    { id: '2', enabled: true, type: 'max', schema: 'metric', params: { field: 'event.duration' } },
    kbVTerms('3', 'service.name', '2'),
    kbVTerms('4', 'host.name', '2')
  ])
);
check(
  kbVOrderedPlainParent.verdict === 'ready' &&
    /ORDER BY max\(event\.duration\) DESC, service_name ASC\n\s+LIMIT 3/.test(kbVSql(kbVOrderedPlainParent)) &&
    /avg\(event\.duration\) AS avg_event_duration,\n\s+max\(event\.duration\) AS max_event_duration\nFROM[^;]*GROUP BY service_name, host_name/.test(
      kbVSql(kbVOrderedPlainParent)
    ),
  'visualisation : mesure simple qui trie un niveau parent → même chose, et les mesures du dernier niveau gardent leur rang'
);
const kbVPercentile = (type, params) =>
  kbVOne(
    kbVis('Centile', 'table', [
      { id: '2', enabled: true, type, schema: 'metric', params: { field: 'event.duration', ...params } },
      kbVTerms('3', 'service.name', '2')
    ])
  );
check(
  /ORDER BY median_event_duration\[1\] DESC/.test(kbVSql(kbVPercentile('median', {}))) &&
    /ORDER BY single_percentile_event_duration\[1\] DESC/.test(
      kbVSql(kbVPercentile('single_percentile', { percentile: 95 }))
    ) &&
    /ORDER BY single_percentile_event_duration\[1\] DESC/.test(
      kbVSql(kbVPercentile('single_percentile', { percentile: 99.9 }))
    ) &&
    /ORDER BY percentiles_event_duration\[2\] DESC/.test(
      kbVSql(kbVPercentile('percentiles', { percents: [25, 50, 75] }))
    ),
  'visualisation : tri sur un centile → l’élément du tableau qui porte ce centile'
);
const kbVRank = (value, orderBy) =>
  kbVOne(
    kbVis('Rang', 'table', [
      {
        id: '2',
        enabled: true,
        type: 'single_percentile_rank',
        schema: 'metric',
        params: { field: 'event.duration', value }
      },
      kbVTerms('3', 'service.name', orderBy)
    ])
  );
const kbVRankInt = kbVRank(500, '_key');
check(
  kbVRankInt.verdict === 'ready' &&
    kbVSql(kbVRankInt).includes(
      'round(100 * countIf(event.duration <= 500) / count(event.duration), 3) AS single_percentile_rank_event_duration_500'
    ),
  'visualisation : single_percentile_rank → rang du centile (part des documents sous la valeur)'
);
check(
  /ORDER BY single_percentile_rank_event_duration_500 DESC, service_name ASC/.test(kbVSql(kbVRank(500, '2'))) &&
    kbVLabels(kbVRank(500, '2')).length === 0,
  'visualisation : tri sur un rang de centile entier → colonne du rang'
);
check(
  /ORDER BY single_percentile_rank_event_duration_99_5 DESC, service_name ASC/.test(kbVSql(kbVRank(99.5, '2'))) &&
    kbVLabels(kbVRank(99.5, '2')).length === 0 &&
    kbVLabels(kbVRank('', '_key')).includes('todo:mesure single_percentile_rank sans valeur') &&
    kbVRank('', '_key').verdict === 'todo',
  'visualisation : tri sur un rang de centile non entier → colonne du rang ; sans valeur → à reprendre'
);

// Pipelines frères : moyenne, somme, minimum, maximum des groupes d’un regroupement personnalisé
const kbVSiblings = [
  ['avg_bucket', kbVByHour, { type: 'count', params: {} }, /SELECT\n {4}avg\(doc_count\) AS avg_bucket\nFROM \(/],
  ['sum_bucket', kbVByService, kbVAvgDuration, /sum\(avg_event_duration\) AS sum_bucket/],
  [
    'min_bucket',
    kbVByService,
    kbVAvgDuration,
    /min\(avg_event_duration\) AS min_bucket,\n {4}argMin\(service_name, avg_event_duration\) AS min_bucket_key/
  ],
  [
    'max_bucket',
    kbVByHour,
    { type: 'count', params: {} },
    /max\(doc_count\) AS max_bucket,\n {4}argMax\(periode, doc_count\) AS max_bucket_key/
  ]
].map(([type, bucket, metric, re]) => [type, re, kbVOne(kbVis(type, 'metric', [kbVSibling(type, bucket, metric)]))]);
check(
  kbVSiblings.every(
    ([, re, e]) => e.verdict === 'ready' && kbVLabels(e).length === 0 && e.queries.length === 1 && re.test(kbVSql(e))
  ),
  'visualisation : avg_bucket, sum_bucket, min_bucket et max_bucket → SQL du pipeline sur les groupes, sans « à reprendre »'
);
const kbVNested = kbVOne(
  kbVis('Pipeline sous un regroupement', 'table', [
    kbVSibling('sum_bucket', kbVByHour, { type: 'count', params: {} }),
    kbVTerms('2', 'host.name', '_key')
  ])
);
check(
  kbVNested.verdict === 'todo' &&
    kbVLabels(kbVNested).includes('todo:pipeline sum_bucket sous un regroupement') &&
    /GROUP BY host_name, periode/.test(kbVSql(kbVNested)),
  'visualisation : pipeline frère sous un autre regroupement → à reprendre, le SQL des groupes est produit'
);
const kbVSiblingBad = kbVOne(
  kbVis('Pipeline sans regroupement', 'metric', [
    {
      id: '1',
      enabled: true,
      type: 'avg_bucket',
      schema: 'metric',
      params: { customMetric: { id: '1-metric', type: 'count' } }
    }
  ])
);
check(
  kbVSiblingBad.verdict === 'todo' && kbVLabels(kbVSiblingBad).includes('todo:pipeline avg_bucket'),
  'visualisation : pipeline frère sans regroupement lisible → à reprendre'
);
const kbVParent = kbVOne(
  kbVis('Dérivée d’une mesure filtrée', 'line', [
    kbVFiltered('1', 'a:b', kbVAvgDuration),
    { id: '2', enabled: true, type: 'derivative', schema: 'metric', params: { metricAgg: '1' } },
    {
      id: '3',
      enabled: true,
      type: 'date_histogram',
      schema: 'segment',
      params: { field: '@timestamp', interval: '1h' }
    }
  ])
);
check(
  !kbVLabels(kbVParent).some(l => l.startsWith('todo:')) &&
    /filtre_avg_event_duration - lagInFrame\(toNullable\(filtre_avg_event_duration\), 1\) OVER/.test(kbVSql(kbVParent)),
  'visualisation : dérivée d’une mesure filtrée → sur la colonne de la mesure'
);
const kbVParentCount = kbVOne(
  kbVis('Cumul d’un comptage filtré', 'line', [
    kbVFiltered('1', 'a:b', { type: 'count', params: {} }),
    { id: '2', enabled: true, type: 'cumulative_sum', schema: 'metric', params: { metricAgg: '1' } },
    {
      id: '3',
      enabled: true,
      type: 'date_histogram',
      schema: 'segment',
      params: { field: '@timestamp', interval: '1h' }
    }
  ])
);
check(
  !kbVLabels(kbVParentCount).some(l => l.startsWith('todo:')) &&
    /sum\(filtre_doc_count\) OVER/.test(kbVSql(kbVParentCount)),
  'visualisation : cumul d’un comptage filtré → sur le nombre de documents du filtre'
);

/* ---------- Chemins vers une sous-agrégation (tri et pipelines) ---------- */
const chemin = (dsl, cfg) => E.translateDSL(JSON.stringify(dsl), cfg || E.DEFAULT_CONFIG, { index: 'logs' });
const chAvg = { avg: { field: 'latency_ms' } };
const chErr = { range: { status: { gte: 500 } } };
const chTri = (order, aggs, terms) => ({
  size: 0,
  aggs: { svc: { terms: { field: 'service', order, ...terms }, aggs } }
});
const chFiltre = aggs => ({ f: { filter: chErr, aggs } });
const chCols = {
  m: chAvg,
  s: { stats: { field: 'bytes' } },
  p: { percentiles: { field: 'latency_ms', percents: [50, 99.9] } },
  r: { percentile_ranks: { field: 'latency_ms', values: [500, 99.5] } }
};
for (const [path, column] of [
  ['f>m', 'f_m DESC NULLS FIRST'],
  ['f>s.avg', 'f_s_avg DESC NULLS FIRST'],
  ['f>s.count', 'f_s_count DESC'],
  ['f>m.value', 'f_m DESC NULLS FIRST'],
  ['f', 'f_doc_count DESC'],
  ['f.doc_count', 'f_doc_count DESC'],
  ['f>p.50', 'f_p[1] DESC NULLS FIRST'],
  ['f>p[99.9]', 'f_p[2] DESC NULLS FIRST'],
  ['f>p[50.0]', 'f_p[1] DESC NULLS FIRST'],
  ['f>r.500', 'f_r_500 DESC NULLS FIRST'],
  ['f>r[500.0]', 'f_r_500 DESC NULLS FIRST'],
  ['f>r[99.5]', 'f_r_99_5 DESC NULLS FIRST']
]) {
  const r = chemin(chTri({ [path]: 'desc' }, chFiltre(chCols)));
  check(
    r.sql.includes(`ORDER BY ${column}, svc ASC`) && !r.stats.ko && !r.notes.some(n => n.title.startsWith('tri sur')),
    `chemin de tri ${path} → ${column}`
  );
}
// Elasticsearch refuse _count sur un filtre dans un tri (HTTP 400) : « à reprendre », avec l’écriture valide dans le message
for (const path of ['f>_count', 'f._count']) {
  const r = chemin(chTri({ [path]: 'desc' }, chFiltre(chCols)));
  check(
    r.stats.ko === 1 &&
      !r.sql.includes('ORDER BY') &&
      r.notes.some(
        n =>
          n.level === 'err' &&
          n.detail.includes(`tri sur « ${path} »`) &&
          n.detail.includes('« f » ou « f.doc_count »') &&
          n.detail.includes('que dans un pipeline')
      ),
    `chemin de tri ${path} → à reprendre (Elasticsearch le refuse), le message donne f et f.doc_count`
  );
}
check(
  ['histogram', 'date_histogram'].every(type => {
    const body =
      type === 'histogram'
        ? { field: 'bytes', interval: 1000, order: { 'f>_count': 'asc' } }
        : { field: '@timestamp', calendar_interval: 'day', order: { 'f>_count': 'asc' } };
    return chemin({ size: 0, aggs: { h: { [type]: body, aggs: chFiltre({}) } } }).stats.ko === 1;
  }),
  'chemin de tri f>_count → à reprendre aussi sur histogram et date_histogram'
);
const chCentiles = chemin(
  chTri({ 'p.50': 'desc' }, { p: { percentiles: { field: 'latency_ms', percents: [99, 50] } } })
);
check(
  chCentiles.sql.includes('ORDER BY p[2] DESC'),
  'chemin de tri : un centile est un élément du tableau, pas le tableau'
);
const chHorsListe = chemin(chTri({ 'p.70': 'desc' }, { p: { percentiles: { field: 'latency_ms', percents: [99] } } }));
check(
  chHorsListe.sql.includes('quantilesTDigest(0.7)(latency_ms))[1] DESC, svc ASC'),
  'chemin de tri : un centile absent de la liste est calculé pour le tri, comme le fait Elasticsearch'
);
const chRangHorsListe = chemin(
  chTri({ 'r.700': 'desc' }, { r: { percentile_ranks: { field: 'latency_ms', values: [500] } } })
);
check(
  /ORDER BY round\(100 \* countIf\(latency_ms <= 700\)/.test(chRangHorsListe.sql),
  'chemin de tri : un rang absent de la liste est calculé pour le tri'
);
const chTop = chemin(
  chTri({ 'f>p.50': 'desc' }, { ...chFiltre({ p: chCols.p }), h: { terms: { field: 'host' } } }, { size: 2 })
);
check(
  /top_svc AS \([^;]*ORDER BY arrayMap\(v -> if\(isNaN\(v\), NULL, v\), quantilesTDigestIf\(0\.5, 0\.999\)\(latency_ms, status >= 500\)\)\[1\] DESC NULLS FIRST, svc ASC/.test(
    chTop.sql
  ),
  'chemin de tri : le top N d’un niveau parent calcule la même valeur que le niveau'
);
const chSansTri = chemin(
  chTri({ _count: 'desc' }, { f: { filter: chErr, aggs: { m: chAvg, h: { terms: { field: 'host' } } } } })
);
const chMixte = chemin(
  chTri({ 'f>m': 'desc' }, { f: { filter: chErr, aggs: { m: chAvg, h: { terms: { field: 'host' } } } } })
);
check(
  chMixte.sql.includes('ORDER BY avgIfOrNull(latency_ms, status >= 500) DESC NULLS FIRST, svc ASC') &&
    JSON.stringify(chMixte.stats) === JSON.stringify(chSansTri.stats),
  'chemin de tri : filtre qui porte un regroupement → calculé pour le tri, sans fausser la couverture'
);
const chSeul = chemin(chTri({ f: 'desc' }, { f: { filter: chErr, aggs: { h: { terms: { field: 'host' } } } } }));
check(
  chSeul.sql.includes('ORDER BY countIf(status >= 500) DESC, svc ASC'),
  'chemin de tri : filtre seul qui porte un regroupement → son nombre de documents'
);
const chImbriques = chemin(
  chTri(
    { 'f1>f2>m': 'desc' },
    { f1: { filter: chErr, aggs: { f2: { filter: { term: { level: 'ERROR' } }, aggs: { m: chAvg } } } } }
  )
);
check(
  chImbriques.sql.includes("ORDER BY avgIfOrNull(latency_ms, (status >= 500) AND (level = 'ERROR')) DESC") ||
    chImbriques.sql.includes("ORDER BY avgIfOrNull(latency_ms, status >= 500 AND level = 'ERROR') DESC"),
  'chemin de tri : filtres imbriqués → conditions réunies'
);
const chMissing = chemin(chTri({ 'a>m': 'desc' }, { a: { missing: { field: 'env' }, aggs: { m: chAvg } } }));
check(
  chMissing.sql.includes('ORDER BY avgIfOrNull(latency_ms, isNull(env)) DESC'),
  'chemin de tri : missing se traverse comme un filtre'
);
const chVide = (path, dir, aggs) => chemin(chTri({ [path]: dir }, chFiltre(aggs))).sql;
check(
  chVide('f>m', 'desc', { m: { min: { field: 'bytes' } } }).includes('ORDER BY f_m DESC NULLS FIRST, svc ASC') &&
    chVide('f>m', 'asc', { m: { min: { field: 'bytes' } } }).includes('ORDER BY f_m ASC, svc ASC') &&
    chVide('f>m', 'asc', { m: { max: { field: 'bytes' } } }).includes('ORDER BY f_m ASC NULLS FIRST, svc ASC') &&
    chVide('f>m', 'desc', { m: { max: { field: 'bytes' } } }).includes('ORDER BY f_m DESC, svc ASC') &&
    chVide('f>s.min', 'desc', { s: chCols.s }).includes('ORDER BY f_s_min DESC NULLS FIRST, svc ASC') &&
    chVide('f>s.avg', 'desc', { s: chCols.s }).includes('ORDER BY f_s_avg DESC NULLS FIRST, svc ASC') &&
    chVide('f>s.avg', 'asc', { s: chCols.s }).includes('ORDER BY f_s_avg ASC, svc ASC') &&
    chVide('f>s.max', 'asc', { s: chCols.s }).includes('ORDER BY f_s_max ASC NULLS FIRST, svc ASC') &&
    chVide('f>m', 'desc', { m: chAvg }).includes('ORDER BY f_m DESC NULLS FIRST, svc ASC') &&
    chVide('f>m', 'asc', { m: chAvg }).includes('ORDER BY f_m ASC, svc ASC') &&
    chVide('f>m', 'desc', { m: { sum: { field: 'bytes' } } }).includes('ORDER BY f_m DESC, svc ASC') &&
    chVide('f>m', 'desc', { m: { value_count: { field: 'bytes' } } }).includes('ORDER BY f_m DESC, svc ASC'),
  'chemin de tri : un groupe sans valeur suit Double.compare (NaN et +∞ en tête du décroissant, −∞ du croissant), sum et comptages valent 0'
);
const chMin = chTri({ mn: 'desc' }, { mn: { min: { field: 'retries' } } });
check(
  chemin(chMin).sql.includes('ORDER BY mn DESC, svc ASC') &&
    chemin(chMin, E.mergeConfig(E.DEFAULT_CONFIG, configOverride('N'))).sql.includes(
      'ORDER BY mn DESC NULLS FIRST, svc ASC'
    ),
  'chemin de tri : min d’une colonne qui peut être NULL → même règle ; colonne sans NULL → rien à préciser'
);
const chEcarte = (aggs, sort, extra) =>
  chemin(chTri({ _key: 'asc' }, { ...chFiltre(aggs), top: { bucket_sort: { sort, ...extra } } })).sql;
const chSortDesc = [{ 'f>m': { order: 'desc' } }];
check(
  chEcarte({ m: { min: { field: 'bytes' } } }, chSortDesc).includes('HAVING isNotNull(f_m)\nORDER BY f_m DESC\n') &&
    chEcarte({ m: chAvg }, chSortDesc).includes('HAVING isNotNull(f_m)') &&
    !chEcarte({ m: { sum: { field: 'bytes' } } }, chSortDesc).includes('HAVING') &&
    !chEcarte({ m: chAvg }, chSortDesc, { gap_policy: 'insert_zeros' }).includes('HAVING') &&
    !chEcarte({ m: chAvg }, [...chSortDesc, { _key: { order: 'asc' } }]).includes('HAVING') &&
    !chEcarte({ m: chAvg }, [...chSortDesc, { _count: { order: 'asc' } }]).includes('HAVING') &&
    chEcarte({ m: chAvg, n: { min: { field: 'bytes' } } }, [...chSortDesc, { 'f>n': { order: 'asc' } }]).includes(
      'HAVING (isNotNull(f_m) OR isNotNull(f_n))'
    ),
  'bucket_sort : gap_policy skip écarte le groupe qui n’a aucune de ses valeurs de tri ; sum, _key et _count en ont toujours une'
);
for (const [title, dsl] of [
  ['agrégation inconnue', chTri({ absent: 'desc' }, { lat: chAvg })],
  ['sous-agrégation inconnue', chTri({ 'f>absent': 'desc' }, chFiltre({ m: chAvg }))],
  ['chemin qui traverse un terms', chTri({ 'h>m': 'desc' }, { h: { terms: { field: 'host' }, aggs: { m: chAvg } } })],
  ['mesure multiple sans clé', chTri({ s: 'desc' }, { s: chCols.s })],
  ['clé inconnue d’une mesure multiple', chTri({ 's.absente': 'desc' }, { s: chCols.s })],
  ['centiles sans clé', chTri({ p: 'desc' }, { p: chCols.p })],
  ['clé d’un filtre', chTri({ 'f.avg': 'desc' }, chFiltre({ m: chAvg }))],
  ['filtre traversé par sa clé', chTri({ "f['a']>m": 'desc' }, chFiltre({ m: chAvg }))]
]) {
  const r = chemin(dsl);
  check(
    !r.error &&
      r.stats.ko > 0 &&
      !/ORDER BY (absent|f|h|s|p)\b(?!_)/.test(r.sql) &&
      r.notes.some(n => /chemin/.test(n.detail)),
    `chemin de tri refusé : ${title} → à reprendre, jamais de colonne absente`
  );
}
const chTopHits = chemin(
  chTri({ 'h>m': 'desc' }, { h: { terms: { field: 'host' }, aggs: { m: chAvg } }, d: { top_hits: { size: 1 } } })
);
check(
  !chTopHits.error && chTopHits.stats.ko > 0,
  'chemin de tri refusé avec un top_hits : à reprendre, la traduction des autres requêtes continue'
);
const chScript = chemin(
  chTri(
    { _key: 'asc' },
    {
      ...chFiltre({ m: chAvg }),
      part: {
        bucket_script: {
          buckets_path: { e: 'f>_count', l: 'f>m', t: '_count' },
          script: 'params.e * params.l / params.t'
        }
      }
    }
  )
);
check(
  chScript.sql.includes('(f_doc_count * f_m) / doc_count AS part') &&
    !chScript.notes.some(n => n.title.startsWith('tri sur')),
  'pipeline : f>_count et f>m → colonnes du filtre, sans la remarque réservée aux tris'
);
const chSort = chemin(
  chTri(
    { _key: 'asc' },
    { ...chFiltre({ m: chAvg }), top: { bucket_sort: { sort: [{ 'f>_count': { order: 'desc' } }], size: 2 } } }
  )
);
check(
  chSort.sql.includes('ORDER BY f_doc_count DESC'),
  'bucket_sort : chemin f>_count → nombre de documents du filtre'
);
const chSortScript = chemin(
  chTri(
    { _key: 'asc' },
    {
      lat: chAvg,
      double: { bucket_script: { buckets_path: { l: 'lat' }, script: 'params.l * 2' } },
      top: { bucket_sort: { sort: [{ double: { order: 'desc' } }], size: 2 } }
    }
  )
);
check(
  chSortScript.sql.includes('ORDER BY double DESC') && !chSortScript.stats.ko,
  'bucket_sort : le nom d’un pipeline reste une colonne'
);
const chDerivee = chemin({
  size: 0,
  aggs: {
    d: {
      date_histogram: { field: '@timestamp', calendar_interval: 'day' },
      aggs: { ...chFiltre({ m: chAvg }), dv: { derivative: { buckets_path: 'f>m' } } }
    }
  }
});
check(
  chDerivee.sql.includes('f_m - lagInFrame(toNullable(f_m), 1) OVER'),
  'pipeline : dérivée sur le chemin d’une mesure filtrée → colonne de la mesure'
);
const chMulti = chemin({
  size: 0,
  aggs: {
    mt: {
      multi_terms: { terms: [{ field: 'service' }, { field: 'host' }], order: { 'f>m': 'desc' } },
      aggs: chFiltre({ m: chAvg })
    }
  }
});
check(chMulti.sql.includes('ORDER BY f_m DESC'), 'chemin de tri sur multi_terms → colonne de la mesure');

/* ---------- Tableaux de bord Grafana ---------- */
const gDash = JSON.stringify(grafanaOut.dashboard);
const gPanel = title => grafanaOut.dashboard.panels.find(p => p.title === title) || { targets: [] };
check(
  !/"elasticsearch"/.test(gDash) &&
    !/DS_ELASTICSEARCH/.test(gDash) &&
    grafanaOut.dashboard.__inputs.some(i => i.pluginId === 'grafana-clickhouse-datasource'),
  'Grafana : plus aucune référence à Elasticsearch, entrée DS_CLICKHOUSE à l’import'
);
const gSeries = gPanel('Requêtes par service').targets[0];
check(
  gSeries.format === 0 &&
    /WHERE \$__timeFilter_ms\(timestamp\)/.test(gSeries.rawSql) &&
    /INTERVAL \$__interval_s SECOND/.test(gSeries.rawSql) &&
    gSeries.rawSql.includes('$__conditionalAll(service.name IN (${service:singlequote}), $service)'),
  'Grafana : $__timeFilter, $__interval_s et $__conditionalAll pour une variable « All »'
);
check(
  /FROM \$__fromTime_ms|toStartOfInterval\(\$__fromTime_ms/.test(gSeries.rawSql) &&
    /\nORDER BY time, service_name$/.test(gSeries.rawSql),
  'Grafana : tranches vides comblées sur la période du tableau de bord, résultat trié par temps'
);
check(
  JSON.stringify(gPanel('Requêtes par service').fieldConfig.overrides).includes('${__field.labels.service_name}'),
  'Grafana : alias {{term service.name}} → nom d’affichage des séries'
);
const gMixed = gPanel('Requêtes × 1000 (expression)');
check(
  gMixed.datasource.uid === '-- Mixed --' &&
    gMixed.targets[1].datasource.type === '__expr__' &&
    gMixed.targets[1].expression === '$A * 1000',
  'Grafana : expression du panneau mixte gardée telle quelle'
);
check(
  grafanaOut.report.panels.find(p => p.title === 'Pic de 5xx (ancienne alerte)').verdict === 'todo' &&
    /Passerelle : à reprendre/.test(gPanel('Pic de 5xx (ancienne alerte)').description),
  'Grafana : ancienne alerte de panneau à reprendre, signalée dans la description'
);
const gVar = grafanaOut.dashboard.templating.list.find(v => v.name === 'service');
check(
  gVar.query.editorType === 'sql' &&
    /^SELECT valeur\n/.test(gVar.query.rawSql) &&
    gVar.allValue === null &&
    gVar.includeAll,
  'Grafana : variable terms → SELECT d’une colonne, « All » géré par $__conditionalAll'
);
check(
  /fromUnixTimestamp64Milli|\$__fromTime_ms/.test(
    E.translateDSL(
      JSON.stringify({
        size: 0,
        aggs: {
          t: {
            date_histogram: {
              field: '@timestamp',
              fixed_interval: '1h',
              min_doc_count: 0,
              extended_bounds: { min: '$__from', max: '$__to' }
            }
          }
        }
      }),
      E.DEFAULT_CONFIG,
      { grafana: true }
    ).sql
  ),
  'Grafana : bornes $__from et $__to → macros du plugin'
);
check(
  /statut IN \(\$\{statut:singlequote\}\)/.test(
    E.translateDSL(JSON.stringify({ query: { term: { statut: '$statut' } } }), E.DEFAULT_CONFIG, { grafana: true }).sql
  ) &&
    /statut NOT IN/.test(
      E.translateDSL(
        JSON.stringify({ query: { bool: { must_not: { term: { statut: '$statut' } } } } }),
        E.DEFAULT_CONFIG,
        { grafana: true, variables: { statut: { includeAll: true } } }
      ).sql
    ),
  'Grafana : égalité → IN, exclusion → NOT IN jamais levée par « All »'
);
check(
  /schéma v2/.test(
    E.grafanaDashboard(
      JSON.stringify({ apiVersion: 'dashboard.grafana.app/v2beta1', kind: 'Dashboard', spec: {} }),
      E.DEFAULT_CONFIG
    ).error || ''
  ),
  'Grafana : schéma v2 refusé avec la marche à suivre'
);
const gNoIndex = E.grafanaDashboard(rd('examples/grafana/supervision_es.json'), grafanaCfg, {});
check(
  gNoIndex.report.notes.some(n => /Aucun index précisé/.test(n)),
  'Grafana : sans --index, la table par défaut est signalée'
);
const unknownCol = E.translateDSL(JSON.stringify({ query: { term: { inconnue: 'x' } } }), grafanaCfg, {
  index: 'logs-web-*'
});
check(
  E.verdictOf(unknownCol) === 'review' && unknownCol.notes.some(n => /absente du schéma/.test(n.title)),
  'schéma déclaré : une colonne qu’il ne connaît pas est à vérifier, pas prête'
);

// Les chiffres du README (« traduit » et « vérifié par le banc ») sont ceux que le moteur et les bancs donnent
{
  const problems = drift();
  check(!problems.length, 'README : les chiffres de couverture sont ceux du moteur et des bancs', problems.join(' ; '));

  // Le décompte lui-même, sur des cas écrits pour l'éprouver
  const range = { range: { n: { gte: 1 } } };
  const dsl = playedByDifferential([
    {
      id: 'imbriqués',
      dsl: {
        query: {
          bool: {
            must: [{ match: { a: 'x' } }],
            filter: range,
            should: [{ dis_max: { queries: [{ term: { a: 1 } }] } }]
          }
        },
        post_filter: { exists: { field: 'a' } },
        aggs: {
          f: {
            filter: { prefix: { a: 'x' } },
            aggs: { t: { terms: { field: 'a' }, aggs: { m: { avg: { field: 'n' } } } } }
          },
          g: { filters: { filters: { u: { wildcard: { a: 'x*' } } } }, meta: { range: 'pas une agrégation' } }
        }
      }
    },
    {
      id: 'écart partout',
      known: 'raison',
      dsl: { query: { regexp: { a: 'x' } }, aggs: { h: { histogram: { field: 'n', interval: 1 } } } }
    },
    { id: 'hors de portée', unsupported: true, dsl: { query: { more_like_this: {} } } },
    { id: 'écart dans un schéma', known: { D: 'raison' }, dsl: { query: { ids: { values: [] } } } }
  ]);
  const same = (got, want) => [...got].sort().join() === want.join();
  check(
    same(dsl.clean.queries, ['bool', 'dis_max', 'exists', 'ids', 'match', 'prefix', 'range', 'term', 'wildcard']),
    'couverture : les requêtes jouées sont lues dans bool, dis_max, post_filter et les agrégations filter et filters',
    [...dsl.clean.queries].sort().join(', ')
  );
  check(
    same(dsl.clean.aggs, ['avg', 'filter', 'filters', 'terms']),
    'couverture : les agrégations jouées sont lues dans les sous-agrégations, sans « meta »',
    [...dsl.clean.aggs].sort().join(', ')
  );
  check(
    same(dsl.diverging.queries, ['more_like_this', 'regexp']) && same(dsl.diverging.aggs, ['histogram']),
    'couverture : un écart dans tous les schémas, ou une construction hors de portée, ne prouve rien ; un écart dans un seul schéma si',
    `${[...dsl.diverging.queries]} / ${[...dsl.diverging.aggs]}`
  );
  const pipe = playedByPipelines(
    ['date', 'mutate', 'grok'],
    [
      { id: 'a', filter: 'mutate { add_tag => ["date"] }' },
      { id: 'b', chain: [{ id: 'x', filter: 'grok { match => { "message" => "%{GREEDYDATA:m}" } }' }] },
      { id: 'c', known: 'raison', filter: 'mutate { rename => { "a" => "b" } }\n date { match => ["t", "ISO8601"] }' }
    ]
  );
  check(
    same(pipe.clean, ['grok', 'mutate']) && same(pipe.diverging, ['date', 'mutate']),
    'couverture : un filtre Logstash compte quand son plugin est ouvert dans un bloc filter (pas quand son nom n’est qu’une valeur), chaînes de pipelines comprises, et pas s’il diverge',
    `${[...pipe.clean]} / ${[...pipe.diverging]}`
  );
}

// Graphe des modules du moteur : il n'importe que ses propres fichiers (il tourne dans le navigateur comme dans le
// serveur), et le seul cycle toléré est celui, connu, de la base et du DSL (dsl-params et dsl-strict en dépendent
// comme du reste du DSL)
{
  const dir = join(ROOT, 'src/engine');
  const files = readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'index.js');
  const deps = new Map();
  const foreign = [];
  for (const f of files) {
    const targets = [];
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)';/gm)) {
      if (/^\.\/[\w-]+\.js$/.test(m[1])) targets.push(m[1].slice(2));
      else foreign.push(`${f} → ${m[1]}`);
    }
    deps.set(f, [...new Set(targets)]);
  }
  check(!foreign.length, 'moteur : les modules n’importent que des modules du moteur', foreign.join(', '));

  // Composantes fortement connexes (Tarjan) : celles de plus d'un module sont des cycles
  const index = new Map();
  const low = new Map();
  const stack = [];
  const cycles = [];
  let n = 0;
  const visit = v => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    for (const w of deps.get(v) || []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (stack.includes(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do comp.push((w = stack.pop()));
      while (w !== v);
      if (comp.length > 1) cycles.push(comp.map(f => f.replace(/\.js$/, '')).sort());
    }
  };
  for (const f of files) if (!index.has(f)) visit(f);
  const known = ['base', 'dsl', 'dsl-params', 'dsl-strict'];
  const unexpected = cycles.filter(c => c.join() !== [...known].sort().join());
  check(
    !unexpected.length,
    'moteur : aucun cycle d’import hors celui de base et du DSL',
    unexpected.map(c => c.join(' ↔ ')).join(' ; ')
  );
  const missing = [...deps.values()].flat().filter(t => !deps.has(t));
  check(!missing.length, 'moteur : tout module importé existe', missing.join(', '));
  const facade = readFileSync(join(dir, 'index.js'), 'utf8');
  const unexported = files.filter(f => !facade.includes(`'./${f}'`));
  check(!unexported.length, 'moteur : la façade src/engine/index.js réexporte chaque module', unexported.join(', '));
}

/* ---------- Watches Elasticsearch ---------- */
{
  const W = (watch, id) => E.watcherTranslate(JSON.stringify({ watches: [{ _id: id || 'w', watch }] }), watcherCfg, {});
  const one = (watch, id) => W(watch, id).entries[0];
  const search = (body, extra) => ({
    trigger: { schedule: { interval: '5m' } },
    input: { search: { request: Object.assign({ indices: ['logs-web-*'], body }, extra || {}) } }
  });
  const win = { range: { '@timestamp': { gte: '{{ctx.trigger.scheduled_time}}||-5m' } } };
  const cond = (x, title) => (x.queries.find(q => q.title === (title || 'Condition')) || {}).sql || '';
  const has = (x, label) => x.issues.some(i => i.label === label);
  const byId = id => watcherRep.entries.find(x => x.id === id) || { issues: [], queries: [], schedule: { cron: [] } };

  // Lecture : réponses d’API, console, index .watches, définition seule, NDJSON
  const def = Object.assign(search({ size: 0, query: win }), { condition: { always: {} }, actions: {} });
  const reads = [
    [
      'GET _watcher/watch/<id>',
      JSON.stringify({ found: true, _id: 'a', watch: def, status: { state: { active: false } } }),
      ['a'],
      1
    ],
    [
      'console, ?active=false, _execute ignoré',
      `PUT _watcher/watch/a?active=false\n${JSON.stringify(def)}\n\nPOST _watcher/watch/a/_execute\n{}\nPUT /_watcher/watch/b\n${JSON.stringify(def)}`,
      ['a', 'b'],
      1
    ],
    [
      'recherche sur .watches',
      JSON.stringify({
        hits: { hits: [{ _id: 'c', _source: Object.assign({ status: { state: { active: true } } }, def) }] }
      }),
      ['c'],
      0
    ],
    ['définitions sans identifiant', JSON.stringify([def, def]), ['regles', 'regles-2'], 0],
    [
      'NDJSON',
      `${JSON.stringify({ _id: 'n1', watch: def })}\n${JSON.stringify({ _id: 'n2', watch: def })}`,
      ['n1', 'n2'],
      0
    ]
  ];
  for (const [label, text, ids, inactive] of reads) {
    const r = E.watcherTranslate(text, watcherCfg, { names: ['regles.json'] });
    check(
      JSON.stringify(r.entries.map(x => x.id).sort()) === JSON.stringify(ids) &&
        r.summary.inactive === inactive &&
        !r.source.errors.length,
      `watches, lecture : ${label}`,
      `${r.entries.map(x => x.id)} ; ${r.summary.inactive} désactivée(s) ; ${r.source.errors}`
    );
  }
  check(
    E.watcherRead('{"query":{"match_all":{}}}', 'x').errors.length === 1,
    'watches, lecture : une requête DSL n’est pas une watch'
  );

  // Planification : chaque forme de Watcher en clair et en cron à 5 champs
  const sch = s => E.watchSchedule({ schedule: s });
  const crons = [
    [{ interval: '5m' }, '*/5 * * * *'],
    [{ interval: '2h' }, '0 */2 * * *'],
    [{ interval: 300 }, '*/5 * * * *'],
    [{ interval: '7m' }, ''],
    [{ interval: '30s' }, ''],
    [{ hourly: { minute: [0, 30] } }, '0,30 * * * *'],
    [{ daily: { at: ['noon', '17:30'] } }, '0 12 * * * ; 30 17 * * *'],
    [{ daily: { at: { hour: [8, 18], minute: 15 } } }, '15 8,18 * * *'],
    [{ weekly: [{ on: ['monday', 'fri'], at: '07:00' }] }, '0 7 * * 1,5'],
    [{ monthly: { on: [1, 15], at: 'midnight' } }, '0 0 1,15 * *'],
    [{ yearly: { in: 'march', on: 31, at: '23:59' } }, '59 23 31 3 *'],
    [{ cron: '0 0/5 8-19 ? * MON-FRI' }, '*/5 8-19 * * MON-FRI'],
    [{ cron: '0 30 9 ? * 2-6' }, '30 9 * * 1-5'],
    [{ cron: '0 15 10 ? * 1' }, '15 10 * * 0'],
    [{ cron: '0 0 12 1/5 * ?' }, '0 12 */5 * *'],
    [{ cron: ['0 0 6 * * ?', '0 0 18 * * ?'] }, '0 6 * * * ; 0 18 * * *']
  ];
  for (const [s, want] of crons) {
    const r = sch(s);
    check(
      r.cron.join(' ; ') === want,
      `watches, planification ${JSON.stringify(s)} → ${want || 'pas de cron'}`,
      `${r.cron.join(' ; ')} (${r.text})`
    );
  }
  for (const c of ['0 0 6 L * ?', '0 0 6 ? * 6#3', '*/10 * * * * ?', '0 0 6 * * ? 2027'])
    check(
      sch({ cron: c }).cron.length === 0 && sch({ cron: c }).issues.some(i => i.kind === 'review'),
      `watches, cron Quartz sans équivalent à 5 champs : ${c}`
    );
  check(
    /Europe\/Paris/.test(sch({ daily: { at: '08:00' }, timezone: 'Europe/Paris' }).text),
    'watches, fuseau de la planification affiché'
  );

  // Conditions → décision SQL
  const total = (op, v, body, extra) =>
    one(
      Object.assign(search(body || { size: 0, query: win }, extra), {
        condition: { compare: { 'ctx.payload.hits.total': { [op]: v } } },
        actions: { l: { logging: { text: 'x' } } }
      })
    );
  let x = total('gte', 5);
  check(
    /count >= 5 AS declenchee/.test(cond(x)) && x.verdict === 'ready',
    'watches, compare hits.total : décompte et seuil',
    cond(x)
  );
  x = total('gt', 5, {
    size: 20,
    query: win,
    post_filter: { term: { 'service.name': 'checkout' } },
    aggs: { s: { terms: { field: 'host.name' } } }
  });
  check(
    /count > 5 AS declenchee/.test(cond(x)) && /service\.name = 'checkout'/.test(cond(x)) && !/GROUP BY/.test(cond(x)),
    'watches, hits.total compte le post_filter, sans les agrégations',
    cond(x)
  );
  x = total('gt', '5');
  check(
    /toString\(count\) > '5'/.test(cond(x)) && has(x, 'seuil entre guillemets'),
    'watches, seuil entre guillemets : comparé en texte, comme Watcher, et signalé',
    cond(x)
  );
  x = total('gt', 20000);
  check(
    has(x, 'décompte plafonné') && x.verdict === 'review',
    'watches, seuil au-delà de 10 000 sans track_total_hits : à vérifier'
  );
  x = total('gt', 20000, { size: 0, track_total_hits: true, query: win });
  check(!has(x, 'décompte plafonné'), 'watches, track_total_hits: true : pas de plafond');
  x = one(
    Object.assign(search({ size: 0, query: win }), {
      condition: { compare: { 'ctx.payload.hits.total.value': { gt: 0 } } },
      actions: { l: { logging: { text: 'x' } } }
    })
  );
  check(
    has(x, 'hits.total.value dans une watch') && x.verdict === 'review' && /count > 0/.test(cond(x)),
    'watches, hits.total.value : vide dans une watch, signalé à vérifier'
  );
  x = one(
    Object.assign(search({ size: 0, query: win }, { rest_total_hits_as_int: false }), {
      condition: { compare: { 'ctx.payload.hits.total.value': { gt: 0 } } },
      actions: { l: { logging: { text: 'x' } } }
    })
  );
  check(
    !has(x, 'hits.total.value dans une watch'),
    'watches, rest_total_hits_as_int: false : hits.total.value est le bon chemin'
  );
  x = one(
    Object.assign(
      search({
        size: 0,
        query: win,
        aggs: {
          p: { percentiles: { field: 'event.duration', percents: [50, 99] } },
          d: { avg: { field: 'event.duration' } }
        }
      }),
      { condition: { compare: { 'ctx.payload.aggregations.d.value': { eq: null } } }, actions: {} }
    )
  );
  check(/isNull\(d\) AS declenchee/.test(cond(x)), 'watches, compare à null : isNull, comme Watcher', cond(x));
  x = one(
    Object.assign(search({ size: 0, query: win, aggs: { d: { avg: { field: 'event.duration' } } } }), {
      condition: { compare: { 'ctx.payload.aggregations.d.value': { not_eq: 5 } } },
      actions: {}
    })
  );
  check(/ifNull\(d != 5, 1\)/.test(cond(x)), 'watches, not_eq sur une valeur absente : vrai, comme Watcher', cond(x));
  x = one(
    Object.assign(
      search({ size: 0, query: win, aggs: { p: { percentiles: { field: 'event.duration', percents: [50, 99] } } } }),
      { condition: { script: { source: "return ctx.payload.aggregations.p.values['99.0'] > 100;" } }, actions: {} }
    )
  );
  check(
    /ifNull\(p\[2\] > 100, 0\)/.test(cond(x)),
    'watches, centile lu dans le script : élément du tableau des centiles',
    cond(x)
  );
  x = one(
    Object.assign(
      search({
        size: 0,
        query: win,
        aggs: {
          err: {
            filter: { range: { 'http.response.status_code': { gte: 500 } } },
            aggs: { lent: { max: { field: 'event.duration' } } }
          }
        }
      }),
      { condition: { compare: { 'ctx.payload.aggregations.err.doc_count': { gte: 3 } } }, actions: {} }
    )
  );
  check(/err_doc_count >= 3 AS declenchee/.test(cond(x)), 'watches, doc_count d’une agrégation filter', cond(x));
  const arr = (q, extra) =>
    one(
      Object.assign(
        search({
          size: 0,
          query: win,
          aggs: { svc: { terms: { field: 'service.name' }, aggs: { lat: { avg: { field: 'event.duration' } } } } }
        }),
        {
          condition: {
            array_compare: {
              'ctx.payload.aggregations.svc.buckets': Object.assign(
                { path: 'lat.value', gt: { value: 10, quantifier: q } },
                extra || {}
              )
            }
          },
          actions: {}
        }
      )
    );
  check(
    /countIf\(ifNull\(lat > 10, 0\)\) > 0 AS declenchee/.test(cond(arr('some'))),
    'watches, array_compare some : au moins un groupe',
    cond(arr('some'))
  );
  check(
    /countIf\(NOT \(ifNull\(lat > 10, 0\)\)\) = 0 AS declenchee/.test(cond(arr('all'))),
    'watches, array_compare all : vrai aussi sans aucun groupe, comme Watcher',
    cond(arr('all'))
  );
  x = one(
    Object.assign(search({ size: 0, query: win, aggs: { svc: { terms: { field: 'service.name' } } } }), {
      condition: {
        script: {
          source:
            'for (def b : ctx.payload.aggregations.svc.buckets) {\n  if (b.doc_count >= params.n) { return true; }\n}\nreturn false;',
          params: { n: 7 }
        }
      },
      actions: {}
    })
  );
  check(
    /countIf\(doc_count >= 7\) > 0/.test(cond(x)),
    'watches, boucle Painless sur les groupes : au moins un groupe',
    cond(x)
  );
  x = one(
    Object.assign(search({ size: 3, query: win }), {
      condition: { script: 'return ctx.payload.hits.hits.size() >= 3' },
      actions: {}
    })
  );
  check(
    /count\(\) >= 3 AS declenchee/.test(cond(x)) && /LIMIT 3/.test(cond(x)),
    'watches, taille de hits.hits : documents renvoyés, limités par size',
    cond(x)
  );
  x = one(
    Object.assign(search({ size: 0, query: win }), {
      condition: { array_compare: { 'ctx.payload.hits.hits': { path: '_source.event.duration', gt: { value: 1 } } } },
      actions: {}
    })
  );
  check(/SELECT 0 AS declenchee/.test(cond(x)), 'watches, liste de documents avec size: 0 : toujours vide', cond(x));
  x = one(
    Object.assign(search({ size: 0, query: win }), {
      condition: { compare: { 'ctx.payload.hits.total': { gt: '<{now-5m}>' } } },
      actions: {}
    })
  );
  check(
    x.verdict === 'todo' && has(x, 'date math dans la condition'),
    'watches, date math dans la condition : à reprendre'
  );
  x = one(
    Object.assign(search({ size: 0, query: win }), {
      condition: { compare: { 'ctx.payload.hits.total': { gt: '{{ctx.payload._shards.total}}' } } },
      actions: {}
    })
  );
  check(
    x.verdict === 'todo' && has(x, 'valeur comparée lue dans le payload'),
    'watches, valeur comparée lue dans le payload : à reprendre'
  );
  x = one(
    Object.assign(search({ size: 0, query: win }), {
      condition: { script: { source: 'def n = 0; for (h in ctx.payload.hits.hits) { n += h._score } return n > 3;' } },
      actions: {}
    })
  );
  check(
    x.verdict === 'todo' && has(x, 'condition Painless'),
    'watches, script Painless hors des formes reconnues : à reprendre'
  );
  x = one(Object.assign(search({ size: 0, query: win }), { condition: { never: {} }, actions: {} }));
  check(
    has(x, 'condition jamais vraie') && has(x, 'aucune action') && !x.queries.some(q => q.title === 'Condition'),
    'watches, condition never et aucune action : signalées'
  );

  // Valeurs connues dans la watch : métadonnées, identifiant, paramètres d’un modèle de recherche
  x = one(
    {
      trigger: { schedule: { interval: '1m' } },
      metadata: { svc: 'checkout', n: 3, codes: [500, 503] },
      input: {
        search: {
          request: {
            indices: ['logs-web-*'],
            template: {
              source:
                '{"size": {{taille}}, "query": {"bool": {"filter": [{"term": {"service.name": "{{ctx.metadata.svc}}"}}, {"terms": {"http.response.status_code": {{#toJson}}ctx.metadata.codes{{/toJson}}}}, {"term": {"host.name": "{{ctx.watch_id}}"}}]}}}',
              params: { taille: 0 }
            }
          }
        }
      },
      condition: { compare: { 'ctx.payload.hits.total': { gte: '{{ctx.metadata.n}}' } } },
      actions: {}
    },
    'web-1'
  );
  check(
    /service\.name = 'checkout'/.test(cond(x)) &&
      /IN \(500, 503\)/.test(cond(x)) &&
      /host\.name = 'web-1'/.test(cond(x)) &&
      /count >= 3/.test(cond(x)),
    'watches, metadata, watch_id et paramètres du modèle remplacés avant la traduction',
    cond(x)
  );
  x = one(
    Object.assign(
      search({
        size: 0,
        query: {
          range: {
            '@timestamp': { gte: '{{ctx.trigger.scheduled_time}}', format: 'strict_date_optional_time||epoch_millis' }
          }
        }
      }),
      { condition: { always: {} }, actions: {} }
    )
  );
  check(
    /parseDateTime64BestEffort\(\{scheduled_time:String\}/.test(cond(x, 'Recherche')),
    'modèle de date, format strict_date_optional_time||epoch_millis : le premier format décide',
    cond(x, 'Recherche')
  );
  check(
    /fromUnixTimestamp64Milli\(toInt64\(\{t:String\}\)\)/.test(
      E.translateDSL(
        JSON.stringify({
          query: { range: { '@timestamp': { gte: '{{t}}', format: 'epoch_millis||strict_date_optional_time' } } }
        }),
        E.DEFAULT_CONFIG,
        {}
      ).sql
    ),
    'modèle de date, format epoch_millis en premier : lu en epoch'
  );

  // Seuil de l’interface Watcher : metadata.watcherui décrit la condition
  const th = byId('6f1d0c2e-5b7a-4c1e-9e0d-3a2b1c4d5e6f');
  check(
    th.kind === 'threshold' &&
      th.verdict === 'ready' &&
      /countIf\(ifNull\(metricAgg > 800000000, 0\)\) > 0/.test(cond(th)),
    'watches, seuil de l’interface Watcher : condition lue dans watcherui',
    cond(th)
  );
  check(
    byId('kQ7fW3aZTGa0b1c2d3e4fA_elasticsearch_cluster_status').skipped && watcherRep.summary.skipped === 1,
    'watches, alerte de Stack Monitoring : sans objet, hors du décompte'
  );
  check(
    byId('sante-cluster').verdict === 'todo' &&
      byId('sante-cluster').issues.filter(i => i.kind === 'todo').length === 1,
    'watches, entrée http : à reprendre une fois, la condition suit son entrée'
  );
  check(
    byId('echecs-de-connexion').verdict === 'todo' &&
      has(byId('echecs-de-connexion'), 'référence à une entrée précédente'),
    'watches, chaîne d’entrées : référence à la première entrée, à reprendre'
  );
  check(
    has(byId('erreurs-paiement'), 'index en date math') &&
      byId('erreurs-paiement').queries.some(q => q.table === 'logs.web'),
    'watches, index en date math : motif, table trouvée, à vérifier'
  );
  check(
    byId('fin-de-mois').verdict === 'todo' &&
      has(byId('fin-de-mois'), 'modèle de recherche stocké') &&
      !byId('fin-de-mois').active,
    'watches, modèle de recherche stocké : à reprendre ; ?active=false lu'
  );
  check(
    watcherRep.summary.effort.hours === watcherRep.entries.reduce((n, e) => n + e.effort, 0),
    'watches, effort total : somme des watches'
  );

  // Secrets : jamais dans le rapport, masqués dans un export
  const md =
    E.watcherReportMarkdown(watcherRep) + E.watcherReportCSV(watcherRep) + E.watcherReportHTML(watcherRep, 't');
  check(
    !/es_redacted|jeton=secret|exploitation@exemple\.fr/.test(md),
    'watches, rapport : ni mot de passe, ni jeton d’URL, ni adresse e-mail'
  );
  const scrubbed = JSON.stringify(
    E.watcherScrub({
      a: {
        webhook: {
          url: 'https://u:motdepasse@h.fr/x?canal=ops&token=abc123',
          auth: { basic: { username: 'u', password: 'p' } },
          headers: { Authorization: 'Bearer t' }
        }
      }
    })
  );
  check(
    !/motdepasse|"p"|Bearer t|abc123/.test(scrubbed) && /"username":"u"/.test(scrubbed) && /canal=ops/.test(scrubbed),
    'watches, export : mots de passe, en-têtes d’autorisation et identifiants d’URL masqués',
    scrubbed
  );
}

process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests passent.\n');
process.exit(failures ? 1 : 0);
