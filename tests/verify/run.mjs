#!/usr/bin/env node
/*
 * Tests de « passerelle verify » (équivalence sur les données du client).
 *   A  le comparateur extrait dans le moteur rend les mêmes écarts que celui des bancs (copie figée : reference.mjs)
 *   B  la fenêtre de temps : « now » figé, bornes, durées
 *   C  une requête sur les deux moteurs (eqRunCase) avec de faux moteurs
 *   D  la ligne de commande, contre un faux Elasticsearch et un faux ClickHouse en HTTP
 *   E  la ligne de commande pour les pipelines, avec de faux Vector et Logstash
 *   F  le pipeline du client réduit à ses filtres = le transport du banc des pipelines
 *   G  les rapports
 * Aucun vrai moteur n’est lancé : les bancs (Docker) prouvent la traduction, ces tests prouvent que la commande
 * compare, signale et se tait comme elle le dit. Linux seulement (les faux binaires sont des scripts exécutables).
 *   node tests/verify/run.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { loadEngine, engineSource, serverSource } from '../../scripts/engine.mjs';
import { diff as RD, pipe as RP } from './reference.mjs';
import { example, translatedPipeline, logstashPipeline, outputsOf } from '../pipelines/transport.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E = loadEngine();
const TMP = mkdtempSync(join(tmpdir(), 'essai-verify-'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${String(detail).slice(0, 600)}`}\n`);
  if (!ok) failures++;
};
const J = JSON.stringify;
const same = (a, b, label) => check(J(a) === J(b), label, `${J(a)} ≠ ${J(b)}`);
const section = name => process.stdout.write(`\n${name}\n`);

const SECRET = 'valeur-secrete-5d2c';

/* ====================================================================== */
section('A. Le comparateur du moteur rend les mêmes écarts que celui des bancs');

const esAggs = {
  by_svc: {
    doc_count_error_upper_bound: 0, sum_other_doc_count: 0,
    buckets: [
      { key: 'svc-a', doc_count: 5, lat: { value: 12.5 }, p95: { values: { '95.0': 80.1 } }, st: { count: 5, min: 1, max: 9, avg: 4.2, sum: 21 }, errs: { doc_count: 2, lat_e: { value: 3 } } },
      { key: SECRET, doc_count: 3, lat: { value: 7 }, p95: { values: { '95.0': 11 } }, st: { count: 3, min: 2, max: 5, avg: 3, sum: 9 }, errs: { doc_count: 0, lat_e: { value: null } } }
    ]
  },
  by_day: { buckets: [{ key: 1792800000000, key_as_string: '2026-10-24T00:00:00.000Z', doc_count: 8 }, { key: 1792886400000, key_as_string: '2026-10-25T00:00:00.000Z', doc_count: 4 }] },
  named: { buckets: { e: { doc_count: 2 }, f: { doc_count: 1 } } }
};
const esDefs = {
  by_svc: { terms: { field: 'svc' }, aggs: { lat: { avg: { field: 'l' } }, p95: { percentiles: { field: 'l', percents: [95] } }, st: { stats: { field: 'l' } }, errs: { filter: { term: { x: 1 } }, aggs: { lat_e: { avg: { field: 'l' } } } } } },
  by_day: { date_histogram: { field: 'ts', calendar_interval: 'day' } },
  named: { filters: { filters: { e: { term: { a: 1 } }, f: { term: { a: 2 } } } } }
};
for (const path of [['by_svc'], ['by_day'], ['named']]) {
  const a = E.eqBucketRows(esAggs, esDefs, path); const b = RD.esBucketRows(esAggs, esDefs, path);
  same({ rows: a, keyed: a.keyed }, { rows: b, keyed: b.keyed }, `lignes d’une agrégation (${path[0]}) : mêmes lignes`);
}
same(E.eqLeafMetrics(esAggs.by_svc.buckets[0], esDefs.by_svc.aggs), RD.leafMetrics(esAggs.by_svc.buckets[0], esDefs.by_svc.aggs), 'mesures d’un groupe : les mêmes');
const shapes = {
  value: [{ value: 3, keys: ['k'] }, null], percentiles: [{ values: { '50.0': 1, '99.0': 9 } }, 'percentiles'], ranks: [{ values: { '10.0': 0.2 } }, 'percentile_ranks'],
  stats: [{ count: 2, min: 1, max: 3, avg: 2, sum: 4 }, null], extended: [{ count: 2, min: 1, max: 3, avg: 2, sum: 4, variance: 1, std_deviation: 1, sum_of_squares: 10 }, null],
  top: [{ top: [{ sort: [1], metrics: { x: 7 } }] }, null], top2: [{ top: [{ metrics: { x: 7 } }, { metrics: { x: 8 } }] }, null],
  hits: [{ hits: { hits: [] } }, null], docs: [{ doc_count: 4 }, null], scalar: [5, null], buckets: [{ buckets: [] }, null]
};
for (const [name, [agg, type]] of Object.entries(shapes)) same(E.eqMetricColumns('m', agg, type), RD.metricColumns('m', agg, type), `colonnes d’une mesure « ${name} » : les mêmes`);

const chBase = [
  { by_svc: 'svc-a', doc_count: 5, lat: 12.5, p95: [80.1], st_count: 5, st_min: 1, st_max: 9, st_avg: 4.2, st_sum: 21, errs_doc_count: 2, errs_lat_e: 3 },
  { by_svc: SECRET, doc_count: 3, lat: 7, p95: [11], st_count: 3, st_min: 2, st_max: 5, st_avg: 3, st_sum: 9, errs_doc_count: 0, errs_lat_e: null }
];
const clone = x => JSON.parse(J(x));
const variants = {
  identiques: chBase,
  'ordre inversé': chBase.slice().reverse(),
  'écart de 1e-12 (dans la tolérance)': (() => { const r = clone(chBase); r[0].lat += 1e-12; return r; })(),
  'mesure fausse': (() => { const r = clone(chBase); r[0].lat = 13; return r; })(),
  'doc_count faux': (() => { const r = clone(chBase); r[1].doc_count = 4; return r; })(),
  'ligne manquante': chBase.slice(0, 1),
  'ligne en trop': chBase.concat([{ by_svc: 'svc-z', doc_count: 1, lat: 1, p95: [1], st_count: 1, st_min: 1, st_max: 1, st_avg: 1, st_sum: 1, errs_doc_count: 0, errs_lat_e: null }]),
  'clé remplacée': (() => { const r = clone(chBase); r[1].by_svc = 'autre'; return r; })(),
  'colonne absente': (() => { const r = clone(chBase); delete r[0].lat; return r; })(),
  'tableau vide': []
};
const esRows = E.eqBucketRows(esAggs, esDefs, ['by_svc']);
for (const [name, rows] of Object.entries(variants)) {
  for (const unordered of [false, true]) {
    same(E.eqCompareRows(esRows, rows, undefined, unordered), RD.compareRows(RD.esBucketRows(esAggs, esDefs, ['by_svc']), rows, undefined, unordered), `lignes (${name}${unordered ? ', sans ordre' : ''}) : mêmes écarts`);
  }
}
same(E.eqCompareRows(esRows, variants['mesure fausse'], 0.1), RD.compareRows(esRows, variants['mesure fausse'], 0.1), 'tolérance relative 0,1 : mêmes écarts');
const dayRows = E.eqBucketRows(esAggs, esDefs, ['by_day']);
for (const [name, ch] of Object.entries({
  'dates ISO': [{ by_day: '2026-10-24T00:00:00.000Z', doc_count: 8 }, { by_day: '2026-10-25T00:00:00.000Z', doc_count: 4 }],
  'jours sans heure': [{ by_day: '2026-10-24', doc_count: 8 }, { by_day: '2026-10-25', doc_count: 4 }],
  'jour faux': [{ by_day: '2026-10-24', doc_count: 8 }, { by_day: '2026-10-26', doc_count: 4 }]
})) same(E.eqCompareRows(dayRows, ch), RD.compareRows(RD.esBucketRows(esAggs, esDefs, ['by_day']), ch), `dates (${name}) : mêmes écarts`);
for (const [name, [a, b]] of Object.entries({ égaux: [['1', '2'], ['1', '2']], 'ordre différent': [['1', '2'], ['2', '1']], 'documents différents': [['1', '2'], ['1', '3']], 'longueurs différentes': [['1'], ['1', '2']] })) {
  same(E.eqCompareIds('docs', a, b), RD.compareIds('docs', a, b), `identifiants (${name}) : mêmes écarts`);
}

// Rien de ce que le client a comme données ne figure dans la version « sans valeurs »
{
  let leaks = 0; let counted = 0;
  for (const rows of Object.values(variants)) {
    for (const d of E.eqCompareRowsDetailed(esRows, rows)) { counted++; if (d.safe.includes(SECRET) || d.safe.includes('svc-a') || d.safe.includes('autre')) leaks++; }
  }
  check(counted > 0 && leaks === 0, `version sans valeurs des écarts de lignes : ${counted} écarts, aucune valeur citée`, `${leaks} fuite(s)`);
  const ids = E.eqCompareIdsDetailed('par_service ["svc-a"]', ['id-secret-1', 'id-secret-2'], ['id-secret-1', 'id-secret-9'], 'par_service');
  check(ids.length === 1 && !/secret|svc-a/.test(ids[0].safe) && /secret/.test(ids[0].text), 'version sans valeurs des écarts d’identifiants : libellé et identifiants masqués', J(ids));
}

// Pipelines : normalisation, alignement, comparaison
const win = [Date.parse('2026-10-28T10:00:00Z'), Date.parse('2026-10-28T10:00:30Z')];
const U1 = '3f2a9c1e-77aa-4b1d-9e0f-0123456789ab'; const U2 = '9a8b7c6d-1111-4222-8333-444455556666';
for (const [name, ev] of Object.entries({
  'horodatage dans la fenêtre': { '@timestamp': '2026-10-28T10:00:10.123Z', a: 1 },
  'horodatage hors fenêtre': { '@timestamp': '2020-01-01T00:00:00.000Z', a: 1 },
  'horodatage sans décimales': { '@timestamp': '2026-10-28T10:00:10Z' },
  uuid: { id: U1, nested: { u: U2, list: [U1] } },
  'valeur ordinaire': { a: [1, { b: 'x' }], c: null }
})) for (const exact of [[], ['horodatage']]) same(E.eqNormalizeEvent(ev, win, exact), RP.normalize(ev, { exact }, win), `normalisation (${name}${exact.length ? ', exacte' : ''}) : la même`);

const pc = { id: 'x', exact: [], output: o => `if [niveau] == "erreur" { ${o('erreurs')} } else { ${o('autres')} }` };
const ev = (n, extra) => Object.assign({ n, '@timestamp': '2026-10-28T10:00:10.123Z', user: SECRET, u: n % 2 ? U1 : U2 }, extra);
const base = { erreurs: [ev(1), ev(2)], autres: [ev(3), ev(4), ev(5), ev(6), ev(7)] };
const mk = f => { const o = clone(base); f(o); return o; };
const pipeCases = {
  identiques: base,
  'uuid différents, même forme': mk(o => { o.autres[0].u = U2; o.autres[1].u = U1; }),
  'horodatage de précision différente': mk(o => { o.autres[0]['@timestamp'] = '2026-10-28T10:00:11.1Z'; }),
  'un événement perdu': mk(o => { o.autres.splice(1, 1); }),
  'un événement en plus': mk(o => { o.autres.push(ev(8)); }),
  'type différent (42 / "42")': mk(o => { o.erreurs[0].n = '1'; }),
  'champ imbriqué absent': mk(o => { delete o.autres[2].user; }),
  'champ en plus': mk(o => { o.autres[2].extra = { deep: { x: 1 } }; }),
  'deux sorties qui diffèrent': mk(o => { o.erreurs.pop(); o.autres[0].n = 99; }),
  'événements permutés': mk(o => { o.autres.reverse(); }),
  vide: { erreurs: [], autres: [] }
};
for (const exact of [[], ['horodatage']]) {
  for (const [name, vec] of Object.entries(pipeCases)) {
    const c = Object.assign({}, pc, { exact });
    const old = RP.compare(c, { outputs: base }, { outputs: vec }, win);
    const r = E.eqComparePipelineOutputs(base, vec, outputsOf(c), win, { exact });
    const nu = { verdict: r.diffs.length ? '≠' : '=', detail: r.diffs.map(d => d.text).join(' || ') };
    same(nu, old, `événements (${name}${exact.length ? ', horodatage exact' : ''}) : mêmes écarts`);
    if (exact.length === 0) check(!r.diffs.some(d => d.safe.includes(SECRET)), `événements (${name}) : la version sans valeurs ne cite aucune valeur`, J(r.diffs.map(d => d.safe)));
  }
}
{
  // Un échantillon de plusieurs milliers d’événements : au-delà de la table d’alignement, mêmes écarts quand ils sont rares
  const big = Array.from({ length: 2100 }, (_, i) => ({ n: i, v: `v${i}` }));
  const a = big.map(e => E.eqCanon(e));
  const withHole = big.slice(); withHole[1000] = { n: 1000, v: 'autre' };
  const b = withHole.map(e => E.eqCanon(e));
  same(E.eqAlign(a, b), RP.align(a, b), 'alignement de 2100 événements, un écart au milieu : le même qu’avec la table complète');
  const t0 = Date.now();
  const allDiff = Array.from({ length: 2100 }, (_, i) => E.eqCanon({ n: i, v: 'x' }));
  const gaps = E.eqAlign(a, allDiff);
  check(gaps.length === 1 && gaps[0].a.length === 2100 && gaps[0].b.length === 2100 && Date.now() - t0 < 2000, 'alignement de deux suites entièrement différentes, au-delà de la table : appariées dans l’ordre, sans table', J(gaps.map(g => [g.a.length, g.b.length])));
  const missingHead = E.eqAlign(a.slice(5), a);
  check(missingHead.length === 1 && missingHead[0].a.length === 0 && missingHead[0].b.length === 5, 'alignement : cinq événements en tête d’une seule des suites', J(missingHead.map(g => [g.a.length, g.b.length])));
}

/* ====================================================================== */
section('B. La fenêtre de temps');

{
  const NOW = Date.parse('2026-10-28T12:34:56.789Z');
  const pin = E.eqPinNow({ query: { bool: { filter: [{ range: { '@timestamp': { gte: 'now-15m/m', lte: 'now' } } }, { range: { day: { gt: 'now/d' } } }], must: [{ match: { message: { query: 'now-15m' } } }, { range: { d: { gte: 'now-1d', format: 'epoch_millis' } } }, { script: { script: { source: "doc['x'].value > 'now'" } } }] } }, aggs: { h: { date_range: { field: 't', ranges: [{ from: 'now-7d', to: 'now' }] } } } }, NOW);
  const s = J(pin.dsl);
  check(s.includes('"gte":"2026-10-28T12:34:56.789Z||-15m/m"') && s.includes('"lte":"2026-10-28T12:34:56.789Z"'), 'now-15m/m et now sont figés à l’instant de fin de fenêtre (date math d’Elasticsearch)', s);
  check(s.includes('"gt":"2026-10-28T12:34:56.789Z||/d"'), 'now/d devient <instant>||/d', s);
  check(s.includes('"from":"2026-10-28T12:34:56.789Z||-7d"') && s.includes('"to":"2026-10-28T12:34:56.789Z"'), 'les bornes d’une date_range sont figées aussi', s);
  check(s.includes('"query":"now-15m"') && s.includes("'now'") && s.includes('"gte":"now-1d"'), 'un texte recherché, un script et une borne dotée d’un format ne sont pas touchés', s);
  check(pin.pinned === 5, 'cinq bornes figées', pin.pinned);
  const none = E.eqPinNow({ query: { match_all: {} } }, NOW);
  check(none.pinned === 0 && J(none.dsl) === J({ query: { match_all: {} } }), 'une requête sans « now » reste telle quelle');

  const dsl = { query: { term: { a: 1 } }, size: 0 };
  const bound = E.eqBoundWindow(dsl, '@timestamp', Date.parse('2026-10-28T10:00:00Z'), Date.parse('2026-10-28T11:00:00Z'));
  same(bound, { query: { bool: { must: [{ term: { a: 1 } }], filter: [{ range: { '@timestamp': { gte: '2026-10-28T10:00:00.000Z', lt: '2026-10-28T11:00:00.000Z' } } }] } }, size: 0 }, 'la fenêtre s’ajoute en filtre, la requête d’origine reste en must');
  check(J(dsl) === J({ query: { term: { a: 1 } }, size: 0 }), 'la requête d’origine n’est pas modifiée');
  check(J(E.eqBoundWindow({ size: 1 }, 'ts', 0, 1000).query.bool.must) === undefined, 'sans requête, seul le filtre de fenêtre est posé');

  same(E.eqWindow({}, NOW), { from: Date.parse('2026-10-28T11:24:00Z'), to: Date.parse('2026-10-28T12:24:00Z'), explicit: false }, 'fenêtre par défaut : 1 h se terminant 10 min avant, arrondie à la minute');
  same(E.eqWindow({ length: '2h', lag: '30m' }, NOW), { from: Date.parse('2026-10-28T10:04:00Z'), to: Date.parse('2026-10-28T12:04:00Z'), explicit: false }, 'fenêtre de 2 h, retard de 30 min');
  const again = E.eqWindow({}, NOW + 3000);
  check(again.to === E.eqWindow({}, NOW).to, 'deux lancements dans la même minute : les mêmes bornes');
  same(E.eqWindow({ from: '2026-10-28T10:00:00Z', to: '2026-10-28T11:00:00Z' }, NOW), { from: Date.parse('2026-10-28T10:00:00Z'), to: Date.parse('2026-10-28T11:00:00Z'), explicit: true }, 'fenêtre explicite');
  same(E.eqWindow({ from: '2026-10-28T10:00:00Z' }, NOW).to, NOW, 'fenêtre explicite sans fin : jusqu’au lancement');
  check(/ISO 8601/.test(E.eqWindow({ from: 'hier' }, NOW).error), 'date illisible refusée');
  check(/précéder/.test(E.eqWindow({ from: '2026-10-28T11:00:00Z', to: '2026-10-28T10:00:00Z' }, NOW).error), 'fenêtre à l’envers refusée');
  check(/90s, 15m, 2h ou 7d/.test(E.eqWindow({ length: 'une heure' }, NOW).error), 'durée illisible refusée');
  same(['90s', '15m', '2h', '7d', ' 5 m ', '1.5h', '', 'h', '-1h'].map(E.eqDuration), [90000, 900000, 7200000, 604800000, 300000, null, null, null, null], 'durées : 90s 15m 2h 7d, le reste refusé');

  const cfg = E.mergeConfig(E.DEFAULT_CONFIG, {});
  check(E.eqTimeField(cfg, 'logs.events') === '@timestamp', 'champ de temps côté Elasticsearch : celui que field_mapping envoie sur la colonne de temps');
  check(E.eqTimeField(E.mergeConfig(cfg, { clickhouse: { time_field: 'event_time', field_mapping: { 'event.created': 'event_time' } } }), 'logs.events') === 'event.created', 'champ de temps : suit le field_mapping de la configuration');
  check(E.eqTimeField(E.mergeConfig(cfg, { verify: { time_field: 'date_reception' } }), 'logs.events') === 'date_reception', 'verify.time_field l’emporte');
}

/* ====================================================================== */
section('C. Une requête sur les deux moteurs (eqRunCase)');

{
  const cfg = E.mergeConfig(E.DEFAULT_CONFIG, {});
  const translate = dsl => E.translateDSL(J(dsl), cfg, { index: 'logs-app' });
  const calls = { es: 0, sql: 0 };
  const ok = (value, over) => ({ status: 200, body: Object.assign({ took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value, relation: 'eq' }, hits: [] } }, over) });
  const io = (es, ch, over) => Object.assign({
    translate,
    search: async () => { calls.es++; return typeof es === 'function' ? es() : es; },
    searchPit: async () => ({ status: 0, body: {} }),
    sql: async s => { calls.sql++; return typeof ch === 'function' ? ch(s) : ch; }
  }, over);
  const count = { size: 0, query: { term: { 'service.name': 'a' } } };

  let r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { rows: [{ count: 3 }] }));
  check(r.verdict === '=' && r.docs === 3 && E.eqStateOf(r).state === 'identical', 'mêmes comptes : identique');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { rows: [{ count: 4 }] }));
  check(r.verdict === '≠' && E.eqStateOf(r).state === 'different' && /ES 3 \/ CH 4/.test(r.diffs[0].text) && !/3|4/.test(r.diffs[0].safe), 'comptes différents : différent, valeurs absentes de la version sans valeurs', J(r.diffs));
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(0), { rows: [{ count: 0 }] }));
  check(r.verdict === '=' && E.eqStateOf(r).state === 'inconclusive' && /rien prouver/.test(E.eqStateOf(r).reason), 'zéro document des deux côtés : non concluant, pas identique');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io({ status: 400, body: { error: { root_cause: [{ type: 'parsing_exception', reason: 'mauvaise requête' }] } } }, { rows: [{ count: 0 }] }));
  check(r.verdict === 'ES✗' && E.eqStateOf(r).state === 'error' && /parsing_exception/.test(E.eqStateOf(r).reason), 'Elasticsearch refuse alors que la traduction ne signale rien : en erreur');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3, { timed_out: true }), { rows: [{ count: 3 }] }));
  check(r.verdict === 'ES✗' && /partielle/.test(r.detail), 'réponse partielle (délai dépassé) : jamais comptée comme égale');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3, { _shards: { total: 3, successful: 2, failed: 1 } }), { rows: [{ count: 3 }] }));
  check(r.verdict === 'ES✗' && /1 shard/.test(r.detail), 'un shard en échec : jamais compté comme égal');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { error: 'Code: 62. DB::Exception: Syntax error' }));
  check(r.verdict === 'CH✗' && E.eqStateOf(r).state === 'error' && /ClickHouse/.test(E.eqStateOf(r).reason), 'ClickHouse refuse le SQL : en erreur');

  calls.es = 0;
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { rows: [] }, { translate: () => ({ error: 'construction inconnue' }) }));
  check(r.verdict === 'TR✗' && calls.es === 0 && /traduction/.test(E.eqStateOf(r).reason), 'traduction en erreur : aucun appel à Elasticsearch (noProbe)');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { rows: [] }, { translate: () => ({ statements: [], stats: { ok: 0, approx: 0, ko: 1 } }) }));
  check(r.verdict === 'RP' && calls.es === 0 && E.eqStateOf(r).state === 'not_compared', 'traduction « à reprendre » : non comparée, aucun appel à Elasticsearch');
  r = await E.eqRunCase({ dsl: count, noProbe: true, skipTodo: true }, io(ok(3), { rows: [{ count: 3 }] }, { translate: () => ({ statements: [{ title: 'Comptage', sql: 'x' }, { title: 'Instruction inconnue', sql: 'y' }], stats: { ok: 2, approx: 0, ko: 0 } }) }));
  check(r.verdict === '=' && J(r.skipped) === '["Instruction inconnue"]' && E.eqStateOf(r).state === 'inconclusive' && /Instruction inconnue/.test(E.eqStateOf(r).reason), 'une instruction que le comparateur ne sait pas lire : non concluant, jamais identique');

  // Agrégations : mêmes lignes, ligne fausse, marge d’erreur annoncée par Elasticsearch
  const terms = { size: 0, aggs: { by_status: { terms: { field: 'http.response.status_code', size: 5 }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } };
  const esTerms = bound => ok(8, { aggregations: { by_status: { doc_count_error_upper_bound: bound, sum_other_doc_count: 0, buckets: [{ key: 200, doc_count: 5, lat: { value: 12.5 } }, { key: 500, doc_count: 3, lat: { value: 40 } }] } } });
  r = await E.eqRunCase({ dsl: terms, skipTodo: true }, io(esTerms(0), { rows: [{ by_status: 200, doc_count: 5, lat: 12.5 }, { by_status: 500, doc_count: 3, lat: 40 }] }));
  check(r.verdict === '=' && r.compared === 1, 'agrégation terms + avg : identique', J(r));
  const wrong = { rows: [{ by_status: 200, doc_count: 5, lat: 12.5 }, { by_status: 500, doc_count: 3, lat: 41 }] };
  r = await E.eqRunCase({ dsl: terms, skipTodo: true }, io(esTerms(0), wrong));
  check(r.verdict === '≠' && E.eqStateOf(r).reason === '' && /lat/.test(r.diffs[0].text) && !/41/.test(r.diffs[0].safe), 'agrégation : une mesure fausse est un écart, la version sans valeurs ne la cite pas', J(r.diffs));
  r = await E.eqRunCase({ dsl: terms, skipTodo: true }, io(esTerms(7), wrong));
  check(E.eqStateOf(r).state === 'different' && /doc_count_error_upper_bound jusqu’à 7/.test(E.eqStateOf(r).reason), 'écart sur un terms dont Elasticsearch annonce une marge d’erreur : signalé comme possible estimation', E.eqStateOf(r).reason);

  // Agrégation composite : pages lues jusqu’au bout, reprise « après » la dernière clé
  const comp = { size: 0, aggs: { c: { composite: { size: 2, sources: [{ svc: { terms: { field: 'service.name' } } }] } } } };
  const pagesEs = [
    { buckets: [{ key: { svc: 'a' }, doc_count: 2 }, { key: { svc: 'b' }, doc_count: 3 }], after_key: { svc: 'b' } },
    { buckets: [{ key: { svc: 'c' }, doc_count: 1 }] }
  ];
  let page = 0; const sqls = [];
  const esPaged = () => ok(6, { aggregations: { c: pagesEs[page++] } });
  const chPaged = s => {
    sqls.push(s);
    if (/svc > 'b'/.test(s)) return { rows: [{ svc: 'c', doc_count: 1 }] };
    return { rows: [{ svc: 'a', doc_count: 2 }, { svc: 'b', doc_count: 3 }] };
  };
  r = await E.eqRunCase({ dsl: comp, composite: 'c', tol: 1e-9, skipTodo: true }, io(esPaged, chPaged));
  check(r.verdict === '=' && r.rows === 3 && sqls.length === 2 && /svc > 'b'/.test(sqls[1]), 'composite : deux pages de chaque côté, la seconde reprend après la clé « b »', J({ v: r.verdict, d: r.detail, n: sqls.length }));
  page = 0;
  r = await E.eqRunCase({ dsl: comp, composite: 'c', tol: 1e-9, skipTodo: true }, io(esPaged, () => ({ rows: [{ svc: 'a', doc_count: 2 }, { svc: 'b', doc_count: 3 }] })));
  check(r.verdict === '≠' && /pagination bouclée/.test(r.detail) && !/'a'|"a"/.test(r.safe), 'composite : une pagination qui boucle côté ClickHouse est un écart, pas une boucle infinie', J(r));
  page = 0;
  r = await E.eqRunCase({ dsl: comp, composite: 'c', tol: 1e-9, skipTodo: true }, io(esPaged, chPaged.bind(null)));
  const never = () => ok(6, { aggregations: { c: { buckets: [{ key: { svc: 'a' }, doc_count: 1 }], after_key: { svc: 'a' } } } });
  r = await E.eqRunCase({ dsl: comp, composite: 'c', tol: 1e-9, skipTodo: true }, io(never, { rows: [] }));
  check(r.verdict === 'INC' && E.eqStateOf(r).state === 'inconclusive', 'composite : plus de 500 pages côté Elasticsearch, comparaison interrompue (non concluant)');

  // Fenêtre : toutes les requêtes rejouées sur les deux moteurs portent la même fenêtre
  const pinned = E.eqBoundWindow(E.eqPinNow({ size: 0, query: { range: { '@timestamp': { gte: 'now-30m' } } } }, Date.parse('2026-10-28T11:00:00Z')).dsl, '@timestamp', Date.parse('2026-10-28T10:00:00Z'), Date.parse('2026-10-28T11:00:00Z'));
  const t = translate(pinned);
  check(!t.error && /2026-10-28T10:30:00\.000Z|INTERVAL 30 MINUTE/.test(t.statements[0].sql) && /10:00:00\.000Z/.test(t.statements[0].sql), 'la requête figée se traduit avec les mêmes bornes que celles envoyées à Elasticsearch', t.error || t.statements[0].sql);
}

/* ====================================================================== */
section('D. passerelle verify queries (faux Elasticsearch et faux ClickHouse)');

const DOCS = [
  { _id: 'a0', ts: '2026-10-28T09:50:00.000Z', svc: 'svc-alpha-7f3', status: 200, lat: 1 },
  { _id: 'a1', ts: '2026-10-28T10:05:00.000Z', svc: 'svc-alpha-7f3', status: 200, lat: 10 },
  { _id: 'a2', ts: '2026-10-28T10:20:00.000Z', svc: 'svc-alpha-7f3', status: 500, lat: 30 },
  { _id: 'a3', ts: '2026-10-28T10:40:00.000Z', svc: 'svc-beta-9c1', status: 200, lat: 20 },
  { _id: 'a4', ts: '2026-10-28T10:50:00.000Z', svc: 'svc-beta-9c1', status: 200, lat: 40 },
  { _id: 'a5', ts: '2026-10-28T11:10:00.000Z', svc: 'svc-alpha-7f3', status: 500, lat: 99 }
];
const FIELD = { 'service.name': 'svc', 'http.response.status_code': 'status', latency_ms: 'lat', '@timestamp': 'ts' };
const world = { es: DOCS, ch: DOCS };
const esLog = []; const chLog = [];

const dateMath = s => { const m = /^(.*?)(?:\|\|-(\d+)m)?$/.exec(String(s)); return Date.parse(m[1]) - (m[2] ? Number(m[2]) * 60000 : 0); };
function esMatch(d, q) {
  if (!q || q.match_all) return true;
  if (q.bool) return [].concat(q.bool.must || [], q.bool.filter || []).every(x => esMatch(d, x));
  if (q.term) { const [f, v] = Object.entries(q.term)[0]; return d[FIELD[f]] === v; }
  if (q.range) {
    const r = Object.values(q.range)[0]; const t = Date.parse(d.ts);
    return (r.gte === undefined || t >= dateMath(r.gte)) && (r.gt === undefined || t > dateMath(r.gt)) && (r.lt === undefined || t < dateMath(r.lt)) && (r.lte === undefined || t <= dateMath(r.lte));
  }
  throw new Error(`faux Elasticsearch : requête non prévue ${J(q)}`);
}
const group = (docs, f) => { const m = new Map(); for (const d of docs) { const k = d[f]; (m.get(k) || m.set(k, []).get(k)).push(d); } return m; };
const avg = (docs, f) => docs.reduce((s, d) => s + d[f], 0) / docs.length;
function fakeEsSearch(body) {
  const hits = world.es.filter(d => esMatch(d, body.query));
  const res = { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: hits.length, relation: 'eq' }, hits: [] } };
  if (body.size) res.hits.hits = hits.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, body.size).map(d => ({ _id: d._id, _source: d }));
  const aggs = body.aggs || body.aggregations;
  if (aggs) {
    res.aggregations = {};
    for (const [name, def] of Object.entries(aggs)) {
      if (def.terms) {
        const g = [...group(hits, FIELD[def.terms.field]).entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, def.terms.size || 10);
        res.aggregations[name] = { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: g.map(([key, docs]) => Object.assign({ key, doc_count: docs.length }, ...Object.entries(def.aggs || {}).map(([n, s]) => ({ [n]: { value: avg(docs, FIELD[s.avg.field]) } })))) };
      } else if (def.composite) {
        const src = Object.keys(def.composite.sources[0])[0]; const f = FIELD[def.composite.sources[0][src].terms.field];
        const after = def.composite.after ? def.composite.after[src] : null;
        const g = [...group(hits, f).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).filter(([k]) => after === null || k > after).slice(0, def.composite.size);
        res.aggregations[name] = { buckets: g.map(([k, docs]) => ({ key: { [src]: k }, doc_count: docs.length })) };
        if (g.length) res.aggregations[name].after_key = { [src]: g[g.length - 1][0] };
      } else throw new Error(`faux Elasticsearch : agrégation non prévue ${J(def)}`);
    }
  }
  return res;
}
function fakeChAnswer(sql) {
  if (/^SELECT version\(\)/.test(sql)) return [{ v: '24.8.1.2' }];
  const lits = [...sql.matchAll(/parseDateTime64BestEffort\('([^']+)'/g)].map(m => Date.parse(m[1]));
  const [from, to] = lits.slice(-2);
  let rows = world.ch.filter(d => Date.parse(d.ts) >= from && Date.parse(d.ts) < to);
  const iv = /parseDateTime64BestEffort\('([^']+)', 3, 'UTC'\) - INTERVAL (\d+) MINUTE/.exec(sql);
  if (iv) rows = rows.filter(d => Date.parse(d.ts) >= Date.parse(iv[1]) - Number(iv[2]) * 60000);
  const svc = /service\.name = '([^']+)'/.exec(sql);
  if (svc) rows = rows.filter(d => d.svc === svc[1]);
  const limit = Number((/LIMIT (\d+)/.exec(sql) || [])[1] || 1e9);
  if (/count\(\) AS count\s+FROM/.test(sql) && !/GROUP BY/.test(sql)) return [{ count: rows.length }];
  if (/GROUP BY by_status/.test(sql)) return [...group(rows, 'status').entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]).slice(0, limit).map(([k, docs]) => ({ by_status: k, doc_count: docs.length, lat: avg(docs, 'lat') }));
  if (/GROUP BY svc/.test(sql)) {
    const after = /svc > '([^']+)'/.exec(sql);
    return [...group(rows, 'svc').entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).filter(([k]) => !after || k > after[1]).slice(0, limit).map(([k, docs]) => ({ svc: k, doc_count: docs.length }));
  }
  if (/^SELECT\s+\*\s+FROM/.test(sql)) return rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit).map(d => ({ _id: d._id, timestamp: d.ts, 'service.name': d.svc }));
  throw new Error(`faux ClickHouse : requête non prévue\n${sql}`);
}
const readBody = req => new Promise(r => { let b = ''; req.setEncoding('utf8'); req.on('data', d => { b += d; }); req.on('end', () => r(b)); });
const esServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  esLog.push({ method: req.method, url: req.url, headers: req.headers, body });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/') { res.end(J({ name: 'es-1', cluster_name: 'es-prod-cluster-SECRET2', version: { number: '8.15.1' } })); return; }
  if (req.method === 'POST' && /^\/logs-app\/_search\?/.test(req.url)) {
    try { res.end(J(fakeEsSearch(JSON.parse(body)))); } catch (e) { res.statusCode = 400; res.end(J({ error: { root_cause: [{ type: 'faux_moteur', reason: e.message }] }, status: 400 })); }
    return;
  }
  res.statusCode = 404; res.end(J({ error: 'inconnu' }));
});
const chServer = http.createServer(async (req, res) => {
  const sql = (await readBody(req)).trim();
  chLog.push({ method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, sql });
  try { res.end(fakeChAnswer(sql).map(r => J(r)).join('\n') + '\n'); } catch (e) { res.statusCode = 500; res.end(`Code: 62. DB::Exception: ${e.message.split('\n')[0]}\n`); }
});
await new Promise(r => esServer.listen(0, '127.0.0.1', r));
await new Promise(r => chServer.listen(0, '127.0.0.1', r));
const ES_URL = `http://127.0.0.1:${esServer.address().port}`;
const CH_URL = `http://127.0.0.1:${chServer.address().port}`;

const BIN = join(TMP, 'passerelle.cjs');
writeFileSync(BIN, "'use strict';\n" + engineSource() + serverSource());
const CONFIG = join(TMP, 'passerelle.json');
writeFileSync(CONFIG, J({ clickhouse: { endpoint: CH_URL }, elasticsearch: { endpoint: ES_URL } }));

const QDIR = join(TMP, 'requetes');
mkdirSync(QDIR);
const queryFiles = {
  'q1-compte.json': { size: 0, query: { term: { 'service.name': 'svc-alpha-7f3' } } },
  'q2-statuts.json': { size: 0, aggs: { by_status: { terms: { field: 'http.response.status_code', size: 5 }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } },
  'q3-documents.json': { size: 3, sort: [{ '@timestamp': 'desc' }], query: { range: { '@timestamp': { gte: 'now-30m' } } } },
  'q4-composite.json': { size: 0, aggs: { c: { composite: { size: 2, sources: [{ svc: { terms: { field: 'service.name' } } }] } } } }
};
for (const [name, q] of Object.entries(queryFiles)) writeFileSync(join(QDIR, name), J(q, null, 2));
const WINDOW = ['--from', '2026-10-28T10:00:00Z', '--to', '2026-10-28T11:00:00Z'];

function cli(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: Object.assign({ PATH: process.env.PATH, PASSERELLE_CONFIG: CONFIG, CLICKHOUSE_USER: 'lecteur-ch', CLICKHOUSE_PASSWORD: 'mdp-ch-91' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const json = r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } };
const states = rep => Object.fromEntries(rep.items.map(i => [i.title, i.state]));

{
  world.es = DOCS; world.ch = DOCS;
  esLog.length = 0; chLog.length = 0;
  let r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--format', 'json'], { ES_USER: 'lecteur-es', ES_PASSWORD: 'mdp-es-77' });
  let rep = json(r);
  check(r.code === 0 && rep, 'données identiques : code de sortie 0', `${r.code} ${r.stderr}`);
  if (rep) {
    same(states(rep), { 'q1-compte.json': 'identical', 'q2-statuts.json': 'identical', 'q3-documents.json': 'identical', 'q4-composite.json': 'identical' }, 'les quatre requêtes (compte, statuts, documents, composite) sont identiques');
    check(rep.kind === 'queries' && rep.summary.total === 4 && rep.summary.byState.identical === 4, 'bilan : 4 identiques');
    check(rep.conditions.window.from === Date.parse('2026-10-28T10:00:00Z') && rep.conditions.window.to === Date.parse('2026-10-28T11:00:00Z') && rep.conditions.window.explicit && rep.conditions.window.field === '@timestamp', 'la fenêtre du rapport est celle demandée, sur @timestamp');
    check(/8\.15\.1/.test(rep.conditions.engines.Elasticsearch) && /24\.8\.1\.2/.test(rep.conditions.engines.ClickHouse), 'le rapport donne les versions des deux moteurs');
    check(rep.items.every(i => i.docs !== null && i.docs > 0 && i.translation && i.table === 'logs.events'), 'chaque ligne du rapport porte son nombre de documents, sa traduction et sa table');
    check(!isNaN(Date.parse(rep.generated_at)) && rep.passerelle, 'le rapport est daté et porte la version de Passerelle');
    same(rep.items.map(i => i.docs), [2, 4, 2, 4], 'documents lus dans la fenêtre : 2, 4, 2, 4');
  }
  // Lecture seule des deux côtés
  const esOk = esLog.every(x => (x.method === 'GET' && x.url === '/') || (x.method === 'POST' && /^\/logs-app\/_search\?allow_partial_search_results=false$/.test(x.url)));
  check(esLog.length > 0 && esOk, 'Elasticsearch ne reçoit que GET / et POST /<index>/_search?allow_partial_search_results=false', J(esLog.map(x => `${x.method} ${x.url}`)));
  const searches = esLog.filter(x => x.method === 'POST').map(x => JSON.parse(x.body));
  check(searches.length >= 5 && searches.every(b => b.track_total_hits === true && /^\d+s$/.test(b.timeout)), 'chaque _search demande des décomptes exacts (track_total_hits) et porte un délai');
  check(searches.every(b => !J(b).includes('"now')), 'aucune borne « now » ne part vers Elasticsearch : toutes sont figées');
  check(searches.every(b => J(b.query).includes('2026-10-28T10:00:00.000Z') && J(b.query).includes('2026-10-28T11:00:00.000Z')), 'chaque _search porte la fenêtre');
  const chOk = chLog.every(x => x.method === 'POST' && x.url.searchParams.get('readonly') === '1' && /^SELECT\b/.test(x.sql));
  check(chLog.length > 0 && chOk, 'ClickHouse ne reçoit que des SELECT sous readonly = 1', J(chLog.filter(x => !(x.url.searchParams.get('readonly') === '1' && /^SELECT\b/.test(x.sql))).map(x => x.sql.slice(0, 60))));
  check(chLog.every(x => x.url.searchParams.get('database') === 'logs' && x.url.searchParams.get('max_execution_time') === '60' && x.url.searchParams.get('default_format') === 'JSONEachRow'), 'ClickHouse : base, délai d’exécution et format réglés par requête');
  check(esLog.every(x => x.headers.authorization === `Basic ${Buffer.from('lecteur-es:mdp-es-77').toString('base64')}`), 'Elasticsearch : authentification Basic depuis ES_USER et ES_PASSWORD');
  check(chLog.every(x => x.headers['x-clickhouse-user'] === 'lecteur-ch' && x.headers['x-clickhouse-key'] === 'mdp-ch-91'), 'ClickHouse : identifiants depuis CLICKHOUSE_USER et CLICKHOUSE_PASSWORD');
  check(!r.stderr.includes('mdp-es-77') && !r.stderr.includes('mdp-ch-91') && !r.stdout.includes('mdp-'), 'aucun mot de passe dans la sortie');
  check(/4 requêtes : 4 identiques/.test(r.stderr) && /✓ identique : q1-compte\.json/.test(r.stderr), 'la progression et le bilan s’affichent sur la sortie d’erreur', r.stderr);

  // Clé d’API : l’emporte sur le mot de passe
  esLog.length = 0;
  r = await cli(['verify', 'queries', join(QDIR, 'q1-compte.json'), '--index', 'logs-app', ...WINDOW, '--format', 'json'], { ES_API_KEY: 'cle-api-xyz', ES_USER: 'lecteur-es', ES_PASSWORD: 'mdp-es-77' });
  check(r.code === 0 && esLog.length > 0 && esLog.every(x => x.headers.authorization === 'ApiKey cle-api-xyz'), 'Elasticsearch : ES_API_KEY donne un en-tête ApiKey, qui l’emporte sur Basic', r.stderr);

  // Fichier de rapport
  const OUT = join(TMP, 'rapport');
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--out', OUT]);
  const files = existsSync(OUT) ? readdirSync(OUT).sort() : [];
  check(r.code === 0 && r.stdout === '' && files.length === 4 && files.every(f => /^equivalence-queries-\d{8}-\d{6}Z\.(md|html|csv|json)$/.test(f)), '--out écrit le rapport en md, html, csv et json, datés', J({ files, code: r.code }));
  if (files.length === 4) {
    const md = readFileSync(join(OUT, files.find(f => f.endsWith('.md'))), 'utf8');
    check(/^# Rapport d’équivalence — requêtes/.test(md) && /4 requêtes : 4 identiques/.test(md) && /Fenêtre de temps : du 2026-10-28 10:00:00 UTC au 2026-10-28 11:00:00 UTC/.test(md), 'le rapport Markdown dit la fenêtre et le bilan', md.slice(0, 500));
    check(/\.md$|rapport/.test(r.stderr), 'le chemin du rapport est annoncé');
  }

  // Écarts : une mesure fausse (avg de latence) et une clé de groupe qui n’existe pas côté Elasticsearch
  world.ch = DOCS.map(d => (d._id === 'a3' ? Object.assign({}, d, { lat: 21 }) : d));
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--format', 'json']);
  rep = json(r);
  check(r.code === 2 && rep, 'une mesure fausse : code de sortie 2', `${r.code} ${r.stderr}`);
  if (rep) {
    same(states(rep), { 'q1-compte.json': 'identical', 'q2-statuts.json': 'different', 'q3-documents.json': 'identical', 'q4-composite.json': 'identical' }, 'seule la requête dont la mesure est fausse est différente');
    check(rep.items.find(i => i.title === 'q2-statuts.json').diffs.some(d => /lat ES 23\.33/.test(d)), 'l’écart cite la mesure et ses deux valeurs', J(rep.items[1].diffs));
  }
  world.ch = DOCS.map(d => (d._id === 'a1' ? Object.assign({}, d, { svc: 'svc-gamma-SECRET' }) : d));
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--format', 'json']);
  check(r.code === 2 && /gamma-SECRET/.test(r.stdout) && /es-prod-cluster-SECRET2/.test(r.stdout), 'par défaut le rapport cite les valeurs des données et le cluster', r.stderr);
  const withValues = json(r);
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--format', 'json', '--no-values']);
  rep = json(r);
  check(r.code === 2 && rep && rep.values_hidden === true && !/gamma-SECRET|SECRET2|svc-alpha|svc-beta/.test(r.stdout), '--no-values : écarts toujours signalés (code 2), aucune valeur ni nom de cluster dans le rapport', r.stdout.match(/.{20}(gamma-SECRET|SECRET2|svc-alpha|svc-beta).{20}/) || r.stderr);
  check(withValues && rep && rep.summary.byState.different === withValues.summary.byState.different && rep.summary.byState.different >= 2, '--no-values ne change ni le bilan ni les états', J(rep && rep.summary));
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--no-values']);
  check(/Les valeurs des données .* sont masquées/.test(r.stdout), 'le rapport Markdown dit que les valeurs sont masquées');
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--format', 'json', '--examples', '1']);
  rep = json(r);
  check(rep && rep.items.every(i => !i.diffs || i.diffs.length <= 2), '--examples limite le nombre d’écarts cités par requête', J(rep && rep.items.map(i => (i.diffs || []).length)));
  world.ch = DOCS;

  // Fenêtre sans aucune donnée : égal ne prouve rien
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-01T01:00:00Z', '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.summary.byState.inconclusive === 4 && rep.summary.byState.identical === 0, 'fenêtre vide : quatre non concluants, aucun identique', `${r.code} ${J(rep && rep.summary)}`);
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-01T01:00:00Z', '--format', 'json', '--strict']);
  check(r.code === 2, '--strict : un non concluant fait échouer la commande (code 2)', r.code);

  // Fenêtre par défaut : l’heure se termine avant le lancement, « now » est figé
  esLog.length = 0;
  r = await cli(['verify', 'queries', join(QDIR, 'q1-compte.json'), '--index', 'logs-app', '--format', 'json']);
  rep = json(r);
  check(rep && rep.conditions.window.explicit === false && rep.conditions.window.to <= Date.now() - 9 * 60000 && rep.conditions.window.to % 60000 === 0 && rep.conditions.window.to - rep.conditions.window.from === 3600000, 'sans --from, la fenêtre est d’1 h, close 10 min avant le lancement, à la minute', J(rep && rep.conditions.window));

  // --no-window, point-in-time, index inconnu
  esLog.length = 0;
  r = await cli(['verify', 'queries', join(QDIR, 'q1-compte.json'), '--index', 'logs-app', ...WINDOW, '--no-window', '--format', 'json']);
  const nw = esLog.filter(x => x.method === 'POST').map(x => JSON.parse(x.body));
  check(nw.length > 0 && nw.every(b => !J(b.query).includes('2026-10-28T10:00:00.000Z')) && json(r).conditions.window === null, '--no-window : aucune fenêtre ajoutée, et le rapport le dit');
  writeFileSync(join(TMP, 'pit.json'), J({ size: 0, pit: { id: 'abc', keep_alive: '1m' }, query: { match_all: {} } }));
  esLog.length = 0;
  r = await cli(['verify', 'queries', join(TMP, 'pit.json'), '--index', 'logs-app', ...WINDOW, '--format', 'json']);
  rep = json(r);
  check(rep && rep.items[0].state === 'not_compared' && /point-in-time/.test(rep.items[0].reason) && esLog.filter(x => x.method === 'POST').length === 0, 'une requête à point-in-time n’est pas rejouée (aucun _search envoyé)', r.stderr);
  r = await cli(['verify', 'queries', join(QDIR, 'q1-compte.json'), ...WINDOW, '--format', 'json']);
  rep = json(r);
  check(r.code === 1 && rep && rep.items[0].state === 'error' && /--index/.test(rep.items[0].reason), 'sans index (ni dans le fichier, ni --index) : en erreur, code 1', r.stderr);
  writeFileSync(join(TMP, 'ligne.es'), `GET /logs-app/_search\n${J({ size: 0, query: { term: { 'service.name': 'svc-beta-9c1' } } })}\n`);
  r = await cli(['verify', 'queries', join(TMP, 'ligne.es'), ...WINDOW, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'identical' && rep.items[0].index === 'logs-app' && rep.items[0].docs === 2, 'un fichier « GET /index/_search » suivi du corps : l’index vient de la ligne', r.stderr);
  writeFileSync(join(TMP, 'casse.json'), '{ "query": ');
  r = await cli(['verify', 'queries', join(TMP, 'casse.json'), '--index', 'logs-app', ...WINDOW, '--format', 'json']);
  rep = json(r);
  check(r.code === 1 && rep && rep.items[0].state === 'error' && /JSON invalide/.test(rep.items[0].reason), 'un JSON cassé : en erreur, code 1, sans appel');

  // Les moteurs injoignables : on s’arrête avant la première requête
  chLog.length = 0;
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--es', 'http://127.0.0.1:1']);
  check(r.code === 1 && /Elasticsearch ne répond pas sur http:\/\/127\.0\.0\.1:1/.test(r.stderr) && chLog.length === 0, 'Elasticsearch injoignable : code 1, message clair, ClickHouse non interrogé', r.stderr);
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW], { PASSERELLE_CONFIG: (() => { const f = join(TMP, 'ch-ko.json'); writeFileSync(f, J({ clickhouse: { endpoint: 'http://127.0.0.1:1' }, elasticsearch: { endpoint: ES_URL } })); return f; })() });
  check(r.code === 1 && /ClickHouse injoignable/.test(r.stderr), 'ClickHouse injoignable : code 1, message clair', r.stderr);
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW], { PASSERELLE_CONFIG: (() => { const f = join(TMP, 'sans-es.json'); writeFileSync(f, J({ clickhouse: { endpoint: CH_URL } })); return f; })() });
  check(r.code === 1 && /elasticsearch\.endpoint n’est pas configuré/.test(r.stderr), 'sans elasticsearch.endpoint ni --es : refusé avec le nom du réglage', r.stderr);

  // Garde-fous d’usage
  esLog.length = 0;
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', ...WINDOW, '--max-queries', '2']);
  check(r.code === 1 && /4 requêtes, plus que --max-queries 2/.test(r.stderr) && esLog.length === 0, '--max-queries : refus avant tout appel', r.stderr);
  r = await cli(['verify', 'queries', join(ROOT, 'examples/kibana/supervision_web.ndjson'), '--index', 'logs-app', ...WINDOW, '--max-queries', '1']);
  check(r.code === 1 && /plus que --max-queries 1/.test(r.stderr) && esLog.length === 0, 'export Kibana (.ndjson) : les requêtes des visualisations sont reconstituées, puis comptées', r.stderr);
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', '--from', 'hier']);
  check(r.code === 1 && /ISO 8601/.test(r.stderr), '--from illisible : refusé');
  r = await cli(['verify', 'queries', QDIR, '--index', 'logs-app', '--format', 'yaml']);
  check(r.code === 1 && /--format attend md, html, csv ou json/.test(r.stderr), '--format inconnu : refusé avec la liste des formats');
  r = await cli(['verify', 'queries']);
  check(r.code === 1 && /aucune requête à comparer/.test(r.stderr), 'sans fichier : refusé avec un exemple');
  r = await cli(['verify', 'nope']);
  check(r.code === 1 && /sous-commande inconnue : verify nope/.test(r.stderr), 'sous-commande inconnue : refusée');
  r = await cli(['verify']);
  check(r.code === 1 && /queries ou pipelines/.test(r.stderr), 'verify seul : refusé avec les sous-commandes');

  // Au total, rien d’autre que de la lecture n’a jamais été demandé
  const post = x => x.method === 'POST' && /^\/[^/?]+\/_search\?/.test(x.url);
  check(esLog.every(x => post(x) || (x.method === 'GET' && x.url === '/')), 'fin du parcours : aucune autre route d’Elasticsearch appelée');
}

/* ====================================================================== */
section('E. passerelle verify pipelines (faux Vector et faux Logstash)');

const BINDIR = join(TMP, 'bin');
mkdirSync(BINDIR);
const FAKE_VECTOR = join(BINDIR, 'vector');
writeFileSync(FAKE_VECTOR, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const conf = args[args.indexOf('--config') + 1];
const yaml = fs.readFileSync(conf, 'utf8');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'vector', args, interp: process.env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION, yaml }) + '\\n');
if (process.env.FAKE_VECTOR_FAIL) { process.stderr.write('configuration refusée par le faux Vector\\n'); process.exit(3); }
const events = fs.readFileSync(0, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l));
if (process.env.FAKE_VECTOR_TWEAK) { const [k, v] = process.env.FAKE_VECTOR_TWEAK.split('='); events.forEach(e => { e[k] = v; }); }
const paths = [...yaml.matchAll(/^\\s*path:\\s*"?([^"\\n]+)"?\\s*$/gm)].map(m => m[1]);
if (!paths.length) { process.stderr.write('aucun sink file dans la configuration\\n'); process.exit(4); }
for (const p of paths) fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''));
`);
const FAKE_LOGSTASH = join(BINDIR, 'logstash');
writeFileSync(FAKE_LOGSTASH, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const conf = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'logstash', args, conf }) + '\\n');
if (process.env.FAKE_LS_FAIL) { process.stderr.write('[ERROR] pipeline interrompu\\n'); process.exit(3); }
const input = /path => "([^"]+)" mode => "read"/.exec(conf)[1];
let events = fs.readFileSync(input, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l));
if (process.env.FAKE_LS_DROP) events = events.slice(0, -1);
for (const m of conf.matchAll(/file \\{ path => "([^"]+)" codec => json_lines \\}/g)) fs.writeFileSync(m[1], events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''));
`);
chmodSync(FAKE_VECTOR, 0o755); chmodSync(FAKE_LOGSTASH, 0o755);

const PDIR = join(TMP, 'pipelines');
mkdirSync(PDIR);
writeFileSync(join(PDIR, 'web.conf'), `input { kafka { bootstrap_servers => "kafka:9092" topics => ["web-in"] codec => json } }
filter { mutate { add_field => { "pipeline" => "web" } } }
output { kafka { bootstrap_servers => "kafka:9092" topic_id => "web-out" codec => json } }
`);
const SAMPLE = join(TMP, 'echantillon.ndjson');
writeFileSync(SAMPLE, Array.from({ length: 6 }, (_, i) => J({ n: i + 1, user: i % 2 ? 'SECRET-USER-4411' : 'visiteur', level: 'info' })).join('\n') + '\n');
const FAKE_LOG = join(TMP, 'fake.log');
const fakeLog = () => (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const pcli = (args, env) => cli(['verify', 'pipelines', ...args], Object.assign({ FAKE_LOG, PASSERELLE_VECTOR_BIN: FAKE_VECTOR }, env));

{
  const leftovers = new Set(readdirSync(tmpdir()).filter(f => /^passerelle-verify-/.test(f)));
  let r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  let rep = json(r);
  check(r.code === 0 && rep, 'pipeline rejoué : mêmes événements, code 0', `${r.code} ${r.stderr}`);
  if (rep) {
    check(rep.kind === 'pipelines' && rep.items.length === 1 && rep.items[0].state === 'identical' && rep.items[0].docs === 6, 'un pipeline, six événements, identique', J(rep.items));
    check(rep.items[0].translation && ['ready', 'review'].includes(rep.items[0].translation.verdict) && rep.items[0].translation.coverage > 0, 'le rapport donne le verdict de traduction du pipeline', J(rep.items[0].translation));
    check(/6 événements \(echantillon\.ndjson\)/.test(rep.conditions.sample) && /logstash/.test(rep.conditions.engines.Référence) && /ecs_compatibility v8/.test(rep.conditions.engines.Référence) && rep.conditions.window === null, 'le rapport dit l’échantillon, les deux moteurs et le mode ECS', J(rep.conditions));
    check(rep.conditions.notes.some(n => /moins de 100 événements/.test(n)), 'un échantillon de moins de 100 événements est signalé dans le rapport');
  }
  const log = fakeLog();
  const v = log.find(x => x.tool === 'vector'); const l = log.find(x => x.tool === 'logstash');
  check(v && v.interp === 'true' && v.args.includes('--quiet') && v.args.includes('--config'), 'Vector est lancé sur la configuration traduite, interpolation d’environnement autorisée', J(v && v.args));
  check(v && /^api:\n {2}enabled: false$/m.test(v.yaml) && /^data_dir: .*passerelle-verify-/m.test(v.yaml) && (v.yaml.match(/^data_dir:/gm) || []).length === 1, 'la configuration de Vector n’a que deux retouches d’environnement : pas d’API (port 8686), un dossier de données à soi', v && v.yaml.slice(0, 300));
  check(v && /type: file/.test(v.yaml) && /web_out\.ndjson/.test(v.yaml), 'la sortie de Vector est un fichier nommé d’après le topic', v && v.yaml);
  check(l && l.args.includes('--pipeline.workers') && l.args[l.args.indexOf('--pipeline.workers') + 1] === '1' && l.args[l.args.indexOf('--pipeline.ecs_compatibility') + 1] === 'v8', 'Logstash est lancé avec un seul worker et le mode ECS demandé', J(l && l.args));
  check(l && /mode => "read" exit_after_read => true/.test(l.conf) && /ruby \{ code => '/.test(l.conf) && /mutate \{ add_field => \{ "pipeline" => "web" \} \}/.test(l.conf) && !/kafka/.test(l.conf.replace(/\n/g, ' ')), 'Logstash rejoue l’échantillon par une entrée fichier, avec les filtres du client et sans Kafka', l && l.conf);
  check(readdirSync(tmpdir()).filter(f => /^passerelle-verify-/.test(f)).every(f => leftovers.has(f)), 'les fichiers de travail sont supprimés');

  // Écart : le faux Vector ajoute un champ, ou l’un des moteurs perd un événement
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_VECTOR_TWEAK: 'user=SECRET-USER-4411-bis' });
  rep = json(r);
  check(r.code === 2 && rep && rep.items[0].state === 'different' && rep.items[0].diffs.some(d => /user : Logstash .* \/ Vector .*SECRET-USER-4411-bis/.test(d)) && rep.items[0].diffs.length <= 4, 'un champ qui diffère : code 2, l’écart cite le champ et les deux valeurs (trois exemples au plus)', J(rep && rep.items[0].diffs));
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--no-values'], { FAKE_VECTOR_TWEAK: 'user=SECRET-USER-4411-bis' });
  check(r.code === 2 && !/SECRET-USER|visiteur/.test(r.stdout) && /valeurs différentes/.test(r.stdout), '--no-values : l’écart reste signalé, aucune valeur de l’échantillon n’est citée', r.stdout.match(/.{20}SECRET-USER.{20}/));
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_LS_DROP: '1' });
  rep = json(r);
  check(r.code === 2 && rep && rep.items[0].state === 'different' && rep.items[0].diffs.some(d => /5 événement\(s\) côté Logstash, 6 côté Vector/.test(d)), 'Logstash perd un événement : écart de comptes signalé', J(rep && rep.items[0].diffs));

  // Référence : événements déjà produits (un fichier pour une sortie, un dossier sinon)
  const REF = join(TMP, 'reference.ndjson');
  writeFileSync(REF, readFileSync(SAMPLE, 'utf8'));
  const fakeLogCount = fakeLog().length;
  r = await pcli([join(PDIR, 'web.conf'), '--sample', SAMPLE, '--reference', REF, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'identical' && fakeLog().slice(fakeLogCount).every(x => x.tool === 'vector') && /événements déjà produits/.test(rep.conditions.engines.Référence), '--reference : pas de Logstash lancé, les événements déjà produits servent de référence', r.stderr);
  const REFDIR = join(TMP, 'reference'); mkdirSync(REFDIR);
  writeFileSync(join(REFDIR, 'web_out.ndjson'), readFileSync(SAMPLE, 'utf8').split('\n').slice(0, 5).join('\n') + '\n');
  r = await pcli([join(PDIR, 'web.conf'), '--sample', SAMPLE, '--reference', REFDIR, '--format', 'json']);
  rep = json(r);
  check(r.code === 2 && rep && rep.items[0].state === 'different', '--reference <dossier> : un <sortie>.ndjson par sortie, comparé', r.stderr);

  // Pannes
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_VECTOR_FAIL: '1' });
  rep = json(r);
  check(r.code === 1 && rep && rep.items[0].state === 'error' && /Vector : code 3/.test(rep.items[0].reason) && /configuration refusée/.test(rep.items[0].reason), 'Vector échoue : en erreur (code 1), avec les dernières lignes de sa sortie', J(rep && rep.items[0].reason));
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_LS_FAIL: '1' });
  rep = json(r);
  check(r.code === 1 && rep && /Logstash : code 3/.test(rep.items[0].reason), 'Logstash échoue : en erreur (code 1)', J(rep && rep.items[0].reason));
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', join(TMP, 'absent'), '--format', 'json']);
  rep = json(r);
  check(r.code === 1 && rep && /binaire introuvable/.test(rep.items[0].reason), 'binaire Logstash introuvable : en erreur, message clair', J(rep && rep.items[0].reason));
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--vector-bin', join(TMP, 'absent')]);
  rep = json(r);
  check(r.code === 1 && rep && /Vector : binaire introuvable/.test(rep.items[0].reason), 'binaire Vector introuvable : en erreur, message clair', J(rep && rep.items[0].reason));

  // Cas non comparés et non concluants
  const CHAIN = join(TMP, 'chaine'); mkdirSync(CHAIN);
  writeFileSync(join(CHAIN, 'a.conf'), 'input { kafka { topics => ["x"] codec => json } }\nfilter { }\noutput { pipeline { send_to => ["suite"] } }\n');
  r = await pcli([CHAIN, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'not_compared' && /pipeline relié/.test(rep.items[0].reason), 'pipeline relié à d’autres (send_to) : non comparé, sans exécution', r.stderr);
  r = await pcli([CHAIN, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--strict']);
  check(r.code === 2, '--strict : un pipeline non comparé fait échouer la commande');
  const EMPTY = join(TMP, 'vide.ndjson'); writeFileSync(EMPTY, '');
  r = await pcli([PDIR, '--sample', EMPTY, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'inconclusive' && /aucun événement en sortie/.test(rep.items[0].reason), 'échantillon vide : non concluant, jamais identique', r.stderr);
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--keep']);
  check(r.code === 0 && /fichiers de travail conservés : (\S+)/.test(r.stderr) && existsSync(/conservés : (\S+)/.exec(r.stderr)[1]), '--keep : les fichiers de travail sont conservés et leur dossier annoncé', r.stderr);
  rmSync(/conservés : (\S+)/.exec(r.stderr)[1], { recursive: true, force: true });

  // Usage
  r = await pcli([PDIR]);
  check(r.code === 1 && /--sample FICHIER est nécessaire/.test(r.stderr), 'sans --sample : refusé avec l’explication');
  r = await pcli([PDIR, '--sample', SAMPLE]);
  check(r.code === 1 && /la référence manque : --logstash-bin .* ou --reference/.test(r.stderr), 'sans référence : refusé avec les deux possibilités');
  r = await pcli([PDIR, '--sample', join(TMP, 'absent.ndjson'), '--reference', REF]);
  check(r.code === 1 && /échantillon introuvable/.test(r.stderr), 'échantillon introuvable : refusé');
  r = await pcli([PDIR, '--sample', SAMPLE, '--reference', REF, '--ecs', 'v9']);
  check(r.code === 1 && /--ecs attend v8 ou disabled/.test(r.stderr), '--ecs inconnu : refusé');
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--ecs', 'disabled', '--format', 'json']);
  check(r.code === 0 && fakeLog().slice(-1)[0].args[fakeLog().slice(-1)[0].args.indexOf('--pipeline.ecs_compatibility') + 1] === 'disabled' && /^ {4}event\.remove\("host"\)/m.test(fakeLog().slice(-1)[0].conf), '--ecs disabled : transmis à Logstash, préambule adapté', r.stderr);
  r = await pcli([PDIR, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--out', join(TMP, 'rapport-pipelines')]);
  check(r.code === 0 && readdirSync(join(TMP, 'rapport-pipelines')).filter(f => /^equivalence-pipelines-\d{8}-\d{6}Z\.(md|html|csv|json)$/.test(f)).length === 4, '--out : rapport de pipelines en quatre formats');
}

/* ====================================================================== */
section('F. Le pipeline du client réduit à ses filtres = le transport du banc des pipelines');

for (const file of ['routage.conf', 'batch.conf', 'nginx.conf']) {
  const text = readFileSync(join(ROOT, 'examples/logstash', file), 'utf8');
  const parts = E.eqPipelineParts(text);
  const c = Object.assign({ id: 'x', lines: [] }, example(file));
  check(!parts.error, `${file} : pipeline lu`, parts.error);
  if (parts.error) continue;
  check(E.eqVectorSource(parts, '/work/out', 'x') === translatedPipeline(c), `${file} : le pipeline que joue Vector est celui du banc`, E.eqVectorSource(parts, '/work/out', 'x') + '\n----\n' + translatedPipeline(c));
  for (const mode of ['v8', 'disabled']) check(E.eqLogstashSource(parts, mode, '/work/in/x.ndjson', '/work/out', `x.${mode}`) === logstashPipeline(c, mode), `${file} : le pipeline que joue Logstash (${mode}) est celui du banc`);
}
{
  const nginx = E.eqPipelineParts(readFileSync(join(ROOT, 'examples/logstash/nginx.conf'), 'utf8'));
  check(nginx.caveats.some(x => /Kafka/.test(x)), 'nginx.conf (decorate_events) : la limite est signalée dans les remarques du rapport', J(nginx.caveats));
  const routage = E.eqPipelineParts(readFileSync(join(ROOT, 'examples/logstash/routage.conf'), 'utf8'));
  same(routage.outputNames, ['alerts', 'logs_emea', 'logs_others'], 'routage.conf : une sortie par topic, nommée d’après lui');
  check(routage.caveats.length === 0, 'routage.conf : rien à signaler');
  check(E.eqPipelineParts('input { stdin {} }').error === 'aucun bloc output' && E.eqPipelineParts('output { stdout {} }').error === 'aucun bloc input', 'un pipeline sans input ou sans output est refusé');
  check(/accolade non fermée/.test(E.eqPipelineParts('input { stdin { }\n').error), 'un pipeline aux accolades déséquilibrées est refusé');
  check(/aucune sortie reconnue/.test(E.eqPipelineParts('input { stdin {} } output { inconnu { x => 1 } }').error), 'un bloc output sans greffon connu est refusé');
  const typed = E.eqPipelineParts('input { beats { type => "web" tags => ["a", "b"] codec => json add_field => { "k" => "v" } } }\nfilter { }\noutput { elasticsearch { index => "logs-%{+YYYY}" } stdout { } }');
  check(typed.options.includes('type => "web"') && typed.options.includes('tags => ["a", "b"]') && typed.options.includes('"k" => "v"') && typed.json && J(typed.outputNames) === '["logs","stdout"]', 'type, tags et add_field de l’entrée sont recopiés ; codec json reconnu ; une sortie par index et par greffon', J(typed));
}

/* ====================================================================== */
section('G. Les rapports');

{
  const rep = {
    kind: 'queries', generated_at: '2026-10-28T12:00:00.000Z', passerelle: '9.9.9',
    conditions: { window: { from: Date.parse('2026-10-28T10:00:00Z'), to: Date.parse('2026-10-28T11:00:00Z'), field: '@timestamp', explicit: false, length: '1h', lag: '10m' }, engines: { Elasticsearch: '8.15.1', ClickHouse: '24.8' }, notes: ['une remarque | avec barre'] },
    values_hidden: false,
    items: [
      { title: 'ok.json', source: 'ok.json', state: 'identical', reason: '', docs: 12, elapsed_ms: 1200, translation: { verdict: 'ready' } },
      { title: 'a|b <script>alert(1)</script>.json', source: 'x;y', state: 'different', reason: 'raison; "citée"', docs: 3, elapsed_ms: 40, diffs: ['[par_service] 1 absentes côté CH, ex. ["a<b"]'], translation: { verdict: 'review' } },
      { title: 'vide.json', source: 'vide.json', state: 'inconclusive', reason: 'aucun document', docs: 0, translation: { verdict: 'ready' } },
      { title: 'pit.json', source: 'pit.json', state: 'not_compared', reason: 'point-in-time' },
      { title: 'cassé.json', source: 'cassé.json', state: 'error', reason: 'Elasticsearch : HTTP 400' }
    ]
  };
  rep.summary = E.eqSummarize(rep.items);
  same(rep.summary.byState, { identical: 1, different: 1, inconclusive: 1, not_compared: 1, error: 1 }, 'bilan par état');
  check(E.eqSentence(rep.summary, 'requête') === '5 requêtes : 1 identique, 1 différent, 1 en erreur, 1 non concluant, 1 non comparé.', 'la phrase de bilan', E.eqSentence(rep.summary, 'requête'));
  check(E.eqSentence({ total: 0, byState: {} }, 'pipeline') === 'Aucun pipeline comparé.' && E.eqSentence({ total: 1, byState: { identical: 1 } }, 'pipeline') === '1 pipeline : 1 identique.', 'la phrase de bilan au singulier et sans rien');
  const md = E.eqReportMarkdown(rep);
  const order = ['a\\|b', 'cassé.json', 'vide.json', 'pit.json', 'ok.json'].map(t => md.indexOf(`| ${t}`));
  check(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), 'Markdown : les écarts d’abord, puis les erreurs, les non concluants, les non comparés, les identiques', J(order));
  check(md.includes('**Daté du 2026-10-28 12:00:00 UTC**') && md.includes('Passerelle 9.9.9') && md.includes('(fin exclue)') && md.includes('1h se terminant 10m avant le lancement'), 'Markdown : daté, versionné, fenêtre dite');
  check(md.includes('une remarque \\| avec barre') && md.includes('Relancez avec --no-values'), 'Markdown : barres échappées, avertissement sur les valeurs');
  const html = E.eqReportHTML(rep);
  check(!html.includes('<script>alert(1)') && html.includes('a|b &lt;script&gt;alert(1)&lt;/script&gt;.json') && html.includes('ex. [&quot;a&lt;b&quot;]'), 'HTML : titres et valeurs échappés (rien de ce que contiennent les données ne s’exécute)');
  check(/<html lang="fr">/.test(html) && /prefers-color-scheme: dark/.test(html) && !/https?:\/\//.test(html.replace(/<\/?[a-z][^>]*>/g, '')), 'HTML : autonome, thème clair et sombre, sans ressource externe');
  check(!/src=|href=|@import|url\(/.test(html), 'HTML : aucune référence externe');
  const csv = E.eqReportCSV(rep);
  check(csv.startsWith('\ufeff') && csv.includes('\r\n') && csv.includes('a|b <script>alert(1)</script>.json;"x;y"') && csv.includes('"raison; ""citée"""') && csv.split('\r\n')[0] === '\ufefftitre;source;verdict_traduction;etat;documents;duree_ms;raison;ecarts', 'CSV : BOM, séparateur point-virgule, champs entre guillemets doublés', csv.split('\r\n').slice(0, 3).join(' ⏎ '));
  const hidden = E.eqReportMarkdown(Object.assign({}, rep, { values_hidden: true }));
  check(hidden.includes('masquées') && !hidden.includes('Relancez avec --no-values'), 'Markdown : la mention « valeurs masquées » remplace l’avertissement');
}

/* ---------- Fin ---------- */
esServer.close(); chServer.close();
rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${failures ? `${failures} échec(s)` : 'tout est vert'}\n`);
process.exit(failures ? 1 : 0);
