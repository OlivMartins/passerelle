#!/usr/bin/env node
/*
 * Ce que Passerelle traduit, et ce que ses bancs vérifient : les chiffres de la section « Ce que Passerelle sait
 * traduire » du README. Ils ne s'écrivent pas à la main.
 *
 *   traduit   les tables du moteur : types de requêtes (QUERY_SPECS) et agrégations (AGG_SPECS) de src/engine/dsl-strict.js,
 *             filtres Logstash (méthodes f_* de la classe VrlGen), processeurs d'ingestion (INGEST_OPTIONS)
 *   vérifié   rejoué par un banc qui compare avec le moteur d'origine, sans écart :
 *               requêtes et agrégations : les cas de tests/differential/cases.mjs (Elasticsearch contre ClickHouse) ;
 *               filtres Logstash : les cas de tests/pipelines/cases.mjs (Logstash contre Vector).
 *             Un cas qui diverge dans tous les schémas (known écrit en texte) ou dont la construction est hors de portée
 *             (unsupported) ne prouve pas l'équivalence : il ne compte pas. Un écart limité à un schéma ou à un fuseau
 *             (known écrit en objet) laisse le cas égal dans les autres : il compte. Le banc Watcher, qui compare la
 *             décision d'une condition et non un résultat, n'est pas compté. Les processeurs d'ingestion n'ont pas de banc de ce genre en local (Vector
 *             compile leur VRL ; la CI rejoue les tests de pipeline des intégrations Elastic) : ils ne sont pas comptés.
 *
 *   node scripts/couverture.mjs             le bilan, avec les noms que les bancs ne rejouent pas
 *   node scripts/couverture.mjs --ecrire    réécrit le bloc du README
 *   node scripts/couverture.mjs --verifier  code 1 si le README ne dit plus ce que le moteur et les bancs montrent
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES as DSL_CASES } from '../tests/differential/cases.mjs';
import { CASES as PIPELINE_CASES } from '../tests/pipelines/cases.mjs';
import { AGG_SPECS, INGEST_OPTIONS, LOGSTASH_FILTERS, QUERY_SPECS } from '../src/engine/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const BEGIN = '<!-- couverture:début (généré par scripts/couverture.mjs --ecrire : ne pas modifier à la main) -->';
const END = '<!-- couverture:fin -->';

/* ---------- Ce que les bancs jouent ---------- */

const arr = x => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// Les clauses contenues dans une clause : bool, constant_score, dis_max, boosting, function_score, script_score, nested
function clauseTypes(q, out) {
  for (const c of arr(q)) {
    if (!isObj(c)) continue;
    for (const [type, body] of Object.entries(c)) {
      out.queries.add(type);
      if (!isObj(body)) continue;
      switch (type) {
        case 'bool':
          for (const k of ['must', 'filter', 'should', 'must_not']) clauseTypes(body[k], out);
          break;
        case 'constant_score':
          clauseTypes(body.filter, out);
          break;
        case 'dis_max':
          clauseTypes(body.queries, out);
          break;
        case 'boosting':
          clauseTypes(body.positive, out);
          clauseTypes(body.negative, out);
          break;
        case 'function_score':
          clauseTypes(body.query, out);
          for (const f of arr(body.functions)) if (isObj(f)) clauseTypes(f.filter, out);
          break;
        case 'script_score':
        case 'nested':
          clauseTypes(body.query, out);
          break;
      }
    }
  }
}

// Les agrégations d'un objet « aggs », et ce qu'elles contiennent : sous-agrégations, filtres des agrégations filter et filters
function aggTypes(aggs, out) {
  if (!isObj(aggs)) return;
  for (const def of Object.values(aggs)) {
    if (!isObj(def)) continue;
    for (const [type, body] of Object.entries(def)) {
      if (type === 'meta') continue;
      if (type === 'aggs' || type === 'aggregations') {
        aggTypes(body, out);
        continue;
      }
      out.aggs.add(type);
      if (!isObj(body)) continue;
      if (type === 'filter') clauseTypes(body, out);
      if (type === 'filters') for (const f of Object.values(body.filters || {})) clauseTypes(f, out);
    }
  }
}

// Les types de requêtes et d'agrégations que jouent les cas du banc différentiel, avec ou sans écart dans tous les schémas
export function playedByDifferential(cases = DSL_CASES) {
  const clean = { queries: new Set(), aggs: new Set() };
  const diverging = { queries: new Set(), aggs: new Set() };
  for (const c of cases) {
    const out = typeof c.known === 'string' || c.unsupported ? diverging : clean;
    const dsl = c.dsl;
    if (!isObj(dsl)) continue;
    clauseTypes(dsl.query, out);
    clauseTypes(dsl.post_filter, out);
    aggTypes(dsl.aggs || dsl.aggregations, out);
  }
  return { clean, diverging };
}

// Les filtres Logstash que jouent les cas du banc d'équivalence : « nom {  » dans le bloc filter du cas
export function playedByPipelines(names, cases = PIPELINE_CASES) {
  const clean = new Set();
  const diverging = new Set();
  for (const c of cases) {
    const texts = c.chain ? c.chain.map(l => l.filter) : [c.filter];
    const into = c.known ? diverging : clean;
    for (const t of texts) {
      for (const name of names) if (new RegExp(`(?<![\\w.])${name}\\s*\\{`).test(t || '')) into.add(name);
    }
  }
  return { clean, diverging };
}

/* ---------- Le bilan ---------- */

const sorted = set => [...set].sort();
const minus = (a, b) => sorted(a).filter(x => !b.has(x));

export function couverture() {
  const translated = {
    queries: new Set(Object.keys(QUERY_SPECS)),
    aggs: new Set(Object.keys(AGG_SPECS)),
    filters: new Set(LOGSTASH_FILTERS),
    processors: new Set(Object.keys(INGEST_OPTIONS))
  };
  const dsl = playedByDifferential();
  const pipelines = playedByPipelines([...translated.filters]);
  const verified = {
    queries: new Set([...dsl.clean.queries].filter(x => translated.queries.has(x))),
    aggs: new Set([...dsl.clean.aggs].filter(x => translated.aggs.has(x))),
    filters: pipelines.clean
  };
  return {
    translated,
    verified,
    unverified: {
      queries: minus(translated.queries, verified.queries),
      aggs: minus(translated.aggs, verified.aggs),
      filters: minus(translated.filters, verified.filters)
    },
    cases: { differential: DSL_CASES.length, pipelines: PIPELINE_CASES.length }
  };
}

/* ---------- Le README ---------- */

const code = names => names.map(n => `\`${n}\``).join(', ');
const fr = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Le bloc généré : une phrase de chiffres, puis ce que les bancs ne rejouent pas
export function blocReadme(c = couverture()) {
  const t = c.translated;
  const v = c.verified;
  const u = c.unverified;
  const lines = [
    `**${t.queries.size}** types de requêtes, **${t.aggs.size}** agrégations, **${t.filters.size}** filtres Logstash, **${t.processors.size}** processeurs d’ingestion, avec les langages qui vont avec : Painless, syntaxe Lucene et grok. Les cas approchés sont signalés « à vérifier », les cas non traduits « à reprendre », sans jamais passer inaperçus.`,
    '',
    `« Traduit » ne veut pas dire « vérifié ». Le banc différentiel (${fr(c.cases.differential)} cas, décrit juste après) rejoue sur Elasticsearch et sur ClickHouse **${v.queries.size}** de ces types de requêtes et **${v.aggs.size}** de ces agrégations, avec le même résultat. Le banc d’équivalence Logstash / Vector (${fr(c.cases.pipelines)} cas) rejoue **${v.filters.size}** de ces filtres. Les autres sont traduits, couverts par les instantanés de \`tests/snapshots\`, mais pas comparés au moteur d’origine :`,
    '',
    `- requêtes : ${u.queries.length ? code(u.queries) : 'aucune'} ;`,
    `- agrégations : ${u.aggs.length ? code(u.aggs) : 'aucune'} ;`,
    `- filtres Logstash : ${u.filters.length ? code(u.filters) : 'aucun'} ;`,
    '- processeurs d’ingestion : Vector compile le VRL de chacun (`vector validate`) et la CI rejoue les tests de pipeline des intégrations Elastic, sans que ce banc les compte.'
  ];
  return `${BEGIN}\n${lines.join('\n')}\n${END}`;
}

// Le tableau « Couverture détaillée » doit lister exactement ce que le moteur traduit
const ROWS = {
  queries: ['Requêtes'],
  aggs: ['Métriques', 'Regroupements', 'Pipelines d’agrégation'],
  filters: ['Filtres Logstash'],
  processors: ['Pipelines d’ingestion Elasticsearch']
};

export function tableNames(readme) {
  const rows = {};
  for (const l of readme.split('\n')) {
    const cells = l.split('|');
    if (l.startsWith('| ') && cells.length > 3)
      rows[cells[1].trim()] = [...cells[2].matchAll(/`([a-z_0-9]+)`/g)].map(m => m[1]);
  }
  return Object.fromEntries(Object.entries(ROWS).map(([k, labels]) => [k, labels.flatMap(label => rows[label] || [])]));
}

// Les écarts entre le README et ce que le moteur et les bancs montrent ; vide si tout est à jour
export function drift(readme = readFileSync(README, 'utf8'), c = couverture()) {
  const problems = [];
  const b = readme.indexOf(BEGIN);
  const e = readme.indexOf(END);
  if (b < 0 || e < b) problems.push('le README n’a plus le bloc « couverture:début … couverture:fin »');
  else if (readme.slice(b, e + END.length) !== blocReadme(c)) {
    problems.push(
      'le bloc de chiffres du README n’est plus celui que le moteur et les bancs donnent : node scripts/couverture.mjs --ecrire'
    );
  }
  const listed = tableNames(readme);
  const labels = {
    queries: 'requêtes',
    aggs: 'agrégations',
    filters: 'filtres Logstash',
    processors: 'processeurs d’ingestion'
  };
  for (const k of Object.keys(ROWS)) {
    const inTable = new Set(listed[k]);
    const missing = minus(c.translated[k], inTable);
    const extra = minus(inTable, c.translated[k]);
    if (missing.length)
      problems.push(`le tableau du README omet ces ${labels[k]} que le moteur traduit : ${missing.join(', ')}`);
    if (extra.length)
      problems.push(`le tableau du README liste ces ${labels[k]} que le moteur ne traduit pas : ${extra.join(', ')}`);
  }
  return problems;
}

/* ---------- En ligne de commande ---------- */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const c = couverture();
  if (mode === '--ecrire') {
    const readme = readFileSync(README, 'utf8');
    const b = readme.indexOf(BEGIN);
    const e = readme.indexOf(END);
    if (b < 0 || e < b) {
      console.error('README.md : le bloc « couverture:début … couverture:fin » est introuvable');
      process.exit(1);
    }
    writeFileSync(README, readme.slice(0, b) + blocReadme(c) + readme.slice(e + END.length));
    console.log('README.md : bloc de couverture réécrit');
  } else if (mode === '--verifier') {
    const problems = drift(undefined, c);
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) process.exit(1);
    console.log('✓ le README dit ce que le moteur traduit et ce que les bancs vérifient');
  } else {
    const t = c.translated;
    const v = c.verified;
    const row = (label, k) =>
      console.log(
        `${label.padEnd(24)} traduits ${String(t[k].size).padStart(3)}   vérifiés ${k in v ? String(v[k].size).padStart(3) : '  —'}`
      );
    row('types de requêtes', 'queries');
    row('agrégations', 'aggs');
    row('filtres Logstash', 'filters');
    row('processeurs d’ingestion', 'processors');
    for (const [k, names] of Object.entries(c.unverified))
      console.log(`\nnon rejoués (${k}) : ${names.join(' ') || '—'}`);
    const problems = drift(undefined, c);
    if (problems.length) console.log(`\nREADME en écart :\n${problems.map(p => `  - ${p}`).join('\n')}`);
  }
}
