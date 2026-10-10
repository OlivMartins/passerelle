/*
 * Cas du banc différentiel.
 *
 * Chaque cas est une requête DSL exécutée telle quelle sur Elasticsearch ; sa traduction est exécutée
 * sur ClickHouse et les deux résultats doivent être identiques.
 *
 *   known      écart connu, avec sa raison. Le cas doit alors diverger : s’il devient identique,
 *              le banc échoue pour rappeler de retirer la mention. Formes acceptées :
 *                'raison'                       quel que soit le schéma et le fuseau
 *                { N: 'raison' }                seulement avec le schéma Nullable (D : valeurs par défaut)
 *                { '@Europe/Paris': 'raison' }  seulement quand le serveur ClickHouse est dans ce fuseau
 *   unsupported  construction valide pour Elasticsearch mais hors de portée de la traduction : le cas
 *              réussit si elle est déclarée « à reprendre » et si le SQL s’arrête au lieu de répondre
 *   tz         fuseaux du serveur ClickHouse à essayer (défaut : UTC seul)
 *   composite  nom de l’agrégation composite à paginer jusqu’au bout des deux côtés
 *   tol        tolérance relative pour les mesures approchées (cardinality, percentiles)
 *   config     options de configuration propres au cas, fusionnées avec celles du banc
 */
import { BASE, DAY } from './dataset.mjs';

const TS = '@timestamp';
const T10 = BASE + 2 * DAY; // 2026-03-10T00:00:00Z
const PARIS = ['UTC', 'Europe/Paris'];
const total = query => ({ size: 0, track_total_hits: true, query });
const perDay = aggs => ({ size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'day' }, aggs } } });
const CLASSE = "if (doc['latency_ms'].value < 100) { emit('rapide'); } else if (doc['latency_ms'].value < 1000) { emit('normal'); } else { emit('lent'); }";

export const CASES = [
  /* ---------- Regroupements ---------- */
  { id: 'agg_terms_metriques', dsl: { size: 0, aggs: { svc: { terms: { field: 'service' }, aggs: { lat: { avg: { field: 'latency_ms' } }, mx: { max: { field: 'bytes' } } } } } } },
  { id: 'agg_terms_nom_du_champ', dsl: { size: 0, aggs: { service: { terms: { field: 'service' } } } } },
  // Agrégations nommées comme une colonne citée ailleurs dans la requête : l’alias ne doit pas la masquer
  { id: 'agg_alias_masque_colonne', dsl: { size: 0, query: { term: { host: 'web-1' } }, aggs: { host: { terms: { field: 'service' } } } } },
  { id: 'agg_metrique_nom_du_champ', dsl: { size: 0, query: { range: { bytes: { gte: 50000 } } }, aggs: { svc: { terms: { field: 'service' }, aggs: { bytes: { sum: { field: 'bytes' } }, moy: { avg: { field: 'bytes' } } } } } } },
  { id: 'agg_terms_imbriques', dsl: { size: 0, aggs: { svc: { terms: { field: 'service', size: 3 }, aggs: { h: { terms: { field: 'host', size: 2 }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } } } },
  { id: 'agg_terms_3_niveaux', dsl: { size: 0, aggs: { svc: { terms: { field: 'service', size: 3 }, aggs: { lvl: { terms: { field: 'level', size: 2 }, aggs: { st: { terms: { field: 'status', size: 2 } } } } } } } } },
  { id: 'agg_terms_tri_metrique', dsl: { size: 0, aggs: { h: { terms: { field: 'host', size: 5, order: { lat: 'desc' } }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } },
  { id: 'agg_terms_tri_cle', dsl: { size: 0, aggs: { h: { terms: { field: 'host', size: 20, order: { _key: 'asc' } } } } } },
  { id: 'agg_terms_include', dsl: { size: 0, aggs: { h: { terms: { field: 'host', include: ['web-1', 'web-2', 'Web-A'] } } } } },
  { id: 'agg_terms_exclude_regex', dsl: { size: 0, aggs: { h: { terms: { field: 'host', exclude: 'web-.*' } } } } },
  { id: 'agg_terms_missing', dsl: { size: 0, aggs: { e: { terms: { field: 'env', missing: 'N/A' } } } } },
  { id: 'agg_terms_champ_absent', dsl: { size: 0, aggs: { e: { terms: { field: 'env' } } } } },
  { id: 'agg_terms_chaine_vide', known: { D: 'valeur par défaut : une chaîne vide réelle ne se distingue plus d’un champ absent' }, dsl: { size: 0, aggs: { u: { terms: { field: 'user' } } } } },
  { id: 'agg_terms_exclude_champ_absent', dsl: { size: 0, aggs: { e: { terms: { field: 'env', exclude: ['dev'] } } } } },
  { id: 'agg_filters_champ_absent', dsl: { size: 0, aggs: { f: { filters: { other_bucket: true, filters: { prod: { term: { env: 'prod' } } } } } } } },
  { id: 'agg_mesures_champ_absent', dsl: { size: 0, aggs: { n: { value_count: { field: 'env' } }, u: { cardinality: { field: 'env' } } } } },
  { id: 'agg_histogramme', dsl: { size: 0, aggs: { h: { histogram: { field: 'latency_ms', interval: 500 } } } } },
  { id: 'agg_filters_autres', dsl: { size: 0, aggs: { f: { filters: { other_bucket: true, filters: { err: { range: { status: { gte: 500 } } }, slow: { range: { latency_ms: { gt: 2000 } } } } } } } } },
  { id: 'agg_filter_sous_terms', dsl: { size: 0, aggs: { err: { filter: { range: { status: { gte: 500 } } }, aggs: { svc: { terms: { field: 'service' } } } } } } },
  { id: 'agg_global', dsl: { size: 0, query: { term: { level: 'ERROR' } }, aggs: { svc: { terms: { field: 'service' } }, tous: { global: {}, aggs: { svc: { terms: { field: 'service' } } } } } } },
  { id: 'agg_missing', dsl: { size: 0, aggs: { sans_env: { missing: { field: 'env' } } } } },
  { id: 'agg_top_hits', dsl: { size: 0, aggs: { svc: { terms: { field: 'service', size: 3 }, aggs: { derniers: { top_hits: { size: 2, sort: [{ [TS]: 'desc' }] } } } } } } },
  { id: 'agg_range_plage_vide', known: 'une plage sans document n’est pas renvoyée', dsl: { size: 0, aggs: { r: { range: { field: 'latency_ms', ranges: [{ key: 'bas', to: 100 }, { key: 'milieu', from: 100, to: 3000 }, { key: 'haut', from: 5000 }] } } } } },
  { id: 'agg_range_cles', known: 'clé de plage par défaut : Elasticsearch écrit « *-100.0 », la traduction « *-100 »', dsl: { size: 0, aggs: { r: { range: { field: 'latency_ms', ranges: [{ to: 100 }, { from: 100, to: 3000 }] } } } } },

  /* ---------- Histogrammes de dates ---------- */
  { id: 'agg_date_jour', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'day' } } } } },
  { id: 'agg_date_6h', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, fixed_interval: '6h' } } } } },
  { id: 'agg_date_fuseau_explicite', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'day', time_zone: 'Europe/Paris' } } } } },
  { id: 'agg_date_semaine', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'week' } } } } },
  { id: 'agg_date_mois', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'month' } } } } },
  { id: 'agg_date_semaine_fuseau', tz: PARIS, dsl: { size: 0, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'week', time_zone: 'Europe/Paris' } } } } },
  { id: 'agg_date_heure_fuseau', tz: PARIS, dsl: { size: 0, query: { range: { [TS]: { lt: '2026-03-08T06:00:00Z' } } }, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'hour', time_zone: 'Asia/Kolkata' } } } } },
  { id: 'agg_date_extended_bounds', dsl: { size: 0, query: { range: { [TS]: { gte: '2026-03-09T00:00:00Z', lt: '2026-03-10T00:00:00Z' } } }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '12h', extended_bounds: { min: '2026-03-08T00:00:00Z', max: '2026-03-10T23:59:59Z' } } } } } },
  { id: 'agg_date_imbrique_tranches_vides', dsl: { size: 0, aggs: { svc: { terms: { field: 'service', size: 10 }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '1h' } } } } } } },
  { id: 'agg_date_bornes_mesures', tz: PARIS, dsl: { size: 0, query: { range: { [TS]: { gte: '2026-03-09T00:00:00Z', lt: '2026-03-10T00:00:00Z' } } }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '12h', extended_bounds: { min: BASE, max: '2026-03-10T23:59:59Z' } }, aggs: { lat: { avg: { field: 'latency_ms' } }, mn: { min: { field: 'latency_ms' } }, s: { sum: { field: 'bytes' } } } } } } },
  { id: 'agg_date_bornes_jour', tz: PARIS, dsl: { size: 0, query: { range: { [TS]: { gte: '2026-03-09T00:00:00Z', lt: '2026-03-10T00:00:00Z' } } }, aggs: { d: { date_histogram: { field: TS, calendar_interval: 'day', extended_bounds: { min: '2026-03-07', max: '2026-03-12' } } } } } },
  { id: 'agg_date_imbrique_bornes', dsl: { size: 0, query: { range: { [TS]: { gte: '2026-03-09T00:00:00Z', lt: '2026-03-10T00:00:00Z' } } }, aggs: { svc: { terms: { field: 'service', size: 3 }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '12h', extended_bounds: { min: '2026-03-08T00:00:00Z', max: '2026-03-10T23:59:59Z' } }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } } } },
  { id: 'agg_date_trous_mesure', dsl: { size: 0, query: { term: { service: 'Search' } }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '1h' }, aggs: { lat: { avg: { field: 'latency_ms' } }, mx: { max: { field: 'bytes' } } } } } } },
  { id: 'agg_histogramme_bornes', dsl: { size: 0, aggs: { h: { histogram: { field: 'latency_ms', interval: 500, extended_bounds: { min: 0, max: 4999 } }, aggs: { lat: { avg: { field: 'bytes' } } } } } } },

  /* ---------- Mesures ---------- */
  { id: 'agg_metriques_globales', known: { D: 'valeur par défaut : une chaîne vide réelle ne se distingue plus d’un champ absent (value_count)' }, dsl: { size: 0, aggs: { st: { stats: { field: 'latency_ms' } }, es: { extended_stats: { field: 'bytes' } }, vc: { value_count: { field: 'user' } }, wa: { weighted_avg: { value: { field: 'latency_ms' }, weight: { field: 'bytes' } } } } } },
  { id: 'agg_metriques_sans_document', dsl: { size: 0, query: { term: { service: 'aucun' } }, aggs: { mn: { min: { field: 'latency_ms' } }, mx: { max: { field: 'latency_ms' } }, av: { avg: { field: 'latency_ms' } }, sm: { sum: { field: 'latency_ms' } }, vc: { value_count: { field: 'latency_ms' } } } } },
  { id: 'agg_filtre_sans_document', dsl: { size: 0, aggs: { svc: { terms: { field: 'service', size: 2 }, aggs: { vide: { filter: { term: { level: 'AUCUN' } }, aggs: { mx: { max: { field: 'latency_ms' } }, av: { avg: { field: 'latency_ms' } } } } } } } } },
  { id: 'agg_stats_sans_document', dsl: { size: 0, query: { term: { service: 'aucun' } }, aggs: { st: { stats: { field: 'latency_ms' } }, es: { extended_stats: { field: 'bytes' } }, wa: { weighted_avg: { value: { field: 'latency_ms' }, weight: { field: 'bytes' } } } } } },
  { id: 'agg_filter_vide_metriques', dsl: { size: 0, aggs: { vide: { filter: { term: { level: 'AUCUN' } }, aggs: { h: { terms: { field: 'host' } }, mx: { max: { field: 'latency_ms' } } } } } } },
  { id: 'agg_approx', tol: 0.05, dsl: { size: 0, aggs: { c: { cardinality: { field: 'latency_ms' } }, p: { percentiles: { field: 'latency_ms', percents: [50, 95, 99] } }, rangs: { percentile_ranks: { field: 'latency_ms', values: [100, 1500] } } } } },

  /* ---------- Pipelines d’agrégation ---------- */
  { id: 'pipeline_cumul_script', dsl: perDay({ s: { sum: { field: 'bytes' } }, cs: { cumulative_sum: { buckets_path: 's' } }, bs: { bucket_script: { buckets_path: { a: 's', n: '_count' }, script: 'params.a / params.n' } } }) },
  { id: 'pipeline_derivative', dsl: perDay({ s: { sum: { field: 'bytes' } }, dv: { derivative: { buckets_path: 's' } } }) },
  { id: 'pipeline_serial_diff', dsl: perDay({ s: { sum: { field: 'bytes' } }, sd: { serial_diff: { buckets_path: 's', lag: 2 } } }) },
  { id: 'pipeline_moving_avg', dsl: perDay({ s: { sum: { field: 'bytes' } }, mv: { moving_fn: { buckets_path: 's', window: 2, script: 'MovingFunctions.unweightedAvg(values)' } } }) },
  { id: 'pipeline_moving_max', dsl: perDay({ s: { sum: { field: 'bytes' } }, mv: { moving_fn: { buckets_path: 's', window: 2, script: 'MovingFunctions.max(values)' } } }) },
  { id: 'pipeline_moving_sum', dsl: perDay({ s: { sum: { field: 'bytes' } }, mv: { moving_fn: { buckets_path: 's', window: 2, script: 'MovingFunctions.sum(values)' } } }) },
  { id: 'pipeline_derivative_compte', dsl: perDay({ dv: { derivative: { buckets_path: '_count' } } }) },
  { id: 'pipeline_avec_tranches_vides', known: 'avec un pipeline, les tranches vides ne sont pas ajoutées : Elasticsearch les compte dans le calcul', dsl: { size: 0, query: { term: { service: 'Search' } }, aggs: { d: { date_histogram: { field: TS, fixed_interval: '1h' }, aggs: { s: { sum: { field: 'bytes' } }, cs: { cumulative_sum: { buckets_path: 's' } }, dv: { derivative: { buckets_path: 's' } } } } } } },
  { id: 'pipeline_max_bucket', dsl: { size: 0, aggs: { svc: { terms: { field: 'service' }, aggs: { s: { sum: { field: 'bytes' } } } }, mx: { max_bucket: { buckets_path: 'svc>s' } } } } },
  { id: 'pipeline_bucket_selector', dsl: { size: 0, aggs: { h: { terms: { field: 'host', size: 20 }, aggs: { lat: { avg: { field: 'latency_ms' } }, garde: { bucket_selector: { buckets_path: { v: 'lat' }, script: 'params.v > 1500' } } } } } } },
  { id: 'pipeline_bucket_sort', dsl: { size: 0, aggs: { h: { terms: { field: 'host', size: 20 }, aggs: { lat: { avg: { field: 'latency_ms' } }, top: { bucket_sort: { sort: [{ lat: { order: 'desc' } }], size: 3 } } } } } } },

  /* ---------- Filtres ---------- */
  { id: 'filtre_bool_documents', dsl: { size: 20, sort: [{ [TS]: 'desc' }], query: { bool: { filter: [{ term: { level: 'ERROR' } }, { range: { status: { gte: 500 } } }] } } } },
  { id: 'filtre_wildcard', dsl: total({ wildcard: { host: 'web-*' } }) },
  { id: 'filtre_prefix', dsl: total({ prefix: { host: 'web' } }) },
  { id: 'filtre_regexp', dsl: total({ regexp: { host: 'web-[1-3]' } }) },
  { id: 'filtre_term_insensible', dsl: total({ term: { service: { value: 'search', case_insensitive: true } } }) },
  { id: 'filtre_query_string', dsl: total({ query_string: { query: 'status:[500 TO 599] AND NOT service:api AND message:timeout' } }) },
  // Requêtes qu’Elasticsearch refuse (HTTP 400) : la traduction doit les refuser ou les déclarer « à reprendre »
  { id: 'filtre_query_string_invalide', dsl: total({ query_string: { query: 'status:500) AND service:api' } }) },
  { id: 'filtre_query_string_operateur_double', dsl: total({ query_string: { query: 'status:500 OR OR status:404' } }) },
  { id: 'filtre_query_string_guillemet', dsl: total({ query_string: { query: '"connection reset' } }) },
  { id: 'requete_size_invalide', dsl: { size: '10; DROP TABLE x' } },
  // Clause valide pour Elasticsearch mais hors de portée : la traduction doit s’arrêter, pas renvoyer un résultat faux
  { id: 'filtre_clause_non_traduite', unsupported: 'more_like_this', dsl: total({ bool: { must_not: [{ more_like_this: { fields: ['message'], like: 'timeout', min_term_freq: 1, min_doc_freq: 1 } }] } }) },
  { id: 'filtre_liste_terms', dsl: total({ bool: { filter: [{ terms: { host: ['web-1', 'web-2', 'web-3', 'Web-A', 'élan-1', 'inconnu'] } }], must_not: [{ terms: { status: [404, 503] } }] } }) },
  { id: 'filtre_liste_should', dsl: total({ bool: { should: [{ match_phrase: { host: 'web-1' } }, { match_phrase: { host: 'web-2' } }, { term: { host: 'db_01' } }, { terms: { host: ['Web-A', 'web-6'] } }], minimum_should_match: 1 } }) },
  { id: 'filtre_should_minimum', dsl: total({ bool: { should: [{ term: { env: 'prod' } }, { term: { level: 'ERROR' } }, { range: { latency_ms: { gte: 2000 } } }], minimum_should_match: 2 } }) },
  { id: 'filtre_should_negation', dsl: total({ bool: { should: [{ bool: { must_not: [{ term: { env: 'prod' } }] } }, { term: { level: 'ERROR' } }], minimum_should_match: 1 } }) },
  { id: 'filtre_must_not_term', dsl: total({ bool: { must_not: [{ term: { env: 'staging' } }] } }) },
  { id: 'filtre_must_not_terms', dsl: total({ bool: { must_not: [{ terms: { user: ['alice', 'bob'] } }] } }) },
  { id: 'filtre_exists', known: { D: 'valeur par défaut : une chaîne vide réelle ne se distingue plus d’un champ absent' }, dsl: total({ exists: { field: 'user' } }) },
  { id: 'filtre_exists_tableau', dsl: total({ exists: { field: 'tags' } }) },
  { id: 'filtre_exists_env', dsl: total({ exists: { field: 'env' } }) },
  { id: 'filtre_must_not_exists', dsl: total({ bool: { must_not: [{ exists: { field: 'env' } }] } }) },
  { id: 'filtre_must_not_plusieurs', dsl: total({ bool: { must_not: [{ term: { env: 'staging' } }, { term: { level: 'DEBUG' } }, { range: { status: { gte: 500 } } }] } }) },
  { id: 'filtre_must_not_groupe', dsl: total({ bool: { must_not: [{ bool: { must: [{ term: { env: 'prod' } }, { term: { level: 'INFO' } }] } }] } }) },
  { id: 'filtre_not_query_string', dsl: total({ query_string: { query: 'NOT env:prod AND level:ERROR' } }) },
  { id: 'filtre_must_not_prefix', dsl: total({ bool: { must_not: [{ prefix: { env: 'pr' } }] } }) },
  { id: 'multivalue_term', dsl: total({ term: { tags: 'a' } }) },
  { id: 'multivalue_terms_agg', dsl: { size: 0, aggs: { t: { terms: { field: 'tags' } } } } },
  { id: 'multivalue_terms', dsl: total({ terms: { tags: ['a', 'c'] } }) },
  { id: 'multivalue_must_not', dsl: total({ bool: { must_not: [{ term: { tags: 'a' } }] } }) },
  { id: 'multivalue_prefix', dsl: total({ prefix: { tags: 'b' } }) },
  { id: 'multivalue_mesures', dsl: { size: 0, aggs: { n: { value_count: { field: 'tags' } }, u: { cardinality: { field: 'tags' } } } } },
  { id: 'multivalue_terms_missing', dsl: { size: 0, aggs: { t: { terms: { field: 'tags', missing: 'aucun' } } } } },
  { id: 'multivalue_terms_imbrique', dsl: { size: 0, aggs: { t: { terms: { field: 'tags' }, aggs: { svc: { terms: { field: 'service', size: 2 } } } } } } },

  /* ---------- Dates ---------- */
  { id: 'date_plage_kibana', tz: PARIS, dsl: total({ bool: { filter: [{ range: { [TS]: { gte: '2026-03-09T00:00:00.000Z', lte: '2026-03-10T23:59:59.999Z', format: 'strict_date_optional_time' } } }, { match_phrase: { service: 'api' } }] } }) },
  { id: 'date_arrondi_bornes', dsl: total({ range: { [TS]: { gt: '2026-03-09T10:00:00Z||/d', lte: '2026-03-10T10:00:00Z||/d' } } }) },
  { id: 'date_epoch_millis', dsl: total({ range: { [TS]: { gte: T10, lt: T10 + DAY } } }) },
  { id: 'date_arrondi_fuseau', tz: PARIS, dsl: { size: 3, sort: [{ [TS]: 'asc' }], query: { range: { [TS]: { gte: '2026-03-10T12:00:00Z||/d', lt: '2026-03-10T12:00:00Z||+1d/d' } } } } },
  { id: 'date_sans_fuseau', tz: PARIS, dsl: { size: 3, sort: [{ [TS]: 'asc' }], query: { range: { [TS]: { gte: '2026-03-10', lt: '2026-03-11' } } } } },
  // Borne écrite sans heure : « lte » et « gt » vont jusqu’à la fin du jour
  { id: 'date_borne_jour', tz: PARIS, dsl: total({ range: { [TS]: { gte: '2026-03-09', lte: '2026-03-10' } } }) },
  { id: 'date_borne_jour_exclusive', tz: PARIS, dsl: total({ range: { [TS]: { gt: '2026-03-09', lt: '2026-03-11' } } }) },
  { id: 'date_borne_mois', tz: PARIS, dsl: total({ range: { [TS]: { gte: '2026-03', lte: '2026-03' } } }) },
  { id: 'date_epoch_chaine', dsl: total({ range: { [TS]: { gte: String(T10), lt: String(T10 + DAY) } } }) },
  { id: 'date_arrondi_semaine', tz: PARIS, dsl: { size: 3, sort: [{ [TS]: 'asc' }], query: { range: { [TS]: { gte: '2026-03-10T12:00:00Z||/w', lt: '2026-03-10T12:00:00Z||/M+1M' } } } } },
  { id: 'date_fuseau_requete', tz: PARIS, dsl: { size: 3, sort: [{ [TS]: 'asc' }], query: { range: { [TS]: { gte: '2026-03-10||/d', lt: '2026-03-10||+1d/d', time_zone: 'Asia/Tokyo' } } } } },

  /* ---------- Recherche plein texte ---------- */
  { id: 'texte_multi_match', dsl: total({ multi_match: { query: 'timeout', fields: ['message', 'level'] } }) },
  { id: 'texte_match_et', dsl: total({ match: { message: { query: 'upstream timeout', operator: 'and' } } }) },
  { id: 'texte_match_casse', dsl: total({ match: { message: 'RESET' } }) },
  { id: 'texte_match_accent', dsl: total({ match: { message: 'RÉSEAU' } }) },
  { id: 'texte_match_apostrophe', dsl: total({ match: { message: "don't" } }) },
  { id: 'texte_match_ip', known: 'l’analyseur standard garde « 10.0.0.1 » entier ; la traduction cherche 10 OU 0 OU 1', dsl: total({ match: { message: '10.0.0.1' } }) },
  { id: 'texte_match_mot_compose', known: 'pour Elasticsearch « user_id » est un seul mot : « user » ne le trouve pas', dsl: total({ match: { message: 'user' } }) },
  { id: 'texte_match_identifiant', known: 'pour Elasticsearch « user_id » est un seul mot ; la traduction cherche user OU id', dsl: total({ match: { message: 'user_id' } }) },
  { id: 'texte_match_decimal', known: 'pour Elasticsearch « 3.14s » est un seul mot ; la traduction cherche 3 OU 14', dsl: total({ match: { message: '3.14' } }) },
  { id: 'texte_match_phrase', known: 'la phrase est cherchée comme sous-chaîne exacte : « connection-reset » et les espaces multiples sont manqués', dsl: total({ match_phrase: { message: 'connection reset' } }) },
  { id: 'texte_phrase_prefixe', known: 'la phrase est cherchée comme sous-chaîne exacte : « connection-reset » et les espaces multiples sont manqués', dsl: total({ match_phrase_prefix: { message: 'connection res' } }) },
  // simple_query_string : opérateurs appliqués de gauche à droite, négation combinée par l’opérateur par défaut, rien n’est refusé
  { id: 'texte_sqs_negation', dsl: total({ simple_query_string: { query: 'timeout -upstream', fields: ['message'] } }) },
  { id: 'texte_sqs_ou', dsl: total({ simple_query_string: { query: 'timeout | reset', fields: ['message'] } }) },
  { id: 'texte_sqs_et', dsl: total({ simple_query_string: { query: 'timeout +upstream', fields: ['message'] } }) },
  { id: 'texte_sqs_groupe', dsl: total({ simple_query_string: { query: '(timeout | reset) +upstream', fields: ['message'] } }) },
  { id: 'texte_sqs_parenthese_en_trop', dsl: total({ simple_query_string: { query: 'timeout) reset', fields: ['message'] } }) },
  { id: 'texte_sqs_operateur_et', dsl: total({ simple_query_string: { query: 'upstream timeout -reset', fields: ['message'], default_operator: 'and' } }) },
  { id: 'texte_sqs_flou', dsl: total({ simple_query_string: { query: 'conection~1', fields: ['message'] } }) },

  /* ---------- Tri et pagination des documents ---------- */
  { id: 'tri_search_after', dsl: { size: 10, sort: [{ [TS]: 'desc' }], search_after: [T10] } },
  { id: 'tri_collapse', dsl: { size: 5, sort: [{ [TS]: 'desc' }], collapse: { field: 'host' } } },
  { id: 'tri_champ_absent_asc', known: { D: 'valeur par défaut : la chaîne vide trie en premier, Elasticsearch place les absents en dernier' }, dsl: { size: 30, sort: [{ user: 'asc' }, { [TS]: 'asc' }] } },
  { id: 'tri_champ_absent_desc', dsl: { size: 30, sort: [{ user: 'desc' }, { [TS]: 'asc' }] } },

  /* ---------- Champs runtime ---------- */
  { id: 'runtime_classe', dsl: { size: 0, runtime_mappings: { classe: { type: 'keyword', script: CLASSE } }, query: { term: { classe: 'lent' } }, aggs: { svc: { terms: { field: 'service' } }, c: { terms: { field: 'classe' } } } } },
  { id: 'runtime_liste_noire', dsl: { size: 0, runtime_mappings: { classe: { type: 'keyword', script: CLASSE }, hote: { type: 'keyword', script: "emit(doc['host'].value.toLowerCase())" } }, query: { bool: { filter: [{ terms: { classe: ['normal', 'lent'] } }], must_not: [{ terms: { hote: ['web-1', 'web-a', 'db_01'] } }] } }, aggs: { h: { terms: { field: 'hote', size: 20 } } } } },
  { id: 'runtime_division_entiere', dsl: { size: 0, runtime_mappings: { tranche: { type: 'long', script: "emit(doc['latency_ms'].value / 100)" } }, aggs: { b: { terms: { field: 'tranche', size: 40, order: { _key: 'asc' } } } } } },
  { id: 'runtime_division_decimale', dsl: { size: 0, runtime_mappings: { moitie: { type: 'double', script: "emit(doc['latency_ms'].value / 2.0)" } }, aggs: { m: { max: { field: 'moitie' } }, s: { sum: { field: 'moitie' } } } } },
  { id: 'runtime_division_accesseur', tz: PARIS, dsl: { size: 0, runtime_mappings: { quart: { type: 'long', script: "emit(doc['@timestamp'].value.getHour() / 6)" } }, aggs: { q: { terms: { field: 'quart', order: { _key: 'asc' } } } } } },
  { id: 'runtime_champ_absent', dsl: { size: 0, runtime_mappings: { milieu: { type: 'keyword', script: "if (doc['env'].size() != 0) { emit(doc['env'].value.toUpperCase()) }" } }, query: { bool: { must_not: [{ term: { milieu: 'PROD' } }] } }, aggs: { m: { terms: { field: 'milieu' } } } } },
  { id: 'runtime_alias_agregation', dsl: { size: 0, runtime_mappings: { b: { type: 'long', script: "emit(doc['status'].value)" } }, aggs: { b: { terms: { field: 'b', size: 40, order: { _key: 'asc' } } } } } },
  { id: 'runtime_heure_fuseau', tz: PARIS, dsl: { size: 0, runtime_mappings: { heure: { type: 'long', script: "emit(doc['@timestamp'].value.getHour())" } }, query: { range: { [TS]: { lt: '2026-03-08T03:00:00Z' } } }, aggs: { h: { terms: { field: 'heure', size: 24, order: { _key: 'asc' } } } } } },
  { id: 'runtime_jour_semaine', tz: PARIS, dsl: { size: 0, runtime_mappings: { jour: { type: 'long', script: "emit(doc['@timestamp'].value.getDayOfWeekEnum().getValue())" } }, aggs: { j: { terms: { field: 'jour', size: 7, order: { _key: 'asc' } } } } } },
  { id: 'runtime_heure_locale', tz: PARIS, dsl: { size: 0, runtime_mappings: { heure: { type: 'long', script: "emit(doc['@timestamp'].value.withZoneSameInstant(ZoneId.of('Asia/Tokyo')).getHour())" } }, query: { range: { [TS]: { lt: '2026-03-08T03:00:00Z' } } }, aggs: { h: { terms: { field: 'heure', size: 24, order: { _key: 'asc' } } } } } },
  // ChronoUnit.between compte les jours entiers écoulés, pas les changements de date
  { id: 'runtime_jours_ecoules', tz: PARIS, dsl: { size: 0, runtime_mappings: { reste: { type: 'long', script: "emit(ChronoUnit.DAYS.between(doc['@timestamp'].value.toInstant(), Instant.ofEpochMilli(1773273600000L)))" } }, aggs: { r: { terms: { field: 'reste', size: 10, order: { _key: 'asc' } } } } } },

  /* ---------- Agrégation composite, paginée jusqu’au bout ---------- */
  { id: 'composite_2_sources', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 7, sources: [{ svc: { terms: { field: 'service' } } }, { lvl: { terms: { field: 'level' } } }] }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } },
  { id: 'composite_5_sources', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 400, sources: [{ svc: { terms: { field: 'service' } } }, { h: { terms: { field: 'host' } } }, { lvl: { terms: { field: 'level' } } }, { st: { terms: { field: 'status' } } }, { m: { terms: { field: 'http.method' } } }] } } } } },
  { id: 'composite_cle_date', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 6, sources: [{ h: { terms: { field: 'host' } } }, { d: { date_histogram: { field: TS, calendar_interval: 'day' } } }] } } } } },
  { id: 'composite_cle_semaine', composite: 'c', tz: PARIS, dsl: { size: 0, aggs: { c: { composite: { size: 4, sources: [{ w: { date_histogram: { field: TS, calendar_interval: 'week' } } }, { svc: { terms: { field: 'service' } } }] } } } } },
  { id: 'composite_ordre_desc', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 25, sources: [{ svc: { terms: { field: 'service' } } }, { env: { terms: { field: 'env' } } }, { lvl: { terms: { field: 'level', order: 'desc' } } }, { st: { terms: { field: 'status' } } }] } } } } },
  { id: 'composite_missing_bucket', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 10, sources: [{ env: { terms: { field: 'env', missing_bucket: true } } }, { svc: { terms: { field: 'service' } } }] } } } } },
  { id: 'composite_missing_desc', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 4, sources: [{ env: { terms: { field: 'env', missing_bucket: true, order: 'desc' } } }, { svc: { terms: { field: 'service' } } }] } } } } },
  { id: 'composite_missing_order', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 4, sources: [{ svc: { terms: { field: 'service' } } }, { env: { terms: { field: 'env', missing_bucket: true, missing_order: 'last' } } }, { lvl: { terms: { field: 'level', order: 'desc' } } }] } } } } },
  // Six sources, sens mélangés, clé null, clé date et mesure : le cas d’usage type d’un export paginé
  { id: 'composite_6_sources', composite: 'c', tz: PARIS, dsl: { size: 0, query: { range: { [TS]: { gte: '2026-03-08T12:00:00Z' } } }, aggs: { c: { composite: { size: 150, sources: [{ svc: { terms: { field: 'service' } } }, { env: { terms: { field: 'env', missing_bucket: true, order: 'desc' } } }, { lvl: { terms: { field: 'level', order: 'desc' } } }, { st: { terms: { field: 'status' } } }, { d: { date_histogram: { field: TS, calendar_interval: 'day' } } }, { m: { terms: { field: 'http.method' } } }] }, aggs: { lat: { avg: { field: 'latency_ms' } }, octets: { sum: { field: 'bytes' } } } } } } },
  // Une page prise au milieu : le curseur « after » tel que le client le renvoie, avec une clé null et une clé date
  { id: 'composite_page_suivante', tz: PARIS, dsl: { size: 0, aggs: { c: { composite: { size: 20, after: { svc: 'cart', env: null, lvl: 'INFO', st: 404, d: 1773014400000, m: 'POST' }, sources: [{ svc: { terms: { field: 'service' } } }, { env: { terms: { field: 'env', missing_bucket: true, order: 'desc' } } }, { lvl: { terms: { field: 'level', order: 'desc' } } }, { st: { terms: { field: 'status' } } }, { d: { date_histogram: { field: TS, calendar_interval: 'day' } } }, { m: { terms: { field: 'http.method' } } }] }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } },
  { id: 'composite_page_simple', dsl: { size: 0, aggs: { c: { composite: { size: 10, after: { svc: 'cart', h: 'web-3' }, sources: [{ svc: { terms: { field: 'service' } } }, { h: { terms: { field: 'host' } } }] } } } } },
  { id: 'composite_histogramme', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 9, sources: [{ tranche: { histogram: { field: 'latency_ms', interval: 500 } } }, { svc: { terms: { field: 'service', order: 'desc' } } }] } } } } },
  { id: 'composite_export_complet', composite: 'c', config: { clickhouse: { composite_mode: 'stream' } }, dsl: { size: 0, aggs: { c: { composite: { size: 400, sources: [{ svc: { terms: { field: 'service' } } }, { h: { terms: { field: 'host' } } }, { lvl: { terms: { field: 'level' } } }, { st: { terms: { field: 'status' } } }, { m: { terms: { field: 'http.method' } } }] }, aggs: { lat: { avg: { field: 'latency_ms' } } } } } } },
  { id: 'composite_multivalue', composite: 'c', dsl: { size: 0, aggs: { c: { composite: { size: 10, sources: [{ t: { terms: { field: 'tags' } } }, { svc: { terms: { field: 'service' } } }] } } } } }
];
