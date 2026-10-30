/* Passerelle — moteur : tableaux de bord Grafana branchés sur Elasticsearch, vers le plugin ClickHouse */
/*
 * Un panneau Grafana interroge Elasticsearch par un modèle de requête (Lucene, mesures, regroupements) que la source
 * de données traduit elle-même en DSL. La traduction ci-dessous reconstruit ce DSL comme le fait la source
 * (grafana-elasticsearch-datasource, data_query_processor.go et aggregation_factory.go) : période du tableau de bord,
 * query_string, regroupements emboîtés dans l’ordre de l’éditeur, mesures sous le plus profond, mesure de tri recopiée
 * sous le terms. Ce DSL passe par translateDSL en mode Grafana : la période devient $__timeFilter, l’intervalle
 * automatique $__interval_s, les variables ${var:singlequote}, avec $__conditionalAll pour « All ».
 *
 * Le SQL produit suit les conventions du plugin ClickHouse (format 0 série temporelle, 1 table, 2 journaux) : une colonne
 * de temps « time », les regroupements en colonnes de texte (étiquettes des séries), une colonne par mesure affichée,
 * nommée comme Grafana nommait la série (Average latency, p95.0 latency…).
 */
const CH_PLUGIN = 'grafana-clickhouse-datasource';
const CH_PLUGIN_VERSION = '4.23.2';
const CH_INPUT = 'DS_CLICKHOUSE';
const ES_METRIC_LABEL = {
  count: 'Count',
  avg: 'Average',
  sum: 'Sum',
  max: 'Max',
  min: 'Min',
  extended_stats: 'Extended Stats',
  percentiles: 'Percentiles',
  top_metrics: 'Top Metrics',
  cardinality: 'Unique Count',
  moving_avg: 'Moving Average',
  moving_fn: 'Moving Function',
  cumulative_sum: 'Cumulative Sum',
  derivative: 'Derivative',
  serial_diff: 'Serial Difference',
  bucket_script: 'Bucket Script',
  rate: 'Rate',
  sum_bucket: 'Sum Bucket',
  max_bucket: 'Max Bucket',
  min_bucket: 'Min Bucket',
  avg_bucket: 'Average Bucket'
};
const ES_EXT_STATS = {
  avg: 'Avg',
  min: 'Min',
  max: 'Max',
  sum: 'Sum',
  count: 'Count',
  std_deviation: 'Std Dev',
  std_deviation_bounds_upper: 'Std Dev Upper',
  std_deviation_bounds_lower: 'Std Dev Lower'
};
const ES_PIPELINES = new Set([
  'moving_avg',
  'moving_fn',
  'cumulative_sum',
  'derivative',
  'serial_diff',
  'bucket_script'
]);
const ES_SIBLINGS = new Set(['sum_bucket', 'max_bucket', 'min_bucket', 'avg_bucket']);
const ES_CALENDAR = new Set(['1w', '1M', '1q', '1y']);
const MOVING_MODEL = {
  simple: 'MovingFunctions.unweightedAvg(values)',
  linear: 'MovingFunctions.linearWeightedAvg(values)'
};

/* ---------- Lecture ---------- */
function grafanaRead(text) {
  let j;
  try {
    j = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { error: `JSON invalide : ${e.message}` };
  }
  if (!isObj(j)) return { error: 'Le tableau de bord doit être un objet JSON.' };
  if (typeof j.apiVersion === 'string' && /dashboard\.grafana\.app\/v2/.test(j.apiVersion))
    return {
      error:
        'Tableau de bord au schéma v2 (dashboard.grafana.app/v2) : exportez-le au format JSON classique (Exporter > Exporter au format JSON, modèle classique).'
    };
  const wrapper =
    isObj(j.dashboard) && (isObj(j.meta) || j.overwrite !== undefined || j.folderUid !== undefined)
      ? 'api'
      : isObj(j.spec) && typeof j.apiVersion === 'string'
        ? 'resource'
        : null;
  const dash = wrapper === 'api' ? j.dashboard : wrapper === 'resource' ? j.spec : j;
  if (!Array.isArray(dash.panels) && !Array.isArray(dash.rows))
    return { error: 'Aucun panneau : ce JSON n’est pas un tableau de bord Grafana.' };
  return { root: j, dash, wrapper };
}
// Panneaux, y compris ceux des lignes repliées et des lignes des anciens tableaux de bord (rows)
function grafanaPanels(dash) {
  const out = [];
  const walk = list => {
    for (const p of list || []) {
      if (!isObj(p)) continue;
      out.push(p);
      if (Array.isArray(p.panels)) walk(p.panels);
    }
  };
  walk(dash.panels);
  for (const r of dash.rows || []) walk(r.panels);
  return out;
}

/* ---------- Sources de données ---------- */
function grafanaSources(dash) {
  const inputs = (dash.__inputs || []).filter(i => isObj(i) && i.type === 'datasource');
  const esInputs = new Set(inputs.filter(i => i.pluginId === 'elasticsearch').map(i => i.name));
  const otherInputs = new Set(inputs.filter(i => i.pluginId !== 'elasticsearch').map(i => i.name));
  const vars = ((dash.templating || {}).list || []).filter(isObj);
  const dsVars = new Set(vars.filter(v => v.type === 'datasource' && v.query === 'elasticsearch').map(v => v.name));
  const ref = s => {
    const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(String(s || ''));
    return m ? m[1] : null;
  };
  // true : Elasticsearch ; false : une autre source ; null : on ne sait pas (source par défaut, nom seul)
  const isES = ds => {
    if (ds === null || ds === undefined || ds === '') return null;
    if (typeof ds === 'string') {
      const v = ref(ds);
      if (v) return esInputs.has(v) || dsVars.has(v) ? true : otherInputs.has(v) ? false : null;
      return /^-- (Mixed|Grafana|Dashboard) --$/.test(ds) ? false : null;
    }
    if (!isObj(ds)) return null;
    if (ds.type === 'elasticsearch') return true;
    if (ds.type && ds.type !== 'datasource') return false;
    const v = ref(ds.uid);
    if (v) return esInputs.has(v) || dsVars.has(v) ? true : otherInputs.has(v) ? false : null;
    return null;
  };
  // Référence vers ClickHouse : la variable de source de données est gardée, sinon l’entrée DS_CLICKHOUSE
  const chRef = ds => {
    const v = typeof ds === 'string' ? ref(ds) : isObj(ds) ? ref(ds.uid) : null;
    return { type: CH_PLUGIN, uid: v && dsVars.has(v) ? `\${${v}}` : `\${${CH_INPUT}}` };
  };
  return { isES, chRef, esInputs, dsVars };
}
// Modèle de requête Elasticsearch : mesures, et regroupements ou requête
const esShaped = t =>
  isObj(t) && Array.isArray(t.metrics) && (Array.isArray(t.bucketAggs) || typeof t.query === 'string');

/* ---------- Modèle de requête → DSL ---------- */
const gName = (used, base) => {
  let n =
    rawAlias(
      String(base || 'm')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
    )
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'm';
  if (/^\d/.test(n)) n = `m${n}`;
  let x = n,
    i = 2;
  while (used.has(x)) x = `${n}_${i++}`;
  used.add(x);
  return x;
};
const settingInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n !== 0 ? n : def;
};
const settingNum = (v, def) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n !== 0 ? n : def;
};
function scriptOf(settings) {
  const s = settings && settings.script;
  return typeof s === 'string'
    ? s
    : isObj(s) && typeof s.inline === 'string'
      ? s.inline
      : isObj(s) && typeof s.source === 'string'
        ? s.source
        : null;
}
/*
 * Une requête Grafana → corps de recherche, type de résultat et colonnes à afficher.
 * names : id de mesure → nom d’agrégation (donc de colonne SQL).
 */
function esTargetDSL(t, env) {
  const issues = env.issues;
  const tf = env.timeField;
  const metrics = (t.metrics && t.metrics.length ? t.metrics : [{ id: '1', type: 'count' }]).filter(isObj);
  const buckets = (t.bucketAggs || []).filter(isObj);
  const filter = [{ range: { [tf]: { gte: '$__from', lte: '$__to', format: 'epoch_millis' } } }];
  const qt = t.queryType || 'lucene';
  if (qt === 'esql' || qt === 'PPL' || qt === 'SQL') {
    issues.push({
      kind: 'todo',
      label: `requête ${qt === 'esql' ? 'ES|QL' : qt}`,
      detail: `La requête se réécrit en SQL ClickHouse : ${String(t.query || '').slice(0, 300)}`
    });
    return null;
  }
  if (qt === 'dsl') {
    let raw;
    try {
      raw = JSON.parse(t.query || '{}');
    } catch (e) {
      issues.push({ kind: 'todo', label: 'requête DSL illisible', detail: e.message });
      return null;
    }
    if (isObj(raw.query)) filter.push(raw.query);
    if (raw.aggs || raw.aggregations) {
      issues.push({
        kind: 'todo',
        label: 'agrégations du DSL brut',
        detail: 'Les agrégations écrites à la main dans le DSL brut de Grafana se recréent dans le SQL.'
      });
    }
  } else if (typeof t.query === 'string' && t.query.trim())
    filter.push({ query_string: { analyze_wildcard: true, query: t.query } });
  const first = metrics[0].type;
  // Documents : journaux et données brutes, triés du plus récent au plus ancien
  if (first === 'logs' || first === 'raw_data' || first === 'raw_document') {
    const st = metrics[0].settings || {};
    const size = settingInt(first === 'logs' ? st.limit : st.size, 500);
    return {
      kind: first === 'logs' ? 'logs' : 'raw',
      dsl: {
        size,
        query: { bool: { filter } },
        sort: [{ [tf]: { order: first === 'logs' && st.sortDirection === 'asc' ? 'asc' : 'desc' } }]
      },
      columns: []
    };
  }
  const used = new Set(['time', 'doc_count']);
  const names = new Map();
  for (const m of metrics) if (m.type !== 'count') names.set(String(m.id), gName(used, `m${m.id}`));
  const byId = id => metrics.find(m => String(m.id) === String(id));
  const pathTo = id => {
    const m = byId(id);
    return !m || m.type === 'count' ? '_count' : names.get(String(m.id));
  };
  // Mesures, sous le regroupement le plus profond
  const metricDefs = {};
  const columns = []; // { sql, label } dans l’ordre d’affichage
  const describe = m => (m.type === 'count' ? 'Count' : `${ES_METRIC_LABEL[m.type] || m.type} ${m.field || ''}`.trim());
  for (const m of metrics) {
    const st = isObj(m.settings) ? m.settings : {};
    const name = names.get(String(m.id));
    const visible = !m.hide;
    const script = scriptOf(st);
    const base = Object.assign(
      {},
      m.field && !ES_PIPELINES.has(m.type) ? { field: m.field } : {},
      script && ['avg', 'sum', 'max', 'min', 'extended_stats', 'percentiles'].includes(m.type)
        ? { script: { source: script } }
        : {},
      st.missing !== undefined && st.missing !== '' ? { missing: isNaN(+st.missing) ? st.missing : +st.missing } : {}
    );
    switch (m.type) {
      case 'count':
        if (visible) columns.push({ sql: 'doc_count', label: 'Count' });
        break;
      case 'avg':
      case 'sum':
      case 'max':
      case 'min':
      case 'cardinality':
        metricDefs[name] = { [m.type]: base };
        if (m.type === 'cardinality')
          issues.push({
            kind: 'review',
            label: 'Unique Count',
            detail:
              'Elasticsearch estime le nombre de valeurs distinctes (HyperLogLog++) ; ClickHouse le calcule selon la configuration (uniq approché, uniqExact exact).'
          });
        if (visible) columns.push({ sql: name, label: describe(m), field: m.field });
        break;
      case 'percentiles': {
        const ps = []
          .concat(st.percents || [25, 50, 75, 95, 99])
          .map(Number)
          .filter(Number.isFinite);
        metricDefs[name] = { percentiles: Object.assign(base, { percents: ps }) };
        if (visible)
          ps.forEach((p, i) =>
            columns.push({ sql: `${name}[${i + 1}]`, label: `p${javaDouble(p)} ${m.field || ''}`.trim() })
          );
        break;
      }
      case 'extended_stats': {
        metricDefs[name] = { extended_stats: base };
        const meta =
          isObj(m.meta) && Object.values(m.meta).some(Boolean)
            ? m.meta
            : { std_deviation_bounds_lower: true, std_deviation_bounds_upper: true };
        const sigma = settingNum(st.sigma, 2);
        if (visible)
          for (const k of Object.keys(ES_EXT_STATS)) {
            if (!meta[k]) continue;
            const sql =
              k === 'std_deviation_bounds_upper'
                ? `${name}_avg + ${sigma} * ${name}_std_deviation`
                : k === 'std_deviation_bounds_lower'
                  ? `${name}_avg - ${sigma} * ${name}_std_deviation`
                  : `${name}_${k}`;
            columns.push({ sql, label: `${ES_EXT_STATS[k]} ${m.field || ''}`.trim() });
          }
        break;
      }
      case 'top_metrics': {
        const fields = [].concat(st.metrics || []).filter(Boolean);
        if (!fields.length) {
          issues.push({
            kind: 'todo',
            label: 'Top Metrics sans champ',
            detail: 'La mesure ne nomme aucun champ à renvoyer.'
          });
          break;
        }
        metricDefs[name] = {
          top_metrics: Object.assign(
            { size: 1, metrics: fields.map(f => ({ field: f })) },
            st.orderBy ? { sort: [{ [st.orderBy]: st.order || 'desc' }] } : {}
          )
        };
        if (!st.orderBy)
          issues.push({
            kind: 'todo',
            label: 'Top Metrics sans tri',
            detail: 'Elasticsearch refuse top_metrics sans tri : choisissez le champ de tri.'
          });
        if (visible)
          fields.forEach(f =>
            columns.push({ sql: fields.length > 1 ? `${name}_${rawAlias(f)}` : name, label: `Top Metrics ${f}` })
          );
        break;
      }
      case 'rate':
        metricDefs[name] = {
          rate: Object.assign(
            {},
            m.field ? { field: m.field } : {},
            st.unit ? { unit: st.unit } : {},
            st.mode ? { mode: st.mode } : {}
          )
        };
        if (visible) columns.push({ sql: name, label: describe(m), field: m.field });
        break;
      case 'moving_avg':
      case 'moving_fn':
      case 'derivative':
      case 'cumulative_sum':
      case 'serial_diff': {
        const ref = m.pipelineAgg !== undefined && m.pipelineAgg !== '' ? m.pipelineAgg : m.field;
        if (!byId(ref)) {
          issues.push({
            kind: 'todo',
            label: `${ES_METRIC_LABEL[m.type]} sans mesure`,
            detail: 'Le calcul porte sur une mesure absente de la requête.'
          });
          break;
        }
        const bp = pathTo(ref);
        if (m.type === 'moving_fn')
          metricDefs[name] = {
            moving_fn: Object.assign(
              {
                buckets_path: bp,
                window: settingInt(st.window, 5),
                script: script || 'MovingFunctions.unweightedAvg(values)'
              },
              st.shift !== undefined ? { shift: settingInt(st.shift, 0) } : {}
            )
          };
        else if (m.type === 'moving_avg') {
          const model = st.model || 'simple';
          if (!MOVING_MODEL[model])
            issues.push({
              kind: 'review',
              label: `moyenne mobile ${model}`,
              detail:
                'moving_avg n’existe plus dans Elasticsearch 8 ; ce modèle devient une moyenne simple sur la fenêtre.'
            });
          metricDefs[name] = {
            moving_fn: {
              buckets_path: bp,
              window: settingInt(st.window, 5),
              script: MOVING_MODEL[model] || MOVING_MODEL.simple
            }
          };
        } else if (m.type === 'serial_diff')
          metricDefs[name] = { serial_diff: { buckets_path: bp, lag: settingInt(st.lag, 1) } };
        else
          metricDefs[name] = {
            [m.type]: Object.assign({ buckets_path: bp }, m.type === 'derivative' && st.unit ? { unit: st.unit } : {})
          };
        if (m.type === 'derivative' && st.unit)
          issues.push({
            kind: 'review',
            label: `dérivée par ${st.unit}`,
            detail:
              'Grafana affiche la dérivée ramenée à l’unité (normalized_value) ; la traduction donne la différence par tranche.'
          });
        if (visible) columns.push({ sql: name, label: `${ES_METRIC_LABEL[m.type]} ${describe(byId(ref))}` });
        break;
      }
      case 'bucket_script': {
        const vars = Array.isArray(m.pipelineVariables)
          ? m.pipelineVariables
          : isObj(m.pipelineVariables)
            ? Object.entries(m.pipelineVariables).map(([n, p]) => ({ name: n, pipelineAgg: p }))
            : [];
        const bp = {};
        for (const v of vars) if (v && v.name && byId(v.pipelineAgg)) bp[v.name] = pathTo(v.pipelineAgg);
        if (!Object.keys(bp).length || !script) {
          issues.push({
            kind: 'todo',
            label: 'Bucket Script incomplet',
            detail: 'Variables ou script manquants : Grafana n’envoie pas ce calcul.'
          });
          break;
        }
        metricDefs[name] = { bucket_script: { buckets_path: bp, script } };
        if (visible)
          columns.push({
            sql: name,
            label: vars.reduce(
              (s, v) => s.split(`params.${v.name}`).join(byId(v.pipelineAgg) ? describe(byId(v.pipelineAgg)) : v.name),
              script
            )
          });
        break;
      }
      case 'sum_bucket':
      case 'max_bucket':
      case 'min_bucket':
      case 'avg_bucket': {
        if (!st.groupBy || !m.field) {
          issues.push({
            kind: 'todo',
            label: `${ES_METRIC_LABEL[m.type]} incomplet`,
            detail: 'Champ ou regroupement manquant : Grafana n’envoie pas ce calcul.'
          });
          break;
        }
        const inner = ['max', 'min', 'sum', 'avg'].includes(st.metric) ? st.metric : 'max';
        metricDefs[`${name}_groupby`] = {
          terms: { field: st.groupBy, size: Math.min(settingInt(st.limit, 100), 10000) },
          aggs: { [`${name}_inner`]: { [inner]: { field: m.field } } }
        };
        metricDefs[name] = { [m.type]: { buckets_path: `${name}_groupby>${name}_inner` } };
        if (visible)
          columns.push({
            sql: name,
            label: `${ES_METRIC_LABEL[m.type]} of ${ES_METRIC_LABEL[inner]} ${m.field} per ${st.groupBy}`
          });
        break;
      }
      default:
        issues.push({
          kind: 'todo',
          label: `mesure ${m.type}`,
          detail: `La mesure « ${m.type} » n’a pas de traduction automatique.`
        });
    }
  }
  // Regroupements : le premier de l’éditeur est le plus extérieur
  let aggs = metricDefs;
  const labels = [];
  let time = null;
  const levels = [];
  const labelOfField = {};
  for (const b of buckets) {
    const st = isObj(b.settings) ? b.settings : {};
    let name, def;
    switch (b.type) {
      case 'date_histogram': {
        name = 'time';
        time = name;
        const iv = String(st.interval || 'auto');
        const body = { field: b.field || tf };
        if (ES_CALENDAR.has(iv)) body.calendar_interval = iv;
        else
          body.fixed_interval =
            iv === 'auto' || /^\$_{0,2}interval$/.test(iv) ? '$__interval' : iv.replace(/^\$interval$/, '$__interval');
        body.min_doc_count = settingInt(st.min_doc_count, 0) || 0;
        body.extended_bounds = { min: '$__from', max: '$__to' };
        if (st.offset) body.offset = st.offset;
        if (st.timeZone && st.timeZone !== 'utc') body.time_zone = st.timeZone;
        if (settingInt(st.trimEdges, 0) > 0)
          issues.push({
            kind: 'review',
            label: `trimEdges ${st.trimEdges}`,
            detail: 'Grafana masque les premières et dernières tranches ; le SQL les renvoie.'
          });
        def = { date_histogram: body };
        break;
      }
      case 'histogram':
        name = gName(used, b.field);
        labels.push(name);
        labelOfField[b.field] = name;
        def = {
          histogram: Object.assign(
            {
              field: b.field,
              interval: settingNum(st.interval, 1000),
              min_doc_count: settingInt(st.min_doc_count, 0) || 0
            },
            st.missing !== undefined ? { missing: +st.missing } : {}
          )
        };
        break;
      case 'terms': {
        name = gName(used, b.field);
        labels.push(name);
        labelOfField[b.field] = name;
        const body = { field: b.field, size: settingInt(st.size, 500) };
        if (st.min_doc_count !== undefined && st.min_doc_count !== '')
          body.min_doc_count = settingInt(st.min_doc_count, 0) || 0;
        if (st.missing !== undefined && st.missing !== '') body.missing = st.missing;
        const dir = st.order || 'desc';
        const ob = st.orderBy === undefined || st.orderBy === '' ? '_term' : String(st.orderBy);
        const mid = (/^(\d+)/.exec(ob) || [])[1];
        def = { terms: body };
        if (mid) {
          const m = byId(mid);
          if (!m) {
            body.order = { _count: dir };
            issues.push({
              kind: 'review',
              label: 'tri des groupes',
              detail: `Le tri porte sur une mesure absente (${ob}) : tri par nombre de documents.`
            });
          } else if (m.type === 'count') body.order = { _count: dir };
          else if (ES_SIBLINGS.has(m.type)) {
            /* Grafana n’envoie pas ce tri */
          } else if (m.type === 'percentiles' || /\[/.test(ob)) {
            body.order = { _count: dir };
            issues.push({
              kind: 'todo',
              label: 'tri des groupes par un centile',
              detail: `Les groupes sont triés par ${ob} : le tri se réécrit à la main.`
            });
          } else {
            // Grafana recalcule la mesure de tri directement sous le terms
            const on = gName(used, `ordre_m${mid}`);
            body.order = { [on]: dir };
            def.aggs = { [on]: { [m.type]: Object.assign({}, m.field ? { field: m.field } : {}) } };
            if (ES_PIPELINES.has(m.type)) {
              body.order = { _count: dir };
              delete def.aggs;
              issues.push({
                kind: 'todo',
                label: 'tri des groupes par un calcul',
                detail: `Les groupes sont triés par ${ES_METRIC_LABEL[m.type]} : à reprendre.`
              });
            }
          }
        } else body.order = { [ob === '_term' ? '_key' : ob]: dir };
        break;
      }
      case 'filters': {
        name = gName(used, 'filtre');
        labels.push(name);
        const filters = {};
        for (const f of [].concat(st.filters || []))
          if (isObj(f))
            filters[f.label || f.query || '*'] = { query_string: { query: f.query || '*', analyze_wildcard: true } };
        if (!Object.keys(filters).length) {
          issues.push({
            kind: 'review',
            label: 'filtres vides',
            detail: 'Grafana n’envoie pas un regroupement Filters sans filtre : il est ignoré.'
          });
          continue;
        }
        def = { filters: { filters } };
        break;
      }
      case 'geohash_grid':
        name = gName(used, 'geohash');
        labels.push(name);
        def = { geohash_grid: { field: b.field, precision: settingInt(st.precision, 3) } };
        break;
      case 'nested':
        issues.push({
          kind: 'todo',
          label: 'regroupement Nested',
          detail: 'Les documents imbriqués se lisent par ARRAY JOIN : à reprendre.'
        });
        continue;
      default:
        issues.push({
          kind: 'todo',
          label: `regroupement ${b.type}`,
          detail: `Le regroupement « ${b.type} » n’a pas de traduction automatique.`
        });
        continue;
    }
    levels.push({ name, def });
  }
  // Mesures sans regroupement : un groupe unique les porte, avec le nombre de documents (valeur unique de Grafana)
  if (!levels.length && Object.keys(metricDefs).length + columns.length)
    levels.push({ name: 'tout', def: { filters: { filters: { tout: { match_all: {} } } } }, hidden: true });
  for (const l of levels.slice().reverse()) {
    if (Object.keys(aggs).length) l.def.aggs = Object.assign({}, l.def.aggs || {}, aggs);
    aggs = { [l.name]: l.def };
  }
  if (!levels.length && Object.values(metricDefs).some(d => Object.keys(d).some(k => ES_PIPELINES.has(k))))
    issues.push({
      kind: 'todo',
      label: 'calcul sans histogramme',
      detail: 'Dérivées, cumuls et moyennes mobiles demandent un histogramme de dates (Elasticsearch les refuse sinon).'
    });
  if (!columns.length)
    issues.push({
      kind: 'review',
      label: 'aucune mesure affichée',
      detail: 'Toutes les mesures sont masquées : le panneau n’affiche rien.'
    });
  const dsl = Object.assign({ size: 0, query: { bool: { filter } } }, Object.keys(aggs).length ? { aggs } : {});
  return {
    kind: time ? 'series' : 'table',
    dsl,
    columns,
    labels,
    time,
    levels: levels.map(l => l.name),
    labelOf: f =>
      labelOfField[f] || labelOfField[String(f).replace(/\.keyword$/, '')] || (labels.includes(f) ? f : null)
  };
}
// Requête de la traduction qui porte tous les regroupements : la plus profonde
function deepestStatement(r, levels) {
  const st = r.statements || [];
  const want = levels.length;
  return (
    st.find(s => s.title === `Agrégation ${levels.join(' › ')}`) ||
    st
      .filter(s => /^Agrégation /.test(s.title))
      .sort((a, b) => b.title.split(' › ').length - a.title.split(' › ').length)[0] ||
    (want ? null : st.find(s => /^(Mesures globales|Comptage)/.test(s.title)) || st[0])
  );
}
const backtick = s => '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
// Colonnes affichées, nommées comme les séries de Grafana, autour de la requête traduite
function grafanaSQL(inner, spec) {
  const body = inner.replace(/;\s*$/, '');
  const cols = [];
  if (spec.time) cols.push(spec.time);
  // Série temporelle : les regroupements en texte, que le plugin prend pour étiquettes des séries
  for (const l of spec.labels) cols.push(spec.time ? `toString(${l}) AS ${backtick(l)}` : l);
  for (const c of spec.columns) cols.push(`${c.sql} AS ${backtick(c.label)}`);
  return `SELECT\n    ${cols.join(',\n    ')}\nFROM\n(\n${indent(body, '    ')}\n)${spec.time ? `\nORDER BY ${spec.time}${spec.labels.length ? `, ${spec.labels.join(', ')}` : ''}` : ''}`;
}
// Nom de série de Grafana : alias {{term champ}}, {{champ}}, {{metric}}, {{field}} → nom d’affichage
function grafanaDisplayName(alias, spec, fieldsByLabel) {
  if (!alias) return null;
  return alias.replace(/\{\{([\s\S]+?)\}\}/g, (m, g) => {
    const k = g.trim();
    const term = /^term\s+(.+)$/.exec(k);
    const label = spec.labelOf(term ? term[1] : k);
    if (label) return `\${__field.labels.${label}}`;
    if (k === 'metric') return '${__field.name}';
    if (k === 'field') return fieldsByLabel || '';
    return m;
  });
}

/* ---------- Variables ---------- */
function esVariableSQL(v, env, cfg, index, vars) {
  let q = v.query;
  if (typeof q === 'string') {
    try {
      q = JSON.parse(q);
    } catch (e) {
      return { error: `requête de variable illisible : ${v.query}` };
    }
  }
  if (!isObj(q)) return { error: 'requête de variable illisible' };
  if (q.find === 'terms') {
    const order = q.orderBy === 'doc_count' ? { _count: q.order || 'desc' } : { _key: q.order || 'asc' };
    const filter = [{ range: { [env.timeField]: { gte: '$__from', lte: '$__to', format: 'epoch_millis' } } }];
    if (q.query) filter.push({ query_string: { analyze_wildcard: true, query: q.query } });
    const dsl = {
      size: 0,
      query: { bool: { filter } },
      aggs: { valeur: { terms: { field: q.field, size: settingInt(q.size, 500), order } } }
    };
    const r = translateDSL(JSON.stringify(dsl), cfg, { index, grafana: true, variables: vars });
    if (r.error) return { error: r.error, result: r };
    const st = deepestStatement(r, ['valeur']);
    return { sql: `SELECT valeur\nFROM\n(\n${indent(st.sql.replace(/;\s*$/, ''), '    ')}\n)`, result: r, dsl };
  }
  if (q.find === 'fields') {
    const table = (r => r.table)(translateDSL('{"size":0}', cfg, { index }));
    const [db, tb] = String(table).includes('.') ? String(table).split('.') : [cfg.clickhouse.database, table];
    const typ =
      {
        keyword: "type LIKE '%String%'",
        number: "match(type, 'Int|Float|Decimal')",
        date: "type LIKE '%Date%'",
        boolean: "type LIKE '%Bool%'"
      }[q.type] || null;
    return {
      sql: `SELECT name\nFROM system.columns\nWHERE database = ${chStr(db)} AND table = ${chStr(tb)}${typ ? `\n  AND ${typ}` : ''}\nORDER BY name`,
      review: 'La liste des champs d’Elasticsearch devient celle des colonnes de la table.'
    };
  }
  return {
    error: `variable « ${q.find || '?'} » : seules les listes de valeurs (terms) et de champs (fields) se traduisent`
  };
}

/* ---------- Conversion du tableau de bord ---------- */
function grafanaDashboard(text, cfg, opts) {
  opts = opts || {};
  const read = grafanaRead(text);
  if (read.error) return { error: read.error };
  const dash = clone(read.dash);
  const src = grafanaSources(dash);
  const index = opts.index || '';
  const env0 = { timeField: opts.timeField || '@timestamp' };
  const templ = ((dash.templating || {}).list || []).filter(isObj);
  // Variables du tableau de bord : « All » change la condition ($__conditionalAll)
  const vars = {};
  for (const v of templ) vars[v.name] = { includeAll: !!v.includeAll, multi: !!v.multi, type: v.type };
  const report = { panels: [], variables: [], annotations: [], notes: [] };
  const usedPanelTypes = new Set();
  let converted = 0;
  const translateTarget = (t, panelTitle) => {
    const issues = [];
    const spec = esTargetDSL(t, Object.assign({ issues }, env0));
    const out = { refId: t.refId || 'A', issues, verdict: 'ready', notes: [], sql: '', kind: spec ? spec.kind : null };
    if (!spec) {
      out.verdict = 'todo';
      out.sql = `SELECT throwIf(1, ${chStr(`Passerelle : ${issues.map(i => i.label).join(', ')} à traduire`)})`;
      return out;
    }
    const r = translateDSL(JSON.stringify(spec.dsl), cfg, { index, grafana: true, variables: vars });
    out.result = r;
    out.dsl = spec.dsl;
    out.table = r.table;
    if (r.error) {
      out.verdict = 'todo';
      issues.push({ kind: 'todo', label: 'requête refusée par la traduction', detail: r.error });
      out.sql = `SELECT throwIf(1, ${chStr(`Passerelle : ${r.error}`.slice(0, 300))})`;
      return out;
    }
    out.notes = r.notes;
    if (spec.kind === 'logs' || spec.kind === 'raw') {
      const st = (r.statements || []).find(s => s.title === 'Documents') || r.statements[0];
      const tcol = mapFieldOf(cfg, r.table, env0.timeField);
      const msg = mapFieldOf(cfg, r.table, (cfg.clickhouse.text_fields || ['message'])[0] || 'message');
      out.sql =
        spec.kind === 'logs'
          ? `SELECT\n    ${tcol} AS timestamp,\n    ${msg} AS body,\n    *\nFROM\n(\n${indent(st.sql.replace(/;\s*$/, ''), '    ')}\n)`
          : st.sql.replace(/;\s*$/, '');
      if (spec.kind === 'logs')
        issues.push({
          kind: 'review',
          label: 'colonnes du panneau de journaux',
          detail: `Le plugin lit timestamp, body et level : body vient de ${msg} (premier champ de clickhouse.text_fields) ; ajoutez « … AS level » pour colorer les niveaux.`
        });
    } else {
      const st = deepestStatement(r, spec.levels);
      if (!st) {
        out.verdict = 'todo';
        issues.push({
          kind: 'todo',
          label: 'requête introuvable',
          detail: 'La traduction ne donne pas de requête pour tous les regroupements.'
        });
        out.sql = `SELECT throwIf(1, 'Passerelle : requête à traduire')`;
        return out;
      }
      out.sql = grafanaSQL(st.sql, spec);
      out.spec = spec;
    }
    out.verdict = worstGrafana(
      [verdictOf(r)].concat(issues.map(i => (i.kind === 'todo' ? 'todo' : i.kind === 'review' ? 'review' : 'ready')))
    );
    return out;
  };
  for (const p of grafanaPanels(dash)) {
    if (p.type === 'row') continue;
    usedPanelTypes.add(p.type);
    const targets = (p.targets || []).filter(isObj);
    const panelES = src.isES(p.datasource);
    const esTargets = targets.filter(t =>
      t.datasource && t.datasource.type === '__expr__'
        ? false
        : (src.isES(t.datasource) ?? panelES) === true || ((src.isES(t.datasource) ?? panelES) === null && esShaped(t))
    );
    if (!esTargets.length) {
      if (panelES === true) {
        p.datasource = src.chRef(p.datasource);
      }
      continue;
    }
    const entry = { id: p.id, title: p.title || '(sans titre)', type: p.type, targets: [], verdict: 'ready' };
    const overrides = [];
    for (const t of esTargets) {
      const alias = typeof t.alias === 'string' && t.alias.trim() ? t.alias : null;
      const r = translateTarget(t, entry.title);
      const fmt = r.kind === 'series' ? 0 : r.kind === 'logs' ? 2 : 1;
      const ds = src.chRef(t.datasource || p.datasource);
      // La requête Elasticsearch est remplacée ; le reste du panneau (affichage, seuils, liens) est gardé
      for (const k of [
        'query',
        'metrics',
        'bucketAggs',
        'alias',
        'timeField',
        'queryType',
        'dsType',
        'target',
        'editorType',
        'intervalMs',
        'includeRuntimeFields',
        'boolFilters',
        'sourceIncludes',
        'index'
      ])
        delete t[k];
      Object.assign(t, {
        datasource: ds,
        editorType: 'sql',
        format: fmt,
        queryType: fmt === 0 ? 'timeseries' : fmt === 2 ? 'logs' : 'table',
        rawSql: r.sql,
        pluginVersion: CH_PLUGIN_VERSION
      });
      // Alias de Grafana → nom d’affichage des séries de cette requête ; sans alias, le nom que donnait Grafana
      const dn =
        r.spec && r.spec.kind === 'series'
          ? alias
            ? grafanaDisplayName(alias, r.spec, r.spec.columns.length === 1 ? r.spec.columns[0].field : '')
            : r.spec.labels.length
              ? r.spec.labels
                  .slice()
                  .sort()
                  .map(l => `\${__field.labels.${l}}`)
                  .join(' ') + (r.spec.columns.length > 1 ? ' ${__field.name}' : '')
              : null
          : null;
      if (dn)
        overrides.push({
          matcher: { id: 'byFrameRefID', options: r.refId },
          properties: [{ id: 'displayName', value: dn }]
        });
      entry.targets.push({
        refId: r.refId,
        verdict: r.verdict,
        sql: r.sql,
        table: r.table,
        issues: r.issues,
        notes: (r.notes || []).filter(n => n.level === 'err' || n.level === 'warn')
      });
      converted++;
    }
    entry.verdict = worstGrafana(entry.targets.map(t => t.verdict));
    if (overrides.length) {
      p.fieldConfig = p.fieldConfig || { defaults: {}, overrides: [] };
      p.fieldConfig.overrides = (p.fieldConfig.overrides || []).concat(overrides);
      if (
        p.fieldConfig.defaults &&
        p.fieldConfig.defaults.displayName &&
        /\{\{/.test(p.fieldConfig.defaults.displayName)
      )
        delete p.fieldConfig.defaults.displayName;
    }
    if (src.isES(p.datasource) === true || panelES === null)
      p.datasource =
        esTargets.length === targets.length ? src.chRef(p.datasource) : { type: 'datasource', uid: '-- Mixed --' };
    if (p.alert) {
      entry.targets[0].issues.push({
        kind: 'todo',
        label: 'alerte du panneau',
        detail: 'Les alertes des anciens panneaux Graph se recréent en règles d’alerte Grafana.'
      });
      entry.verdict = 'todo';
    }
    if (entry.verdict !== 'ready') {
      const why = [
        ...new Set(
          entry.targets.flatMap(t =>
            t.issues
              .filter(i => i.kind !== 'info')
              .map(i => i.label)
              .concat(t.notes.map(n => n.title))
          )
        )
      ]
        .slice(0, 4)
        .join(' ; ');
      p.description = `${p.description ? `${p.description}\n\n` : ''}Passerelle : ${VERDICTS[entry.verdict]}${why ? ` — ${why}` : ''}.`;
    }
    report.panels.push(entry);
  }
  // Variables : listes de valeurs et de champs, source de données, filtres ad hoc
  for (const v of templ) {
    if (v.type === 'datasource' && v.query === 'elasticsearch') {
      v.query = CH_PLUGIN;
      v.current = {};
      v.options = [];
      report.variables.push({ name: v.name, verdict: 'ready', detail: 'source de données ClickHouse' });
      continue;
    }
    if (src.isES(v.datasource) !== true) continue;
    if (v.type === 'adhoc') {
      v.datasource = src.chRef(v.datasource);
      report.variables.push({
        name: v.name,
        verdict: 'review',
        detail: 'Filtres ad hoc : le plugin ClickHouse les ajoute à chaque requête (ClickHouse 22.7 ou plus récent).'
      });
      continue;
    }
    if (v.type !== 'query') continue;
    const r = esVariableSQL(v, env0, cfg, index, vars);
    v.datasource = src.chRef(v.datasource);
    if (r.error) {
      report.variables.push({ name: v.name, verdict: 'todo', detail: r.error });
      v.query = { editorType: 'sql', rawSql: `SELECT throwIf(1, ${chStr(`Passerelle : ${r.error}`.slice(0, 200))})` };
      v.definition = v.query.rawSql;
      continue;
    }
    v.query = { editorType: 'sql', rawSql: r.sql };
    v.definition = r.sql;
    const hadAll = v.allValue !== undefined && v.allValue !== null && v.allValue !== '';
    if (hadAll) {
      report.notes.push(
        `Variable ${v.name} : la valeur « All » personnalisée (${v.allValue}) est retirée ; $__conditionalAll lève la condition quand tout est sélectionné.`
      );
      v.allValue = null;
    }
    v.options = [];
    v.current = v.current && v.current.value !== undefined ? v.current : {};
    report.variables.push({
      name: v.name,
      verdict: r.review ? 'review' : r.result ? worstGrafana([verdictOf(r.result)]) : 'ready',
      detail: r.review || 'liste de valeurs',
      sql: r.sql
    });
  }
  // Annotations
  for (const a of ((dash.annotations || {}).list || []).filter(isObj)) {
    if (src.isES(a.datasource) !== true) continue;
    const tf = a.timeField || env0.timeField;
    const filter = [{ range: { [tf]: { gte: '$__from', lte: '$__to', format: 'epoch_millis' } } }];
    if (a.query) filter.push({ query_string: { analyze_wildcard: true, query: a.query } });
    const fields = [tf, a.textField, a.tagsField, a.timeEndField].filter(Boolean);
    const r = translateDSL(
      JSON.stringify({ size: 10000, query: { bool: { filter } }, _source: fields, sort: [{ [tf]: 'desc' }] }),
      cfg,
      { index, grafana: true, variables: vars }
    );
    const name = a.name || 'annotations';
    if (r.error) {
      report.annotations.push({ name, verdict: 'todo', detail: r.error });
      continue;
    }
    const st = (r.statements || []).find(s => s.title === 'Documents');
    const col = f => mapFieldOf(cfg, r.table, f);
    const sel = [`${col(tf)} AS time`].concat(
      a.timeEndField ? [`${col(a.timeEndField)} AS timeEnd`] : [],
      a.textField ? [`${col(a.textField)} AS text`] : [],
      a.tagsField ? [`${col(a.tagsField)} AS tags`] : []
    );
    const sql = `SELECT\n    ${sel.join(',\n    ')}\nFROM\n(\n${indent(st.sql.replace(/;\s*$/, ''), '    ')}\n)`;
    for (const k of ['query', 'timeField', 'textField', 'tagsField', 'timeEndField', 'target']) delete a[k];
    a.datasource = src.chRef(a.datasource);
    a.target = {
      refId: 'Anno',
      editorType: 'sql',
      format: 1,
      queryType: 'table',
      rawSql: sql,
      pluginVersion: CH_PLUGIN_VERSION
    };
    report.annotations.push({ name, verdict: verdictOf(r), detail: 'requête d’annotations (time, text, tags)', sql });
  }
  // Entrées et dépendances : la source ClickHouse à choisir à l’import
  if (Array.isArray(dash.__inputs) || read.wrapper !== 'api') {
    const inputs = (dash.__inputs || []).filter(i => !(isObj(i) && i.pluginId === 'elasticsearch'));
    if (!inputs.some(i => i.name === CH_INPUT))
      inputs.unshift({
        name: CH_INPUT,
        label: 'ClickHouse',
        description: 'Source de données ClickHouse (remplace Elasticsearch)',
        type: 'datasource',
        pluginId: CH_PLUGIN,
        pluginName: 'ClickHouse'
      });
    dash.__inputs = inputs;
    const req = (dash.__requires || []).filter(r => !(isObj(r) && r.id === 'elasticsearch'));
    if (!req.some(r => r.id === CH_PLUGIN))
      req.push({ type: 'datasource', id: CH_PLUGIN, name: 'ClickHouse', version: '4.0.0' });
    dash.__requires = req;
  }
  // Un tableau de bord importé est un nouveau tableau de bord : son identifiant numérique est retiré, son uid distingué
  delete dash.id;
  if (dash.uid && opts.keepUid !== true) dash.uid = String(dash.uid).slice(0, 37) + '-ch';
  if (dash.title && opts.keepTitle !== true)
    dash.title = /\belasticsearch\b/i.test(dash.title)
      ? dash.title.replace(/\belasticsearch\b/i, 'ClickHouse')
      : `${dash.title} (ClickHouse)`;
  if (!index)
    report.notes.push(
      `Aucun index précisé : le tableau de bord ne le contient pas (il est réglé dans la source de données Elasticsearch). La table par défaut ${cfg.clickhouse.default_table} est utilisée ; précisez l’index (--index) pour viser la table de clickhouse.index_mapping.`
    );
  const tables = [...new Set(report.panels.flatMap(p => p.targets.map(t => t.table)).filter(Boolean))];
  if (tables.length)
    report.notes.push(
      `Table${tables.length > 1 ? 's' : ''} interrogée${tables.length > 1 ? 's' : ''} : ${tables.join(', ')}.`
    );
  const verdicts = report.panels
    .map(p => p.verdict)
    .concat(
      report.variables.map(v => v.verdict),
      report.annotations.map(a => a.verdict)
    );
  const summary = {
    panels: report.panels.length,
    queries: converted,
    byVerdict: { ready: 0, review: 0, todo: 0, unrecognized: 0 }
  };
  for (const p of report.panels) summary.byVerdict[p.verdict]++;
  const root =
    read.wrapper === 'api'
      ? Object.assign({}, read.root, { dashboard: dash })
      : read.wrapper === 'resource'
        ? Object.assign({}, read.root, { spec: dash })
        : dash;
  return {
    dashboard: root,
    report,
    summary,
    verdict: verdicts.length ? worstGrafana(verdicts) : 'ready',
    empty: !converted && !report.variables.length && !report.annotations.length
  };
}
const worstGrafana = list => list.reduce((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), 'ready');
// Colonne SQL d’un champ, avec le profil de la table
function mapFieldOf(cfg, table, field) {
  const ctx = makeDslCtx(cfg);
  ctx.table = table;
  ctx.columns = new Set();
  try {
    ctx.cfg = tableConfig(cfg, table);
  } catch (e) {
    /* signalé par la traduction */
  }
  ctx.targets = new Map();
  return mapField(ctx, field);
}

/* ---------- Rapport ---------- */
function grafanaReportMarkdown(r, name) {
  const L = [];
  const s = r.summary;
  const v = s.byVerdict;
  const flat = x =>
    String(x === undefined || x === null ? '' : x)
      .replace(/\s+/g, ' ')
      .trim();
  const cell = x => flat(x).replace(/\|/g, '\\|');
  L.push(`# Conversion Grafana vers ClickHouse${name ? ` : ${flat(name)}` : ''}`, '');
  L.push(
    `Verdict : **${VERDICTS[r.verdict]}**. ${s.panels} panneau${s.panels > 1 ? 'x' : ''} converti${s.panels > 1 ? 's' : ''} (${v.ready} prêt${v.ready > 1 ? 's' : ''}, ${v.review} à vérifier, ${v.todo} à reprendre), ${s.queries} requête${s.queries > 1 ? 's' : ''}.`,
    ''
  );
  for (const n of r.report.notes) L.push(`- ${flat(n)}`);
  if (r.report.notes.length) L.push('');
  L.push(
    'Le tableau de bord converti s’importe dans Grafana (Tableaux de bord > Nouveau > Importer) : choisissez la source ClickHouse demandée. Les requêtes utilisent les macros du plugin ClickHouse ($__timeFilter, $__interval_s, $__conditionalAll) et les variables du tableau de bord.',
    ''
  );
  if (r.report.panels.length) {
    L.push('## Panneaux', '', '| Panneau | Type | Verdict | Points |', '|---|---|---|---|');
    for (const p of r.report.panels) {
      const pts = [
        ...new Set(
          p.targets.flatMap(t =>
            t.issues
              .filter(i => i.kind !== 'info')
              .map(i => i.label)
              .concat(t.notes.map(n => n.title))
          )
        )
      ];
      L.push(`| ${cell(p.title)} | ${cell(p.type)} | ${VERDICTS[p.verdict]} | ${cell(pts.join(' ; '))} |`);
    }
    L.push('');
  }
  if (r.report.variables.length) {
    L.push('## Variables', '', '| Variable | Verdict | Traduction |', '|---|---|---|');
    for (const x of r.report.variables) L.push(`| ${cell(x.name)} | ${VERDICTS[x.verdict]} | ${cell(x.detail)} |`);
    L.push('');
  }
  if (r.report.annotations.length) {
    L.push('## Annotations', '', '| Annotation | Verdict | Traduction |', '|---|---|---|');
    for (const x of r.report.annotations) L.push(`| ${cell(x.name)} | ${VERDICTS[x.verdict]} | ${cell(x.detail)} |`);
    L.push('');
  }
  L.push('## Détail', '');
  for (const p of r.report.panels) {
    L.push(
      `### ${flat(p.title)}`,
      '',
      `${VERDICTS[p.verdict].replace(/^./, c => c.toUpperCase())}. Panneau ${flat(p.type)}.`,
      ''
    );
    for (const t of p.targets) {
      L.push(`**Requête ${flat(t.refId)}** — ${VERDICTS[t.verdict]}${t.table ? `, table ${t.table}` : ''}.`, '');
      for (const i of t.issues)
        L.push(
          `- ${i.kind === 'todo' ? 'À reprendre' : i.kind === 'review' ? 'À vérifier' : 'À noter'} : **${flat(i.label)}** — ${flat(i.detail)}`
        );
      for (const n of t.notes)
        L.push(`- ${n.level === 'err' ? 'À reprendre' : 'À vérifier'} : **${flat(n.title)}** — ${flat(n.detail)}`);
      if (t.issues.length || t.notes.length) L.push('');
      L.push('```sql', t.sql, '```', '');
    }
  }
  for (const x of r.report.variables.concat(r.report.annotations).filter(x => x.sql))
    L.push(
      `### ${r.report.variables.includes(x) ? 'Variable' : 'Annotation'} ${flat(x.name)}`,
      '',
      '```sql',
      x.sql,
      '```',
      ''
    );
  return L.join('\n');
}
