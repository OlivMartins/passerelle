/* Passerelle — moteur : équivalence de deux moteurs (Elasticsearch / ClickHouse, Logstash / Vector) */
/*
 * Le comparateur du banc différentiel (tests/differential, tests/pipelines) et celui de « passerelle verify »,
 * qui joue les requêtes et les pipelines d’un client sur ses propres données : le même code, donc la même preuve.
 *
 * Aucune entrée-sortie ici. Les appels aux moteurs sont fournis par l’appelant (io), synchrones ou non :
 *   io.translate(dsl)     traduction de la requête (translateDSL) ;
 *   io.search(dsl)        Elasticsearch : { status, body } ;
 *   io.searchPit(dsl)     idem sous un point-in-time (cas « pit » du banc) ;
 *   io.sql(sql)           ClickHouse : { rows } ou { error } ;
 *   io.setup(liste)       crée une liste nommée avant la requête : message d’erreur, ou rien.
 */

/* ---------- Résultats de requêtes ---------- */
const eqIsDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(v);
const eqNormKey = v => (v === undefined ? null : eqIsDate(v) ? Date.parse(v) : v);
function eqSame(a, b, tol) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (eqIsDate(b)) b = Date.parse(b);
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eqSame(x, b[i], tol));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}
const EQ_BUCKET_FIELDS = new Set(['key', 'key_as_string', 'doc_count', 'from', 'to', 'from_as_string', 'to_as_string', 'doc_count_error_upper_bound', 'sum_other_doc_count', 'meta']);

// Colonnes attendues côté ClickHouse pour une mesure Elasticsearch (null : ce n’est pas une mesure)
function eqMetricColumns(name, a, type) {
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
function eqLeafMetrics(bucket, defs) {
  const typeOf = n => { const d = defs && defs[n]; return d ? Object.keys(d).find(k => k !== 'aggs' && k !== 'aggregations') : null; };
  const m = {};
  for (const [name, a] of Object.entries(bucket)) {
    if (EQ_BUCKET_FIELDS.has(name)) continue;
    const cols = eqMetricColumns(name, a, typeOf(name));
    if (cols) { Object.assign(m, cols); continue; }
    // Sous-filtre sans regroupement : la traduction le fusionne en colonnes <nom>_doc_count, <nom>_<mesure>
    if (a && typeof a === 'object' && !('buckets' in a) && !('hits' in a) && 'doc_count' in a) {
      m[`${name}_doc_count`] = a.doc_count;
      for (const [sub, v] of Object.entries(a)) {
        if (EQ_BUCKET_FIELDS.has(sub)) continue;
        const c = eqMetricColumns(`${name}_${sub}`, v, null);
        if (c) Object.assign(m, c);
      }
    }
  }
  return m;
}
const eqSubAggs = def => (def && (def.aggs || def.aggregations)) || {};
// Parcourt l’arbre d’agrégations d’Elasticsearch le long d’un chemin et appelle onLeaf(bucket, clés, définitions enfants).
// Renvoie true si un niveau a des groupes nommés (filters) : ils forment un objet JSON, dont l’ordre ne porte pas de sens.
function eqWalkBuckets(aggs, defs, path, onLeaf) {
  let keyed = false;
  (function walk(cur, curDefs, i, keys, labels) {
    const name = path[i];
    const a = cur && cur[name];
    if (!a) return;
    const children = eqSubAggs(curDefs && curDefs[name]);
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
function eqBucketRows(aggs, defs, path) {
  const rows = [];
  rows.keyed = eqWalkBuckets(aggs, defs, path, (b, keys, children, labels) => rows.push({ keys, labels, doc_count: b.doc_count, m: eqLeafMetrics(b, children) }));
  return rows;
}
const eqShort = v => { const s = JSON.stringify(v === undefined ? null : v); return s.length > 120 ? s.slice(0, 120) + '…' : s; };

/*
 * Écarts entre les lignes d’Elasticsearch { keys, doc_count, m } et celles de ClickHouse.
 * Chaque écart porte deux textes : « text » (avec des exemples de clés et de valeurs, pour qui lit le banc)
 * et « safe » (comptes seulement, sans aucune valeur : pour un rapport qui quitte la machine du client).
 */
function eqCompareRowsDetailed(esRows, chRows, tol, unordered) {
  const keyNames = [...new Set(esRows.flatMap(r => Object.keys(r.keys)))];
  const metricNames = [...new Set(esRows.flatMap(r => Object.keys(r.m)))];
  // Une agrégation qui porte le nom d’une colonne citée par la requête est suffixée _agg par la traduction
  const col = (row, name) => (name in row || !(`${name}_agg` in row) ? row[name] : row[`${name}_agg`]);
  // Semaine, mois, année : ClickHouse renvoie une date sans heure. Elle se compare au jour écrit par
  // Elasticsearch dans key_as_string, qui est déjà exprimé dans le fuseau de l’agrégation.
  const byDay = new Set(keyNames.filter(k => chRows.some(r => /^\d{4}-\d{2}-\d{2}$/.test(String(col(r, k)))) && esRows.some(r => r.labels && r.labels[k])));
  const esKeys = esRows.map(r => JSON.stringify(keyNames.map(k => (byDay.has(k) ? String(r.labels[k]).slice(0, 10) : eqNormKey(r.keys[k])))));
  const chKeys = chRows.map(r => JSON.stringify(keyNames.map(k => (byDay.has(k) ? col(r, k) : eqNormKey(col(r, k))))));
  const chByKey = new Map(chKeys.map((k, i) => [k, chRows[i]]));
  const esSet = new Set(esKeys);
  const missing = esKeys.filter(k => !chByKey.has(k));
  const extra = chKeys.filter(k => !esSet.has(k));
  const diffs = [];
  esRows.forEach((r, i) => {
    const c = chByKey.get(esKeys[i]);
    if (!c) return;
    if (!eqSame(r.doc_count, c.doc_count)) diffs.push(`${esKeys[i]} doc_count ES ${r.doc_count} / CH ${c.doc_count}`);
    for (const m of metricNames) if (!eqSame(r.m[m], col(c, m), tol)) diffs.push(`${esKeys[i]} ${m} ES ${eqShort(r.m[m])} / CH ${eqShort(col(c, m))}`);
  });
  const common = new Set(esKeys.filter(k => chByKey.has(k)));
  const sameOrder = JSON.stringify(esKeys.filter(k => common.has(k))) === JSON.stringify(chKeys.filter(k => common.has(k)));
  const out = [];
  const both = text => out.push({ text, safe: text });
  if (esRows.length !== chRows.length) both(`ES ${esRows.length} lignes / CH ${chRows.length}`);
  if (missing.length) out.push({ text: `${missing.length} absentes côté CH, ex. ${missing.slice(0, 3).join(' ')}`, safe: `${missing.length} absentes côté CH` });
  if (extra.length) out.push({ text: `${extra.length} en trop côté CH, ex. ${extra.slice(0, 3).join(' ')}`, safe: `${extra.length} en trop côté CH` });
  if (diffs.length) out.push({ text: `${diffs.length} valeurs ≠, ex. ${diffs.slice(0, 2).join(' ; ')}`, safe: `${diffs.length} valeurs ≠` });
  if (!sameOrder && !unordered) both('ordre différent');
  return out;
}
const eqCompareRows = (esRows, chRows, tol, unordered) => eqCompareRowsDetailed(esRows, chRows, tol, unordered).map(d => d.text);

// safeLabel : le libellé sans les valeurs des clés de groupe (qui sont des données du client)
function eqCompareIdsDetailed(label, esIds, chIds, safeLabel) {
  if (JSON.stringify(esIds) === JSON.stringify(chIds)) return [];
  const sameSet = esIds.length === chIds.length && [...esIds].sort().join() === [...chIds].sort().join();
  return [{
    text: `[${label}] ${sameSet ? 'mêmes documents, ordre différent' : 'documents différents'} : ES ${esIds.slice(0, 6).join(',')}… / CH ${chIds.slice(0, 6).join(',')}…`,
    safe: `[${safeLabel === undefined ? label : safeLabel}] ${sameSet ? 'mêmes documents, ordre différent' : `documents différents (ES ${esIds.length}, CH ${chIds.length})`}`
  }];
}
const eqCompareIds = (label, esIds, chIds) => eqCompareIdsDetailed(label, esIds, chIds).map(d => d.text);

const eqEsError = r => {
  const e = (r.body && r.body.error) || {};
  const cause = (e.root_cause && e.root_cause[0]) || e;
  return `HTTP ${r.status} ${cause.type || ''} : ${String(cause.reason || '').slice(0, 160)}`;
};

/*
 * Compare les résultats d’une requête traduite : chaque instruction SQL de la traduction est exécutée (io.sql)
 * et confrontée à la partie correspondante de la réponse d’Elasticsearch.
 * Renvoie { failed, diffs, skipped, compared } : skipped liste les instructions que le comparateur ne sait pas
 * lire. Un appelant qui prouve quelque chose ne les compte pas comme égales.
 */
async function eqCompareStatements(dsl, t, esBody, io, tol) {
  const defs = dsl.aggs || dsl.aggregations || {};
  const diffs = []; const skipped = []; let failed = false; let compared = 0;
  const add = list => diffs.push(...list);
  for (const s of t.statements) {
    const q = await io.sql(s.sql);
    if (q.error) { failed = true; diffs.push({ text: `[${s.title}] ClickHouse : ${q.error}`, safe: `[${s.title}] ClickHouse : erreur`, error: q.error }); continue; }
    let m;
    if ((m = /^Agrégation (.+)$/.exec(s.title))) {
      const esRows = eqBucketRows(esBody.aggregations, defs, m[1].split(' › '));
      const d = eqCompareRowsDetailed(esRows, q.rows, tol, esRows.keyed);
      compared++;
      add(d.map(x => ({ text: `[${m[1]}] ${x.text}`, safe: `[${m[1]}] ${x.safe}` })));
    } else if ((m = /^Top hits (.+)$/.exec(s.title))) {
      // Les documents sont comparés groupe par groupe, dans l’ordre ; l’ordre des groupes entre eux
      // est celui du regroupement parent, déjà vérifié par sa propre requête.
      const path = m[1].split(' › ');
      const keyNames = path.slice(0, -1);
      const esGroups = new Map();
      eqWalkBuckets(esBody.aggregations, defs, keyNames, (b, keys) => esGroups.set(JSON.stringify(Object.values(keys).map(eqNormKey)), b[path[path.length - 1]].hits.hits.map(h => h._id)));
      const chGroups = new Map();
      for (const x of q.rows) {
        const k = JSON.stringify(keyNames.filter(n => n in x).map(n => eqNormKey(x[n])));
        if (!chGroups.has(k)) chGroups.set(k, []);
        chGroups.get(k).push(x._id);
      }
      compared++;
      for (const k of new Set([...esGroups.keys(), ...chGroups.keys()])) add(eqCompareIdsDetailed(`${m[1]} ${k}`, esGroups.get(k) || [], chGroups.get(k) || [], m[1]));
    } else if (s.title === 'Mesures globales') {
      const d = eqCompareRowsDetailed([{ keys: {}, m: eqLeafMetrics(esBody.aggregations, defs) }], q.rows, tol);
      compared++;
      add(d.map(x => ({ text: `[mesures] ${x.text}`, safe: `[mesures] ${x.safe}` })));
    } else if ((m = /^Pipeline (.+)$/.exec(s.title))) {
      const d = eqCompareRowsDetailed([{ keys: {}, m: eqMetricColumns(m[1], esBody.aggregations[m[1]], null) || {} }], q.rows, tol);
      compared++;
      add(d.map(x => ({ text: `[${m[1]}] ${x.text}`, safe: `[${m[1]}] ${x.safe}` })));
    } else if (s.title === 'Documents') {
      compared++;
      add(eqCompareIdsDetailed('documents', esBody.hits.hits.map(h => h._id), q.rows.map(x => x._id)));
    } else if (/^Total|^Comptage/.test(s.title)) {
      const row = q.rows[0] || {};
      const n = row.total !== undefined ? row.total : row.count;
      compared++;
      if (esBody.hits.total.value !== n) diffs.push({ text: `[total] ES ${esBody.hits.total.value} / CH ${n}`, safe: '[total] comptes différents' });
    } else skipped.push(s.title);
  }
  return { failed, diffs, skipped, compared };
}

const eqDetail = diffs => diffs.map(d => d.text).join(' || ');

// Plus grande marge d’erreur annoncée par un terms (doc_count_error_upper_bound) : un écart peut alors venir de
// l’estimation par shard d’Elasticsearch, pas de la traduction
function eqEsEstimate(node) {
  let max = 0;
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    if (typeof v.doc_count_error_upper_bound === 'number') max = Math.max(max, v.doc_count_error_upper_bound);
    Object.values(v).forEach(walk);
  })(node);
  return max;
}

// Agrégation composite : les pages sont lues jusqu’au bout des deux côtés
async function eqRunComposite(c, io) {
  const name = c.composite;
  const sources = c.dsl.aggs[name].composite.sources.map(s => Object.keys(s)[0]);
  const size = c.dsl.aggs[name].composite.size;
  const page = after => { const d = structuredClone(c.dsl); if (after) d.aggs[name].composite.after = after; return d; };
  // Mode « export complet » : une seule requête côté ClickHouse, comparée à l’ensemble des pages d’Elasticsearch, sans ordre
  const stream = c.stream !== undefined ? !!c.stream : !!(c.config && c.config.clickhouse && c.config.clickhouse.composite_mode === 'stream');
  const MAX_PAGES = 500;

  const esRows = []; let docs = null; let complete = false;
  for (let p = 0, after; p < MAX_PAGES; p++) {
    const r = await io.search(page(after));
    if (r.status !== 200) return { verdict: 'ES✗', detail: eqEsError(r) };
    const a = r.body.aggregations[name];
    if (docs === null && r.body.hits && r.body.hits.total) docs = r.body.hits.total.value;
    a.buckets.forEach(b => esRows.push({ keys: b.key, doc_count: b.doc_count, m: eqLeafMetrics(b, eqSubAggs(c.dsl.aggs[name])) }));
    if (!a.after_key || !a.buckets.length) { complete = true; break; }
    after = a.after_key;
  }
  if (!complete) return { verdict: 'INC', detail: `plus de ${MAX_PAGES} pages côté Elasticsearch : comparaison interrompue`, docs };

  const chRows = [];
  let t = null; let pages = 0; let firstKey = null; let chComplete = false;
  for (let p = 0, after; p < MAX_PAGES; p++) {
    t = io.translate(page(after));
    if (t.error) return { verdict: 'TR✗', detail: t.error, docs };
    const r = await io.sql(t.statements[0].sql);
    if (r.error) return { verdict: 'CH✗', detail: r.error, t, docs };
    pages++;
    if (!r.rows.length) { chComplete = true; break; }
    const key = JSON.stringify(sources.map(s => r.rows[0][s]));
    if (p > 0 && key === firstKey) return { verdict: '≠', detail: `pagination bouclée : la page ${p + 1} recommence à la première clé ${key}`, safe: 'pagination bouclée côté ClickHouse', t, docs };
    if (p === 0) firstKey = key;
    chRows.push(...r.rows);
    // Le client reprend les clés de la dernière ligne, au format d’Elasticsearch (dates en epoch millis)
    const last = r.rows[r.rows.length - 1];
    after = Object.fromEntries(sources.map(s => [s, eqNormKey(last[s])]));
    if (stream || r.rows.length < size) { chComplete = true; break; }
  }
  if (!chComplete) return { verdict: 'INC', detail: `plus de ${MAX_PAGES} pages côté ClickHouse : comparaison interrompue`, t, docs };
  const diffs = eqCompareRowsDetailed(esRows, chRows, c.tol, stream);
  const tail = ` (${esRows.length} groupes ES, ${pages} pages CH)`;
  return { verdict: diffs.length ? '≠' : '=', detail: `${diffs.map(d => d.text).join(' | ')}${tail}`, safe: `${diffs.map(d => d.safe).join(' | ')}${tail}`, t, docs, rows: esRows.length };
}

/*
 * Une requête sur les deux moteurs. Verdicts : « = » (mêmes résultats), « ≠ » (écart), « ES✗ », « TR✗ » et « CH✗ »
 * (un moteur ou la traduction refuse), « RP » (traduction à reprendre : rien n’est comparé, option skipTodo),
 * « INC » (comparaison interrompue). c : { dsl, pit, unsupported, composite, tol, stream, skipTodo, noProbe, config }.
 */
async function eqRunCase(c, io) {
  if (c.composite) return eqRunComposite(c, io);
  const t = io.translate(c.dsl);
  // Sans appel à Elasticsearch quand la traduction échoue : sur un cluster de production, une requête inutile pèse
  if (c.noProbe && t.error) return { verdict: 'TR✗', detail: `traducteur : ${t.error}`, t };
  if (c.skipTodo && !t.error && t.stats && t.stats.ko) return { verdict: 'RP', detail: 'traduction à reprendre : le SQL s’arrête sur une construction sans équivalent', t };
  // Listes nommées : la table et ses lignes sont créées avant la requête, comme le fera l’utilisateur
  for (const list of t.lists || []) {
    const err = io.setup ? await io.setup(list) : null;
    if (err) return { verdict: 'CH✗', detail: `liste ${list.name} : ${err}`, t };
  }
  const r = c.pit ? await io.searchPit(c.dsl) : await io.search(c.dsl);
  if (t.error) return { verdict: r.status === 200 ? 'TR✗' : '=', detail: `traducteur : ${t.error}${r.status === 200 ? '' : ` ; Elasticsearch refuse aussi (${eqEsError(r)})`}` };
  if (r.status !== 200) {
    // Elasticsearch refuse la requête : la traduction doit le signaler (« à reprendre »), pas produire un SQL silencieux
    return t.stats.ko ? { verdict: '=', detail: `refusée des deux côtés : ${eqEsError(r)}`, t } : { verdict: 'ES✗', detail: `${eqEsError(r)} — la traduction produit pourtant du SQL sans rien signaler`, t };
  }
  const docs = r.body.hits && r.body.hits.total ? r.body.hits.total.value : null;
  // Une réponse partielle ne prouve rien : des shards manquent d’un côté seulement
  if (r.body.timed_out || (r.body._shards && r.body._shards.failed)) return { verdict: 'ES✗', detail: `réponse partielle d’Elasticsearch (${r.body.timed_out ? 'délai dépassé' : `${r.body._shards.failed} shard(s) en échec`})`, t, docs };
  if (c.unsupported) {
    // Construction hors de portée : la traduction doit la déclarer « à reprendre » et le SQL doit s’arrêter
    // sur le message de Passerelle, au lieu de renvoyer un résultat.
    const errors = [];
    for (const s of t.statements) errors.push((await io.sql(s.sql)).error || '');
    const stopped = t.stats.ko > 0 && errors.some(e => /Passerelle : .* à traduire/.test(e));
    return { verdict: stopped ? '=' : '≠', detail: stopped ? 'déclarée à reprendre, le SQL s’arrête' : `attendu : à reprendre et SQL arrêté ; obtenu ko=${t.stats.ko}, ${errors.join(' | ') || 'exécution sans erreur'}`, t, docs };
  }
  const cmp = await eqCompareStatements(c.dsl, t, r.body, io, c.tol);
  return {
    verdict: cmp.failed ? 'CH✗' : cmp.diffs.length ? '≠' : '=',
    detail: eqDetail(cmp.diffs), safe: cmp.diffs.map(d => d.safe).join(' || '), diffs: cmp.diffs, skipped: cmp.skipped, compared: cmp.compared, t, docs,
    estimate: eqEsEstimate(r.body.aggregations)
  };
}

/* ---------- Fenêtre de temps ---------- */
/*
 * Deux moteurs alimentés en parallèle ne détiennent pas les mêmes documents à la même seconde : les dernières
 * minutes diffèrent, et « now » vaut un instant différent à chaque appel. La comparaison se fait donc sur une
 * fenêtre close, dans le passé, où « now » est un instant fixe.
 */
const EQ_DATE_KEYS = new Set(['gte', 'gt', 'lte', 'lt', 'from', 'to', 'min', 'max']);
// Les bornes « now-15m/m » deviennent « <instant>||-15m/m » : la date math d’Elasticsearch et la traduction les lisent toutes deux
function eqPinNow(dsl, instant) {
  const iso = new Date(instant).toISOString();
  let pinned = 0;
  const walk = (v, key, skip) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!skip && EQ_DATE_KEYS.has(key) && /^now(?=$|[+\-/])/.test(s)) { pinned++; return s.length > 3 ? `${iso}||${s.slice(3)}` : iso; }
      return v;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key, skip));
    if (isObj(v)) {
      // Avec un « format », la date ancre devrait s’écrire dans ce format : la borne est laissée telle quelle
      const withFormat = typeof v.format === 'string';
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === 'script' ? x : walk(x, k, withFormat);
      return o;
    }
    return v;
  };
  return { dsl: walk(dsl, '', false), pinned };
}

// La requête d’origine reste en « must » (le score est conservé) ; la fenêtre est un filtre
function eqBoundWindow(dsl, field, from, to) {
  const range = { range: { [field]: { gte: new Date(from).toISOString(), lt: new Date(to).toISOString() } } };
  const out = Object.assign({}, dsl);
  out.query = dsl.query ? { bool: { must: [dsl.query], filter: [range] } } : { bool: { filter: [range] } };
  return out;
}

// Champ de date côté Elasticsearch : verify.time_field, sinon le champ que field_mapping envoie sur la colonne de temps de la table
function eqTimeField(cfg, table) {
  if (cfg.verify && cfg.verify.time_field) return cfg.verify.time_field;
  let ch = cfg.clickhouse;
  try { ch = tableConfig(cfg, table).clickhouse; } catch (e) { /* profil invalide : la traduction le signale */ }
  const fm = ch.field_mapping || {};
  return Object.keys(fm).find(k => fm[k] === ch.time_field) || '@timestamp';
}

const EQ_UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
// « 90s », « 15m », « 2h », « 7d » → millisecondes ; null si la durée n’est pas lisible
function eqDuration(text) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(text).trim());
  return m ? Number(m[1]) * EQ_UNITS[m[2]] : null;
}
/*
 * Fenêtre de la comparaison : [from, to) fournis, ou « length » se terminant à now − lag, arrondi à la minute
 * (les mêmes bornes à chaque lancement dans la même minute).
 */
function eqWindow(opts, now) {
  const minute = 60000;
  if (opts.from || opts.to) {
    const from = Date.parse(opts.from); const to = Date.parse(opts.to || new Date(now).toISOString());
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: 'la fenêtre attend des dates ISO 8601 (2026-10-28T10:00:00Z)' };
    if (from >= to) return { error: 'le début de la fenêtre doit précéder sa fin' };
    return { from, to, explicit: true };
  }
  const length = eqDuration(opts.length || '1h'); const lag = eqDuration(opts.lag || '10m');
  if (length === null || lag === null || length <= 0) return { error: 'la longueur et le retard de la fenêtre s’écrivent 90s, 15m, 2h ou 7d' };
  const to = Math.floor((now - lag) / minute) * minute;
  return { from: to - length, to, explicit: false };
}

/* ---------- États et rapport ---------- */
const EQ_STATES = { identical: 'identique', different: 'différent', inconclusive: 'non concluant', not_compared: 'non comparé', error: 'en erreur' };
const EQ_STATE_ORDER = ['different', 'error', 'inconclusive', 'not_compared', 'identical'];

// État d’une requête d’après le résultat d’eqRunCase
function eqStateOf(res) {
  switch (res.verdict) {
    case '=':
      // Deux résultats vides sont égaux sans rien prouver
      if (res.docs === 0) return { state: 'inconclusive', reason: 'aucun document dans la fenêtre : deux résultats vides sont égaux sans rien prouver' };
      if (res.skipped && res.skipped.length) return { state: 'inconclusive', reason: `instruction non comparée : ${res.skipped.join(', ')}` };
      return { state: 'identical', reason: '' };
    case '≠': return { state: 'different', reason: res.estimate > 0 ? `Elasticsearch annonce une marge d’erreur sur ses terms (doc_count_error_upper_bound jusqu’à ${res.estimate}) : un écart peut venir de cette estimation par shard, pas de la traduction. Relancez avec un shard_size plus grand pour le savoir.` : '' };
    case 'RP': return { state: 'not_compared', reason: res.detail };
    case 'INC': return { state: 'inconclusive', reason: res.detail };
    case 'TR✗': return { state: 'error', reason: `traduction : ${res.detail}` };
    case 'ES✗': return { state: 'error', reason: `Elasticsearch : ${res.detail}` };
    default: return { state: 'error', reason: `ClickHouse : ${res.detail}` };
  }
}

function eqSummarize(items) {
  const by = Object.fromEntries(Object.keys(EQ_STATES).map(k => [k, 0]));
  const translation = { ready: 0, review: 0, todo: 0, unrecognized: 0 };
  for (const it of items) { by[it.state]++; if (it.translation && translation[it.translation.verdict] !== undefined) translation[it.translation.verdict]++; }
  return { total: items.length, byState: by, byTranslation: translation };
}
// Verdict d’ensemble : ce que dit le rapport en une phrase
function eqSentence(sum, what) {
  const s = sum.byState;
  if (!sum.total) return `Aucun ${what} comparé.`;
  const parts = [`${s.identical} identique${s.identical > 1 ? 's' : ''}`];
  if (s.different) parts.push(`${s.different} différent${s.different > 1 ? 's' : ''}`);
  if (s.error) parts.push(`${s.error} en erreur`);
  if (s.inconclusive) parts.push(`${s.inconclusive} non concluant${s.inconclusive > 1 ? 's' : ''}`);
  if (s.not_compared) parts.push(`${s.not_compared} non comparé${s.not_compared > 1 ? 's' : ''}`);
  return `${sum.total} ${what}${sum.total > 1 ? 's' : ''} : ${parts.join(', ')}.`;
}

const eqMd = s => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const eqHtml = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eqFrDate = iso => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

function eqSorted(items) {
  return items.map((it, i) => [it, i]).sort((a, b) => EQ_STATE_ORDER.indexOf(a[0].state) - EQ_STATE_ORDER.indexOf(b[0].state) || a[1] - b[1]).map(x => x[0]);
}
function eqReportMarkdown(rep) {
  const L = [];
  const what = rep.kind === 'pipelines' ? 'pipeline' : 'requête';
  L.push(`# Rapport d’équivalence — ${rep.kind === 'pipelines' ? 'pipelines' : 'requêtes'}`, '');
  L.push(`**Daté du ${eqFrDate(rep.generated_at)}** · Passerelle ${rep.passerelle}`, '');
  L.push(`> ${eqSentence(rep.summary, what)}`, '');
  L.push('## Conditions de la comparaison', '');
  const cond = rep.conditions;
  if (cond.window) L.push(`- Fenêtre de temps : du ${eqFrDate(new Date(cond.window.from).toISOString())} au ${eqFrDate(new Date(cond.window.to).toISOString())} (fin exclue), champ \`${eqMd(cond.window.field)}\`${cond.window.explicit ? '' : `, ${eqMd(cond.window.length)} se terminant ${eqMd(cond.window.lag)} avant le lancement`}.`);
  for (const [name, v] of Object.entries(cond.engines || {})) L.push(`- ${name} : ${eqMd(v)}`);
  if (cond.sample) L.push(`- Échantillon : ${eqMd(cond.sample)}`);
  for (const line of cond.notes || []) L.push(`- ${eqMd(line)}`);
  L.push('');
  const s = rep.summary;
  L.push('## Bilan', '', '| État | Nombre |', '|---|---:|');
  for (const k of EQ_STATE_ORDER) L.push(`| ${EQ_STATES[k]} | ${s.byState[k]} |`);
  L.push('');
  L.push(`## Détail par ${what}`, '');
  const pipelines = rep.kind === 'pipelines';
  L.push(pipelines ? '| Pipeline | Traduction | État | Événements | Durée |' : '| Requête | Traduction | État | Documents | Durée |', '|---|---|---|---:|---:|');
  for (const it of eqSorted(rep.items)) L.push(`| ${eqMd(it.title)} | ${it.translation ? eqMd(VERDICTS[it.translation.verdict] || it.translation.verdict) : ''} | ${EQ_STATES[it.state]} | ${it.docs === null || it.docs === undefined ? '' : it.docs} | ${it.elapsed_ms === undefined ? '' : `${(it.elapsed_ms / 1000).toFixed(1).replace('.', ',')} s`} |`);
  L.push('');
  const detailed = eqSorted(rep.items).filter(it => it.state !== 'identical');
  if (detailed.length) {
    L.push('## À lire', '');
    for (const it of detailed) {
      L.push(`### ${eqMd(it.title)} — ${EQ_STATES[it.state]}`, '');
      if (it.source) L.push(`Source : \`${eqMd(it.source)}\``, '');
      if (it.reason) L.push(it.reason, '');
      for (const d of it.diffs || []) L.push(`- ${d}`);
      if ((it.diffs || []).length) L.push('');
    }
  }
  L.push('---', '', rep.values_hidden ? 'Les valeurs des données (clés de groupe, identifiants, champs) sont masquées : le rapport ne contient que des comptes.' : 'Ce rapport peut citer des valeurs des données comparées (clés de groupe, identifiants, champs). Relancez avec --no-values avant de le partager hors de l’organisation.');
  return L.join('\n') + '\n';
}
function eqReportCSV(rep) {
  const cell = v => { const s = String(v === undefined || v === null ? '' : v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['titre', 'source', 'verdict_traduction', 'etat', 'documents', 'duree_ms', 'raison', 'ecarts'].join(';')];
  for (const it of rep.items) rows.push([it.title, it.source, it.translation ? it.translation.verdict : '', it.state, it.docs, it.elapsed_ms, it.reason, (it.diffs || []).join(' | ')].map(cell).join(';'));
  return '﻿' + rows.join('\r\n') + '\r\n';
}
function eqReportHTML(rep) {
  const h = eqHtml; const s = rep.summary; const what = rep.kind === 'pipelines' ? 'pipeline' : 'requête';
  const badge = st => `<span class="v v-${st}">${h(EQ_STATES[st])}</span>`;
  const total = s.total || 1;
  const bar = EQ_STATE_ORDER.filter(k => s.byState[k]).map(k => `<span class="seg v-${k}" style="flex:${s.byState[k]}" title="${h(EQ_STATES[k])} : ${s.byState[k]}"></span>`).join('');
  const rows = eqSorted(rep.items).map(it => `<tr><td>${h(it.title)}</td><td>${it.translation ? h(VERDICTS[it.translation.verdict] || it.translation.verdict) : ''}</td><td>${badge(it.state)}</td><td class="n">${it.docs === null || it.docs === undefined ? '' : it.docs}</td><td class="n">${it.elapsed_ms === undefined ? '' : `${(it.elapsed_ms / 1000).toFixed(1).replace('.', ',')} s`}</td></tr>`).join('');
  const details = eqSorted(rep.items).filter(it => it.state !== 'identical').map(it => `<section class="obj"><h3>${h(it.title)} ${badge(it.state)}</h3>${it.source ? `<p class="muted"><code>${h(it.source)}</code></p>` : ''}${it.reason ? `<p>${h(it.reason)}</p>` : ''}${(it.diffs || []).length ? `<ul>${it.diffs.map(d => `<li>${h(d)}</li>`).join('')}</ul>` : ''}</section>`).join('');
  const cond = rep.conditions;
  const lines = [];
  if (cond.window) lines.push(`Fenêtre de temps : du ${eqFrDate(new Date(cond.window.from).toISOString())} au ${eqFrDate(new Date(cond.window.to).toISOString())} (fin exclue), champ <code>${h(cond.window.field)}</code>`);
  for (const [name, v] of Object.entries(cond.engines || {})) lines.push(`${h(name)} : ${h(v)}`);
  if (cond.sample) lines.push(`Échantillon : ${h(cond.sample)}`);
  for (const l of cond.notes || []) lines.push(h(l));
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport d’équivalence</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--ok:#2f7d4f;--warn:#b7791f;--bad:#c0392b;--none:#7a7a7a;--code:#f3f2ee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--card:#1f1f1d;--ok:#5fbf86;--warn:#e0a84a;--bad:#ec7063;--none:#a0a0a0;--code:#262624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 10px}h3{font-size:16px;margin:0 0 4px}
.muted{color:var(--muted)}.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:14px 0 18px;background:var(--line)}
.seg.v-identical{background:var(--ok)}.seg.v-different,.seg.v-error{background:var(--bad)}.seg.v-inconclusive{background:var(--warn)}.seg.v-not_compared{background:var(--none)}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse}tr:last-child td{border-bottom:0}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;font-size:13px;color:var(--muted)}td.n,th.n{text-align:right;white-space:nowrap}
.v{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.v-identical{color:var(--ok)}.v-different,.v-error{color:var(--bad)}.v-inconclusive{color:var(--warn)}.v-not_compared{color:var(--none)}
.obj{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.obj ul{margin:6px 0 0;padding-left:20px}
code{background:var(--code);border-radius:4px;padding:0 4px;font-size:13px}
</style></head><body><main>
<h1>Rapport d’équivalence — ${rep.kind === 'pipelines' ? 'pipelines' : 'requêtes'}</h1>
<p class="muted">Daté du ${h(eqFrDate(rep.generated_at))} · Passerelle ${h(rep.passerelle)}</p>
<p><b>${h(eqSentence(s, what))}</b></p>
<div class="bar">${bar}</div>
<h2>Conditions de la comparaison</h2><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
<h2>Détail par ${what}</h2>
<div class="tw"><table><thead><tr><th>${rep.kind === 'pipelines' ? 'Pipeline' : 'Requête'}</th><th>Traduction</th><th>État</th><th class="n">${rep.kind === 'pipelines' ? 'Événements' : 'Documents'}</th><th class="n">Durée</th></tr></thead><tbody>${rows}</tbody></table></div>
${details ? `<h2>À lire</h2>${details}` : ''}
<p class="muted">${rep.values_hidden ? 'Les valeurs des données sont masquées : le rapport ne contient que des comptes.' : 'Ce rapport peut citer des valeurs des données comparées. Relancez avec --no-values avant de le partager hors de l’organisation.'}</p>
</main></body></html>
`;
}
