/*
 * Copie figée des comparateurs des deux bancs (tests/differential/run.mjs et tests/pipelines/run.mjs), telle qu’ils
 * étaient avant leur extraction dans src/engine/equivalence.js et src/engine/replay.js (0c92889).
 * tests/verify/run.mjs vérifie que le moteur rend exactement les mêmes écarts : les bancs, qui demandent Docker,
 * n’ont plus à être relancés pour savoir si l’extraction a changé une comparaison.
 */
import { outputsOf } from '../pipelines/transport.mjs';

// Banc différentiel
export const diff = (() => {
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(v);
const normKey = v => (v === undefined ? null : isDate(v) ? Date.parse(v) : v);
function same(a, b, tol) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (isDate(b)) b = Date.parse(b);
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}
const BUCKET_FIELDS = new Set(['key', 'key_as_string', 'doc_count', 'from', 'to', 'from_as_string', 'to_as_string', 'doc_count_error_upper_bound', 'sum_other_doc_count', 'meta']);

// Colonnes attendues côté ClickHouse pour une mesure Elasticsearch (null : ce n’est pas une mesure)
function metricColumns(name, a, type) {
  if (a === null || typeof a !== 'object') return {};
  if ('buckets' in a) return null;
  if ('values' in a) {
    const keys = Object.keys(a.values);
    if (type === 'percentile_ranks') return Object.fromEntries(keys.map(k => [`${name}_${String(Number(k)).replace(/\W/g, '_')}`, a.values[k]]));
    return { [name]: keys.map(k => a.values[k]) };
  }
  if ('count' in a && 'min' in a && 'avg' in a) {
    const o = { [`${name}_count`]: a.count, [`${name}_min`]: a.min, [`${name}_max`]: a.max, [`${name}_avg`]: a.avg, [`${name}_sum`]: a.sum };
    if ('variance' in a) Object.assign(o, { [`${name}_variance`]: a.variance, [`${name}_std_deviation`]: a.std_deviation, [`${name}_sum_of_squares`]: a.sum_of_squares });
    return o;
  }
  if ('value' in a) {
    const o = { [name]: a.value };
    if (Array.isArray(a.keys)) o[`${name}_key`] = a.keys[0];
    return o;
  }
  // top_metrics avec une seule mesure : la valeur, ou la liste des valeurs quand size > 1
  if (Array.isArray(a.top)) {
    const vals = a.top.map(t => Object.values(t.metrics)[0]);
    return { [name]: vals.length === 1 ? vals[0] : vals };
  }
  if ('hits' in a || 'doc_count' in a) return null;
  return {};
}
function leafMetrics(bucket, defs) {
  const typeOf = n => { const d = defs && defs[n]; return d ? Object.keys(d).find(k => k !== 'aggs' && k !== 'aggregations') : null; };
  const m = {};
  for (const [name, a] of Object.entries(bucket)) {
    if (BUCKET_FIELDS.has(name)) continue;
    const cols = metricColumns(name, a, typeOf(name));
    if (cols) { Object.assign(m, cols); continue; }
    // Sous-filtre sans regroupement : la traduction le fusionne en colonnes <nom>_doc_count, <nom>_<mesure>
    if (a && typeof a === 'object' && !('buckets' in a) && !('hits' in a) && 'doc_count' in a) {
      m[`${name}_doc_count`] = a.doc_count;
      for (const [sub, v] of Object.entries(a)) {
        if (BUCKET_FIELDS.has(sub)) continue;
        const c = metricColumns(`${name}_${sub}`, v, null);
        if (c) Object.assign(m, c);
      }
    }
  }
  return m;
}
const subAggs = def => (def && (def.aggs || def.aggregations)) || {};
// Parcourt l’arbre d’agrégations d’Elasticsearch le long d’un chemin et appelle onLeaf(bucket, clés, définitions enfants).
// Renvoie true si un niveau a des groupes nommés (filters) : ils forment un objet JSON, dont l’ordre ne porte pas de sens.
function walkBuckets(aggs, defs, path, onLeaf) {
  let keyed = false;
  (function walk(cur, curDefs, i, keys, labels) {
    const name = path[i];
    const a = cur && cur[name];
    if (!a) return;
    const children = subAggs(curDefs && curDefs[name]);
    let buckets;
    if (Array.isArray(a.buckets)) buckets = a.buckets.map(b => [b.key, b]);
    else if (a.buckets && typeof a.buckets === 'object') { buckets = Object.entries(a.buckets); keyed = true; }
    else buckets = [[undefined, a]];
    for (const [k, b] of buckets) {
      const next = Object.assign({}, keys);
      const nextLabels = Object.assign({}, labels);
      const multi = curDefs && curDefs[name] && curDefs[name].multi_terms;
      if (k !== undefined) {
        if (k !== null && typeof k === 'object' && !Array.isArray(k)) Object.assign(next, k);
        // multi_terms : une clé tableau, une colonne <nom>_<champ> par terme côté ClickHouse
        else if (multi && Array.isArray(k)) multi.terms.forEach((t, j) => { next[`${name}_${t.field}`] = k[j]; });
        else { next[name] = k; if (typeof b.key_as_string === 'string') nextLabels[name] = b.key_as_string; }
      }
      if (i < path.length - 1) walk(b, children, i + 1, next, nextLabels);
      else onLeaf(b, next, children, nextLabels);
    }
  })(aggs, defs, 0, {}, {});
  return keyed;
}
function esBucketRows(aggs, defs, path) {
  const rows = [];
  rows.keyed = walkBuckets(aggs, defs, path, (b, keys, children, labels) => rows.push({ keys, labels, doc_count: b.doc_count, m: leafMetrics(b, children) }));
  return rows;
}
const short = v => { const s = JSON.stringify(v === undefined ? null : v); return s.length > 120 ? s.slice(0, 120) + '…' : s; };

// Compare des lignes Elasticsearch { keys, doc_count, m } aux lignes ClickHouse ; renvoie la liste des écarts
function compareRows(esRows, chRows, tol, unordered) {
  const keyNames = [...new Set(esRows.flatMap(r => Object.keys(r.keys)))];
  const metricNames = [...new Set(esRows.flatMap(r => Object.keys(r.m)))];
  const keyOf = get => JSON.stringify(keyNames.map(k => normKey(get(k))));
  // Une agrégation qui porte le nom d’une colonne citée par la requête est suffixée _agg par la traduction
  const col = (row, name) => (name in row || !(`${name}_agg` in row) ? row[name] : row[`${name}_agg`]);
  // Semaine, mois, année : ClickHouse renvoie une date sans heure. Elle se compare au jour écrit par
  // Elasticsearch dans key_as_string, qui est déjà exprimé dans le fuseau de l’agrégation.
  const byDay = new Set(keyNames.filter(k => chRows.some(r => /^\d{4}-\d{2}-\d{2}$/.test(String(col(r, k)))) && esRows.some(r => r.labels && r.labels[k])));
  const esKeys = esRows.map(r => JSON.stringify(keyNames.map(k => (byDay.has(k) ? String(r.labels[k]).slice(0, 10) : normKey(r.keys[k])))));
  const chKeys = chRows.map(r => JSON.stringify(keyNames.map(k => (byDay.has(k) ? col(r, k) : normKey(col(r, k))))));
  const chByKey = new Map(chKeys.map((k, i) => [k, chRows[i]]));
  const esSet = new Set(esKeys);
  const missing = esKeys.filter(k => !chByKey.has(k));
  const extra = chKeys.filter(k => !esSet.has(k));
  const diffs = [];
  esRows.forEach((r, i) => {
    const c = chByKey.get(esKeys[i]);
    if (!c) return;
    if (!same(r.doc_count, c.doc_count)) diffs.push(`${esKeys[i]} doc_count ES ${r.doc_count} / CH ${c.doc_count}`);
    for (const m of metricNames) if (!same(r.m[m], col(c, m), tol)) diffs.push(`${esKeys[i]} ${m} ES ${short(r.m[m])} / CH ${short(col(c, m))}`);
  });
  const common = new Set(esKeys.filter(k => chByKey.has(k)));
  const sameOrder = JSON.stringify(esKeys.filter(k => common.has(k))) === JSON.stringify(chKeys.filter(k => common.has(k)));
  const out = [];
  if (esRows.length !== chRows.length) out.push(`ES ${esRows.length} lignes / CH ${chRows.length}`);
  if (missing.length) out.push(`${missing.length} absentes côté CH, ex. ${missing.slice(0, 3).join(' ')}`);
  if (extra.length) out.push(`${extra.length} en trop côté CH, ex. ${extra.slice(0, 3).join(' ')}`);
  if (diffs.length) out.push(`${diffs.length} valeurs ≠, ex. ${diffs.slice(0, 2).join(' ; ')}`);
  if (!sameOrder && !unordered) out.push('ordre différent');
  return out;
}
function compareIds(label, esIds, chIds) {
  if (JSON.stringify(esIds) === JSON.stringify(chIds)) return [];
  const sameSet = esIds.length === chIds.length && [...esIds].sort().join() === [...chIds].sort().join();
  return [`[${label}] ${sameSet ? 'mêmes documents, ordre différent' : 'documents différents'} : ES ${esIds.slice(0, 6).join(',')}… / CH ${chIds.slice(0, 6).join(',')}…`];
}

  return { isDate, normKey, same, metricColumns, leafMetrics, esBucketRows, compareRows, compareIds };
})();

// Banc d’équivalence des pipelines
export const pipe = (() => {
/*
 * Les événements sont comparés champ par champ, types compris : 42 n’est pas "42", et [event][original] compris.
 * Une tolérance seulement, désactivée par le champ « exact » d’un cas qui en fait l’inventaire :
 *   horodatage   un @timestamp posé à l’ingestion ne peut pas être égal des deux côtés : il est reconnu à ce
 *                qu’il tombe pendant l’exécution du banc, et sa précision n’est pas comparée non plus
 * Un UUID, tiré au hasard par chaque moteur, n’est comparé que par sa forme.
 */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalize(event, c, window) {
  const e = JSON.parse(JSON.stringify(event), (k, v) => (typeof v === 'string' && UUID.test(v) ? '<uuid>' : v));
  const exact = c.exact || [];
  const ts = e['@timestamp'];
  if (typeof ts === 'string' && Date.parse(ts) >= window[0] && Date.parse(ts) <= window[1]) {
    const digits = (/\.(\d+)Z$/.exec(ts) || ['', ''])[1].length;
    e['@timestamp'] = exact.includes('horodatage') ? `<ingestion, ${digits} décimales>` : '<ingestion>';
  }
  return e;
}

// Aligne les deux suites sur leurs événements identiques : un événement perdu ne décale pas les suivants
function align(a, b) {
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const gaps = []; let gap = { a: [], b: [] }; let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { gaps.push(gap); gap = { a: [], b: [] }; i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) gap.a.push(i++);
    else gap.b.push(j++);
  }
  gaps.push(gap);
  return gaps.filter(g => g.a.length || g.b.length);
}

function leaves(v, path, out) {
  if (isObj(v) && Object.keys(v).length) for (const k of Object.keys(v)) leaves(v[k], path ? `${path}.${k}` : k, out);
  else out.set(path, canon(v));
  return out;
}
const short = s => (s.length > 120 ? s.slice(0, 117) + '…' : s);

function compare(c, l, v, window) {
  if (l.error) return { verdict: 'L✗', detail: l.error };
  if (v.error) return { verdict: 'V✗', detail: v.error };
  const diffs = [];
  for (const name of outputsOf(c)) {
    const where = name ? `[sortie ${name}] ` : '';
    // Pipelines reliés : deux pipelines qui écrivent dans une même sortie s’y entrelacent au hasard, l’ordre n’est pas comparé
    const order = list => (c.chain ? list.slice().sort((x, y) => (canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0)) : list);
    const ln = order(l.outputs[name].map(e => normalize(e, c, window))); const vn = order(v.outputs[name].map(e => normalize(e, c, window)));
    if (ln.length !== vn.length) diffs.push(`${where}${ln.length} événement(s) côté Logstash, ${vn.length} côté Vector`);
    for (const gap of align(ln.map(canon), vn.map(canon))) {
      gap.a.forEach((i, k) => {
        if (k >= gap.b.length) { diffs.push(`${where}[événement ${i + 1}] sans équivalent côté Vector : ${short(canon(ln[i]))}`); return; }
        const a = leaves(ln[i], '', new Map()); const b = leaves(vn[gap.b[k]], '', new Map());
        for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
          if (a.get(key) !== b.get(key)) diffs.push(`${where}[événement ${i + 1}] ${key} : Logstash ${a.has(key) ? short(a.get(key)) : 'absent'} / Vector ${b.has(key) ? short(b.get(key)) : 'absent'}`);
        }
      });
      for (const j of gap.b.slice(gap.a.length)) diffs.push(`${where}[Vector seul] ${short(canon(vn[j]))}`);
    }
  }
  return { verdict: diffs.length ? '≠' : '=', detail: diffs.join(' || ') };
}

  return { normalize, align, compare, canon };
})();
