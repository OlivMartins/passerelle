/* Passerelle — moteur : objets sauvegardés Kibana (.ndjson) vers SQL, et inventaire de migration */
/*
 * Un export de Kibana (Gestion de la suite > Objets sauvegardés > Exporter) contient les vues de données, les recherches
 * Discover, les visualisations (agrégées, TSVB, Vega…), les visualisations Lens, les tableaux de bord et, depuis la 7.13,
 * les règles d’alerte. Chaque objet porte sa requête (KQL ou Lucene), ses filtres et ses agrégations, rangés dans des
 * chaînes JSON (searchSourceJSON, visState, panelsJSON) et reliés entre eux par des références.
 *
 * Pour chaque objet, Kibana reconstruit la requête DSL qu’il enverrait à Elasticsearch : requête, filtres actifs,
 * plage de temps de la vue de données, agrégations. Ce DSL passe ensuite par translateDSL, comme une requête collée
 * dans l’interface : le verdict, la couverture et les remarques ont le même sens partout. La plage de temps du sélecteur
 * de Kibana devient deux paramètres de requête ClickHouse, {time_from:String} et {time_to:String}.
 */

/* ---------- Lecture de l’export ---------- */
const jsonAttr = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return undefined; } };
function kibanaObjects(text) {
  const src = String(text || '').trim();
  const out = { objects: [], errors: [], summary: null };
  if (!src) return out;
  let list = null;
  if (src[0] === '[' || (src[0] === '{' && !/\n\s*\{/.test(src))) {
    try {
      const j = JSON.parse(src);
      list = Array.isArray(j) ? j : Array.isArray(j.saved_objects) ? j.saved_objects : Array.isArray(j.data) ? j.data.map(r => (r.rule_type_id ? { type: 'alert', id: r.id, attributes: Object.assign({ alertTypeId: r.rule_type_id }, r) } : r)) : Array.isArray(j.objects) ? j.objects : [j];
    } catch (e) { list = null; }
  }
  if (!list) {
    list = [];
    const errors = [];
    src.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try { list.push(JSON.parse(line)); } catch (e) { errors.push(`ligne ${i + 1} : JSON invalide (${e.message})`); }
    });
    // Objets indentés les uns à la suite des autres (format des archives de Kibana) : lus comme une suite de valeurs JSON
    if (errors.length) { const seq = jsonSequence(src); if (seq) list = seq; else out.errors.push(...errors); }
  }
  for (let o of list) {
    if (!isObj(o)) continue;
    if ((o.exportedCount !== undefined || o.exported_count !== undefined) && !o.type) { out.summary = Object.assign({ exportedCount: o.exportedCount !== undefined ? o.exportedCount : o.exported_count }, o); continue; }
    // Règles de détection exportées depuis Security : une ligne par règle, sans enveloppe d’objet sauvegardé
    if (o.rule_id && !isObj(o.attributes)) o = { type: 'security-rule', id: o.rule_id, attributes: o };
    if (!o.type || !isObj(o.attributes)) { out.errors.push(`objet sans type ni attributs${o.id ? ` (${o.id})` : ''}`); continue; }
    out.objects.push(o);
  }
  return out;
}
function jsonSequence(src) {
  const out = []; let depth = 0; let start = -1; let str = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{' || c === '[') { if (!depth) start = i; depth++; }
    else if (c === '}' || c === ']') { depth--; if (depth < 0) return null; if (!depth) { try { out.push(JSON.parse(src.slice(start, i + 1))); } catch (e) { return null; } } }
    else if (!depth && !/\s/.test(c)) return null;
  }
  return depth ? null : out;
}
const refOf = (obj, name, prefix) => {
  const refs = obj.references || [];
  return refs.find(r => r.name === (prefix ? `${prefix}:${name}` : name)) || (prefix ? refs.find(r => r.name === name) : null);
};

/* ---------- Vues de données ---------- */
// type d’un champ pour KQL : keyword, text, date, number, boolean, ip ou null
function dataViewFieldType(f) {
  const es = f.esTypes || [];
  if (es.length === 1) return es[0] === 'keyword' || es[0] === 'constant_keyword' || es[0] === 'wildcard' ? 'keyword' : ['text', 'match_only_text'].includes(es[0]) ? 'text' : es[0] === 'date' || es[0] === 'date_nanos' ? 'date' : ['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long'].includes(es[0]) ? 'number' : es[0] === 'boolean' ? 'boolean' : es[0] === 'ip' ? 'ip' : null;
  if (f.type === 'date') return 'date';
  if (f.type === 'number') return 'number';
  if (f.type === 'boolean') return 'boolean';
  if (f.type === 'ip') return 'ip';
  // Exports anciens, sans esTypes : un champ chaîne non agrégeable est un champ texte
  if (f.type === 'string') return f.aggregatable === false ? 'text' : f.aggregatable === true ? 'keyword' : null;
  return null;
}
function readDataView(id, a) {
  const fields = new Map();
  for (const f of [].concat(jsonAttr(a.fields) || [])) if (isObj(f) && f.name) fields.set(f.name, f);
  const runtime = {};
  for (const [name, def] of Object.entries(jsonAttr(a.runtimeFieldMap) || {})) if (isObj(def) && def.script && def.script.source) runtime[name] = { type: def.type || 'keyword', script: { source: def.script.source } };
  // Champs scriptés (champs calculés des versions 6 et 7) : des scripts Painless, comme les champs runtime
  for (const f of fields.values()) if (f.scripted && f.script && (f.lang || 'painless') === 'painless') runtime[f.name] = { type: { string: 'keyword', number: 'double', date: 'date', boolean: 'boolean' }[f.type] || 'keyword', script: { source: f.script } };
  return { id, title: String(a.title || ''), name: a.name || a.title || '', timeField: a.timeFieldName || null, runtime, fields };
}
function dataViewsOf(objects) {
  const out = new Map();
  for (const o of objects) if (o.type === 'index-pattern' || o.type === 'index_pattern') out.set(o.id, readDataView(o.id, o.attributes));
  return out;
}

/* ---------- Filtres et requête d’un objet ---------- */
// Filtre de Kibana (pastille) → clause DSL ; null s’il est désactivé
function filterDSL(f, issues) {
  if (!isObj(f)) return null;
  const meta = f.meta || {};
  if (meta.disabled) return null;
  let q = f.query;
  if (meta.type === 'combined' && Array.isArray(meta.params)) {
    const parts = meta.params.map(p => filterDSL(p, issues)).filter(Boolean);
    q = String(meta.relation || 'AND').toUpperCase() === 'OR' ? { bool: { should: parts, minimum_should_match: 1 } } : { bool: { filter: parts } };
  } else if (!isObj(q)) {
    // Formes anciennes : la clause est rangée à la racine du filtre
    const key = Object.keys(f).find(k => ['range', 'exists', 'script', 'match_all', 'match_phrase', 'match', 'bool', 'query_string', 'terms', 'term', 'geo_bounding_box', 'geo_polygon', 'geo_shape', 'geo_distance'].includes(k));
    if (!key) { issues.push({ kind: 'todo', label: `filtre ${meta.type || 'inconnu'}${meta.key ? ` sur ${meta.key}` : ''}`, detail: 'Forme de filtre non reconnue : à reprendre à la main.' }); return null; }
    q = { [key]: f[key] };
  }
  // match { champ: { query, type: phrase } } des versions 6 : un match_phrase
  if (isObj(q.match)) {
    const [field, v] = Object.entries(q.match)[0] || [];
    if (isObj(v) && v.type === 'phrase') q = { match_phrase: { [field]: v.query } };
  }
  if (meta.type === 'spatial_filter' || q.geo_shape || q.geo_polygon || q.geo_bounding_box) issues.push({ kind: 'review', label: 'filtre géographique', detail: 'Les filtres de carte (forme, polygone, rectangle) supposent une colonne géographique : vérifiez leur traduction.' });
  return meta.negate ? { bool: { must_not: q } } : q;
}
// Requête de la barre de recherche : KQL, Lucene, ou un objet DSL des versions anciennes
// env : fieldType, fields (noms connus, pour les champs à motif) et tz (fuseau des dates sans décalage)
function queryDSL(query, env, issues) {
  if (!query) return null;
  if (isObj(query) && query.language === undefined && query.query === undefined) return Object.keys(query).length ? query : null;
  const text = isObj(query) ? query.query : query;
  const lang = isObj(query) ? String(query.language || 'kuery') : 'kuery';
  if (isObj(text)) return Object.keys(text).length ? text : null;
  if (text === undefined || text === null || !String(text).trim()) return null;
  if (lang === 'lucene') return { query_string: { query: String(text), analyze_wildcard: true } };
  if (lang !== 'kuery') { issues.push({ kind: 'todo', label: `requête en ${lang}`, detail: 'Seuls KQL et Lucene se traduisent ; une requête ES|QL ou SQL se réécrit en SQL ClickHouse.' }); return null; }
  try { return kqlTranslate(String(text), Object.assign({ fieldType: env.fieldType, fields: env.fields, issues }, env.tz ? { timeZone: env.tz } : {})); }
  catch (e) { issues.push({ kind: 'todo', label: 'requête KQL', detail: `${e.message} — requête : ${text}` }); return { match_none: {} }; }
}
// Plage de temps du sélecteur de Kibana : deux paramètres, fournis à l’exécution
const TIME_FROM = '{{time_from}}', TIME_TO = '{{time_to}}';
const timeRange = field => ({ range: { [field]: { gte: TIME_FROM, lte: TIME_TO, format: 'strict_date_optional_time' } } });

/* ---------- Environnement d’un objet ---------- */
/*
 * Ce qu’il faut savoir pour reconstruire la requête d’un objet : la vue de données (motif d’index, champ de temps,
 * champs runtime, types des champs), et la façon de typer un champ quand l’export ne liste pas les champs
 * (champs texte et types des colonnes de la configuration).
 */
function viewEnv(cfg, view) {
  const pattern = view ? view.title : '';
  const ctx = makeDslCtx(cfg); ctx.columns = new Set();
  const table = resolveTable(ctx, pattern).table; ctx.table = table;
  try { ctx.cfg = tableConfig(cfg, table); } catch (e) { /* préréglage inconnu : signalé par la traduction */ }
  ctx.targets = new Map();
  const runtime = view ? view.runtime : {};
  const fieldType = name => {
    const n = String(name);
    if (view && view.fields.has(n)) { const t = dataViewFieldType(view.fields.get(n)); if (t) return t; }
    if (view && n === view.timeField) return 'date';
    if (runtime[n]) return { keyword: 'keyword', date: 'date', boolean: 'boolean', ip: 'ip' }[runtime[n].type] || 'number';
    if ((ctx.cfg.clickhouse.text_fields || []).includes(n)) return 'text';
    if (n.endsWith('.keyword')) return 'keyword';
    const t = fieldType_(ctx, n);
    if (!t) return null;
    return t.kind === 'date' ? 'date' : t.kind === 'int' || t.kind === 'float' ? 'number' : t.kind === 'bool' ? 'boolean' : t.kind === 'string' ? 'keyword' : null;
  };
  return { view, pattern, table, timeField: view ? view.timeField : null, runtime, fieldType, fields: view ? [...view.fields.keys()] : [] };
}
// fieldType du traducteur, sous un autre nom (celui de viewEnv le masquerait)
const fieldType_ = (ctx, f) => fieldType(ctx, f);
// Corps de recherche complet d’un objet : requête, filtres, plage de temps et, au besoin, agrégations
function searchBody(env, parts) {
  const filter = []; const mustNot = [];
  for (const q of parts.queries || []) if (q) filter.push(q);
  for (const f of parts.filters || []) if (f) { if (isObj(f.bool) && f.bool.must_not && Object.keys(f.bool).length === 1) mustNot.push(f.bool.must_not); else filter.push(f); }
  if (env.timeField && !parts.noTime) filter.unshift(timeRange(env.timeField));
  const body = {};
  if (filter.length || mustNot.length) body.query = { bool: Object.assign({}, filter.length ? { filter } : {}, mustNot.length ? { must_not: mustNot } : {}) };
  if (Object.keys(env.runtime).length) body.runtime_mappings = clone(env.runtime);
  return Object.assign(body, parts.extra || {});
}

/* ---------- Intervalle automatique ---------- */
// Kibana choisit l’intervalle d’un histogramme d’après la période affichée (environ 50 tranches)
const AUTO_STEPS = [['1s', 1], ['5s', 5], ['10s', 10], ['30s', 30], ['1m', 60], ['5m', 300], ['10m', 600], ['30m', 1800], ['1h', 3600], ['3h', 10800], ['12h', 43200], ['1d', 86400], ['7d', 604800], ['30d', 2592000], ['1y', 31536000]];
function autoInterval(rangeSeconds) {
  const target = rangeSeconds / 50;
  let best = AUTO_STEPS[0];
  for (const s of AUTO_STEPS) if (Math.abs(Math.log(s[1] / target)) < Math.abs(Math.log(best[1] / target))) best = s;
  return best[0];
}
function rangeSeconds(from, to) {
  const dm = v => parseDateMath(String(v || ''));
  const a = dm(from || 'now-15m'); const b = dm(to || 'now');
  if (a && a.now && b && b.now) {
    const sec = x => x.ops.reduce((n, op) => n + (op.sign === '-' ? -1 : 1) * op.n * ({ s: 1, m: 60, h: 3600, H: 3600, d: 86400, w: 604800, M: 2592000, y: 31536000 }[op.unit]), 0);
    return Math.max(1, sec(b) - sec(a));
  }
  const ta = Date.parse(from); const tb = Date.parse(to);
  return Number.isFinite(ta) && Number.isFinite(tb) && tb > ta ? (tb - ta) / 1000 : 900;
}
// Intervalle d’un histogramme de date : calendaire pour une unité seule (1d, 1M…), fixe sinon
function dateInterval(iv, defaultRange) {
  const v = String(iv || 'auto');
  if (v === 'auto' || v === '') return { fixed: autoInterval(defaultRange), auto: true };
  const unit = { ms: '1ms', s: '1s', m: '1m', h: '1h', d: '1d', w: '1w', M: '1M', y: '1y' }[v];
  const x = unit || v;
  const m = /^(\d+)(ms|s|m|h|d|w|M|q|y)$/.exec(x);
  if (!m) return { error: `intervalle « ${v} »` };
  if (m[1] === '1' && 'mhdwMqy'.includes(m[2])) return { calendar: x };
  if ('wMqy'.includes(m[2])) return { error: `intervalle « ${v} » (multiple d’une unité calendaire)` };
  return { fixed: x };
}
const intervalSeconds = v => { const m = /^(\d+)(ms|s|m|h|d)$/.exec(String(v || '')); return m ? +m[1] * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : 0; };
function histogramDSL(field, iv, env, extra) {
  const d = dateInterval(iv, env.defaultRange);
  const out = { field };
  if (d.error) { env.issues.push({ kind: 'todo', label: d.error, detail: 'Elasticsearch n’accepte pas un multiple de semaine, de mois ou d’année : intervalle à choisir à la main.' }); out.fixed_interval = '1h'; }
  else if (d.calendar) out.calendar_interval = d.calendar; else out.fixed_interval = d.fixed;
  // Kibana découpe les tranches dans le fuseau de dateFormat:tz (celui du navigateur par défaut)
  if (env.tz) out.time_zone = env.tz;
  else if (d.calendar ? /^1[dwMqy]$/.test(d.calendar) : intervalSeconds(d.fixed) >= 86400) env.issues.push({ kind: 'review', label: 'fuseau des tranches de jours', detail: 'Kibana découpe les jours dans le fuseau de son paramètre dateFormat:tz, celui du navigateur par défaut ; la traduction les découpe en UTC. Indiquez le fuseau (option --timezone, ou le paramètre exporté avec les objets) pour des tranches identiques.' });
  if (d.auto) env.issues.push({ kind: 'review', label: 'intervalle automatique', detail: `Kibana calcule l’intervalle d’après la période affichée. La traduction retient ${d.fixed}, l’intervalle de la période par défaut du tableau de bord (${frDuration(Math.round(env.defaultRange))}) ; dans Grafana, $__interval le recalcule à chaque affichage.` });
  return Object.assign(out, extra || {});
}

/* ---------- Visualisations agrégées (visState) ---------- */
const VIS_BUCKETS = new Set(['date_histogram', 'histogram', 'range', 'date_range', 'ip_range', 'terms', 'multi_terms', 'rare_terms', 'filters', 'significant_terms', 'significant_text', 'geohash_grid', 'geotile_grid']);
// Nom d’agrégation, donc de colonne SQL : lisible, sans accents ni espaces
const aggName = (used, base) => { let n = rawAlias(String(base || 'agg').normalize('NFD').replace(/[\u0300-\u036f]/g, '')).replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'agg'; if (/^\d/.test(n)) n = `m_${n}`; let x = n, i = 2; while (used.has(x)) x = `${n}_${i++}`; used.add(x); return x; };
// Mesure de Kibana → { def, name, count } ; count : la mesure est le nombre de documents (doc_count)
function visMetric(a, env, used) {
  const p = a.params || {}; const label = p.customLabel || `${a.type}${p.field ? `_${p.field}` : ''}`;
  const field = p.field;
  switch (a.type) {
    case 'count': return { count: true };
    case 'avg': case 'sum': case 'min': case 'max': case 'cardinality': case 'value_count':
      return { name: aggName(used, label), def: { [a.type]: { field } } };
    case 'median': return { name: aggName(used, label), def: { percentiles: { field, percents: [50] } } };
    case 'single_percentile': return { name: aggName(used, label), def: { percentiles: { field, percents: [p.percentile === undefined ? 50 : p.percentile] } } };
    case 'percentiles': return { name: aggName(used, label), def: { percentiles: { field, percents: p.percents || [1, 5, 25, 50, 75, 95, 99] } } };
    case 'percentile_ranks': return { name: aggName(used, label), def: { percentile_ranks: { field, values: p.values || [] } } };
    case 'std_dev': return { name: aggName(used, label), def: { extended_stats: { field } } };
    case 'top_hits': {
      if (p.aggregate && p.aggregate !== 'concat' && /^(min|max|sum|average)$/.test(p.aggregate)) env.issues.push({ kind: 'review', label: `top_hits agrégé (${p.aggregate})`, detail: 'Kibana combine les valeurs des documents retenus ; la traduction renvoie les documents.' });
      return { name: aggName(used, label), def: { top_hits: { size: p.size || 1, sort: p.sortField ? [{ [p.sortField]: { order: p.sortOrder || 'desc' } }] : undefined, _source: field ? [field] : undefined } } };
    }
    case 'top_metrics': return { name: aggName(used, label), def: { top_metrics: { metrics: [{ field }], sort: p.sortField ? { [p.sortField]: p.sortOrder || 'desc' } : undefined, size: p.size || 1 } } };
    case 'rate': return { name: aggName(used, label), def: { rate: Object.assign({}, field ? { field } : {}, p.unit ? { unit: p.unit } : {}) } };
    case 'geo_bounds': case 'geo_centroid':
      env.issues.push({ kind: 'todo', label: `mesure ${a.type}`, detail: 'Les mesures géographiques se réécrivent avec les fonctions de ClickHouse (min et max des coordonnées, moyenne).' }); return null;
    default:
      env.issues.push({ kind: 'todo', label: `mesure ${a.type}`, detail: `La mesure « ${a.type} » de Kibana n’a pas de traduction automatique.` }); return null;
  }
}
function visBucket(a, env, used, metricsById) {
  const p = a.params || {}; const field = p.field;
  const name = aggName(used, a.type === 'date_histogram' ? 'periode' : a.type === 'filters' ? 'filtres' : field ? String(field).replace(/\.keyword$/, '') : a.type);
  switch (a.type) {
    case 'terms': case 'significant_terms': case 'rare_terms': case 'significant_text': {
      const body = { field };
      if (a.type !== 'rare_terms') body.size = p.size || 5;
      const ob = p.orderBy === undefined ? '1' : String(p.orderBy);
      const dir = String(p.order || 'desc').toLowerCase();
      if (a.type === 'terms') {
        if (ob === '_key') body.order = { _key: dir };
        else if (ob === 'custom' && p.orderAgg) {
          const m = visMetric(Object.assign({ id: 'orderAgg' }, p.orderAgg), env, used);
          if (m && m.count) body.order = { _count: dir };
          else if (m) { body.order = { [m.name]: dir }; body.__orderAgg = m; }
        } else {
          const m = metricsById.get(ob);
          if (!m || m.count) body.order = { _count: dir };
          else if (m.def && Object.keys(m.def)[0] === 'percentiles') body.order = { [`${m.name}.50`]: dir };
          else if (m.def) body.order = { [m.name]: dir };
          else body.order = { _count: dir };
        }
        if (p.missingBucket) body.missing = p.missingBucketLabel || '__missing__';
        if (p.otherBucket) env.issues.push({ kind: 'review', label: 'groupe « Autres »', detail: 'Kibana ajoute le groupe des valeurs hors du top par une seconde requête (filters) ; la traduction renvoie le top seul.' });
      }
      if (p.include) body.include = typeof p.include === 'object' && p.include.pattern !== undefined ? p.include.pattern : p.include;
      if (p.exclude) body.exclude = typeof p.exclude === 'object' && p.exclude.pattern !== undefined ? p.exclude.pattern : p.exclude;
      return { name, def: { [a.type]: body } };
    }
    case 'multi_terms': return { name, def: { multi_terms: { terms: (p.fields || []).map(f => ({ field: f })), size: p.size || 5 } } };
    case 'date_histogram': {
      const extra = {};
      if (p.min_doc_count === 0 || p.min_doc_count === true || p.extendToTimeRange) { extra.min_doc_count = 0; extra.extended_bounds = { min: TIME_FROM, max: TIME_TO }; }
      else extra.min_doc_count = 1;
      return { name, def: { date_histogram: histogramDSL(field || env.timeField, p.interval, env, extra) } };
    }
    case 'histogram': {
      const body = { field, interval: p.interval === 'auto' || p.interval === undefined ? 1 : Number(p.interval) };
      if (p.interval === 'auto' || p.interval === undefined || p.maxBars) env.issues.push({ kind: 'review', label: 'histogramme à pas automatique', detail: 'Kibana règle le pas selon les valeurs ; la traduction retient un pas fixe, à ajuster.' });
      body.min_doc_count = p.min_doc_count ? 0 : 1;
      if (isObj(p.extended_bounds) && p.has_extended_bounds) body.extended_bounds = p.extended_bounds;
      return { name, def: { histogram: body } };
    }
    case 'range': return { name, def: { range: { field, ranges: (p.ranges || []).map(r => ({ from: r.from, to: r.to, key: r.label })) } } };
    case 'date_range': return { name, def: { date_range: { field, ranges: (p.ranges || []).map(r => ({ from: r.from, to: r.to })) } } };
    case 'ip_range': {
      const masks = p.ipRangeType === 'mask' ? ((p.ranges && p.ranges.mask) || []).map(r => ({ mask: r.mask })) : ((p.ranges && p.ranges.fromTo) || []).map(r => ({ from: r.from, to: r.to }));
      return { name, def: { ip_range: { field, ranges: masks } } };
    }
    case 'filters': {
      const filters = {};
      (p.filters || []).forEach((f, i) => { filters[f.label || (f.input && f.input.query) || String(i)] = queryDSL(f.input || {}, env, env.issues) || { match_all: {} }; });
      return { name, def: { filters: { filters } } };
    }
    case 'geohash_grid': case 'geotile_grid': return { name, def: { [a.type]: { field, precision: p.precision || 5 } } };
  }
  return null;
}
/*
 * Agrégations d’une visualisation : les regroupements s’emboîtent dans l’ordre de leur déclaration (répartition des
 * graphiques, puis axe des abscisses et séries), les mesures se placent sous le plus profond. Les pipelines de Kibana
 * (dérivée, cumul, moyenne mobile, sériel) se calculent sur la mesure qu’ils désignent, sous le dernier histogramme.
 */
function visAggsDSL(aggs, env) {
  const used = new Set(); const enabled = (aggs || []).filter(a => isObj(a) && a.enabled !== false);
  const metricAggs = enabled.filter(a => !VIS_BUCKETS.has(a.type) && !/^(derivative|cumulative_sum|moving_avg|serial_diff|avg_bucket|sum_bucket|min_bucket|max_bucket)$/.test(a.type));
  const parentPipes = enabled.filter(a => /^(derivative|cumulative_sum|moving_avg|serial_diff)$/.test(a.type));
  const siblingPipes = enabled.filter(a => /^(avg_bucket|sum_bucket|min_bucket|max_bucket)$/.test(a.type));
  const buckets = enabled.filter(a => VIS_BUCKETS.has(a.type));
  const metricsById = new Map();
  for (const a of metricAggs) { const m = visMetric(a, env, used); if (m) metricsById.set(String(a.id), m); }
  const root = {}; let cur = root; let last = null;
  for (const b of buckets) {
    const x = visBucket(b, env, used, metricsById);
    if (!x) continue;
    const orderAgg = x.def[Object.keys(x.def)[0]].__orderAgg; delete x.def[Object.keys(x.def)[0]].__orderAgg;
    cur[x.name] = Object.assign({}, x.def, { aggs: {} });
    if (orderAgg) cur[x.name].aggs[orderAgg.name] = orderAgg.def;
    last = cur[x.name]; cur = cur[x.name].aggs;
  }
  for (const m of metricsById.values()) if (!m.count) cur[m.name] = m.def;
  for (const pa of parentPipes) {
    const p = pa.params || {};
    const target = p.metricAgg === 'custom' ? (p.customMetric ? visMetric(p.customMetric, env, used) : null) : metricsById.get(String(p.metricAgg));
    if (target && !target.count && p.metricAgg === 'custom') cur[target.name] = target.def;
    const path = !target || target.count ? '_count' : target.name;
    const name = aggName(used, p.customLabel || pa.type);
    if (!last || !last.date_histogram && !last.histogram) { env.issues.push({ kind: 'todo', label: `pipeline ${pa.type}`, detail: 'Le calcul porte sur un histogramme : la visualisation n’en a pas au dernier niveau.' }); continue; }
    cur[name] = pa.type === 'moving_avg' ? { moving_fn: { buckets_path: path, window: p.window || 5, script: 'MovingFunctions.unweightedAvg(values)' } } : pa.type === 'serial_diff' ? { serial_diff: { buckets_path: path, lag: p.lag || 1 } } : { [pa.type]: { buckets_path: path } };
  }
  if (siblingPipes.length) env.issues.push({ kind: 'todo', label: `pipeline ${siblingPipes.map(a => a.type).join(', ')}`, detail: 'Les mesures sur un regroupement personnalisé (moyenne, somme, minimum ou maximum des groupes) se réécrivent par une sous-requête.' });
  const clean = o => { for (const v of Object.values(o)) if (isObj(v) && isObj(v.aggs)) { if (!Object.keys(v.aggs).length) delete v.aggs; else clean(v.aggs); } return o; };
  return Object.keys(root).length ? clean(root) : null;
}
const VIS_TYPE_LABEL = { area: 'aires', line: 'courbes', histogram: 'barres verticales', horizontal_bar: 'barres horizontales', pie: 'secteurs', table: 'tableau', metric: 'métrique', gauge: 'jauge', goal: 'objectif', heatmap: 'carte de chaleur', tagcloud: 'nuage de mots', region_map: 'carte de régions', tile_map: 'carte de tuiles', metrics: 'TSVB', timelion: 'Timelion', vega: 'Vega', markdown: 'Markdown', input_control_vis: 'contrôles', enhanced_tilemap: 'carte' };


/* ---------- TSVB ---------- */
const missingView = id => ({ kind: 'review', label: 'vue de données absente de l’export', detail: `L’objet lit la vue de données ${id || '?'}, qui n’est pas dans le fichier : la table est devinée et les types des champs sont inconnus. Exportez les objets avec leurs objets liés.` });
// Environnement d’une autre vue de données, qui garde la liste des remarques et la période de l’objet
const envFor = (base, view) => Object.assign(viewEnv(base.cfg, view), { issues: base.issues, cfg: base.cfg, defaultRange: base.defaultRange, tz: base.tz });
// Vue de données d’un panneau TSVB : motif écrit en clair, vue de Kibana ({ id }) ou référence (index_pattern_ref_name)
function tsvbView(pattern, refName, obj, prefix, views, issues) {
  if (refName) {
    const r = refOf(obj, refName, prefix);
    if (r && views.has(r.id)) return views.get(r.id);
    if (r) { issues.push(missingView(r.id)); return null; }
  }
  if (isObj(pattern) && pattern.id) { if (views.has(pattern.id)) return views.get(pattern.id); issues.push(missingView(pattern.id)); return null; }
  if (typeof pattern === 'string' && pattern.trim()) return { id: null, title: pattern.trim(), timeField: null, runtime: {}, fields: new Map() };
  return null;
}
// Script d’une mesure « math » de TSVB : seule l’arithmétique sur params.x se recopie telle quelle en Painless
const TSVB_MATH = /^[\s\d.+\-*/()]*(params\.[A-Za-z_]\w*[\s\d.+\-*/()]*)*$/;
function tsvbMetrics(series, env, used) {
  const metrics = {}; const byId = new Map();
  const pathOf = id => (byId.has(id) && byId.get(id) ? byId.get(id) : '_count');
  const todoMetric = (type, why) => env.issues.push({ kind: 'todo', label: `mesure TSVB ${type}`, detail: why || `La mesure « ${type} » de TSVB se réécrit à la main.` });
  for (const m of series.metrics || []) {
    const name = aggName(used, m.type);
    const f = m.field;
    const simple = { avg: 'avg', sum: 'sum', min: 'min', max: 'max', cardinality: 'cardinality', value_count: 'value_count' }[m.type];
    if (m.type === 'count') byId.set(m.id, '_count');
    else if (simple) { metrics[name] = { [simple]: { field: f } }; byId.set(m.id, name); }
    else if (m.type === 'percentile') {
      const ps = (m.percentiles || []).map(x => Number(x.value)).filter(Number.isFinite);
      metrics[name] = { percentiles: { field: f, percents: ps.length ? ps : [50] } }; byId.set(m.id, `${name}.${ps.length ? ps[0] : 50}`);
    } else if (m.type === 'percentile_rank') { metrics[name] = { percentile_ranks: { field: f, values: (m.values || []).map(Number).filter(Number.isFinite) } }; byId.set(m.id, name); }
    else if (m.type === 'std_deviation' || m.type === 'variance' || m.type === 'sum_of_squares') {
      if (m.mode && m.mode !== 'raw') todoMetric(`${m.type} (${m.mode})`, 'Les bornes de l’écart type (upper, lower, band) se calculent à partir de la moyenne et de l’écart type.');
      metrics[name] = { extended_stats: { field: f } }; byId.set(m.id, `${name}.${m.type}`);
    } else if (m.type === 'derivative' || m.type === 'cumulative_sum' || m.type === 'serial_diff') {
      metrics[name] = { [m.type]: Object.assign({ buckets_path: pathOf(m.field) }, m.type === 'serial_diff' ? { lag: m.lag || 1 } : {}) }; byId.set(m.id, name);
      if (m.type === 'derivative' && m.unit) env.issues.push({ kind: 'review', label: `dérivée par ${m.unit} (TSVB)`, detail: `TSVB ramène la dérivée à ${m.unit} ; la traduction donne la différence par tranche : divisez par la durée de la tranche exprimée en ${m.unit}.` });
    } else if (m.type === 'moving_average') { metrics[name] = { moving_fn: { buckets_path: pathOf(m.field), window: m.window || 5, script: 'MovingFunctions.unweightedAvg(values)' } }; byId.set(m.id, name); if (m.model_type && m.model_type !== 'simple') env.issues.push({ kind: 'review', label: `moyenne mobile ${m.model_type} (TSVB)`, detail: 'La traduction calcule une moyenne mobile simple.' }); }
    else if (m.type === 'positive_only') { metrics[name] = { bucket_script: { buckets_path: { value: pathOf(m.field) }, script: 'params.value > 0.0 ? params.value : 0.0' } }; byId.set(m.id, name); }
    else if (m.type === 'positive_rate') {
      // Compteur cumulatif : maximum par tranche, dérivée, partie positive, comme la requête de TSVB
      const mx = aggName(used, 'max'); const dv = aggName(used, 'derivee');
      metrics[mx] = { max: { field: f } }; metrics[dv] = { derivative: { buckets_path: mx } };
      metrics[name] = { bucket_script: { buckets_path: { value: dv }, script: 'params.value > 0.0 ? params.value : 0.0' } };
      byId.set(m.id, name);
      if (m.unit) env.issues.push({ kind: 'review', label: `taux par ${m.unit} (TSVB)`, detail: `TSVB ramène le taux à ${m.unit} ; la traduction donne l’accroissement par tranche : divisez par la durée de la tranche exprimée en ${m.unit}.` });
    } else if (m.type === 'filter_ratio') {
      if (m.metric_agg && m.metric_agg !== 'count') { todoMetric(`filter_ratio (${m.metric_agg})`, `Le rapport porte sur ${m.metric_agg} de ${m.field || '?'} sous deux filtres : à écrire avec ${m.metric_agg}If.`); continue; }
      const q = v => queryDSL(typeof v === 'string' ? { query: v, language: 'lucene' } : v || {}, env, env.issues) || { match_all: {} };
      const n = aggName(used, 'numerateur'); const d = aggName(used, 'denominateur');
      metrics[n] = { filter: q(m.numerator) }; metrics[d] = { filter: q(m.denominator) };
      metrics[name] = { bucket_script: { buckets_path: { n: `${n}._count`, d: `${d}._count` }, script: 'params.d > 0 ? params.n / params.d : 0' } };
      byId.set(m.id, name);
    } else if (m.type === 'calculation' || m.type === 'math') {
      const vars = {}; for (const v of m.variables || []) if (v.name) vars[v.name] = pathOf(v.field);
      const script = String(m.script || '');
      if (m.type === 'math' && !TSVB_MATH.test(script)) { todoMetric('math', `Formule TinyMath « ${script} » : seules les quatre opérations sur params.x se traduisent automatiquement.`); continue; }
      metrics[name] = { bucket_script: { buckets_path: vars, script } }; byId.set(m.id, name);
    } else if (m.type === 'top_hit') {
      if (m.agg_with && m.agg_with !== 'noop' && (m.size || 1) > 1) env.issues.push({ kind: 'review', label: `top_hit combiné (${m.agg_with})`, detail: 'TSVB combine les valeurs des documents retenus ; la traduction renvoie le premier.' });
      metrics[name] = { top_metrics: { metrics: [{ field: f }], sort: { [m.order_by || env.timeField || '@timestamp']: m.order || 'desc' } } }; byId.set(m.id, name);
    } else if (m.type === 'static') byId.set(m.id, null);
    else todoMetric(m.type, m.type === 'series_agg' ? 'L’agrégation entre séries se calcule sur le résultat de chaque série : à reprendre.' : undefined);
  }
  return { metrics, byId };
}
function tsvbQueries(params, base, obj, prefix, views, extra) {
  const out = [];
  const type = params.type || 'timeseries';
  if (type === 'markdown') base.issues.push({ kind: 'review', label: 'TSVB Markdown', detail: 'Le texte et ses variables se recréent dans un panneau texte ; les séries sont traduites ci-dessous.' });
  if ((params.annotations || []).length) base.issues.push({ kind: 'review', label: 'annotations TSVB', detail: `${params.annotations.length} annotation(s) à recréer (requête d’annotations de Grafana).` });
  let panelView = tsvbView(params.index_pattern, params.index_pattern_ref_name, obj, prefix, views, base.issues);
  if (!panelView && !params.index_pattern_ref_name && !(isObj(params.index_pattern) && params.index_pattern.id)) {
    // Sans index nommé, TSVB lit la vue de données par défaut de l’espace
    panelView = views.defaultId ? views.get(views.defaultId) : null;
    base.issues.push(panelView ? { kind: views.defaultFromConfig ? 'info' : 'review', label: 'TSVB sur la vue de données par défaut', detail: `Le panneau ne nomme pas d’index : Kibana lit la vue de données par défaut de l’espace, ${views.defaultFromConfig ? `${panelView.title} d’après les paramètres exportés` : `supposée être ${panelView.title}, la seule vue de l’export`}.` } : { kind: 'review', label: 'TSVB sur la vue de données par défaut', detail: 'Le panneau ne nomme pas d’index : Kibana lit la vue de données par défaut de l’espace, inconnue ici. La table par défaut est utilisée.' });
  }
  const penv = envFor(base, panelView);
  // Hors des courbes, TSVB affiche par défaut la valeur de la dernière tranche (time_range_mode: last_value)
  const lastValue = type !== 'timeseries' && params.time_range_mode !== 'entire_time_range';
  if (lastValue && type !== 'markdown') base.issues.push({ kind: 'review', label: 'valeur de la dernière tranche (TSVB)', detail: 'Le panneau affiche la valeur de la dernière tranche de temps : le SQL renvoie toutes les tranches, retenez la dernière (ORDER BY … DESC LIMIT 1).' });
  if (params.ignore_global_filter) base.issues.push({ kind: 'review', label: 'filtres globaux ignorés (TSVB)', detail: 'Le panneau ignore la requête et les filtres du tableau de bord.' });
  const panelFilter = queryDSL(params.filter || {}, penv, base.issues);
  let dropped = false;
  for (const s of params.series || []) {
    if (s.hidden) continue;
    const senv = s.override_index_pattern ? envFor(base, tsvbView(s.series_index_pattern, s.series_index_pattern_ref_name, obj, prefix, views, base.issues) || panelView) : penv;
    const tf = (s.override_index_pattern && s.series_time_field) || params.time_field || senv.timeField;
    if (!tf && (type === 'timeseries' || lastValue)) base.issues.push({ kind: 'todo', label: 'TSVB sans champ de temps', detail: 'Ni le panneau ni la vue de données ne nomment le champ de temps des tranches.' });
    const used = new Set();
    const { metrics } = tsvbMetrics(s, senv, used);
    const lastMetric = (s.metrics || [])[(s.metrics || []).length - 1];
    let aggs = metrics;
    if ((type === 'timeseries' || lastValue) && tf) {
      let iv = (s.override_index_pattern && s.series_interval) || params.interval || 'auto';
      if (/^>=/.test(iv)) { base.issues.push({ kind: 'review', label: `intervalle minimal ${iv} (TSVB)`, detail: 'TSVB choisit l’intervalle d’après la période, sans descendre sous ce minimum.' }); iv = 'auto'; }
      const hist = { date_histogram: histogramDSL(tf, iv, base, { min_doc_count: 0, extended_bounds: { min: TIME_FROM, max: TIME_TO } }) };
      if (Object.keys(metrics).length) hist.aggs = metrics;
      aggs = { periode: hist };
    }
    const wrap = (name, def) => { if (Object.keys(aggs).length) def.aggs = aggs; aggs = { [aggName(used, name)]: def }; };
    if (s.split_mode === 'terms' && s.terms_field) {
      const fields = [].concat(s.terms_field);
      // Tri des groupes par une mesure : TSVB la recalcule directement sous le terms, sur toute la période
      const om = s.terms_order_by && !/^_(count|key)$/.test(s.terms_order_by) ? (s.metrics || []).find(m => m.id === s.terms_order_by) : null;
      const simple = om && { avg: 'avg', sum: 'sum', min: 'min', max: 'max', cardinality: 'cardinality', value_count: 'value_count' }[om.type];
      if (om && !simple && om.type !== 'count') base.issues.push({ kind: 'review', label: 'tri des groupes TSVB', detail: `Les groupes sont triés par la mesure ${om.type}, recalculée sur la période : la traduction les trie par nombre de documents.` });
      const ordName = simple ? aggName(used, `ordre_${om.type}`) : null;
      const order = { [ordName || (s.terms_order_by === '_key' ? '_key' : '_count')]: s.terms_direction || 'desc' };
      wrap(fields[0], fields.length > 1 ? { multi_terms: { terms: fields.map(f => ({ field: f })), size: +s.terms_size || 10, order } } : { terms: Object.assign({ field: fields[0], size: +s.terms_size || 10, order }, s.terms_include ? { include: s.terms_include } : {}, s.terms_exclude ? { exclude: s.terms_exclude } : {}) });
      if (ordName) { const top = Object.values(aggs)[0]; top.aggs = Object.assign({ [ordName]: { [simple]: { field: om.field } } }, top.aggs || {}); }
    } else if (s.split_mode === 'filters' && (s.split_filters || []).length) {
      const filters = {};
      for (const f of s.split_filters) filters[f.label || (f.filter && f.filter.query) || f.id] = queryDSL(f.filter || {}, senv, base.issues) || { match_all: {} };
      wrap('filtres', { filters: { filters } });
    }
    if (type === 'table' && params.pivot_id) wrap(String(params.pivot_id), { terms: { field: params.pivot_id, size: +params.pivot_rows || 10 } });
    if (lastMetric && lastMetric.type === 'static') base.issues.push({ kind: 'review', label: 'valeur fixe (TSVB)', detail: `La série « ${s.label || s.id} » affiche la valeur ${lastMetric.value} : une constante à recréer dans le panneau.` });
    const queries = [panelFilter, queryDSL(s.filter || {}, senv, base.issues)].concat(extra.queries || []);
    const body = searchBody(Object.assign({}, senv, { timeField: tf }), { queries, filters: extra.filters, extra: Object.assign({ size: 0 }, Object.keys(aggs).length ? { aggs } : {}) });
    if (type === 'timeseries' && params.drop_last_bucket !== 0 && s.series_drop_last_bucket !== 0 && !dropped) { dropped = true; base.issues.push({ kind: 'review', label: 'dernière tranche écartée (TSVB)', detail: 'TSVB masque par défaut la dernière tranche, incomplète ; le SQL la renvoie.' }); }
    out.push({ title: s.label || `Série ${out.length + 1}`, pattern: senv.pattern, dsl: body });
  }
  return out;
}

/* ---------- Lens ---------- */
// Noms des versions 7 (avg, cardinality) et des suivantes (average, unique_count)
const LENS_METRIC = { avg: 'avg', cardinality: 'cardinality', average: 'avg', sum: 'sum', min: 'min', max: 'max', unique_count: 'cardinality', standard_deviation: 'extended_stats', median: 'percentiles', percentile: 'percentiles', percentile_rank: 'percentile_ranks', last_value: 'top_metrics', count: 'value_count' };
const LENS_KIND = { lnsXY: 'graphique XY', lnsPie: 'secteurs', lnsDatatable: 'tableau', lnsMetric: 'métrique', lnsLegacyMetric: 'métrique', lnsHeatmap: 'carte de chaleur', lnsGauge: 'jauge', lnsTagcloud: 'nuage de mots', lnsChoropleth: 'carte choroplèthe', lnsMosaic: 'mosaïque', lnsWaffle: 'gaufre', lnsTreemap: 'treemap' };
const TINYMATH = { add: '+', subtract: '-', multiply: '*', divide: '/' };
const TIME_SCALE = { s: 'second', m: 'minute', h: 'hour', d: 'day' };
const isRecords = f => !f || f === '___records___' || f === 'Records';
// Expression TinyMath d’une formule Lens → script Painless d’un bucket_script
function tinymathScript(ast, pathOf) {
  const paths = {}; let k = 0;
  const leaf = id => { const v = `v${k++}`; paths[v] = pathOf(id); return `params.${v}`; };
  const m = n => {
    if (typeof n === 'number') return String(n);
    if (typeof n === 'string') return leaf(n);
    if (isObj(n) && n.type === 'variable') return leaf(n.value);
    if (isObj(n) && n.type === 'function' && TINYMATH[n.name] && (n.args || []).length === 2) return `(${m(n.args[0])} ${TINYMATH[n.name]} ${m(n.args[1])})`;
    if (isObj(n) && n.type === 'function' && /^(abs|sqrt|floor|ceil|log10|exp)$/.test(n.name) && n.args.length === 1) return `Math.${n.name}(${m(n.args[0])})`;
    if (isObj(n) && n.type === 'function' && n.name === 'round' && n.args.length === 1) return `Math.round(${m(n.args[0])})`;
    if (isObj(n) && n.type === 'function' && n.name === 'pow' && n.args.length === 2) return `Math.pow(${m(n.args[0])}, ${m(n.args[1])})`;
    throw new Error(`fonction de formule « ${isObj(n) ? n.name : n} » sans traduction automatique`);
  };
  return { script: m(ast), paths };
}
function lensLayers(attrs, obj, prefix, views, base, extra) {
  const st = attrs.state || {};
  const ds = st.datasourceStates || {};
  const formBased = ds.formBased || ds.indexpattern || null;
  const out = [];
  const textLayers = ds.textBased && isObj(ds.textBased.layers) ? Object.values(ds.textBased.layers).filter(isObj) : [];
  if (textLayers.length || (isObj(st.query) && st.query.esql !== undefined)) {
    const q = (textLayers[0] && textLayers[0].query && textLayers[0].query.esql) || (st.query && st.query.esql) || '';
    base.issues.push({ kind: 'todo', label: 'Lens en ES|QL', detail: `Une visualisation ES|QL se réécrit en SQL ClickHouse : la traduction automatique lit KQL, Lucene et le DSL.${q ? ` Requête : ${q}` : ''}` });
    return out;
  }
  if (!formBased || !isObj(formBased.layers) || !Object.keys(formBased.layers).length) { base.issues.push({ kind: 'todo', label: 'Lens sans couche de données', detail: 'L’état de la visualisation ne contient aucune couche formBased ou indexpattern.' }); return out; }
  const adHoc = st.adHocDataViews || {};
  for (const [layerId, layer] of Object.entries(formBased.layers)) {
    if (!isObj(layer) || !isObj(layer.columns) || !Object.keys(layer.columns).length) continue;
    const ref = refOf(obj, `indexpattern-datasource-layer-${layerId}`, prefix) || refOf(obj, 'indexpattern-datasource-current-indexpattern', prefix);
    const viewId = (ref && ref.id) || layer.indexPatternId;
    const view = views.get(viewId) || (adHoc[viewId] ? readDataView(viewId, Object.assign({}, adHoc[viewId], { fields: [] })) : null);
    if (!view) base.issues.push(missingView(viewId));
    const env = envFor(base, view);
    const cols = layer.columns;
    const order = (layer.columnOrder || Object.keys(cols)).filter(id => cols[id]);
    for (const id of Object.keys(cols)) if (!order.includes(id)) order.push(id);
    const used = new Set(); const metrics = {}; const ids = new Map(); const done = new Set();
    const bucketIds = order.filter(id => cols[id].isBucketed);
    const hasHistogram = bucketIds.some(id => cols[id].operationType === 'date_histogram');
    const pathOf = id => { resolve(id); return ids.has(id) && ids.get(id) !== null ? ids.get(id) : '_count'; };
    // La colonne de calcul d’une formule prend le nom de la formule affichée
    const labels = new Map();
    for (const c of Object.values(cols)) if (c.operationType === 'formula' && (c.references || [])[0]) labels.set(c.references[0], c.label);
    // Une colonne se résout après celles qu’elle cite (formules, cumuls, dérivées)
    function resolve(id) {
      if (done.has(id) || !cols[id] || cols[id].isBucketed) return;
      done.add(id);
      for (const r of cols[id].references || []) resolve(r);
      try { metricColumn(id, cols[id]); }
      catch (e) { env.issues.push({ kind: 'todo', label: `colonne Lens « ${cols[id].label || id} »`, detail: e.message }); }
    }
    function metricColumn(id, c) {
      const p = c.params || {};
      const label = labels.get(id) || (c.customLabel && c.label ? c.label : `${c.operationType}${!isRecords(c.sourceField) ? `_${c.sourceField}` : ''}`);
      let def = null; let path = null;
      if (c.operationType === 'formula') { ids.set(id, (c.references || []).length ? pathOf(c.references[0]) : null); return; }
      if (c.operationType === 'static_value') { ids.set(id, null); return; }
      const name = aggName(used, label);
      if (c.operationType === 'count' && isRecords(c.sourceField)) {
        if (c.timeScale && hasHistogram) def = { rate: { unit: TIME_SCALE[c.timeScale] } };
        else path = '_count';
      } else if (LENS_METRIC[c.operationType]) {
        const t = LENS_METRIC[c.operationType];
        if (t === 'percentiles') { const pc = c.operationType === 'median' ? 50 : p.percentile === undefined ? 95 : p.percentile; def = { percentiles: { field: c.sourceField, percents: [pc] } }; path = `${name}.${pc}`; }
        else if (t === 'percentile_ranks') def = { percentile_ranks: { field: c.sourceField, values: [p.value] } };
        else if (t === 'top_metrics') { def = { top_metrics: { metrics: [{ field: c.sourceField }], sort: { [p.sortField || env.timeField || '@timestamp']: 'desc' } } }; if (p.showArrayValues) env.issues.push({ kind: 'review', label: 'dernière valeur multivaluée', detail: 'Lens affiche toutes les valeurs du dernier document ; la traduction en garde une.' }); }
        else if (t === 'extended_stats') { def = { extended_stats: { field: c.sourceField } }; path = `${name}.std_deviation`; }
        else def = { [t]: { field: c.sourceField } };
        if (c.timeScale && (t === 'sum' || t === 'value_count') && hasHistogram) def = { rate: Object.assign({ field: c.sourceField, unit: TIME_SCALE[c.timeScale] }, t === 'value_count' ? { mode: 'value_count' } : {}) };
        if (t === 'cardinality') env.issues.push({ kind: 'review', label: 'nombre de valeurs distinctes', detail: 'Elasticsearch l’estime (HyperLogLog++, exact jusqu’à 3 000 valeurs) ; ClickHouse le calcule selon la configuration (uniqExact exact, uniq approché).' });
      } else if (/^(cumulative_sum|differences|moving_average|counter_rate)$/.test(c.operationType)) {
        if (!hasHistogram && c.operationType !== 'cumulative_sum') throw new Error(`« ${c.label || c.operationType} » demande un histogramme de dates`);
        const src = pathOf((c.references || [])[0]);
        if (c.operationType === 'cumulative_sum') def = { cumulative_sum: { buckets_path: src } };
        else if (c.operationType === 'differences') def = { derivative: { buckets_path: src } };
        else if (c.operationType === 'moving_average') def = { moving_fn: { buckets_path: src, window: p.window || 5, script: 'MovingFunctions.unweightedAvg(values)' } };
        else {
          // counter_rate : dérivée du maximum, négatives écartées (remise à zéro du compteur)
          const dv = aggName(used, 'derivee'); metrics[dv] = { derivative: { buckets_path: src } };
          def = { bucket_script: { buckets_path: { d: dv }, script: 'params.d > 0 ? params.d : 0' } };
        }
      } else if (c.operationType === 'math') {
        if (p.tinymathAst === undefined) throw new Error('formule sans arbre de calcul (tinymathAst)');
        if (typeof p.tinymathAst === 'string' || typeof p.tinymathAst === 'number') { ids.set(id, typeof p.tinymathAst === 'string' ? pathOf(p.tinymathAst) : null); return; }
        const t = tinymathScript(p.tinymathAst, pathOf);
        def = { bucket_script: { buckets_path: t.paths, script: t.script } };
      } else if (/^overall_(sum|min|max|average)$/.test(c.operationType)) throw new Error(`${c.operationType} : la valeur sur l’ensemble des groupes se calcule par une fonction de fenêtre sur tout le résultat`);
      else throw new Error(`opération « ${c.operationType} » sans traduction automatique`);
      if (c.timeShift) env.issues.push({ kind: 'todo', label: 'décalage temporel (time shift)', detail: `« ${c.label || name} » compare à la période décalée de ${c.timeShift} : une seconde requête sur cette période est nécessaire.` });
      if (c.reducedTimeRange) env.issues.push({ kind: 'todo', label: 'plage de temps réduite', detail: `« ${c.label || name} » ne lit que les dernières ${c.reducedTimeRange} de la période : à reprendre.` });
      if (c.timeScale && !(def && def.rate)) env.issues.push({ kind: 'review', label: `mesure par ${{ s: 'seconde', m: 'minute', h: 'heure', d: 'jour' }[c.timeScale] || c.timeScale}`, detail: `Lens ramène « ${c.label || name} » à l’unité de temps : ${hasHistogram ? 'divisez la valeur par la durée de la tranche' : 'divisez la valeur par la durée de la période affichée'}.` });
      if (c.filter && c.filter.query) {
        const q = queryDSL(c.filter, env, env.issues) || { match_all: {} };
        const fname = aggName(used, `filtre_${name}`);
        metrics[fname] = path === '_count' ? { filter: q } : { filter: q, aggs: { [name]: def } };
        ids.set(id, path === '_count' ? `${fname}._count` : `${fname}>${path || name}`);
        return;
      }
      if (path === '_count') { ids.set(id, '_count'); return; }
      metrics[name] = def; ids.set(id, path || name);
    }
    for (const id of order) resolve(id);
    if (hasHistogram && Object.values(metrics).some(d => d && d.rate)) env.issues.push({ kind: 'review', label: 'taux par unité de temps aux bords', detail: 'Lens ramène les deux tranches des bords de la période à leur partie affichée ; rate divise par la tranche entière : seules ces deux tranches diffèrent.' });
    // Regroupements, dans l’ordre des colonnes : le premier est le plus extérieur
    let aggs = metrics;
    // Formule sans regroupement : Lens la calcule sur la ligne unique du résultat ; un groupe unique la porte en SQL
    if (!bucketIds.length && Object.values(metrics).some(d => d && d.bucket_script)) aggs = { tout: { filters: { filters: { tout: { match_all: {} } } }, aggs: metrics } };
    for (const id of bucketIds.slice().reverse()) {
      const c = cols[id]; const p = c.params || {};
      const name = aggName(used, c.operationType === 'date_histogram' ? 'periode' : c.sourceField ? String(c.sourceField).replace(/\.keyword$/, '') : c.operationType);
      let def;
      if (c.operationType === 'terms') {
        const fields = [c.sourceField].concat(p.secondaryFields || []);
        const ob = p.orderBy || { type: 'alphabetical' };
        const dir = String(p.orderDirection || (ob.type === 'alphabetical' ? 'asc' : 'desc'));
        let order;
        if (ob.type === 'alphabetical') order = { _key: dir };
        else if (ob.type === 'column') { const path = pathOf(ob.columnId); order = { [path]: dir }; }
        else if (ob.type === 'rare') def = { rare_terms: { field: c.sourceField, max_doc_count: ob.maxDocCount || 1 } };
        else if (ob.type === 'significant') def = { significant_terms: { field: c.sourceField, size: p.size || 5 } };
        else if (ob.type === 'custom' && p.orderAgg) { env.issues.push({ kind: 'review', label: 'tri des groupes personnalisé', detail: `« ${c.label} » est trié par une mesure qui n’est pas affichée ; la traduction trie par nombre de documents.` }); order = { _count: dir }; }
        else order = { _count: dir };
        if (!def) {
          const list = v => (Array.isArray(v) ? (v.length === 1 ? v[0] : v) : v);
          def = fields.length > 1 ? { multi_terms: { terms: fields.map(f => ({ field: f })), size: p.size || 5, order } } : { terms: Object.assign({ field: c.sourceField, size: p.size || 5, order }, p.missingBucket ? { missing: '(vide)' } : {}, p.include && p.include.length ? { include: p.includeIsRegex ? String(list(p.include)) : p.include } : {}, p.exclude && p.exclude.length ? { exclude: p.excludeIsRegex ? String(list(p.exclude)) : p.exclude } : {}) };
        }
        if (p.otherBucket) env.issues.push({ kind: 'review', label: 'groupe « Autres »', detail: 'Lens ajoute le groupe des valeurs hors du top par une seconde requête ; la traduction renvoie le top seul.' });
      } else if (c.operationType === 'date_histogram') {
        def = { date_histogram: histogramDSL(c.sourceField || env.timeField, p.interval, env, p.includeEmptyRows !== false ? { min_doc_count: 0, extended_bounds: { min: TIME_FROM, max: TIME_TO } } : { min_doc_count: 1 }) };
        if (p.dropPartials) env.issues.push({ kind: 'review', label: 'tranches partielles écartées', detail: 'Lens masque les tranches incomplètes aux bords de la période ; le SQL les renvoie.' });
      } else if (c.operationType === 'range') {
        if (p.type === 'range') def = { range: { field: c.sourceField, ranges: (p.ranges || []).map(r => Object.assign({}, r.from === null || r.from === undefined || r.from === -Infinity ? {} : { from: r.from }, r.to === null || r.to === undefined || r.to === Infinity ? {} : { to: r.to }, r.label ? { key: r.label } : {})) } };
        else { def = { histogram: { field: c.sourceField, interval: p.interval && p.interval !== 'auto' ? Number(p.interval) : 1 } }; env.issues.push({ kind: 'review', label: 'pas de l’histogramme Lens', detail: `Lens choisit le pas pour obtenir au plus ${p.maxBars || 'une centaine de'} barres ; la traduction retient un pas fixe, à ajuster.` }); }
      } else if (c.operationType === 'filters') {
        const filters = {};
        (p.filters || []).forEach((f, i) => { filters[f.label || (f.input && f.input.query) || String(i)] = queryDSL(f.input || {}, env, env.issues) || { match_all: {} }; });
        def = { filters: { filters } };
      } else { env.issues.push({ kind: 'todo', label: `regroupement Lens ${c.operationType}`, detail: `« ${c.label || c.operationType} » n’a pas de traduction automatique.` }); continue; }
      if (Object.keys(aggs).length) def.aggs = aggs;
      aggs = { [name]: def };
    }
    const body = searchBody(env, { queries: [queryDSL(st.query, env, env.issues)].concat(extra.queries || []), filters: (st.filters || []).map(f => filterDSL(f, env.issues)).concat(extra.filters || []), extra: Object.assign({ size: 0 }, Object.keys(aggs).length ? { aggs } : {}) });
    out.push({ title: Object.keys(formBased.layers).length > 1 ? `Couche ${out.length + 1}` : 'Requête', pattern: env.pattern, dsl: body });
  }
  return out;
}

/* ---------- Règles d’alerte ---------- */
const COMPARATORS = { '>': '>', '<': '<', '>=': '>=', '<=': '<=', between: 'BETWEEN', notBetween: 'NOT BETWEEN', 'more than': '>', 'less than': '<', 'more than or equals': '>=', 'less than or equals': '<=', equals: '=', 'not equals': '!=' };
const windowOf = (size, unit) => (size ? `now-${size}${{ s: 's', m: 'm', h: 'h', d: 'd' }[unit] || 'm'}` : null);
// Critère d’une règle de seuil de logs → clause DSL
function logCriterion(c) {
  const f = c.field; const v = c.value;
  switch (c.comparator) {
    case 'equals': return { match_phrase: { [f]: v } };
    case 'does not equal': return { bool: { must_not: { match_phrase: { [f]: v } } } };
    case 'matches': return { match: { [f]: v } };
    case 'does not match': return { bool: { must_not: { match: { [f]: v } } } };
    case 'matches phrase': return { match_phrase: { [f]: v } };
    case 'does not match phrase': return { bool: { must_not: { match_phrase: { [f]: v } } } };
    case 'more than': return { range: { [f]: { gt: v } } };
    case 'less than': return { range: { [f]: { lt: v } } };
    case 'more than or equals': return { range: { [f]: { gte: v } } };
    case 'less than or equals': return { range: { [f]: { lte: v } } };
  }
  return null;
}
/*
 * Règle → corps de recherche sur sa fenêtre de temps, et seuil. Le SQL rend la valeur évaluée et la décision
 * (colonne declenchee) ; la planification et les actions se recréent dans l’outil d’alerte cible.
 */
function ruleQuery(a, base, views, obj) {
  const p = a.params || {}; const type = a.alertTypeId || a.rule_type_id || a.ruleTypeId;
  const issues = base.issues;
  const threshold = Array.isArray(p.threshold) ? p.threshold : p.threshold !== undefined && !isObj(p.threshold) ? [p.threshold] : [];
  const metric = () => (p.aggType && p.aggType !== 'count' ? { valeur: { [p.aggType]: { field: p.aggField } } } : null);
  // Groupes : les termSize premiers selon la mesure (croissante pour min), ou selon le nombre de documents, comme Kibana
  const grouped = aggs => (p.groupBy === 'top' && p.termField ? { groupe: Object.assign({ terms: Object.assign({ field: [].concat(p.termField)[0], size: p.termSize || 5 }, aggs ? { order: { valeur: p.aggType === 'min' ? 'asc' : 'desc' } } : {}) }, aggs ? { aggs } : {}) } : aggs);
  if ([].concat(p.termField || []).length > 1) issues.push({ kind: 'review', label: 'regroupement sur plusieurs champs', detail: 'La règle groupe par plusieurs champs ; la traduction groupe par le premier.' });
  const finish = (pattern, env, queries, filters, aggs, tf) => {
    const win = windowOf(p.timeWindowSize, p.timeWindowUnit);
    const q = queries.slice(); if (win && tf) q.push({ range: { [tf]: { gte: win } } });
    const body = searchBody(Object.assign({}, env, { timeField: null }), { queries: q, filters, extra: Object.assign({ size: 0 }, aggs ? { aggs } : {}) });
    return { pattern, body, threshold, comparator: COMPARATORS[p.thresholdComparator] || null };
  };
  if (type === '.es-query') {
    if (p.searchType === 'esqlQuery') { issues.push({ kind: 'todo', label: 'règle ES|QL', detail: `La requête ES|QL de la règle se réécrit en SQL ClickHouse.${p.esqlQuery && p.esqlQuery.esql ? ` Requête : ${p.esqlQuery.esql}` : ''}` }); return null; }
    if (p.searchType === 'searchSource') {
      const sc = p.searchConfiguration || {};
      const ref = refOf(obj, 'param:kibanaSavedObjectMeta.searchSourceJSON.index');
      const id = (ref && ref.id) || (typeof sc.index === 'string' ? sc.index : null);
      const view = views.get(id) || (isObj(sc.index) ? readDataView(sc.index.id, sc.index) : null);
      if (!view) issues.push(missingView(id));
      const env = envFor(base, view);
      return finish(env.pattern, env, [queryDSL(sc.query, env, issues)], (sc.filter || []).map(f => filterDSL(f, issues)), grouped(metric()), p.timeField || env.timeField);
    }
    const q = jsonAttr(p.esQuery);
    if (!isObj(q)) { issues.push({ kind: 'todo', label: 'requête de la règle', detail: 'esQuery n’est pas un JSON lisible.' }); return null; }
    const pattern = [].concat(p.index || []).join(',');
    const env = envFor(base, { id: null, title: pattern, timeField: p.timeField, runtime: {}, fields: new Map() });
    const r = finish(pattern, env, [q.query || null], [], grouped(metric()), p.timeField);
    if (q.runtime_mappings) r.body.runtime_mappings = q.runtime_mappings;
    if (q.aggs || q.aggregations) issues.push({ kind: 'review', label: 'agrégations de la requête de la règle', detail: 'La règle évalue le nombre de documents (ou la mesure choisie) ; les agrégations écrites dans esQuery ne servent qu’au contexte des actions.' });
    return r;
  }
  if (type === '.index-threshold') {
    const pattern = [].concat(p.index || []).join(',');
    const env = envFor(base, { id: null, title: pattern, timeField: p.timeField, runtime: {}, fields: new Map() });
    return finish(pattern, env, [p.filterKuery ? queryDSL({ query: p.filterKuery, language: 'kuery' }, env, issues) : null], [], grouped(metric()), p.timeField);
  }
  if (type === 'logs.alert.document.count') {
    // Seuil de logs : la source (index) se règle dans l’application Logs, hors de la règle
    const pattern = 'logs-*,filebeat-*';
    issues.push({ kind: 'review', label: 'index de la règle de logs', detail: `La règle lit la source de l’application Logs, configurée hors de la règle : ${pattern} (valeur par défaut de Kibana) est supposé.` });
    const env = envFor(base, { id: null, title: pattern, timeField: '@timestamp', runtime: {}, fields: new Map() });
    const crit = (p.criteria || []).map(c => { const x = logCriterion(c); if (!x) issues.push({ kind: 'todo', label: `critère ${c.comparator}`, detail: `Critère sur ${c.field} sans traduction automatique.` }); return x; }).filter(Boolean);
    if (Array.isArray(p.criteria) && Array.isArray(p.criteria[0])) issues.push({ kind: 'todo', label: 'règle de logs par rapport', detail: 'Le rapport de deux requêtes (ratio) se calcule par countIf : à reprendre.' });
    const group = (p.groupBy || []).length ? { groupe: { terms: { field: p.groupBy[0], size: 100 } } } : null;
    if ((p.groupBy || []).length > 1) issues.push({ kind: 'review', label: 'regroupement sur plusieurs champs', detail: 'La règle groupe par plusieurs champs ; la traduction groupe par le premier.' });
    const win = windowOf(p.timeSize, p.timeUnit);
    const body = searchBody(Object.assign({}, env, { timeField: null }), { queries: crit.concat(win ? [{ range: { '@timestamp': { gte: win } } }] : []), filters: [], extra: Object.assign({ size: 0 }, group ? { aggs: group } : {}) });
    return { pattern, body, threshold: p.count && p.count.value !== undefined ? [p.count.value] : [], comparator: p.count ? COMPARATORS[p.count.comparator] : null };
  }
  if (type === 'observability.rules.custom_threshold') {
    const cr = (p.criteria || [])[0] || {};
    const ms = cr.metrics || [];
    const sc = p.searchConfiguration || {};
    const id = (refOf(obj, 'param:kibanaSavedObjectMeta.searchSourceJSON.index') || {}).id || (typeof sc.index === 'string' ? sc.index : null);
    const view = views.get(id) || (isObj(sc.index) ? readDataView(sc.index.id || 'adhoc', sc.index) : null);
    if ((p.criteria || []).length !== 1 || ms.length !== 1 || (cr.equation && cr.equation !== ms[0].name)) {
      issues.push({ kind: 'todo', label: 'seuil personnalisé à plusieurs mesures', detail: 'Les critères multiples et les équations entre mesures (A / B…) se réécrivent en SQL : à reprendre.' });
      return null;
    }
    if (!view) issues.push(missingView(id));
    const env = envFor(base, view);
    const m = ms[0];
    const agg = m.aggType === 'count' ? null : { valeur: { [{ avg: 'avg', sum: 'sum', min: 'min', max: 'max', cardinality: 'cardinality' }[m.aggType] || m.aggType]: { field: m.field } } };
    const fq = m.filter ? queryDSL({ query: m.filter, language: 'kuery' }, env, issues) : null;
    const group = (p.groupBy || []).length ? { groupe: Object.assign({ terms: { field: [].concat(p.groupBy)[0], size: 100 } }, agg ? { aggs: agg } : {}) } : agg;
    const win = windowOf(cr.timeSize, cr.timeUnit);
    const tf = env.timeField || '@timestamp';
    const body = searchBody(Object.assign({}, env, { timeField: null }), { queries: [queryDSL(sc.query, env, issues), fq, win ? { range: { [tf]: { gte: win } } } : null], filters: (sc.filter || []).map(f => filterDSL(f, issues)), extra: Object.assign({ size: 0 }, group ? { aggs: group } : {}) });
    return { pattern: env.pattern, body, threshold: cr.threshold || [], comparator: COMPARATORS[cr.comparator] || null };
  }
  if (/^siem\./.test(type)) {
    issues.push({ kind: 'todo', label: 'logique de détection (Security)', detail: `La règle ${type.replace(/^siem\./, '')} (seuils, séquences, suppression des doublons, signaux) se recrée dans l’outil cible ; seule sa requête est traduite.` });
    return securityQuery(p, base);
  }
  issues.push({ kind: 'todo', label: `règle ${type || 'de type inconnu'}`, detail: 'Type de règle sans traduction automatique : ses critères se recréent dans l’outil d’alerte cible.' });
  return null;
}
// Requête d’une règle de détection (Security) : KQL ou Lucene sur ses index, depuis « from »
function securityQuery(p, base) {
  if (!p.query || !(p.language === 'kuery' || p.language === 'lucene' || !p.language)) return null;
  const pattern = [].concat(p.index || ['logs-*']).join(',');
  const env = envFor(base, { id: null, title: pattern, timeField: '@timestamp', runtime: {}, fields: new Map() });
  const q = queryDSL({ query: p.query, language: p.language || 'kuery' }, env, base.issues);
  const range = { range: { '@timestamp': { gte: p.from || 'now-6m' } } };
  const filters = (p.filters || []).map(f => filterDSL(f, base.issues));
  if (p.type === 'threshold' && isObj(p.threshold)) {
    const field = [].concat(p.threshold.field || [])[0];
    const aggs = field ? { groupe: { terms: { field, size: 100, min_doc_count: Math.max(1, +p.threshold.value || 1) } } } : null;
    const body = searchBody(Object.assign({}, env, { timeField: null }), { queries: [q, range], filters, extra: Object.assign({ size: 0 }, aggs ? { aggs } : {}) });
    return { pattern, body, threshold: field ? [] : [p.threshold.value], comparator: field ? null : '>=' };
  }
  return { pattern, body: searchBody(Object.assign({}, env, { timeField: null }), { queries: [q, range], filters, extra: { size: 100, sort: [{ '@timestamp': 'desc' }] } }), threshold: [], comparator: null };
}
// Ajoute la décision de la règle à la requête : la valeur comparée au seuil
function ruleDecision(sql, rule) {
  if (!rule.comparator || !rule.threshold.length) return null;
  const value = /\bAS valeur\b/.test(sql) ? 'valeur' : /\bAS count\b/.test(sql) ? 'count' : /\bAS doc_count\b/.test(sql) ? 'doc_count' : null;
  if (!value) return null;
  const t = rule.threshold.map(Number);
  if (!t.every(Number.isFinite)) return null;
  const cond = /BETWEEN/.test(rule.comparator) ? `${value} ${rule.comparator} ${t[0]} AND ${t[1]}` : `${value} ${rule.comparator} ${t[0]}`;
  return decisionWrap(sql, ['*', `${cond} AS declenchee`]);
}
// Décision d’une alerte (règle Kibana, watch) : des colonnes calculées sur le résultat de sa requête
function decisionWrap(sql, select) {
  return `SELECT\n    ${select.join(',\n    ')}\nFROM\n(\n${indent(String(sql).replace(/;\s*$/, ''), '    ')}\n)`;
}

/* ---------- Inventaire ---------- */
const KB_TYPES = { 'index-pattern': 'Vue de données', search: 'Recherche', query: 'Requête enregistrée', visualization: 'Visualisation', lens: 'Lens', map: 'Carte', links: 'Liens', dashboard: 'Tableau de bord', alert: 'Règle d’alerte', 'security-rule': 'Règle de détection', action: 'Connecteur', 'canvas-workpad': 'Canvas', 'graph-workspace': 'Graph', other: 'Autre' };
const KB_ORDER = ['index-pattern', 'search', 'query', 'visualization', 'lens', 'map', 'links', 'dashboard', 'alert', 'security-rule', 'action', 'canvas-workpad', 'graph-workspace', 'other'];
// Objets sans requête ni affichage à migrer : comptés à part
const KB_IGNORED = new Set(['config', 'config-global', 'tag', 'url', 'ui-metric', 'telemetry', 'space', 'search-session', 'core-usage-stats', 'lens-ui-telemetry', 'file', 'fileShare', 'usage-counters', 'sample-data-telemetry', 'legacy-url-alias', 'event_loop_delays_daily']);
/*
 * Barème de l’effort, en heures : recréer l’objet dans l’outil cible, vérifier ses requêtes, reprendre ce qui ne se
 * traduit pas. Les poids d’un point à reprendre dépendent de sa nature (un panneau Vega se réécrit, un filtre se corrige).
 */
const KB_EFFORT = {
  base: { 'index-pattern': 0.25, search: 0.25, query: 0.1, visualization: 0.5, lens: 0.5, map: 0.5, links: 0.25, dashboard: 0.5, alert: 1, 'security-rule': 1, action: 0.25, 'canvas-workpad': 0.5, 'graph-workspace': 0.5, other: 0.5 },
  panel: 0.1, control: 0.25, action: 0.25,
  query: { ready: 0, review: 0.25, todo: 0.5, unrecognized: 1 },
  review: 0.25, warn: 0.25, warnCap: 1,
  todo: [[/Vega/, 6, 'visualisation Vega'], [/Canvas/, 6, 'classeur Canvas'], [/[Cc]arte|Maps/, 4, 'carte'], [/TSVB|Timelion/, 3, 'TSVB ou Timelion'], [/ES\|QL|EQL/, 3, 'requête ES|QL ou EQL'], [/détection/, 4, 'logique de détection'], [/Painless|script|runtime/i, 2, 'script Painless'], [/agrégation|mesure|pipeline|regroupement|opération|colonne|formule/i, 1.5, 'agrégation, mesure ou formule']],
  todoDefault: 1, hoursPerDay: 7
};
// Remarques qui relèvent de la configuration (une fois pour tout le parc), pas d’un objet
const KB_PREREQ = /^(Index sans correspondance|Schéma des colonnes non fourni)/;
// Index sans correspondance : repris par la liste des tables à déclarer
const KB_PREREQ_SHOWN = /^Schéma des colonnes non fourni/;
const todoHours = label => { for (const [re, h] of KB_EFFORT.todo) if (re.test(label)) return h; return KB_EFFORT.todoDefault; };
const quarter = h => Math.ceil(h * 4 - 1e-9) / 4;
const worstVerdict = list => list.reduce((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), 'ready');
// Champs cités par un corps de recherche, pour le bilan par vue de données
function dslFields(dsl, out) {
  const add = f => { if (typeof f === 'string' && f && !f.startsWith('_') && !f.includes('{{') && f !== '*') out.add(f.replace(/\.keyword$/, '')); };
  const FIELD_KEYS = new Set(['term', 'terms', 'match', 'match_phrase', 'match_phrase_prefix', 'match_bool_prefix', 'range', 'wildcard', 'prefix', 'regexp', 'fuzzy']);
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'runtime_mappings' || k === 'script' || k === 'buckets_path') continue;
      if (k === 'field') add(x);
      else if (k === 'fields' && Array.isArray(x)) x.forEach(y => add(isObj(y) ? y.field : y));
      else if (k === '_source' && Array.isArray(x)) x.forEach(add);
      else if (k === 'sort') [].concat(x).forEach(s => (typeof s === 'string' ? add(s) : isObj(s) && Object.keys(s).forEach(add)));
      // Clause de requête ({ term: { champ: … } }), pas agrégation ({ terms: { field: … } })
      else if (FIELD_KEYS.has(k) && isObj(x) && typeof x.field !== 'string') Object.keys(x).filter(f => !['boost', '_name', 'case_insensitive'].includes(f)).forEach(add);
      if (isObj(x) || Array.isArray(x)) walk(x);
    }
  };
  walk(dsl);
  return out;
}
function makeEntry(type, id, title, extra) {
  return Object.assign({ key: `${type}:${id}`, type: KB_TYPES[type] ? type : 'other', rawType: type, id, title: String(title || '').trim() || '(sans titre)', kind: '', parent: null, byValue: false, views: [], tables: [], queries: [], issues: [], children: [], usedBy: [], fields: new Set(), verdict: 'ready', effort: 0, effortDetail: [] }, extra || {});
}
// Traduit un corps de recherche reconstruit et range le résultat dans l’objet
function addQuery(entry, src, cfg, decorate) {
  const text = JSON.stringify(src.dsl, null, 2);
  const r = translateDSL(text, cfg, { index: src.pattern });
  const q = { title: src.title || 'Requête', pattern: src.pattern || '', table: r.table || null, matched: r.matched || null, dsl: src.dsl, verdict: verdictOf(r), coverage: r.stats ? coverage(r.stats) : null, notes: r.notes || [], error: r.error || null, sentence: r.sentence || '', parameters: r.parameters || [], sql: r.sql || '' };
  if (r.error) entry.issues.push({ kind: 'todo', label: 'requête refusée par la traduction', detail: `${src.title || 'Requête'} : ${r.error}` });
  if (decorate && r.statements && r.statements.length === 1) {
    const d = decorate(r.statements[0].sql);
    if (d) q.sql = `-- ${r.statements[0].title}, avec la décision de la règle\n${d};`;
  }
  dslFields(src.dsl, entry.fields);
  if (q.table && !entry.tables.includes(q.table)) entry.tables.push(q.table);
  if (src.pattern && !entry.views.includes(src.pattern)) entry.views.push(src.pattern);
  entry.queries.push(q);
  return q;
}
// Recherche (searchSourceJSON) d’un objet : vue de données, requête, filtres
function searchSourceOf(o, a, prefix, views, issues) {
  const meta = a.kibanaSavedObjectMeta || {};
  const ss = jsonAttr(meta.searchSourceJSON) || {};
  let viewId = null;
  if (ss.indexRefName) { const r = refOf(o, ss.indexRefName, prefix); viewId = r ? r.id : null; }
  else if (typeof ss.index === 'string') viewId = ss.index;
  else { const r = refOf(o, 'kibanaSavedObjectMeta.searchSourceJSON.index', prefix); viewId = r ? r.id : null; }
  const adhoc = isObj(ss.index) ? readDataView(ss.index.id || 'adhoc', ss.index) : null;
  const view = (viewId && views.get(viewId)) || adhoc;
  if (viewId && !view) issues.push(missingView(viewId));
  return { view, viewId, query: ss.query, filters: ss.filter || [], ss };
}
// Liste de valeurs d’un contrôle (liste d’options, curseur) : la requête d’une variable de tableau de bord
function controlQueries(entry, controls, o, base, views, cfg) {
  for (const c of controls) {
    const field = c.fieldName; const title = c.title || c.label || field || 'contrôle';
    if (c.type === 'timeSlider' || c.type === 'timeSliderControl') { entry.issues.push({ kind: 'review', label: 'curseur de temps', detail: 'Le curseur de temps se remplace par le sélecteur de période de l’outil cible.' }); continue; }
    if (c.type === 'esqlControl') { entry.issues.push({ kind: 'todo', label: `contrôle ES|QL « ${title} »`, detail: 'Les valeurs d’un contrôle ES|QL viennent d’une requête ES|QL à réécrire en SQL.' }); continue; }
    if (!field) continue;
    const ref = c.ref ? refOf(o, c.ref) : null;
    const viewId = (ref && ref.id) || c.dataViewId || null;
    const view = viewId ? views.get(viewId) : null;
    if (viewId && !view) entry.issues.push(missingView(viewId));
    const env = envFor(base, view);
    const range = c.type === 'rangeSliderControl' || c.type === 'range';
    const aggs = range ? { minimum: { min: { field } }, maximum: { max: { field } } } : { valeurs: { terms: { field, size: Math.max(10, +c.size || 100), order: { _count: 'desc' } } } };
    addQuery(entry, { title: `Contrôle « ${title} »`, pattern: env.pattern, dsl: searchBody(env, { queries: [], filters: [], extra: { size: 0, aggs } }) }, cfg);
    if ((c.selectedOptions || []).length || (Array.isArray(c.value) && c.value.some(v => v !== '' && v !== null))) entry.issues.push({ kind: 'review', label: `valeur enregistrée du contrôle « ${title} »`, detail: `Le contrôle filtre le tableau de bord sur ${(c.selectedOptions || c.value).join(', ')} : valeur par défaut de la variable à recréer.` });
  }
}
function kbEnv(ctx, view, defaultRange) { return Object.assign(viewEnv(ctx.cfg, view), { issues: [], cfg: ctx.cfg, defaultRange: defaultRange || 900, tz: ctx.tz }); }

/* ---------- Analyse par type d’objet ---------- */
function analyzeDataView(o, ctx) {
  const v = ctx.views.get(o.id);
  const e = makeEntry('index-pattern', o.id, v.title, { kind: v.timeField ? `champ de temps ${v.timeField}` : 'sans champ de temps' });
  const env = kbEnv(ctx, v);
  e.views.push(v.title); e.tables.push(env.table);
  const rt = Object.keys(v.runtime);
  if (rt.length) {
    addQuery(e, { title: `Champs calculés (${rt.length})`, pattern: v.title, dsl: { size: 10, _source: false, fields: rt, runtime_mappings: clone(v.runtime) } }, ctx.cfg);
  }
  if (v.fields.size) e.kind += `, ${v.fields.size} champs`;
  e.issues.push(...env.issues);
  return [e];
}
function analyzeSearch(o, ctx, opts) {
  const a = o.attributes; opts = opts || {};
  const e = makeEntry('search', opts.key || o.id, opts.title || a.title, { kind: 'Discover', parent: opts.parent || null, byValue: !!opts.parent });
  const tabs = Array.isArray(a.tabs) && a.tabs.length ? a.tabs : [{ id: null, label: null, attributes: a }];
  if (tabs.length > 1) e.kind = `Discover, ${tabs.length} onglets`;
  for (const tab of tabs) {
    const ta = tab.attributes || {};
    const base = kbEnv(ctx, null, opts.defaultRange); base.issues = e.issues;
    const src = searchSourceOf(o, ta, opts.prefix, ctx.views, e.issues);
    if (ta.isTextBasedQuery || (isObj(src.query) && src.query.esql !== undefined)) { e.issues.push({ kind: 'todo', label: 'recherche ES|QL', detail: `Une recherche ES|QL se réécrit en SQL ClickHouse.${isObj(src.query) && src.query.esql ? ` Requête : ${src.query.esql}` : ''}` }); continue; }
    const env = envFor(base, src.view);
    const columns = (ta.columns || []).filter(c => c && c !== '_source');
    let sort = (ta.sort || []);
    if (sort.length === 2 && typeof sort[0] === 'string') sort = [sort];
    const sortDSL = sort.filter(s => Array.isArray(s) && s[0] && s[0] !== '_score').map(s => ({ [s[0]]: { order: String(s[1] || 'desc').toLowerCase() } }));
    if (!sortDSL.length && env.timeField) sortDSL.push({ [env.timeField]: { order: 'desc' } });
    const size = +ta.sampleSize || 500;
    const extra = { size, sort: sortDSL };
    if (columns.length) extra._source = (env.timeField && !columns.includes(env.timeField) ? [env.timeField] : []).concat(columns);
    const body = searchBody(env, { queries: [queryDSL(src.query, env, e.issues)].concat(opts.queries || []), filters: src.filters.map(f => filterDSL(f, e.issues)).concat(opts.filters || []), extra });
    addQuery(e, { title: tab.label ? `Onglet « ${tab.label} »` : 'Documents', pattern: env.pattern, dsl: body }, ctx.cfg);
    if (ta.grid && ta.grid.columns && Object.values(ta.grid.columns).some(c => c && c.width)) { /* mise en forme seule */ }
  }
  return [e];
}
function analyzeSavedQuery(o, ctx) {
  const a = o.attributes;
  const e = makeEntry('query', o.id, a.title, { kind: isObj(a.query) && a.query.language === 'lucene' ? 'Lucene' : 'KQL' });
  const base = kbEnv(ctx, null);
  base.issues = e.issues;
  e.issues.push({ kind: 'review', label: 'requête sans vue de données', detail: 'Une requête enregistrée s’applique à la vue de données de l’écran qui la charge : la table par défaut est utilisée pour la vérifier.' });
  const body = searchBody(Object.assign({}, base, { timeField: null }), { queries: [queryDSL(a.query, base, e.issues)], filters: (a.filters || []).map(f => filterDSL(f, e.issues)), extra: { size: 0 } });
  addQuery(e, { title: 'Condition', pattern: '', dsl: body }, ctx.cfg);
  return [e];
}
function analyzeVisualization(o, ctx, opts) {
  const a = o.attributes; opts = opts || {};
  const vs = jsonAttr(a.visState) || {};
  const type = vs.type || a.type || '?';
  const title = opts.title || a.title || vs.title;
  const e = makeEntry('visualization', opts.key || o.id, title, { kind: VIS_TYPE_LABEL[type] || type, parent: opts.parent || null, byValue: !!opts.parent });
  const base = kbEnv(ctx, null, opts.defaultRange); base.issues = e.issues;
  const params = vs.params || {};
  const extra = { queries: opts.queries || [], filters: opts.filters || [] };
  if (type === 'markdown') return [e];
  if (type === 'vega') { e.issues.push({ kind: 'todo', label: 'visualisation Vega', detail: 'Une spécification Vega embarque ses propres requêtes Elasticsearch : le graphique se recrée dans l’outil cible et ses requêtes se réécrivent en SQL.' }); return [e]; }
  if (type === 'timelion') { e.issues.push({ kind: 'todo', label: 'expression Timelion', detail: `L’expression se réécrit en SQL (une requête par série) : ${String(params.expression || '').slice(0, 300)}` }); return [e]; }
  if (type === 'input_control_vis') {
    e.kind = 'contrôles';
    const controls = (params.controls || []).map(c => ({ fieldName: c.fieldName, title: c.label, type: c.type === 'range' ? 'range' : 'list', size: c.options && c.options.size, ref: c.indexPatternRefName, dataViewId: c.indexPattern }));
    controlQueries(e, controls, o, base, ctx.views, ctx.cfg);
    return [e];
  }
  if (type === 'metrics') {
    e.kind = `TSVB ${params.type || 'timeseries'}`;
    for (const q of tsvbQueries(params, base, o, opts.prefix, ctx.views, extra)) addQuery(e, q, ctx.cfg);
    return [e];
  }
  // Visualisation agrégée : recherche de la visualisation, éventuellement héritée d’une recherche enregistrée
  let src = searchSourceOf(o, a, opts.prefix, ctx.views, e.issues);
  const queries = []; const filters = [];
  const ssRef = a.savedSearchRefName ? refOf(o, a.savedSearchRefName, opts.prefix) : a.savedSearchId ? { id: a.savedSearchId } : null;
  if (ssRef) {
    const ss = ctx.byKey.get(`search:${ssRef.id}`);
    if (!ss) e.issues.push({ kind: 'review', label: 'recherche enregistrée absente de l’export', detail: `La visualisation part de la recherche ${ssRef.id}, absente du fichier : sa requête et ses filtres manquent. Exportez les objets avec leurs objets liés.` });
    else {
      const sa = Array.isArray(ss.attributes.tabs) && ss.attributes.tabs.length ? ss.attributes.tabs[0].attributes : ss.attributes;
      const s2 = searchSourceOf(ss, sa, null, ctx.views, e.issues);
      if (!src.view) src = Object.assign({}, src, { view: s2.view });
      queries.push(s2.query); filters.push(...s2.filters);
      e.kind += ', depuis une recherche';
    }
  }
  const env = envFor(base, src.view);
  const qs = queries.map(q => queryDSL(q, env, e.issues)).concat([queryDSL(src.query, env, e.issues)], extra.queries);
  const fs = filters.concat(src.filters).map(f => filterDSL(f, e.issues)).concat(extra.filters);
  const aggs = visAggsDSL(vs.aggs || [], env);
  if (/^(region_map|tile_map|enhanced_tilemap)$/.test(type)) e.issues.push({ kind: 'review', label: `carte ${VIS_TYPE_LABEL[type] || type}`, detail: 'La carte se recrée dans l’outil cible (Geomap de Grafana) à partir des coordonnées ou des codes de région renvoyés.' });
  addQuery(e, { title: 'Requête', pattern: env.pattern, dsl: searchBody(env, { queries: qs, filters: fs, extra: Object.assign({ size: 0 }, aggs ? { aggs } : {}) }) }, ctx.cfg);
  return [e];
}
function analyzeLens(o, ctx, opts) {
  const a = o.attributes; opts = opts || {};
  const e = makeEntry('lens', opts.key || o.id, opts.title || a.title, { kind: LENS_KIND[a.visualizationType] || a.visualizationType || 'Lens', parent: opts.parent || null, byValue: !!opts.parent });
  const base = kbEnv(ctx, null, opts.defaultRange); base.issues = e.issues;
  if (a.visualizationType === 'lnsChoropleth') e.issues.push({ kind: 'review', label: 'carte choroplèthe', detail: 'La carte se recrée dans l’outil cible (Geomap de Grafana) à partir des codes de région renvoyés.' });
  const st = a.state || {};
  const viz = st.visualization || {};
  if (Array.isArray(viz.layers) && viz.layers.some(l => l && l.layerType === 'annotations')) e.issues.push({ kind: 'review', label: 'annotations Lens', detail: 'Les annotations se recréent avec les annotations de Grafana.' });
  if (Array.isArray(viz.layers) && viz.layers.some(l => l && l.layerType === 'referenceLine')) e.issues.push({ kind: 'review', label: 'lignes de référence', detail: 'Les lignes de référence se recréent en seuils du panneau.' });
  for (const q of lensLayers(a, o, opts.prefix, ctx.views, base, { queries: opts.queries || [], filters: opts.filters || [] })) addQuery(e, q, ctx.cfg);
  return [e];
}
function analyzeRule(o, ctx) {
  const a = o.attributes;
  const type = a.alertTypeId || a.rule_type_id || a.ruleTypeId || '?';
  const e = makeEntry('alert', o.id, a.name || a.title, { kind: type });
  const base = kbEnv(ctx, null); base.issues = e.issues;
  if (a.enabled === false) e.kind += ', désactivée';
  const rule = ruleQuery(a, base, ctx.views, o);
  if (rule) addQuery(e, { title: 'Condition', pattern: rule.pattern, dsl: rule.body }, ctx.cfg, sql => ruleDecision(sql, rule));
  const iv = a.schedule && a.schedule.interval;
  const actions = a.actions || [];
  if (actions.length) {
    const kinds = [...new Set(actions.map(x => x.actionTypeId || x.action_type_id || '?'))];
    e.issues.push({ kind: 'info', label: `${actions.length} action${actions.length > 1 ? 's' : ''} à recréer`, detail: `Notifications (${kinds.join(', ')}) à recréer dans l’outil d’alerte cible${iv ? `, avec la planification « toutes les ${iv} »` : ''}.`, hours: KB_EFFORT.action * actions.length });
  } else if (iv) e.issues.push({ kind: 'info', label: 'planification', detail: `La règle s’évalue toutes les ${iv} : à reproduire dans l’outil cible.` });
  return [e];
}
function analyzeSecurityRule(o, ctx) {
  const a = o.attributes;
  const e = makeEntry('security-rule', o.id, a.name, { kind: a.type || 'query' });
  const base = kbEnv(ctx, null); base.issues = e.issues;
  if (a.enabled === false) e.kind += ', désactivée';
  const t = a.type || 'query';
  if (t === 'query' || t === 'saved_query' || t === 'threshold') {
    e.issues.push({ kind: t === 'threshold' ? 'review' : 'review', label: 'logique de détection à recréer', detail: `Planification (${a.interval || '5m'}), gravité, suppression des doublons et création des signaux se recréent dans l’outil cible ; la requête est traduite.` });
    if (t === 'saved_query' && !a.query) e.issues.push({ kind: 'todo', label: 'requête enregistrée de la règle', detail: `La règle lit la requête enregistrée ${a.saved_id || '?'} : exportez-la.` });
    const rule = securityQuery(a, base);
    if (rule) addQuery(e, { title: 'Détection', pattern: rule.pattern, dsl: rule.body }, ctx.cfg, sql => ruleDecision(sql, rule));
    if (t === 'threshold' && isObj(a.threshold) && [].concat(a.threshold.field || []).length > 1) e.issues.push({ kind: 'review', label: 'seuil sur plusieurs champs', detail: 'La traduction groupe par le premier champ.' });
    if (isObj(a.threshold) && Array.isArray(a.threshold.cardinality) && a.threshold.cardinality.length) e.issues.push({ kind: 'todo', label: 'seuil de cardinalité', detail: 'Le seuil porte sur un nombre de valeurs distinctes : HAVING uniqExact(…) à écrire.' });
  } else e.issues.push({ kind: 'todo', label: `règle de détection ${t}`, detail: `${{ eql: 'Une séquence EQL', esql: 'Une requête ES|QL', machine_learning: 'Une détection par apprentissage automatique', threat_match: 'Une correspondance avec des indicateurs de menace', new_terms: 'Une détection de nouvelles valeurs' }[t] || 'Ce type de règle'} se réécrit dans l’outil cible.${a.query ? ` Requête : ${String(a.query).slice(0, 300)}` : ''}` });
  return [e];
}
function analyzeDashboard(o, ctx) {
  const a = o.attributes; const views = ctx.views;
  const panels = [].concat(jsonAttr(a.panelsJSON) || a.panels || []).filter(isObj);
  const e = makeEntry('dashboard', o.id, a.title, { kind: `${panels.length} panneau${panels.length > 1 ? 'x' : ''}` });
  const range = a.timeRestore ? rangeSeconds(a.timeFrom, a.timeTo) : 900;
  if (a.timeRestore) e.kind += `, période ${a.timeFrom || '?'} → ${a.timeTo || 'now'}`;
  // Requête et filtres du tableau de bord : appliqués à chaque panneau
  const src = searchSourceOf(o, a, null, ctx.views, e.issues);
  const base = kbEnv(ctx, null, range); base.issues = e.issues;
  const dq = queryDSL(src.query, base, e.issues);
  const df = src.filters.map(f => filterDSL(f, e.issues)).filter(Boolean);
  const out = [e];
  let byRef = 0;
  panels.forEach((p, i) => {
    const cfgP = p.embeddableConfig || p.panelConfig || p.config || {};
    const prefix = p.panelIndex || (p.gridData && p.gridData.i) || String(i);
    // Référence : panelRefName (7.x et 8.x), « <panneau>:savedObjectRef » (versions récentes), id et type écrits dans le panneau (6.x)
    const ref = p.panelRefName ? refOf(o, p.panelRefName, prefix) : (o.references || []).find(r => r.name === `${prefix}:savedObjectRef`) || (p.id && p.type ? { id: p.id, type: p.type } : null);
    const type = p.type || (ref && ref.type);
    const ptitle = cfgP.title || p.title;
    if (ref) {
      byRef++;
      const child = ctx.byKey.get(`${ref.type || type}:${ref.id}`);
      if (child) { e.children.push(`${child.type}:${child.id}`); ctx.usedBy(child, e, range); }
      else e.issues.push({ kind: 'review', label: 'panneau absent de l’export', detail: `Le panneau${ptitle ? ` « ${ptitle} »` : ''} (${ref.type || type} ${ref.id}) n’est pas dans le fichier : son effort n’est pas compté. Exportez les objets avec leurs objets liés.` });
      return;
    }
    // Panneau par valeur : il vit dans le tableau de bord, qui lui transmet sa requête et ses filtres
    const key = `${o.id}/${prefix}`;
    const opts = { key, parent: e.key, prefix, defaultRange: range, queries: dq ? [dq] : [], filters: df };
    const synth = (t, attrs, refs) => ({ type: t, id: key, attributes: attrs, references: (refs && refs.length ? refs : []).concat(o.references || []) });
    let entries = null;
    if (type === 'visualization' && isObj(cfgP.savedVis)) {
      const sv = cfgP.savedVis; const data = sv.data || {};
      const attrs = { title: sv.title, visState: { type: sv.type, params: sv.params || {}, aggs: data.aggs || [] }, kibanaSavedObjectMeta: { searchSourceJSON: data.searchSource || {} }, savedSearchRefName: data.savedSearchRefName || sv.savedSearchRefName };
      entries = analyzeVisualization(synth('visualization', attrs), ctx, Object.assign(opts, { title: ptitle || sv.title || `Panneau ${i + 1}` }));
    } else if (type === 'lens' && isObj(cfgP.attributes)) entries = analyzeLens(synth('lens', cfgP.attributes, cfgP.attributes.references), ctx, Object.assign(opts, { title: ptitle || cfgP.attributes.title || `Panneau ${i + 1}` }));
    else if (type === 'search' && isObj(cfgP.attributes)) entries = analyzeSearch(synth('search', cfgP.attributes, cfgP.attributes.references), ctx, Object.assign(opts, { title: ptitle || cfgP.attributes.title || `Panneau ${i + 1}` }));
    else if (type === 'map') { const m = makeEntry('map', key, ptitle || (cfgP.attributes && cfgP.attributes.title) || `Panneau ${i + 1}`, { kind: 'Maps', parent: e.key, byValue: true }); m.issues.push(mapIssue()); entries = [m]; }
    else if (type === 'links' || type === 'image' || type === 'DASHBOARD_MARKDOWN' || type === 'markdown') { e.issues.push({ kind: 'review', label: `panneau ${type}`, detail: 'Contenu statique (texte, image, liens) à recréer.', hours: 0.1 }); return; }
    else { const m = makeEntry('other', key, ptitle || `Panneau ${i + 1}`, { kind: type || 'panneau', parent: e.key, byValue: true }); m.verdict = 'unrecognized'; m.issues.push({ kind: 'todo', label: `panneau ${type || 'inconnu'}`, detail: 'Type de panneau sans traduction automatique : à recréer.' }); entries = [m]; }
    for (const x of entries) { out.push(x); e.children.push(x.key); }
  });
  if ((dq || df.length) && byRef) {
    e.issues.push({ kind: 'review', label: 'filtre commun du tableau de bord', detail: 'Le tableau de bord ajoute sa requête et ses filtres à chaque panneau. Ils sont inclus dans le SQL des panneaux par valeur ; pour les panneaux par référence, ajoutez la condition ci-dessous à leur requête (ou recréez-la en variable).' });
    // Vue de données du filtre : celle d’une pastille (meta.index), sinon celle du premier panneau qui en cite une
    const filterView = src.filters.map(f => f && f.meta && (f.meta.indexRefName ? (refOf(o, f.meta.indexRefName) || {}).id : f.meta.index)).find(id => id && views.has(id));
    const childView = e.children.map(k => ctx.byKey.get(k)).filter(Boolean).map(c => (c.references || []).find(r => r.type === 'index-pattern' && views.has(r.id))).find(Boolean);
    const env = envFor(base, src.view || views.get(filterView || (childView && childView.id)) || null);
    addQuery(e, { title: 'Filtre commun', pattern: env.pattern, dsl: searchBody(Object.assign({}, env, { timeField: null }), { queries: [dq], filters: df, extra: { size: 0 } }) }, ctx.cfg);
  }
  // Contrôles (8.x et suivantes) : listes d’options et curseurs
  const cg = a.controlGroupInput || null;
  const cpanels = cg ? jsonAttr(cg.panelsJSON) || cg.panels || {} : {};
  const controls = Object.entries(isObj(cpanels) ? cpanels : {}).map(([id, c]) => {
    const x = Object.assign({}, c.explicitInput || {}, c.config || {}, c);
    const kindRef = { optionsListControl: 'optionsListDataView', rangeSliderControl: 'rangeSliderDataView' }[c.type];
    const refName = kindRef ? [`controlGroup_${id}:${kindRef}`, `${id}:${kindRef}`].find(n => (o.references || []).some(r => r.name === n)) : null;
    return { type: c.type, fieldName: x.fieldName, title: x.title, selectedOptions: x.selectedOptions, value: x.value, dataViewId: x.dataViewId, ref: refName || null };
  });
  if (controls.length) { controlQueries(e, controls, o, base, ctx.views, ctx.cfg); e.controls = controls.length; }
  e.panels = panels.length;
  return out;
}
const mapIssue = () => ({ kind: 'todo', label: 'carte (Maps)', detail: 'Une carte de l’application Maps (couches, documents, grilles, jointures) se recrée dans l’outil cible (Geomap de Grafana) ; ses requêtes se réécrivent en SQL.' });

/* ---------- Inventaire du parc ---------- */
function kibanaInventory(text, cfg, opts) {
  opts = opts || {};
  // Un ou plusieurs exports (un par espace, par exemple) : les objets s’ajoutent, un objet présent deux fois compte une fois
  const texts = Array.isArray(text) ? text : [text];
  const names = opts.names || texts.map((t, i) => `fichier ${i + 1}`);
  const parts = texts.map(kibanaObjects);
  const seen = new Set();
  const read = {
    objects: parts.flatMap(p => p.objects).filter(o => { const k = `${o.type}:${o.id}`; if (seen.has(k)) return false; seen.add(k); return true; }),
    errors: parts.flatMap((p, i) => p.errors.map(e => (texts.length > 1 ? `${names[i]}, ${e}` : e))),
    summary: parts.some(p => p.summary) ? { exportedCount: parts.reduce((n, p) => n + ((p.summary && p.summary.exportedCount) || 0), 0), missingRefCount: parts.reduce((n, p) => n + ((p.summary && p.summary.missingRefCount) || 0), 0) } : null
  };
  // Règles de détection exportées depuis Security : lignes sans attributs, rangées comme des objets
  const objects = read.objects;
  const views = dataViewsOf(objects);
  // Vue de données par défaut de l’espace (paramètre defaultIndex), ou la seule vue de l’export
  const conf = objects.find(o => o.type === 'config' && o.attributes.defaultIndex && views.has(o.attributes.defaultIndex));
  views.defaultId = conf ? conf.attributes.defaultIndex : views.size === 1 ? [...views.keys()][0] : null;
  views.defaultFromConfig = !!conf;
  // Fuseau de Kibana : option, sinon paramètre dateFormat:tz exporté (Browser : celui du navigateur, inconnu ici)
  const tzConf = objects.find(o => o.type === 'config' && o.attributes['dateFormat:tz'] && o.attributes['dateFormat:tz'] !== 'Browser');
  const tz = opts.timeZone || (tzConf ? tzConf.attributes['dateFormat:tz'] : null);
  const byKey = new Map(objects.map(o => [`${o.type}:${o.id}`, o]));
  const ignored = {};
  const entries = [];
  const parentRange = new Map();
  const ctx = {
    cfg, views, byKey, tz,
    usedBy: (child, dash, range) => { const k = `${child.type}:${child.id}`; if (!parentRange.has(k)) parentRange.set(k, { range, dashboards: [] }); parentRange.get(k).dashboards.push(dash.key); }
  };
  // Les tableaux de bord d’abord : ils donnent la période par défaut des panneaux qu’ils citent
  const sorted = objects.slice().sort((x, y) => (x.type === 'dashboard' ? 0 : 1) - (y.type === 'dashboard' ? 0 : 1));
  for (const o of sorted) {
    const t = o.type;
    const pr = parentRange.get(`${t}:${o.id}`);
    const opt = pr ? { defaultRange: pr.range } : {};
    let list;
    try {
      if (t === 'index-pattern' || t === 'index_pattern') list = analyzeDataView(o, ctx);
      else if (t === 'search') list = analyzeSearch(o, ctx, opt);
      else if (t === 'query') list = analyzeSavedQuery(o, ctx);
      else if (t === 'visualization') list = analyzeVisualization(o, ctx, opt);
      else if (t === 'lens') list = analyzeLens(o, ctx, opt);
      else if (t === 'dashboard') list = analyzeDashboard(o, ctx);
      else if (t === 'alert' || t === 'rule') list = analyzeRule(o, ctx);
      else if (t === 'security-rule') list = analyzeSecurityRule(o, ctx);
      else if (t === 'map') { const m = makeEntry('map', o.id, o.attributes.title, { kind: 'Maps' }); m.issues.push(mapIssue()); list = [m]; }
      else if (t === 'canvas-workpad') { const m = makeEntry('canvas-workpad', o.id, o.attributes.name || o.attributes.title, { kind: `${(o.attributes.pages || []).length} page(s)` }); m.issues.push({ kind: 'todo', label: 'classeur Canvas', detail: 'Les éléments Canvas (expressions, requêtes essql et esdocs) se recréent dans l’outil cible.' }); list = [m]; }
      else if (t === 'graph-workspace') { const m = makeEntry('graph-workspace', o.id, o.attributes.title, { kind: 'Graph' }); m.issues.push({ kind: 'todo', label: 'espace Graph', detail: 'L’exploration de relations (significant_terms en cascade) n’a pas d’équivalent direct.' }); list = [m]; }
      else if (t === 'links') { list = [makeEntry('links', o.id, o.attributes.title, { kind: `${(o.attributes.links || []).length} lien(s)` })]; }
      else if (t === 'action') { const m = makeEntry('action', o.id, o.attributes.name, { kind: o.attributes.actionTypeId || '' }); m.issues.push({ kind: 'info', label: 'connecteur à recréer', detail: `Le connecteur ${o.attributes.actionTypeId || ''} (destination des notifications) se recrée dans l’outil d’alerte cible ; ses secrets ne sont pas exportés.`, hours: 0 }); list = [m]; }
      else if (KB_IGNORED.has(t)) { ignored[t] = (ignored[t] || 0) + 1; continue; }
      else { const m = makeEntry('other', o.id, o.attributes.title || o.attributes.name, { kind: t }); m.verdict = 'unrecognized'; m.issues.push({ kind: 'todo', label: `type d’objet ${t}`, detail: 'Type d’objet que Passerelle ne lit pas : à examiner.' }); list = [m]; }
    } catch (err) {
      const m = makeEntry(KB_TYPES[t] ? t : 'other', o.id, o.attributes.title || o.attributes.name, { kind: t });
      m.verdict = 'unrecognized'; m.issues.push({ kind: 'todo', label: 'objet illisible', detail: `L’objet n’a pas pu être analysé : ${err.message}` });
      list = [m];
    }
    entries.push(...list);
  }
  const byEntry = new Map(entries.map(x => [x.key, x]));
  for (const [k, v] of parentRange) { const x = byEntry.get(k); if (x) x.usedBy = v.dashboards.slice(); }
  // Verdict et effort de chaque objet
  for (const x of entries) scoreEntry(x);
  // Un tableau de bord vaut son plus mauvais panneau ; son effort propre reste l’assemblage
  for (const x of entries.filter(y => y.type === 'dashboard')) {
    const kids = x.children.map(k => byEntry.get(k)).filter(Boolean);
    x.verdict = worstVerdict([x.verdict].concat(kids.map(k => k.verdict)));
    x.effortTotal = quarter(x.effort + kids.reduce((n, k) => n + k.effort, 0));
  }
  entries.sort((p, q) => (KB_ORDER.indexOf(p.type) - KB_ORDER.indexOf(q.type)) || (p.parent ? 1 : 0) - (q.parent ? 1 : 0) || p.title.localeCompare(q.title, 'fr'));
  return summarize(read, entries, ignored, cfg, opts);
}
function scoreEntry(x) {
  const seen = new Set();
  x.issues = x.issues.filter(i => { const k = `${i.kind}|${i.label}|${i.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const lines = [];
  const typeLabel = (KB_TYPES[x.type] || 'objet').toLowerCase();
  const baseH = KB_EFFORT.base[x.type] || 0.5;
  lines.push({ label: x.type === 'index-pattern' ? 'Déclarer la table et vérifier les champs' : `Recréer ${x.type === 'dashboard' ? 'le tableau de bord' : `l’objet (${typeLabel})`}`, hours: baseH });
  if (x.type === 'dashboard' && x.panels) lines.push({ label: `Disposer ${x.panels} panneau${x.panels > 1 ? 'x' : ''}`, hours: KB_EFFORT.panel * x.panels });
  for (const q of x.queries) {
    if (KB_EFFORT.query[q.verdict]) lines.push({ label: `Vérifier « ${q.title} » (${VERDICTS[q.verdict]})`, hours: KB_EFFORT.query[q.verdict] });
    let warn = 0;
    for (const n of q.notes) {
      if (KB_PREREQ.test(n.title)) continue;
      if (n.level === 'err') lines.push({ label: n.title, hours: todoHours(n.title) });
      else if (n.level === 'warn') warn += KB_EFFORT.warn;
    }
    if (warn) lines.push({ label: `Points à vérifier de « ${q.title} »`, hours: Math.min(warn, KB_EFFORT.warnCap) });
  }
  for (const i of x.issues) if (i.kind !== 'info' || i.hours) lines.push({ label: i.label, hours: i.hours !== undefined ? i.hours : i.kind === 'todo' ? todoHours(i.label) : KB_EFFORT.review });
  x.effortDetail = lines.filter(l => l.hours > 0);
  x.effort = quarter(x.effortDetail.reduce((n, l) => n + l.hours, 0));
  const verdicts = x.queries.map(q => (q.verdict === 'unrecognized' ? 'todo' : q.verdict)).concat(x.issues.filter(i => i.kind !== 'info').map(i => (i.kind === 'todo' ? 'todo' : 'review')));
  x.verdict = x.verdict === 'unrecognized' ? 'unrecognized' : worstVerdict(verdicts);
}
const blockerLabel = s => String(s).replace(/«[^»]*»/g, '«…»').replace(/\s+/g, ' ').trim();
function summarize(read, entries, ignored, cfg, opts) {
  const byVerdict = { ready: 0, review: 0, todo: 0, unrecognized: 0 };
  const byType = {};
  for (const x of entries) {
    byVerdict[x.verdict]++;
    const t = byType[x.type] || (byType[x.type] = { label: KB_TYPES[x.type], total: 0, ready: 0, review: 0, todo: 0, unrecognized: 0, effort: 0 });
    t.total++; t[x.verdict]++; t.effort += x.effort;
  }
  for (const t of Object.values(byType)) t.effort = quarter(t.effort);
  const hours = quarter(entries.reduce((n, x) => n + x.effort, 0));
  // Obstacles : ce qui ne se traduit pas, regroupé par nature, du plus coûteux au moins coûteux
  const blockers = new Map();
  const bump = (label, kind, key, h) => {
    const k = `${kind}|${blockerLabel(label)}`;
    if (!blockers.has(k)) blockers.set(k, { label: blockerLabel(label), kind, objects: new Set(), hours: 0 });
    const b = blockers.get(k); b.objects.add(key); b.hours += h;
  };
  const prereq = new Map();
  for (const x of entries) {
    for (const i of x.issues) if (i.kind === 'todo') bump(i.label, 'todo', x.key, todoHours(i.label));
    for (const q of x.queries) for (const n of q.notes) {
      if (KB_PREREQ.test(n.title)) { if (!KB_PREREQ_SHOWN.test(n.title)) continue; const k = n.title.replace(/ «.*$/, ''); if (!prereq.has(k)) prereq.set(k, { label: k, detail: n.detail, objects: new Set() }); prereq.get(k).objects.add(x.key); }
      else if (n.level === 'err') bump(n.title, 'todo', x.key, todoHours(n.title));
    }
  }
  // Tables à déclarer : motifs d’index sans correspondance dans clickhouse.index_mapping
  const guessed = new Map();
  for (const x of entries) for (const q of x.queries) if (q.pattern && !q.matched && q.table) guessed.set(q.pattern, q.table);
  const missing = entries.filter(x => x.issues.some(i => /absente? de l’export/.test(i.label))).length;
  // Champs cités, par vue de données : les candidats de la clé de tri et des index
  const fieldsByView = new Map();
  for (const x of entries) {
    const v = x.views[0] || '(table par défaut)';
    if (!fieldsByView.has(v)) fieldsByView.set(v, new Map());
    const m = fieldsByView.get(v);
    for (const f of x.fields) m.set(f, (m.get(f) || 0) + 1);
  }
  const dataViews = [...fieldsByView.entries()].map(([title, m]) => {
    const view = [...entries].find(x => x.type === 'index-pattern' && x.title === title);
    const q = entries.flatMap(x => x.queries).find(y => y.pattern === title);
    return { title, table: (view && view.tables[0]) || (q && q.table) || null, matched: !guessed.has(title), objects: entries.filter(x => x.views[0] === title && x.type !== 'index-pattern').length, fields: [...m.entries()].sort((p, q2) => q2[1] - p[1] || p[0].localeCompare(q2[0])).map(([field, uses]) => ({ field, uses })) };
  }).filter(d => d.objects || d.fields.length);
  const out = {
    source: { objects: read.objects.length, exported: read.summary ? read.summary.exportedCount : null, missingRefs: read.summary && read.summary.missingRefCount ? read.summary.missingRefCount : 0, errors: read.errors, ignored },
    summary: { objects: entries.length, byVerdict, byType, effort: { hours, days: Math.round((hours / KB_EFFORT.hoursPerDay) * 10) / 10 }, queries: entries.reduce((n, x) => n + x.queries.length, 0) },
    prerequisites: [...prereq.values()].map(p => ({ label: p.label, detail: p.detail, objects: p.objects.size })).concat(guessed.size ? [{ label: 'Tables à déclarer', detail: `${[...guessed.keys()].join(', ')} : aucune correspondance dans clickhouse.index_mapping, la table est devinée. Déclarez-les dans la configuration (passerelle schema ddl génère tables et profils depuis les mappings).`, objects: guessed.size }] : []).concat(missing ? [{ label: 'Objets liés absents', detail: 'Des objets citent une vue de données, une recherche ou un panneau absents du fichier : réexportez avec « Inclure les objets liés ».', objects: missing }] : []),
    blockers: [...blockers.values()].map(b => ({ label: b.label, kind: b.kind, objects: b.objects.size, hours: quarter(b.hours) })).sort((p, q) => q.hours - p.hours || q.objects - p.objects).slice(0, 20),
    dataViews,
    entries: entries.map(x => Object.assign({}, x, { fields: [...x.fields].sort() })),
    effortScale: { hoursPerDay: KB_EFFORT.hoursPerDay, base: KB_EFFORT.base, query: KB_EFFORT.query, review: KB_EFFORT.review, panel: KB_EFFORT.panel, todo: KB_EFFORT.todo.map(([re, h, label]) => ({ label, match: re.source, hours: h })), todoDefault: KB_EFFORT.todoDefault }
  };
  return out;
}

/* ---------- Rapports ---------- */
const frNum = n => (Math.round(n * 100) / 100).toString().replace('.', ',');
const frHours = h => `${frNum(h)} h`;
const kbVerdict = v => VERDICTS[v] || v;
function kbFlat(s) { return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim(); }
function inventoryMarkdown(inv) {
  const L = [];
  const s = inv.summary;
  const cell = v => kbFlat(v).replace(/\|/g, '\\|');
  L.push('# Inventaire de migration Kibana vers ClickHouse', '');
  L.push(`${s.objects} objet${s.objects > 1 ? 's' : ''} à migrer, ${s.queries} requête${s.queries > 1 ? 's' : ''} traduite${s.queries > 1 ? 's' : ''}. Effort estimé : **${frHours(s.effort.hours)}**, soit **${frNum(s.effort.days)} jour${s.effort.days > 1 ? 's' : ''}** à ${inv.effortScale.hoursPerDay} h.`, '');
  const ign = Object.entries(inv.source.ignored);
  if (ign.length) L.push(`Non comptés (sans requête à migrer) : ${ign.map(([t, n]) => `${n} ${t}`).join(', ')}.`, '');
  if (inv.source.errors.length) L.push(`Lignes illisibles : ${inv.source.errors.length} (${inv.source.errors.slice(0, 3).join(' ; ')}${inv.source.errors.length > 3 ? ' ; …' : ''}).`, '');
  L.push('## Synthèse', '', '| Type | Objets | Prêts | À vérifier | À reprendre | Non reconnus | Effort |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const t of KB_ORDER) { const x = s.byType[t]; if (x) L.push(`| ${x.label} | ${x.total} | ${x.ready} | ${x.review} | ${x.todo} | ${x.unrecognized} | ${frHours(x.effort)} |`); }
  L.push(`| **Total** | **${s.objects}** | **${s.byVerdict.ready}** | **${s.byVerdict.review}** | **${s.byVerdict.todo}** | **${s.byVerdict.unrecognized}** | **${frHours(s.effort.hours)}** |`, '');
  L.push('*Prête* : traduction directe. *À vérifier* : traduite, avec un écart de comportement à confirmer. *À reprendre* : une partie ne se traduit pas et s’écrit à la main. *Non reconnue* : objet que Passerelle ne lit pas.', '');
  if (inv.prerequisites.length) {
    L.push('## Prérequis', '');
    for (const p of inv.prerequisites) L.push(`- **${p.label}** (${p.objects} objet${p.objects > 1 ? 's' : ''}) : ${kbFlat(p.detail)}`);
    L.push('');
  }
  if (inv.blockers.length) {
    L.push('## Principaux points à reprendre', '', '| Point | Objets | Effort |', '|---|---:|---:|');
    for (const b of inv.blockers) L.push(`| ${cell(b.label)} | ${b.objects} | ${frHours(b.hours)} |`);
    L.push('');
  }
  const dashes = inv.entries.filter(x => x.type === 'dashboard');
  if (dashes.length) {
    L.push('## Tableaux de bord', '', '| Tableau de bord | Panneaux | Verdict | Effort, panneaux compris |', '|---|---:|---|---:|');
    for (const d of dashes) L.push(`| ${cell(d.title)} | ${d.panels || 0} | ${kbVerdict(d.verdict)} | ${frHours(d.effortTotal || d.effort)} |`);
    L.push('', 'L’effort d’un tableau de bord compte ses panneaux ; un objet partagé par plusieurs tableaux de bord est compté dans chacun ici, une seule fois dans le total.', '');
  }
  L.push('## Objets', '', '| Type | Objet | Nature | Verdict | Effort |', '|---|---|---|---|---:|');
  const byKey = new Map(inv.entries.map(x => [x.key, x]));
  for (const x of inv.entries) L.push(`| ${KB_TYPES[x.type]} | ${cell(x.parent ? `${byKey.get(x.parent) ? byKey.get(x.parent).title : '?'} › ${x.title}` : x.title)} | ${cell(x.kind)} | ${kbVerdict(x.verdict)} | ${frHours(x.effort)} |`);
  L.push('');
  if (inv.dataViews.length) {
    L.push('## Champs cités, par vue de données', '');
    for (const d of inv.dataViews) {
      L.push(`- **${d.title}** → ${d.table || '?'}${d.matched ? '' : ' (table devinée)'} : ${d.objects} objet${d.objects > 1 ? 's' : ''}. ${d.fields.slice(0, 15).map(f => `${f.field} (${f.uses})`).join(', ')}${d.fields.length > 15 ? `, et ${d.fields.length - 15} autres` : ''}.`);
    }
    L.push('');
  }
  L.push('## Détail par objet', '');
  for (const x of inv.entries) {
    L.push(`### ${KB_TYPES[x.type]} : ${kbFlat(x.parent ? `${byKey.get(x.parent) ? byKey.get(x.parent).title : '?'} › ${x.title}` : x.title)}`, '');
    L.push(`${kbVerdict(x.verdict).replace(/^./, c => c.toUpperCase())}, ${frHours(x.effort)}. ${kbFlat(x.kind)}. Identifiant : \`${x.id}\`.${x.views.length ? ` Vue de données : ${x.views.join(', ')}.` : ''}${x.tables.length ? ` Table : ${x.tables.join(', ')}.` : ''}${x.usedBy.length ? ` Utilisé par ${x.usedBy.length} tableau${x.usedBy.length > 1 ? 'x' : ''} de bord.` : ''}`, '');
    for (const [kind, head] of [['todo', 'À reprendre'], ['review', 'À vérifier'], ['info', 'À noter']]) {
      const list = x.issues.filter(i => i.kind === kind);
      if (list.length) { L.push(`${head} :`); for (const i of list) L.push(`- **${kbFlat(i.label)}** : ${kbFlat(i.detail)}`); L.push(''); }
    }
    for (const q of x.queries) {
      L.push(`**${kbFlat(q.title)}** — ${kbVerdict(q.verdict)}${q.coverage ? `, couverture ${q.coverage.percent} %` : ''}. ${kbFlat(q.sentence)}`, '');
      const notes = q.notes.filter(n => n.level === 'err' || n.level === 'warn');
      for (const n of notes) L.push(`- ${n.level === 'err' ? 'À reprendre' : 'À vérifier'} : **${kbFlat(n.title)}** — ${kbFlat(n.detail)}`);
      if (notes.length) L.push('');
      if (q.sql) L.push('```sql', q.sql, '```', '');
      else if (q.error) L.push(`> ${kbFlat(q.error)}`, '');
    }
    if (x.effortDetail.length > 1) L.push(`<details><summary>Calcul de l’effort</summary>\n\n${x.effortDetail.map(l => `- ${kbFlat(l.label)} : ${frHours(l.hours)}`).join('\n')}\n\n</details>`, '');
  }
  L.push('## Barème de l’effort', '');
  L.push(`Recréer un objet : ${Object.entries(inv.effortScale.base).filter(([t]) => KB_TYPES[t]).map(([t, h]) => `${KB_TYPES[t].toLowerCase()} ${frHours(h)}`).join(', ')} ; ${frHours(inv.effortScale.panel)} par panneau de tableau de bord. Vérifier une requête : ${frHours(inv.effortScale.query.review)} si elle est à vérifier, ${frHours(inv.effortScale.query.todo)} si elle est à reprendre, plus ${frHours(inv.effortScale.review)} par point à vérifier. Point à reprendre : ${inv.effortScale.todo.map(t => `${t.label} ${frHours(t.hours)}`).join(' ; ')} ; ${frHours(inv.effortScale.todoDefault)} pour une clause ou un paramètre. Total arrondi au quart d’heure supérieur par objet ; un jour vaut ${inv.effortScale.hoursPerDay} h.`, '');
  return L.join('\n');
}
function inventoryCSV(inv) {
  const q = v => { const s = kbFlat(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const byKey = new Map(inv.entries.map(x => [x.key, x]));
  const rows = [['Type', 'Identifiant', 'Titre', 'Tableau de bord', 'Nature', 'Vue de données', 'Table', 'Verdict', 'Effort (h)', 'Requêtes', 'Points à reprendre', 'Points à vérifier']];
  for (const x of inv.entries) {
    const notesOf = lvl => [...new Set(x.queries.flatMap(r => r.notes.filter(n => n.level === lvl).map(n => n.title)))];
    rows.push([KB_TYPES[x.type], x.id, x.title, x.parent ? (byKey.get(x.parent) || {}).title || '' : '', x.kind, x.views.join(', '), x.tables.join(', '), kbVerdict(x.verdict), frNum(x.effort), x.queries.length, x.issues.filter(i => i.kind === 'todo').map(i => i.label).concat(notesOf('err')).join(' ; '), x.issues.filter(i => i.kind === 'review').map(i => i.label).concat(notesOf('warn')).join(' ; ')]);
  }
  // Point-virgule et BOM : le fichier s’ouvre tel quel dans un tableur réglé en français
  return '\uFEFF' + rows.map(r => r.map(q).join(';')).join('\r\n') + '\r\n';
}
// Feuille de style des rapports HTML (inventaire Kibana, watches) : thème clair et sombre
const KB_CSS = `:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--ready:#2f7d4f;--review:#b7791f;--todo:#c0392b;--unrec:#7a7a7a;--code:#f3f2ee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--card:#1f1f1d;--ready:#5fbf86;--review:#e0a84a;--todo:#ec7063;--unrec:#a0a0a0;--code:#262624}}
:root[data-theme="dark"]{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--card:#1f1f1d;--ready:#5fbf86;--review:#e0a84a;--todo:#ec7063;--unrec:#a0a0a0;--code:#262624}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 10px}h3{font-size:16px;margin:0 0 4px}
.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.tile b{display:block;font-size:24px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:8px 0 18px;background:var(--line)}.seg.v-ready{background:var(--ready)}.seg.v-review{background:var(--review)}.seg.v-todo{background:var(--todo)}.seg.v-unrecognized{background:var(--unrec)}

.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse}tr:last-child td{border-bottom:0}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;font-size:13px;color:var(--muted)}td.n,th.n{text-align:right;white-space:nowrap}
a{color:inherit}.v{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.v-ready{color:var(--ready)}.v-review{color:var(--review)}.v-todo{color:var(--todo)}.v-unrecognized{color:var(--unrec)}
.obj{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.obj ul{margin:6px 0 10px;padding-left:20px}
ul.todo li::marker,li.err::marker{color:var(--todo)}ul.review li::marker,li.warn::marker{color:var(--review)}
.q{border-top:1px dashed var(--line);margin-top:10px;padding-top:10px}pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12.5px;line-height:1.45}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.filters button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:3px 12px;cursor:pointer}.filters button[aria-pressed="true"]{border-color:var(--fg)}
.eff summary{cursor:pointer;color:var(--muted);font-size:13px}p.err{color:var(--todo)}`;
const kbHtml = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inventoryHTML(inv, title) {
  const s = inv.summary; const h = kbHtml;
  const byKey = new Map(inv.entries.map(x => [x.key, x]));
  const name = x => (x.parent ? `${(byKey.get(x.parent) || {}).title || '?'} › ${x.title}` : x.title);
  const badge = v => `<span class="v v-${v}">${h(kbVerdict(v))}</span>`;
  const total = s.objects || 1;
  const bar = ['ready', 'review', 'todo', 'unrecognized'].filter(v => s.byVerdict[v]).map(v => `<span class="seg v-${v}" style="flex:${s.byVerdict[v]}" title="${h(kbVerdict(v))} : ${s.byVerdict[v]}"></span>`).join('');
  const typeRows = KB_ORDER.filter(t => s.byType[t]).map(t => { const x = s.byType[t]; return `<tr><td>${h(x.label)}</td><td class="n">${x.total}</td><td class="n">${x.ready}</td><td class="n">${x.review}</td><td class="n">${x.todo}</td><td class="n">${x.unrecognized}</td><td class="n">${h(frHours(x.effort))}</td></tr>`; }).join('');
  const objRows = inv.entries.map(x => `<tr data-v="${x.verdict}"><td>${h(KB_TYPES[x.type])}</td><td><a href="#o-${h(x.key.replace(/[^A-Za-z0-9_-]/g, '-'))}">${h(name(x))}</a></td><td>${h(x.kind)}</td><td>${badge(x.verdict)}</td><td class="n">${h(frHours(x.effort))}</td></tr>`).join('');
  const issueList = (list, cls) => (list.length ? `<ul class="${cls}">${list.map(i => `<li><b>${h(i.label)}</b> : ${h(i.detail)}</li>`).join('')}</ul>` : '');
  const details = inv.entries.map(x => {
    const qs = x.queries.map(q => {
      const notes = q.notes.filter(n => n.level === 'err' || n.level === 'warn');
      return `<div class="q"><div class="qh"><b>${h(q.title)}</b> ${badge(q.verdict)}${q.coverage ? ` <span class="muted">couverture ${q.coverage.percent} %</span>` : ''}</div>${q.sentence ? `<p class="muted">${h(q.sentence)}</p>` : ''}${notes.length ? `<ul>${notes.map(n => `<li class="${n.level}"><b>${h(n.title)}</b> : ${h(n.detail)}</li>`).join('')}</ul>` : ''}${q.sql ? `<pre><code>${h(q.sql)}</code></pre>` : q.error ? `<p class="err">${h(q.error)}</p>` : ''}</div>`;
    }).join('');
    const eff = x.effortDetail.length ? `<details class="eff"><summary>Effort : ${h(frHours(x.effort))}</summary><ul>${x.effortDetail.map(l => `<li>${h(l.label)} : ${h(frHours(l.hours))}</li>`).join('')}</ul></details>` : '';
    return `<section class="obj" id="o-${h(x.key.replace(/[^A-Za-z0-9_-]/g, '-'))}"><h3>${h(KB_TYPES[x.type])} · ${h(name(x))} ${badge(x.verdict)}</h3><p class="muted">${h(x.kind)} — <code>${h(x.id)}</code>${x.views.length ? ` — vue de données ${h(x.views.join(', '))}` : ''}${x.tables.length ? ` → ${h(x.tables.join(', '))}` : ''}</p>${issueList(x.issues.filter(i => i.kind === 'todo'), 'todo')}${issueList(x.issues.filter(i => i.kind === 'review'), 'review')}${issueList(x.issues.filter(i => i.kind === 'info'), 'info')}${qs}${eff}</section>`;
  }).join('');
  const prereq = inv.prerequisites.length ? `<h2>Prérequis</h2><ul>${inv.prerequisites.map(p => `<li><b>${h(p.label)}</b> (${p.objects}) : ${h(p.detail)}</li>`).join('')}</ul>` : '';
  const blockers = inv.blockers.length ? `<h2>Principaux points à reprendre</h2><div class="tw"><table><thead><tr><th>Point</th><th class="n">Objets</th><th class="n">Effort</th></tr></thead><tbody>${inv.blockers.map(b => `<tr><td>${h(b.label)}</td><td class="n">${b.objects}</td><td class="n">${h(frHours(b.hours))}</td></tr>`).join('')}</tbody></table></div>` : '';
  const dashes = inv.entries.filter(x => x.type === 'dashboard');
  const dashTable = dashes.length ? `<h2>Tableaux de bord</h2><div class="tw"><table><thead><tr><th>Tableau de bord</th><th class="n">Panneaux</th><th>Verdict</th><th class="n">Effort, panneaux compris</th></tr></thead><tbody>${dashes.map(d => `<tr><td><a href="#o-${h(d.key.replace(/[^A-Za-z0-9_-]/g, '-'))}">${h(d.title)}</a></td><td class="n">${d.panels || 0}</td><td>${badge(d.verdict)}</td><td class="n">${h(frHours(d.effortTotal || d.effort))}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title || 'Inventaire Kibana')}</title>
<style>
${KB_CSS}
</style></head><body><main>
<h1>Inventaire de migration Kibana vers ClickHouse</h1>
<p class="muted">${s.objects} objets à migrer, ${s.queries} requêtes traduites.${Object.keys(inv.source.ignored).length ? ` Non comptés (sans requête) : ${h(Object.entries(inv.source.ignored).map(([t, n]) => `${n} ${t}`).join(', '))}.` : ''}</p>
<div class="tiles"><div class="tile"><b>${h(frHours(s.effort.hours))}</b><span class="muted">effort estimé, ${h(frNum(s.effort.days))} j à ${inv.effortScale.hoursPerDay} h</span></div><div class="tile"><b class="v-ready">${s.byVerdict.ready}</b><span class="muted">prêts</span></div><div class="tile"><b class="v-review">${s.byVerdict.review}</b><span class="muted">à vérifier</span></div><div class="tile"><b class="v-todo">${s.byVerdict.todo}</b><span class="muted">à reprendre</span></div>${s.byVerdict.unrecognized ? `<div class="tile"><b class="v-unrecognized">${s.byVerdict.unrecognized}</b><span class="muted">non reconnus</span></div>` : ''}</div>
<div class="bar" aria-label="Répartition des verdicts sur ${total} objets">${bar}</div>
<h2>Synthèse par type</h2><div class="tw"><table><thead><tr><th>Type</th><th class="n">Objets</th><th class="n">Prêts</th><th class="n">À vérifier</th><th class="n">À reprendre</th><th class="n">Non reconnus</th><th class="n">Effort</th></tr></thead><tbody>${typeRows}</tbody></table></div>
${prereq}${blockers}${dashTable}
<h2>Objets</h2><div class="filters" role="group" aria-label="Filtrer par verdict"><button data-f="all" aria-pressed="true">Tous</button><button data-f="ready" aria-pressed="false">Prêts</button><button data-f="review" aria-pressed="false">À vérifier</button><button data-f="todo" aria-pressed="false">À reprendre</button></div>
<div class="tw"><table id="objs"><thead><tr><th>Type</th><th>Objet</th><th>Nature</th><th>Verdict</th><th class="n">Effort</th></tr></thead><tbody>${objRows}</tbody></table></div>
<h2>Détail par objet</h2>${details}
<h2>Barème</h2><p class="muted">Recréer un objet, vérifier ses requêtes (${h(frHours(inv.effortScale.query.review))} si elle est à vérifier, ${h(frHours(inv.effortScale.query.todo))} si elle est à reprendre, ${h(frHours(inv.effortScale.review))} par point à vérifier), reprendre chaque point selon sa nature (de ${h(frHours(inv.effortScale.todoDefault))} pour une clause à ${h(frHours(6))} pour une visualisation Vega). Arrondi au quart d’heure supérieur par objet ; un jour vaut ${inv.effortScale.hoursPerDay} h.</p>
</main><script>
document.querySelectorAll('.filters button').forEach(function(b){b.addEventListener('click',function(){var f=b.getAttribute('data-f');document.querySelectorAll('.filters button').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false')});document.querySelectorAll('#objs tbody tr').forEach(function(r){r.style.display=f==='all'||r.getAttribute('data-v')===f?'':'none'})})});
</script></body></html>
`;
}
// Fichiers SQL d’un inventaire, un par objet : nom lisible et unique
function inventorySQLFiles(inv) {
  const used = new Set(); const files = [];
  const slugOf = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'objet';
  for (const x of inv.entries) {
    if (!x.queries.some(q => q.sql)) continue;
    let base = `${x.type}-${slugOf(x.title)}`; let name = base; let i = 2;
    while (used.has(name)) name = `${base}-${i++}`;
    used.add(name);
    const head = `-- ${KB_TYPES[x.type]} : ${kbFlat(x.title)} (${x.id})\n-- Verdict : ${kbVerdict(x.verdict)}, effort estimé ${frHours(x.effort)}\n`;
    files.push({ name: `${name}.sql`, content: head + x.queries.filter(q => q.sql).map(q => `\n-- ===== ${kbFlat(q.title)} (${kbVerdict(q.verdict)})\n${q.sql}\n`).join('') });
  }
  return files;
}
