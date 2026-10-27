/* Passerelle — moteur : contrôle strict d’une requête DSL, avant traduction */
/*
 * Elasticsearch refuse une clé qu’il ne connaît pas. Ignorer cette clé rendait un SQL qui s’exécute
 * et répond faux : un « filtre » mal écrit lisait toute la table, un « knn » disparaissait.
 * checkDSL relit la requête et classe chaque clé :
 *   error     clé inconnue là où la liste d’Elasticsearch est fermée (corps de recherche, bool, définition
 *             d’agrégation, une seule clause ou un seul champ par objet) : la requête est refusée, comme
 *             Elasticsearch la refuserait ;
 *   todo      paramètre inconnu d’une clause, ou option connue qui change le résultat sans être traduite :
 *             la requête est « à reprendre » et le SQL s’arrête sur throwIf ;
 *   review    option connue, non appliquée, dont l’effet dépend des données (analyseur, drapeaux…) ;
 *   noEffect  option sans effet sur les lignes ni sur les agrégats (score, mise en forme, exécution).
 * Les clauses et agrégations d’un type inconnu restent signalées par la traduction elle-même.
 */
const always = () => true;
const notDefault = def => v => String(v).toLowerCase() !== def;
const positive = v => Number(v) > 0;

/* ---------- Corps de la recherche ---------- */
const BODY_TRANSLATED = new Set(['query', 'aggs', 'aggregations', 'size', 'from', 'sort', '_source', 'fields', 'docvalue_fields', 'stored_fields', 'script_fields', 'runtime_mappings', 'post_filter', 'search_after', 'collapse', 'track_total_hits', 'timeout']);
const BODY_NO_EFFECT = new Set(['highlight', 'explain', 'version', 'seq_no_primary_term', 'profile', 'stats', 'track_scores', 'indices_boost', 'rescore', 'pit']);
const BODY_TODO = {
  knn: 'La recherche vectorielle (knn) n’a pas d’équivalent automatique : écrivez-la avec une fonction de distance (L2Distance, cosineDistance) et un index vector_similarity.',
  retriever: 'Les retrievers (combinaison de recherches, RRF) n’ont pas d’équivalent en SQL.',
  rank: 'Le classement par fusion (rank, RRF) n’a pas d’équivalent en SQL.',
  sub_searches: 'Les sous-recherches combinées n’ont pas d’équivalent en SQL.',
  min_score: 'Le seuil de score écarte des documents, mais le score de pertinence n’existe pas en SQL.',
  terminate_after: 'Elasticsearch s’arrête après N documents par shard : le résultat dépend de la répartition, ClickHouse lit tout.',
  suggest: 'Les suggestions (correction orthographique, complétion) n’ont pas d’équivalent en SQL.',
  slice: 'Le découpage en tranches (slice) d’un parcours parallèle est à réécrire, par exemple avec cityHash64(clé) % N.',
  ext: 'Les extensions de plugin (ext) n’ont pas d’équivalent.'
};

/* ---------- Clauses de requête ---------- */
// field : forme { <champ>: valeur ou { paramètres } } ; queries : sous-requêtes à contrôler aussi
const QUERY_SPECS = {
  match_all: { params: [] },
  match_none: { params: [] },
  term: { field: true, params: ['value', 'case_insensitive'] },
  terms: { terms: true },
  range: { field: true, object: true, params: ['gt', 'gte', 'lt', 'lte', 'from', 'to', 'include_lower', 'include_upper', 'format', 'relation', 'time_zone'] },
  exists: { params: ['field'] },
  ids: { params: ['values', 'type'] },
  prefix: { field: true, params: ['value', 'case_insensitive', 'rewrite'] },
  wildcard: { field: true, params: ['value', 'wildcard', 'case_insensitive', 'rewrite'] },
  regexp: { field: true, params: ['value', 'case_insensitive', 'rewrite', 'max_determinized_states', 'flags'], review: { flags: notDefault('all') } },
  fuzzy: { field: true, params: ['value', 'fuzziness', 'max_expansions', 'prefix_length', 'transpositions', 'rewrite'] },
  match: {
    field: true,
    params: ['query', 'operator', 'minimum_should_match', 'fuzziness', 'zero_terms_query', 'analyzer', 'auto_generate_synonyms_phrase_query', 'max_expansions', 'prefix_length', 'fuzzy_transpositions', 'fuzzy_rewrite', 'lenient', 'cutoff_frequency'],
    review: { analyzer: always, cutoff_frequency: always }
  },
  match_phrase: { field: true, params: ['query', 'slop', 'zero_terms_query', 'analyzer'], review: { analyzer: always } },
  match_phrase_prefix: { field: true, params: ['query', 'slop', 'zero_terms_query', 'analyzer', 'max_expansions'], review: { analyzer: always, slop: positive } },
  match_bool_prefix: {
    field: true,
    params: ['query', 'operator', 'minimum_should_match', 'fuzziness', 'analyzer', 'prefix_length', 'max_expansions', 'fuzzy_transpositions', 'fuzzy_rewrite'],
    todo: { operator: notDefault('or'), minimum_should_match: always, fuzziness: notDefault('0') },
    review: { analyzer: always }
  },
  multi_match: {
    params: ['query', 'fields', 'type', 'operator', 'minimum_should_match', 'fuzziness', 'zero_terms_query', 'analyzer', 'auto_generate_synonyms_phrase_query', 'max_expansions', 'prefix_length', 'fuzzy_transpositions', 'fuzzy_rewrite', 'rewrite', 'lenient', 'cutoff_frequency', 'tie_breaker', 'slop'],
    review: { analyzer: always, cutoff_frequency: always, slop: positive }
  },
  combined_fields: {
    params: ['query', 'fields', 'operator', 'minimum_should_match', 'zero_terms_query', 'auto_generate_synonyms_phrase_query'],
    todo: { minimum_should_match: always }
  },
  query_string: {
    params: ['query', 'default_field', 'fields', 'default_operator', 'analyzer', 'quote_analyzer', 'allow_leading_wildcard', 'analyze_wildcard', 'enable_position_increments', 'fuzziness', 'fuzzy_max_expansions', 'fuzzy_prefix_length', 'fuzzy_transpositions', 'lenient', 'max_determinized_states', 'minimum_should_match', 'quote_field_suffix', 'phrase_slop', 'rewrite', 'time_zone', 'auto_generate_synonyms_phrase_query', 'type', 'tie_breaker', 'escape', 'use_dis_max', 'split_on_whitespace'],
    todo: { minimum_should_match: always },
    review: { analyzer: always, quote_analyzer: always, quote_field_suffix: always, phrase_slop: positive, time_zone: always }
  },
  simple_query_string: {
    params: ['query', 'fields', 'default_operator', 'analyzer', 'analyze_wildcard', 'auto_generate_synonyms_phrase_query', 'flags', 'fuzzy_max_expansions', 'fuzzy_prefix_length', 'fuzzy_transpositions', 'lenient', 'minimum_should_match', 'quote_field_suffix'],
    todo: { minimum_should_match: always },
    review: { analyzer: always, flags: notDefault('all'), quote_field_suffix: always }
  },
  bool: { bool: true },
  constant_score: { params: ['filter'], queries: { filter: 'one' } },
  dis_max: { params: ['queries', 'tie_breaker'], queries: { queries: 'many' } },
  boosting: { params: ['positive', 'negative', 'negative_boost'], queries: { positive: 'one', negative: 'one' } },
  function_score: {
    params: ['query', 'functions', 'boost_mode', 'score_mode', 'max_boost', 'min_score', 'random_score', 'field_value_factor', 'script_score', 'weight', 'gauss', 'linear', 'exp'],
    queries: { query: 'one' },
    todo: { min_score: always }
  },
  script_score: { params: ['query', 'script', 'min_score'], queries: { query: 'one' }, todo: { min_score: always } },
  script: { params: ['script'] },
  nested: { params: ['path', 'query', 'score_mode', 'ignore_unmapped', 'inner_hits'], queries: { query: 'one' }, review: { inner_hits: always } },
  geo_distance: { geo: true, params: ['distance', 'distance_type', 'validation_method', 'ignore_unmapped'] }
};
const COMMON_PARAMS = ['boost', '_name', 'queryName'];
const BOOL_KEYS = new Set(['must', 'filter', 'should', 'must_not', 'minimum_should_match', 'boost', '_name', 'adjust_pure_negative']);

/* ---------- Agrégations ---------- */
const METRIC = ['field', 'script', 'missing', 'format', 'value_type'];
const PIPE = ['buckets_path', 'gap_policy', 'format'];
const gapPolicy = { gap_policy: notDefault('skip') };
const AGG_SPECS = {
  avg: { params: METRIC }, sum: { params: METRIC }, min: { params: METRIC }, max: { params: METRIC },
  value_count: { params: ['field', 'script', 'format', 'value_type'] },
  cardinality: { params: [...METRIC, 'precision_threshold', 'execution_hint', 'rehash'] },
  stats: { params: METRIC },
  extended_stats: { params: [...METRIC, 'sigma'] },
  percentiles: { params: [...METRIC, 'percents', 'keyed', 'tdigest', 'hdr'], review: { hdr: always } },
  percentile_ranks: { params: [...METRIC, 'values', 'keyed', 'tdigest', 'hdr'], review: { hdr: always } },
  weighted_avg: { params: ['value', 'weight', 'format', 'value_type'] },
  top_metrics: { params: ['metrics', 'sort', 'size'] },
  boxplot: { params: ['field', 'script', 'missing', 'compression', 'execution_hint'] },
  rate: { params: ['field', 'script', 'unit', 'mode', 'format'] },
  top_hits: { params: ['from', 'size', 'sort', '_source', 'fields', 'docvalue_fields', 'stored_fields', 'script_fields', 'highlight', 'explain', 'version', 'seq_no_primary_term', 'track_scores'] },
  terms: { params: ['field', 'script', 'size', 'shard_size', 'order', 'min_doc_count', 'shard_min_doc_count', 'include', 'exclude', 'missing', 'value_type', 'execution_hint', 'collect_mode', 'show_term_doc_count_error', 'format'] },
  multi_terms: { params: ['terms', 'size', 'shard_size', 'order', 'min_doc_count', 'shard_min_doc_count', 'show_term_doc_count_error', 'collect_mode'] },
  rare_terms: { params: ['field', 'max_doc_count', 'precision', 'include', 'exclude', 'missing'] },
  significant_terms: { params: ['field', 'size', 'shard_size', 'min_doc_count', 'shard_min_doc_count', 'include', 'exclude', 'background_filter', 'execution_hint', 'jlh', 'mutual_information', 'chi_square', 'gnd', 'percentage', 'script_heuristic'] },
  significant_text: { params: ['field', 'size', 'shard_size', 'min_doc_count', 'shard_min_doc_count', 'include', 'exclude', 'background_filter', 'filter_duplicate_text', 'source_fields', 'jlh', 'mutual_information', 'chi_square', 'gnd', 'percentage', 'script_heuristic'] },
  date_histogram: { params: ['field', 'script', 'calendar_interval', 'fixed_interval', 'interval', 'time_zone', 'offset', 'min_doc_count', 'extended_bounds', 'hard_bounds', 'format', 'keyed', 'missing', 'order'] },
  auto_date_histogram: { params: ['field', 'script', 'buckets', 'format', 'time_zone', 'minimum_interval', 'missing'], review: { minimum_interval: always } },
  histogram: { params: ['field', 'script', 'interval', 'offset', 'min_doc_count', 'extended_bounds', 'hard_bounds', 'keyed', 'missing', 'order', 'format'] },
  range: { params: ['field', 'script', 'ranges', 'keyed', 'format', 'missing'] },
  date_range: { params: ['field', 'script', 'ranges', 'keyed', 'format', 'missing', 'time_zone'] },
  ip_range: { params: ['field', 'script', 'ranges', 'keyed', 'missing'] },
  filter: { query: true },
  filters: { params: ['filters', 'other_bucket', 'other_bucket_key', 'keyed'] },
  missing: { params: ['field'] },
  global: { params: [] },
  composite: { params: ['sources', 'size', 'after'] },
  geohash_grid: { params: ['field', 'precision', 'bounds', 'size', 'shard_size'], review: { bounds: always } },
  geotile_grid: { params: ['field', 'precision', 'bounds', 'size', 'shard_size'], review: { bounds: always } },
  nested: { params: ['path'] },
  reverse_nested: { params: ['path'] },
  sampler: { params: ['shard_size'] },
  diversified_sampler: { params: ['field', 'script', 'shard_size', 'max_docs_per_value', 'execution_hint'], review: { max_docs_per_value: always } },
  bucket_selector: { params: ['buckets_path', 'script', 'gap_policy'], review: gapPolicy },
  bucket_script: { params: [...PIPE, 'script'], review: gapPolicy },
  bucket_sort: { params: ['sort', 'from', 'size', 'gap_policy'], review: gapPolicy },
  cumulative_sum: { params: ['buckets_path', 'format'] },
  derivative: { params: [...PIPE, 'unit'], review: gapPolicy },
  serial_diff: { params: [...PIPE, 'lag'], review: gapPolicy },
  moving_fn: { params: ['buckets_path', 'window', 'script', 'shift', 'gap_policy'], review: gapPolicy },
  moving_avg: { params: [...PIPE, 'model', 'window', 'predict', 'settings', 'minimize'], review: gapPolicy },
  avg_bucket: { params: PIPE, review: gapPolicy }, sum_bucket: { params: PIPE, review: gapPolicy },
  min_bucket: { params: PIPE, review: gapPolicy }, max_bucket: { params: PIPE, review: gapPolicy },
  stats_bucket: { params: PIPE, review: gapPolicy },
  extended_stats_bucket: { params: [...PIPE, 'sigma'], review: gapPolicy },
  percentiles_bucket: { params: [...PIPE, 'percents', 'keyed'], review: gapPolicy }
};
const COMPOSITE_SOURCES = {
  terms: ['field', 'script', 'missing_bucket', 'missing_order', 'order', 'value_type'],
  histogram: ['field', 'script', 'interval', 'missing_bucket', 'missing_order', 'order'],
  date_histogram: ['field', 'script', 'calendar_interval', 'fixed_interval', 'interval', 'time_zone', 'offset', 'format', 'missing_bucket', 'missing_order', 'order'],
  geotile_grid: ['field', 'precision', 'bounds', 'missing_bucket', 'missing_order', 'order']
};
const AGG_CONTAINER = new Set(['aggs', 'aggregations', 'meta']);

/* ---------- Parcours ---------- */
function checkDSL(dsl) {
  const out = { errors: [], issues: [] };
  const error = msg => out.errors.push(msg);
  const issue = (kind, label, detail) => out.issues.push({ kind, label, detail });
  const list = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

  // Paramètres d’une clause ou d’une agrégation : connus, sans effet, à vérifier ou à reprendre
  function params(obj, spec, where, allowed) {
    if (!isObj(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (allowed.includes(k)) continue;
      if (!spec.params.includes(k)) { issue('todo', `paramètre « ${k} » (${where})`, `Paramètre inconnu : Elasticsearch le refuserait s’il ne le connaît pas, et la traduction ne l’applique pas. Corrigez son nom ou retirez-le.`); continue; }
      if (spec.todo && spec.todo[k] && spec.todo[k](v)) issue('todo', `option « ${k} » (${where})`, `L’option ${k} change le résultat et n’est pas traduite.`);
      else if (spec.review && spec.review[k] && spec.review[k](v)) issue('review', `option « ${k} » (${where})`, `L’option ${k} n’est pas appliquée : vérifiez que le résultat n’en dépend pas.`);
    }
  }

  function query(q, where) {
    if (!isObj(q)) return;
    const keys = Object.keys(q);
    if (keys.length > 1) { error(`${where} : une clause par objet, trouvé ${keys.join(', ')}`); return; }
    if (!keys.length) return;
    const type = keys[0]; const body = q[type]; const spec = QUERY_SPECS[type];
    const at = `${type} dans ${where}`;
    if (!spec || !isObj(body)) return;
    if (spec.bool) {
      for (const k of Object.keys(body)) if (!BOOL_KEYS.has(k)) error(`${at} : clé « ${k} » inconnue (must, filter, should, must_not, minimum_should_match)`);
      for (const k of ['must', 'filter', 'should', 'must_not']) list(body[k]).forEach((c, i) => query(c, `${where}.bool.${k}[${i}]`));
      return;
    }
    if (spec.field || spec.terms || spec.geo) {
      const fields = Object.keys(body).filter(k => !COMMON_PARAMS.includes(k) && !(spec.geo && spec.params.includes(k)));
      if (fields.length > 1) { error(`${at} : un seul champ par clause, trouvé ${fields.join(', ')}`); return; }
      if (spec.geo) { params(body, spec, at, [...COMMON_PARAMS, ...fields]); return; }
      if (spec.terms) return;
      const v = body[fields[0]];
      if (isObj(v)) params(v, spec, `${at}, champ ${fields[0]}`, COMMON_PARAMS);
      else if (spec.object && fields.length) error(`${at} : les bornes de ${fields[0]} s’écrivent dans un objet`);
      return;
    }
    params(body, spec, at, COMMON_PARAMS);
    for (const [k, card] of Object.entries(spec.queries || {})) {
      if (card === 'one') query(body[k], `${where}.${type}.${k}`);
      else list(body[k]).forEach((c, i) => query(c, `${where}.${type}.${k}[${i}]`));
    }
    if (type === 'function_score') list(body.functions).forEach((f, i) => isObj(f) && query(f.filter, `${where}.function_score.functions[${i}].filter`));
  }

  function aggs(defs, where) {
    if (!isObj(defs)) return;
    for (const [name, def] of Object.entries(defs)) {
      const at = `${where}.${name}`;
      if (!isObj(def)) { error(`${at} : définition d’agrégation attendue`); continue; }
      const types = Object.keys(def).filter(k => !AGG_CONTAINER.has(k));
      if (types.length !== 1) { error(types.length ? `${at} : deux types d’agrégation (${types.join(', ')})` : `${at} : type d’agrégation absent`); continue; }
      if (def.aggs && def.aggregations) error(`${at} : aggs et aggregations ensemble`);
      const type = types[0]; const body = def[type]; const spec = AGG_SPECS[type];
      if (spec && spec.query) query(body, `${at}.filter`);
      else if (spec) params(body, spec, `${type} ${at}`, []);
      if (type === 'filters' && isObj(body)) {
        const fs = body.filters;
        (Array.isArray(fs) ? fs : isObj(fs) ? Object.values(fs) : []).forEach((f, i) => query(f, `${at}.filters[${i}]`));
      }
      if (type === 'composite' && isObj(body)) {
        list(body.sources).forEach(src => {
          if (!isObj(src)) return;
          for (const [srcName, srcDef] of Object.entries(src)) {
            const st = isObj(srcDef) ? Object.keys(srcDef) : [];
            if (st.length !== 1) { error(`${at}.sources.${srcName} : un type de source attendu`); continue; }
            if (COMPOSITE_SOURCES[st[0]]) params(srcDef[st[0]], { params: COMPOSITE_SOURCES[st[0]] }, `source ${srcName} de ${at}`, []);
          }
        });
      }
      aggs(def.aggs || def.aggregations, `${at}`);
    }
  }

  if (!isObj(dsl)) return out;
  // Formes qui ne sont pas une requête de recherche : le message dit quoi en extraire
  if (isObj(dsl.attributes) && typeof dsl.type === 'string') {
    error(`objet sauvegardé Kibana (${dsl.type}), pas une requête de recherche. Importez l’export .ndjson dans l’inventaire Kibana (passerelle kibana), ou copiez la requête depuis Inspect > Request dans Kibana`);
    return out;
  }
  if (isObj(dsl.query) && typeof dsl.query.query === 'string' && typeof dsl.query.language === 'string') {
    error(`requête Kibana en ${dsl.query.language === 'kuery' ? 'KQL' : dsl.query.language} (searchSource), pas une requête DSL. Importez l’export .ndjson dans l’inventaire Kibana (passerelle kibana), ou copiez la requête depuis Inspect > Request dans Kibana`);
    return out;
  }
  const noEffect = [];
  for (const k of Object.keys(dsl)) {
    if (BODY_TRANSLATED.has(k)) continue;
    if (BODY_NO_EFFECT.has(k)) noEffect.push(k);
    else if (BODY_TODO[k]) issue('todo', `option « ${k} »`, BODY_TODO[k]);
    else error(`clé « ${k} » inconnue dans le corps de la recherche`);
  }
  if (dsl.aggs && dsl.aggregations) error('aggs et aggregations ensemble');
  if (noEffect.length) out.issues.push({ kind: 'noEffect', label: noEffect.join(', '), detail: '' });
  if (isObj(dsl.collapse) && dsl.collapse.inner_hits !== undefined) issue('review', 'option « inner_hits » de collapse', 'Les documents internes de chaque groupe ne sont pas reproduits : un seul document par valeur.');
  query(dsl.query, 'query');
  query(dsl.post_filter, 'post_filter');
  aggs(dsl.aggs || dsl.aggregations, 'aggs');
  return out;
}

// Applique le contrôle à une traduction : notes, compteurs, et un throwIf par élément à reprendre
function applyStrictIssues(ctx, issues) {
  const guards = [];
  for (const it of issues) {
    if (it.kind === 'todo') {
      ctx.stats.ko++;
      ctx.notes.add('err', `${it.label[0].toUpperCase()}${it.label.slice(1)} : à reprendre`, it.detail);
      guards.push(`throwIf(1, ${chStr(`Passerelle : ${it.label} à reprendre`)})`);
    } else if (it.kind === 'review') {
      ctx.stats.approx++;
      ctx.notes.add('warn', `${it.label[0].toUpperCase()}${it.label.slice(1)} non appliquée`, it.detail);
    } else ctx.notes.add('info', 'Options sans effet sur le résultat', `${it.label} : ignorées, elles ne changent ni les documents renvoyés ni les agrégats.`);
  }
  return guards;
}
