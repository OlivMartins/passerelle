/* Passerelle — moteur : schéma ClickHouse tiré d’Elasticsearch (mappings, modèles d’index, politiques ILM) */
import { CH_KW, chIdent, chStr, clone, isObj, makeNotes, OTEL_RESOURCE, painlessToSQL, PRESETS } from './base.js';
import { globToRe, makeDslCtx, mayBeNull, preprocessDSL } from './dsl.js';
import { toYAML } from './logstash.js';

/*
 * Une table ClickHouse bien faite décide de la vitesse de toutes les requêtes traduites. Elle se déduit en grande
 * partie de ce qu’Elasticsearch sait déjà de l’index :
 *   mapping          type de chaque colonne, champs texte (index text), objets, champs nested, champs runtime ;
 *   modèle d’index   motifs d’index (la table visée par index_mapping), composants, tri de l’index ;
 *   politique ILM    durée de conservation (TTL), donc la granularité de la partition.
 *
 * schemaFromElastic produit pour chaque modèle ou index un CREATE TABLE commenté et le profil de table que la
 * traduction lit (clickhouse.tables) : la requête traduite et la table créée suivent le même schéma.
 * Les choix qui reposent sur une heuristique (cardinalité d’un keyword, champ multivalué) sont signalés.
 */

/* ---------- Lecture des documents Elasticsearch ---------- */
/*
 * Formes acceptées, seules ou plusieurs dans un même texte :
 *   format console de Kibana   PUT _index_template/nom {…}, PUT _component_template/nom {…}, PUT _template/nom {…},
 *                              PUT _ilm/policy/nom {…}, PUT mon-index {…}, PUT mon-index/_mapping {…}
 *   réponses d’API             GET _index_template, GET _component_template, GET _template, GET _ilm/policy,
 *                              GET mon-index, GET mon-index/_mapping
 *   corps seuls                { mappings, settings }, { properties }, { index_patterns, template }, { policy }
 */
function esDocsFrom(text) {
  const src = String(text || '').trim();
  if (!src) return { docs: [] };
  const blocks = [];
  if (/^(GET|PUT|POST)\s+\S/i.test(src)) {
    // Requêtes successives de la console : une ligne « MÉTHODE chemin », puis son corps JSON
    const re = /^(GET|PUT|POST)\s+(\S+)[^\n]*$/gim;
    const heads = [...src.matchAll(re)];
    heads.forEach((m, i) => {
      const body = src.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length).trim();
      blocks.push({ path: m[2].replace(/^\//, '').replace(/\?.*$/, ''), body });
    });
  } else blocks.push({ path: '', body: src });
  const docs = [];
  const errors = [];
  for (const b of blocks) {
    if (!b.body) continue;
    let json;
    try {
      json = JSON.parse(preprocessDSL(b.body));
    } catch (e) {
      errors.push(`${b.path || 'document'} : JSON invalide (${e.message})`);
      continue;
    }
    if (!isObj(json)) {
      errors.push(`${b.path || 'document'} : objet JSON attendu`);
      continue;
    }
    docs.push(...classifyEsDoc(b.path, json));
  }
  return { docs, errors };
}
function classifyEsDoc(path, json) {
  const seg = String(path || '')
    .split('/')
    .filter(Boolean);
  const named = (kind, name, body) => [{ kind, name, body }];
  if (seg[0] === '_index_template' && seg[1]) return named('index_template', seg[1], json);
  if (seg[0] === '_component_template' && seg[1]) return named('component', seg[1], json);
  if (seg[0] === '_template' && seg[1]) return named('legacy', seg[1], json);
  if (seg[0] === '_ilm' && seg[1] === 'policy' && seg[2]) return named('ilm', seg[2], json);
  if (seg[0] && !seg[0].startsWith('_') && seg[1] === '_mapping') return named('index', seg[0], { mappings: json });
  if (seg[0] && !seg[0].startsWith('_') && !seg[1]) return named('index', seg[0], json);
  // Réponses d’API et corps seuls
  if (Array.isArray(json.index_templates))
    return json.index_templates
      .filter(isObj)
      .map(t => ({ kind: 'index_template', name: t.name, body: t.index_template || {} }));
  if (Array.isArray(json.component_templates))
    return json.component_templates
      .filter(isObj)
      .map(t => ({ kind: 'component', name: t.name, body: t.component_template || {} }));
  if (isObj(json.policy) && isObj(json.policy.phases)) return named('ilm', '', json);
  if (isObj(json.phases)) return named('ilm', '', { policy: json });
  if (Array.isArray(json.index_patterns) && (isObj(json.template) || json.composed_of))
    return named('index_template', '', json);
  if (Array.isArray(json.index_patterns) || typeof json.index_patterns === 'string') return named('legacy', '', json);
  if (isObj(json.template) && !json.index_patterns) return named('component', '', json);
  if (isObj(json.mappings) || isObj(json.settings)) return named('index', '', json);
  if (isObj(json.properties) || isObj(json.runtime)) return named('index', '', { mappings: json });
  // Objet dont chaque valeur est un index, un modèle hérité ou une politique (GET mon-index, GET _template, GET _ilm/policy)
  const out = [];
  for (const [name, v] of Object.entries(json)) {
    if (!isObj(v)) continue;
    if (isObj(v.policy) && isObj(v.policy.phases)) out.push({ kind: 'ilm', name, body: v });
    else if (v.index_patterns) out.push({ kind: 'legacy', name, body: v });
    else if (isObj(v.mappings) || isObj(v.settings)) out.push({ kind: 'index', name, body: v });
  }
  return out;
}

/* ---------- Réglages et mappings ---------- */
// Réglages à plat, sans le préfixe « index. » : { 'lifecycle.name': 'logs-30j', 'sort.field': ['@timestamp'] }
function flatSettings(settings) {
  const out = {};
  (function walk(o, pre) {
    for (const [k, v] of Object.entries(o || {})) {
      const key = pre ? `${pre}.${k}` : k;
      if (isObj(v) && !['analysis'].includes(key.replace(/^index\./, ''))) walk(v, key);
      else out[key.replace(/^index\./, '')] = v;
    }
  })(settings, '');
  return out;
}
// Mapping 6.x/7.x avec un nom de type (_doc, doc…) : le type est retiré
function unwrapMapping(m) {
  if (!isObj(m)) return {};
  if (m.properties || m.runtime || m.dynamic_templates) return m;
  const keys = Object.keys(m).filter(k => !k.startsWith('_') || k === '_doc');
  if (keys.length === 1 && isObj(m[keys[0]]) && (m[keys[0]].properties || m[keys[0]].runtime)) return m[keys[0]];
  return m;
}
function mergeMappings(a, b) {
  const out = clone(unwrapMapping(a));
  const m = unwrapMapping(b);
  for (const [k, v] of Object.entries(m)) {
    if ((k === 'properties' || k === 'runtime') && isObj(v)) out[k] = mergeProperties(out[k] || {}, v);
    else if (k === 'dynamic_templates' && Array.isArray(v)) out[k] = (out[k] || []).concat(v);
    else out[k] = clone(v);
  }
  return out;
}
function mergeProperties(a, b) {
  const out = clone(a);
  for (const [k, v] of Object.entries(b)) {
    if (isObj(out[k]) && isObj(v) && out[k].properties && v.properties && !v.type)
      out[k] = Object.assign({}, out[k], v, { properties: mergeProperties(out[k].properties, v.properties) });
    else out[k] = clone(v);
  }
  return out;
}
// Composants fournis par Elasticsearch pour les data streams de logs : ce qu’ils fixent de façon certaine
const BUILTIN_COMPONENTS = {
  'logs@mappings': {
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        data_stream: {
          properties: {
            type: { type: 'constant_keyword', value: 'logs' },
            dataset: { type: 'constant_keyword' },
            namespace: { type: 'constant_keyword' }
          }
        }
      }
    }
  },
  'data-streams@mappings': { mappings: { properties: { '@timestamp': { type: 'date' } } } }
};

/* ---------- Durées (ILM) ---------- */
const DURATION_S = { nanos: 1e-9, micros: 1e-6, ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
function durationSeconds(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(nanos|micros|ms|s|m|h|d)?\s*$/.exec(String(v === undefined ? '' : v));
  return m ? +m[1] * DURATION_S[m[2] || 'ms'] : null;
}
function intervalOf(seconds) {
  const s = Math.ceil(seconds);
  if (s % 86400 === 0) return { n: s / 86400, unit: 'DAY', days: s / 86400 };
  if (s % 3600 === 0) return { n: s / 3600, unit: 'HOUR' };
  if (s % 60 === 0) return { n: s / 60, unit: 'MINUTE' };
  return { n: s, unit: 'SECOND' };
}
export const frDuration = sec =>
  sec % 86400 === 0
    ? `${sec / 86400} j`
    : sec % 3600 === 0
      ? `${sec / 3600} h`
      : sec % 60 === 0
        ? `${sec / 60} min`
        : `${sec} s`;
/*
 * Conservation d’après ILM. Avec rollover, min_age d’une phase compte depuis le rollover de l’index : un document y
 * reste entre min_age et min_age + max_age du rollover. Le TTL prend la borne haute, pour ne jamais effacer plus tôt
 * qu’Elasticsearch. Les phases warm et cold deviennent des déplacements vers un volume, à condition de déclarer une
 * politique de stockage.
 */
function ilmRetention(policy) {
  const phases = (policy && policy.policy && policy.policy.phases) || {};
  const out = { moves: [], notes: [] };
  const rollover = phases.hot && phases.hot.actions && phases.hot.actions.rollover;
  const maxAge = rollover ? durationSeconds(rollover.max_age) : 0;
  if (rollover && !rollover.max_age)
    out.notes.push(
      'Rollover sans max_age (taille ou nombre de documents) : la durée réelle de conservation dépend du volume ; le TTL compte depuis l’horodatage du document.'
    );
  for (const name of ['warm', 'cold', 'frozen']) {
    const ph = phases[name];
    if (!ph || ph.min_age === undefined) continue;
    const s = durationSeconds(ph.min_age);
    if (s !== null) out.moves.push({ phase: name, seconds: s + (maxAge || 0) });
  }
  const del = phases.delete;
  if (del && del.actions && del.actions.delete !== undefined) {
    const s = durationSeconds(del.min_age === undefined ? '0ms' : del.min_age);
    if (s !== null) out.deleteSeconds = s + (maxAge || 0);
    if (maxAge)
      out.notes.push(
        `Rollover à ${frDuration(maxAge)} : Elasticsearch efface un document entre ${frDuration(s)} et ${frDuration(s + maxAge)} après sa date. Le TTL retient ${frDuration(s + maxAge)}, pour ne rien effacer plus tôt.`
      );
    if (del.actions.wait_for_snapshot)
      out.notes.push(
        'wait_for_snapshot : la suppression attendait une sauvegarde ; planifiez les sauvegardes ClickHouse (BACKUP) avant l’échéance du TTL.'
      );
  }
  for (const [name, ph] of Object.entries(phases)) {
    const acts = Object.keys((ph && ph.actions) || {}).filter(
      a =>
        ![
          'rollover',
          'delete',
          'set_priority',
          'migrate',
          'allocate',
          'forcemerge',
          'shrink',
          'readonly',
          'wait_for_snapshot',
          'downsample',
          'searchable_snapshot',
          'unfollow'
        ].includes(a)
    );
    if (acts.length)
      out.notes.push(`Phase ${name} : action${acts.length > 1 ? 's' : ''} ${acts.join(', ')} sans équivalent.`);
    if (ph && ph.actions && ph.actions.downsample)
      out.notes.push(
        `Phase ${name} : le sous-échantillonnage (downsample) se reproduit par une vue matérialisée d’agrégats (AggregatingMergeTree), avec son propre TTL.`
      );
  }
  return out;
}

/* ---------- Types ---------- */
const ES_SCALAR = {
  long: 'Int64',
  integer: 'Int32',
  short: 'Int16',
  byte: 'Int8',
  unsigned_long: 'UInt64',
  double: 'Float64',
  float: 'Float32',
  half_float: 'Float32',
  token_count: 'UInt32',
  rank_feature: 'Float32',
  boolean: 'Bool',
  binary: 'String',
  version: 'String',
  ip: 'String',
  murmur3: 'UInt64'
};
const ES_TEXT = new Set(['text', 'match_only_text', 'search_as_you_type', 'completion']);
const ES_KEYWORD = new Set(['keyword', 'constant_keyword', 'wildcard']);
// Champs que la convention ECS déclare multivalués
const ECS_ARRAYS = new Set([
  'tags',
  'event.category',
  'event.type',
  'related.hash',
  'related.hosts',
  'related.ip',
  'related.user',
  'host.ip',
  'host.mac',
  'process.args',
  'threat.tactic.id',
  'threat.technique.id',
  'vulnerability.category',
  'user.roles',
  'file.attributes'
]);
// Noms de feuille dont la cardinalité est faible par nature : LowCardinality(String) leur convient
const LOW_CARD =
  /(^|\.)(level|severity|severity_text|status|state|outcome|method|protocol|scheme|env|environment|region|zone|availability_zone|cluster|namespace|dataset|module|type|kind|category|action|service|version|os|platform|provider|family|country_iso_code|continent_name|facility|logger|language|tier|stage|app|application|team|tenant|datacenter|direction|transport|channel|priority|name)$/;
// … sauf pour les noms qui désignent un identifiant ou un texte libre
const HIGH_CARD =
  /(^|[._])(id|uuid|guid|hash|token|key|session|trace|span|transaction|request|correlation|message|msg|url|uri|path|query|referrer|referer|original|email|address|full|args|command_line|title|description|body|user\.name|file\.name|process\.name|pod\.name)$/;
function lowCardinality(path) {
  return LOW_CARD.test(path) && !HIGH_CARD.test(path) && !/(^|\.)(user|file|process|url|email|pod)\.name$/.test(path);
}
const isIdentifier = path =>
  /(^|[._])(id|uuid|guid|trace_id|span_id|request_id|transaction_id|session_id|correlation_id)$/.test(path);

/*
 * Colonnes d’un mapping. Chaque champ feuille devient une colonne de même nom ; « @timestamp » s’écrit timestamp.
 * Les objets ne sont qu’un préfixe (http.request.method) ; un objet dynamique sans propriétés ou flattened
 * devient une Map de chaînes, un champ nested une colonne Nested, dont chaque sous-champ est un tableau.
 */
function mappingColumns(mapping, opts) {
  const m = unwrapMapping(mapping);
  const cols = [];
  const fieldMap = {};
  const text = [];
  const notes = [];
  const stats = { ok: 0, approx: 0, ko: 0 };
  const copyTo = new Map();
  const types = {};
  const note = (level, title, detail) => {
    notes.push({ level, title, detail: detail || '' });
    if (level === 'warn') stats.approx++;
    if (level === 'err') stats.ko++;
  };
  const colName = path => (path === '@timestamp' ? 'timestamp' : path.replace(/^@/, ''));
  const add = (path, col) => {
    const name = colName(path);
    if (name !== path) fieldMap[path] = name;
    const c = Object.assign({ name, field: path }, col);
    cols.push(c);
    types[path] = col.esType;
    return c;
  };
  const scalarType = (path, p, inNested) => {
    const t = p.type;
    if (ES_TEXT.has(t)) return { ch: 'String', kind: 'text' };
    if (ES_KEYWORD.has(t))
      return {
        ch: 'String',
        kind: t === 'wildcard' ? 'wildcard' : 'keyword',
        low: t === 'constant_keyword' || (!inNested && lowCardinality(path))
      };
    if (t === 'date') return { ch: "DateTime64(3, 'UTC')", kind: 'date' };
    if (t === 'date_nanos') return { ch: "DateTime64(9, 'UTC')", kind: 'date' };
    if (t === 'scaled_float') {
      const f = Number(p.scaling_factor);
      const digits = Math.log10(f);
      return Number.isInteger(digits) && digits >= 0 && digits <= 18
        ? { ch: `Decimal(18, ${digits})`, kind: 'number' }
        : { ch: 'Float64', kind: 'number' };
    }
    if (ES_SCALAR[t])
      return {
        ch: ES_SCALAR[t],
        kind: t === 'boolean' ? 'bool' : t === 'ip' ? 'ip' : /String/.test(ES_SCALAR[t]) ? 'keyword' : 'number'
      };
    return null;
  };
  (function walk(props, prefix) {
    for (const [name, p] of Object.entries(props || {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (!isObj(p)) continue;
      const type = p.type || 'object';
      if (type === 'object' && p.properties && p.enabled !== false) {
        walk(p.properties, path);
        continue;
      }
      if (type === 'alias') {
        // Un alias ne contient rien : la traduction lit le champ désigné
        if (p.path) {
          fieldMap[path] = colName(String(p.path));
          stats.ok++;
        }
        continue;
      }
      if (type === 'object' || type === 'flattened') {
        add(path, { type: opts.json ? 'JSON' : 'Map(LowCardinality(String), String)', esType: type, map: true });
        note(
          'info',
          `${path} : objet ${type === 'flattened' ? 'flattened' : 'sans propriétés déclarées'}`,
          `Ses sous-champs, inconnus à l’avance, sont rangés dans une colonne ${opts.json ? 'JSON' : 'Map de chaînes'} et se lisent par leur nom complet. Déclarez la colonne dans clickhouse.attributes pour que la traduction y cherche ces champs.`
        );
        stats.ok++;
        continue;
      }
      if (type === 'nested') {
        const subs = [];
        (function leaves(ps, pre) {
          for (const [n2, p2] of Object.entries(ps || {})) {
            const sp = pre ? `${pre}.${n2}` : n2;
            if (isObj(p2) && p2.properties && (p2.type || 'object') === 'object') {
              leaves(p2.properties, sp);
              continue;
            }
            const st = isObj(p2) ? scalarType(`${path}.${sp}`, p2, true) : null;
            if (st) subs.push({ name: sp, type: st.ch, text: st.kind === 'text' });
            else
              note(
                'warn',
                `${path}.${sp} : sous-champ nested ignoré`,
                `Type ${isObj(p2) ? p2.type || 'object' : '?'} imbriqué dans un champ nested : à décrire à la main.`
              );
          }
        })(p.properties, '');
        if (!subs.length) {
          note('warn', `${path} : champ nested vide`, 'Aucun sous-champ exploitable.');
          continue;
        }
        add(path, {
          type: `Nested(${subs.map(s => `${chIdent(s.name)} ${s.type}`).join(', ')})`,
          esType: 'nested',
          nested: subs
        });
        note(
          'warn',
          `${path} : champ nested`,
          `Les objets deviennent des tableaux parallèles (${subs.map(s => `${path}.${s.name}`).join(', ')}). Une requête nested qui exige que deux conditions portent sur le même objet se réécrit avec arrayExists((a, b) -> …, ${path}.a, ${path}.b).`
        );
        continue;
      }
      if (['integer_range', 'long_range', 'float_range', 'double_range', 'date_range', 'ip_range'].includes(type)) {
        const inner = {
          integer_range: 'Int32',
          long_range: 'Int64',
          float_range: 'Float32',
          double_range: 'Float64',
          date_range: "DateTime64(3, 'UTC')",
          ip_range: 'String'
        }[type];
        add(path, { type: `Tuple(gte Nullable(${inner}), lte Nullable(${inner}))`, esType: type });
        note(
          'warn',
          `${path} : champ ${type}`,
          'Rangé en Tuple(gte, lte). Les requêtes range sur un champ d’intervalle (relation intersects, contains, within) se réécrivent à la main.'
        );
        continue;
      }
      if (type === 'geo_point') {
        add(path, { type: 'Point', esType: type });
        note(
          'info',
          `${path} : geo_point`,
          'Colonne Point, rangée (longitude, latitude) comme le suppose la traduction de geo_distance. Un point écrit en chaîne « lat,lon » ou en geohash est à convertir à l’ingestion.'
        );
        stats.ok++;
        continue;
      }
      if (['geo_shape', 'shape', 'point'].includes(type)) {
        add(path, { type: 'String', esType: type });
        note(
          'warn',
          `${path} : ${type}`,
          'Rangé en texte (GeoJSON ou WKT). Les requêtes géométriques se réécrivent avec les fonctions de ClickHouse (pointInPolygon, polygonsIntersection…).'
        );
        continue;
      }
      if (type === 'dense_vector') {
        add(path, { type: 'Array(Float32)', esType: type, vector: p.dims });
        note(
          'info',
          `${path} : dense_vector`,
          `Colonne Array(Float32)${p.dims ? ` de ${p.dims} dimensions` : ''}. La recherche kNN se réécrit avec L2Distance ou cosineDistance, accélérée par un index vector_similarity.`
        );
        stats.ok++;
        continue;
      }
      if (type === 'sparse_vector' || type === 'rank_features') {
        add(path, { type: 'Map(LowCardinality(String), Float32)', esType: type });
        stats.ok++;
        continue;
      }
      if (type === 'histogram') {
        add(path, { type: 'Tuple(values Array(Float64), counts Array(UInt64))', esType: type });
        note(
          'warn',
          `${path} : histogram`,
          'Rangé en Tuple(values, counts) ; les agrégations qui le lisent (percentiles pré-agrégés) se réécrivent à la main.'
        );
        continue;
      }
      if (type === 'aggregate_metric_double') {
        add(path, {
          type: 'Tuple(min Nullable(Float64), max Nullable(Float64), sum Nullable(Float64), value_count Nullable(UInt64))',
          esType: type
        });
        note(
          'warn',
          `${path} : aggregate_metric_double`,
          'Rangé en Tuple ; une table AggregatingMergeTree est souvent le meilleur équivalent.'
        );
        continue;
      }
      if (['percolator', 'join', 'semantic_text', 'passthrough'].includes(type)) {
        note('err', `${path} : type ${type} non traduit`, 'Pas d’équivalent automatique dans une colonne ClickHouse.');
        continue;
      }
      const st = scalarType(path, p, false);
      if (!st) {
        note('err', `${path} : type ${type} inconnu`, 'Type de champ non reconnu : colonne à décrire à la main.');
        continue;
      }
      const col = { type: st.ch, esType: type, kind: st.kind, low: !!st.low };
      if (type === 'constant_keyword' && p.value !== undefined) col.default = chStr(String(p.value));
      if (st.kind === 'text') text.push(path);
      const added = add(path, col);
      stats.ok++;
      // Sous-champs : .keyword est la valeur brute, que la traduction lit déjà dans la colonne ; les autres y renvoient
      for (const [sub, sp] of Object.entries(p.fields || {})) {
        const subPath = `${path}.${sub}`;
        if (sub === 'keyword' && isObj(sp) && sp.type === 'keyword') continue;
        fieldMap[subPath] = colName(path);
        if (isObj(sp) && ES_TEXT.has(sp.type)) {
          text.push(subPath);
          added.textSub = true;
        }
        if (isObj(sp) && sp.analyzer)
          added.subAnalyzers = (added.subAnalyzers || []).concat([{ field: subPath, analyzer: sp.analyzer }]);
      }
      if (p.analyzer || p.search_analyzer) added.analyzer = p.analyzer || p.search_analyzer;
      if (p.normalizer) added.normalizer = p.normalizer;
      for (const target of [].concat(p.copy_to || [])) {
        if (!copyTo.has(target)) copyTo.set(target, []);
        copyTo.get(target).push(path);
      }
    }
  })(m.properties || {}, '');
  // copy_to : le champ cible est rempli par Elasticsearch à l’indexation ; ClickHouse le calcule à l’insertion
  for (const [target, sources] of copyTo) {
    const c = cols.find(x => x.field === target);
    if (!c || (c.kind !== 'text' && c.kind !== 'keyword')) {
      note(
        'warn',
        `copy_to vers ${target}`,
        `Le champ cible n’est pas un champ texte ou keyword du mapping : ${sources.join(', ')} y sont copiés par Elasticsearch, à reproduire à la main.`
      );
      continue;
    }
    c.materialized = `concatWithSeparator(' ', ${sources
      .map(s => {
        const sc = cols.find(x => x.field === s);
        const id = chIdent(sc ? sc.name : s);
        return sc && sc.kind === 'number' ? `ifNull(toString(${id}), '')` : `ifNull(${id}, '')`;
      })
      .join(', ')})`;
    note(
      'info',
      `copy_to vers ${target}`,
      `La colonne ${c.name} est calculée à l’insertion (MATERIALIZED) depuis ${sources.join(', ')}, comme Elasticsearch la remplit à l’indexation.`
    );
  }
  if (isObj(m.dynamic_templates) || (Array.isArray(m.dynamic_templates) && m.dynamic_templates.length)) {
    note(
      'info',
      'Modèles dynamiques (dynamic_templates)',
      `Ils typent les champs inconnus à leur arrivée ; ClickHouse n’ajoute pas de colonne en route. Les champs qui ne sont pas des colonnes peuvent être rangés dans une Map ou une colonne JSON${opts.json ? '' : ' (option --json)'} déclarée dans clickhouse.attributes.`
    );
  }
  if (m.dynamic === 'strict')
    note(
      'info',
      'dynamic: strict',
      'Elasticsearch refusait un champ inconnu ; ClickHouse refuse lui aussi une colonne inconnue, sauf input_format_skip_unknown_fields.'
    );
  return { cols, fieldMap, text, notes, stats, types, runtime: m.runtime || {} };
}
// Champs runtime du mapping : traduits depuis Painless en colonnes MATERIALIZED, une fois connus les types des colonnes qu’ils lisent
function runtimeColumns(mc, cfg, table) {
  const out = [];
  for (const [name, def] of Object.entries(mc.runtime)) {
    const sc = isObj(def) ? def.script : null;
    const src = typeof sc === 'string' ? sc : sc && sc.source;
    if (!src) {
      mc.notes.push({
        level: 'info',
        title: `${name} : champ runtime sans script`,
        detail: 'Il ne fait que relire un champ existant.',
        code: ''
      });
      continue;
    }
    try {
      const ctx = makeDslCtx(
        Object.assign({}, cfg, {
          clickhouse: Object.assign({}, cfg.clickhouse, {
            field_mapping: mc.fieldMap,
            columns: Object.fromEntries(mc.cols.map(c => [c.name, c.finalType])),
            attributes: {}
          })
        })
      );
      ctx.columns = new Set();
      ctx.table = table;
      const r = painlessToSQL(ctx, src, { mode: 'emit', params: (isObj(sc) && sc.params) || {}, rtType: def.type });
      const chType =
        {
          keyword: 'String',
          long: 'Int64',
          double: 'Float64',
          date: "DateTime64(3, 'UTC')",
          boolean: 'Bool',
          ip: 'String'
        }[def.type] || 'String';
      // Le script lit une colonne Nullable ou n’émet rien dans une branche : la colonne calculée est Nullable
      const nullable = mayBeNull(ctx, r.sql) || /\bNULL\b/.test(r.sql.replace(/'(?:[^'\\]|\\.)*'/g, "''"));
      out.push({
        name,
        field: name,
        type: chType,
        finalType: nullable ? nullableType(chType) : chType,
        esType: `runtime ${def.type}`,
        materialized: r.sql,
        runtime: true,
        kind: def.type === 'date' ? 'date' : 'runtime'
      });
      mc.stats.ok++;
    } catch (e) {
      mc.notes.push({
        level: 'err',
        title: `${name} : champ runtime non traduit`,
        detail: `Painless : ${e.message}.`,
        code: ''
      });
      mc.stats.ko++;
    }
  }
  return out;
}
const ddlIdent = n =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !CH_KW.has(n.toLowerCase())
    ? n
    : '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

/* ---------- Table ---------- */
function tableNameFor(cfg, patterns, fallback) {
  const ch = cfg.clickhouse;
  for (const idx of patterns) {
    for (const [pat, table] of Object.entries(ch.index_mapping || {})) {
      const probe = String(idx).replace(/\*/g, 'x');
      if (pat === idx || new RegExp(globToRe(pat)).test(probe)) return { table, matched: pat };
    }
  }
  const base =
    String(patterns[0] || fallback || 'events')
      .replace(/^\.ds-/, '')
      .replace(/[-_.]?\*.*$/, '')
      .replace(/[-_.](\d{4}[.-]\d{2}([.-]\d{2})?|\d{6})$/, '')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'events';
  return { table: `${ch.database || 'default'}.${base}`, matched: null };
}
function nullableType(t) {
  return /^LowCardinality\(/.test(t)
    ? t.replace(/^LowCardinality\((.*)\)$/, 'LowCardinality(Nullable($1))')
    : `Nullable(${t})`;
}
function columnSQL(c) {
  const parts = [`${ddlIdent(c.name)} ${c.finalType}`];
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  if (c.materialized) parts.push(`MATERIALIZED ${c.materialized}`);
  if (c.comment) parts.push(`COMMENT ${chStr(c.comment)}`);
  if (c.codec) parts.push(`CODEC(${c.codec})`);
  return parts.join(' ');
}
/*
 * CREATE TABLE d’une table de logs.
 *   clé de tri   tri de l’index s’il est déclaré, sinon une ou deux dimensions de faible cardinalité, puis la date
 *   partition    par jour quand la conservation ne dépasse pas 90 jours (TTL par parties entières), par mois sinon
 *   Nullable     un champ facultatif reste distinct d’une valeur par défaut, comme dans Elasticsearch ; --compact
 *                l’écarte pour les chaînes (la chaîne vide vaut alors absence, empty_as_missing)
 */
function buildTable(cfg, src, opts) {
  const notes = [];
  const stats = { ok: 0, approx: 0, ko: 0 };
  const note = (level, title, detail, code) => {
    notes.push({ level, title, detail: detail || '', code: code || '' });
  };
  const { table } = opts.table ? { table: opts.table } : tableNameFor(cfg, src.patterns, src.name);
  const mc = mappingColumns(src.mappings, { json: !!opts.json, cfg, table });
  mc.notes.forEach(n => notes.push(n));
  Object.keys(stats).forEach(k => (stats[k] += mc.stats[k]));
  const cols = mc.cols;
  if (!cols.length) return { table, error: 'aucun champ dans le mapping', notes, stats };
  const settings = flatSettings(src.settings);
  // Colonne temporelle : @timestamp, sinon le premier champ date au nom évocateur
  const dates = cols.filter(c => c.kind === 'date' && !c.runtime);
  const time =
    dates.find(c => c.field === '@timestamp') ||
    dates.find(c => /(^|\.)(timestamp|time|date|ts)$/.test(c.field)) ||
    dates[0] ||
    null;
  if (!time)
    note(
      'warn',
      'Aucune colonne de date',
      'Le mapping n’a pas de champ date : la table n’est ni partitionnée ni conservée par date, et la traduction n’a pas de colonne temporelle par défaut.'
    );
  // Types finaux : tableaux, Nullable, LowCardinality, codecs
  for (const c of cols) {
    let t = c.type;
    if (ECS_ARRAYS.has(c.field) && !c.map && !c.nested) {
      t = `Array(${c.low ? 'LowCardinality(String)' : t})`;
      c.array = true;
    } else if (c.low && t === 'String') t = 'LowCardinality(String)';
    const scalar = !c.array && !c.map && !c.nested && !/^(Tuple|Point|Array|Map|JSON)/.test(t);
    const required = c === time || c.esType === 'constant_keyword' || !!c.materialized;
    const compactString = opts.compact && /String\)?$/.test(t) && !/Nullable/.test(t);
    if (scalar && !required && !compactString) t = nullableType(t);
    c.finalType = t;
    if (c === time) c.codec = 'Delta(8), ZSTD(1)';
    else if (c.kind === 'text' || c.field === 'event.original') c.codec = 'ZSTD(1)';
    c.comment = `Elasticsearch : ${c.field} (${c.esType})`;
  }
  for (const rc of runtimeColumns(mc, cfg, table)) {
    rc.comment = `champ runtime Elasticsearch ${rc.field}`;
    cols.push(rc);
  }
  // Clé de tri
  const byField = f => cols.find(c => c.field === f || c.name === f);
  let sortCols = [];
  const indexSort = [].concat(settings['sort.field'] || []).map(String);
  if (indexSort.length) {
    sortCols = indexSort.map(byField).filter(c => c && !c.array && !c.map && !c.nested);
    note(
      'info',
      'Clé de tri reprise du tri de l’index',
      `index.sort.field (${indexSort.join(', ')}) devient la clé de tri, sens compris : ClickHouse trie en croissant et lit à rebours pour un tri décroissant.`
    );
  } else {
    const prefer = [
      'service.name',
      'service',
      'kubernetes.namespace',
      'event.dataset',
      'host.name',
      'host',
      'log.level',
      'level'
    ];
    sortCols = prefer
      .map(byField)
      .filter(c => c && /LowCardinality/.test(c.finalType) && !c.array)
      .slice(0, 1);
  }
  if (time && !sortCols.includes(time)) sortCols.push(time);
  const ttlCol = time;
  // Conservation (ILM)
  const ret = src.ilm ? ilmRetention(src.ilm) : null;
  const ttl = [];
  let daily = false;
  if (ret && ttlCol) {
    if (ret.deleteSeconds !== undefined) {
      const iv = intervalOf(ret.deleteSeconds);
      ttl.push(`${ddlIdent(ttlCol.name)} + INTERVAL ${iv.n} ${iv.unit} DELETE`);
      daily = ret.deleteSeconds <= 90 * 86400;
      stats.ok++;
    }
    ret.notes.forEach(n => note('info', `Politique ILM ${src.ilmName || ''}`.trim(), n));
    if (ret.moves.length)
      note(
        'opt',
        'Phases warm et cold',
        `Les phases ${ret.moves.map(x => `${x.phase} (${frDuration(x.seconds)})`).join(', ')} peuvent déplacer les parties anciennes vers un stockage moins cher. Déclarez une politique de stockage (storage_policy) avec ces volumes, puis ajoutez au TTL :`,
        ret.moves
          .map(x => {
            const iv = intervalOf(x.seconds);
            return `    ${ddlIdent(ttlCol.name)} + INTERVAL ${iv.n} ${iv.unit} TO VOLUME '${x.phase}'`;
          })
          .join(',\n')
      );
  } else if (src.ilmName && !src.ilm)
    note(
      'warn',
      `Politique ILM ${src.ilmName} non fournie`,
      'Ajoutez sa définition (GET _ilm/policy/' + src.ilmName + ') aux fichiers lus pour en tirer le TTL.'
    );
  if (settings['lifecycle.name'] === undefined && !ret && time)
    note(
      'info',
      'Aucune politique ILM',
      'Sans durée de conservation connue, la table n’a pas de TTL et la partition est mensuelle. Ajoutez TTL timestamp + INTERVAL n DAY DELETE si les données expirent.'
    );
  // Index de saut
  const indexes = [];
  for (const c of cols) {
    const id = ddlIdent(c.name);
    const base = c.name.replace(/[^A-Za-z0-9_]/g, '_');
    // Colonne Array(String) : lowerUTF8 n’en accepte pas, le préprocesseur de l’index s’applique à chaque valeur
    if (c.kind === 'text' || c.textSub)
      indexes.push(
        c.array
          ? `INDEX idx_${base}_text ${id} TYPE text(tokenizer = splitByNonAlpha, preprocessor = lowerUTF8(${id}))`
          : `INDEX idx_${base}_text lowerUTF8(${id}) TYPE text(tokenizer = splitByNonAlpha)`
      );
    else if (c.kind === 'wildcard') indexes.push(`INDEX idx_${base}_ngram ${id} TYPE text(tokenizer = ngrams(3))`);
    else if (c.kind === 'keyword' && isIdentifier(c.field) && !c.array)
      indexes.push(`INDEX idx_${base}_bf ${id} TYPE bloom_filter(0.01) GRANULARITY 1`);
    else if (c.vector)
      indexes.push(`INDEX idx_${base}_vec ${id} TYPE vector_similarity('hnsw', 'cosineDistance', ${c.vector})`);
  }
  if (cols.some(c => c.kind === 'text'))
    note(
      'opt',
      'Index text sur les champs plein texte',
      'Chaque champ text reçoit un index text construit sur lowerUTF8(colonne), l’expression qu’emploie la traduction de match et query_string : un bloc sans le mot cherché est sauté sans être lu.'
    );
  if (cols.some(c => c.kind === 'wildcard'))
    note(
      'opt',
      'Champs wildcard',
      "Un index text à trigrammes (ngrams(3)) accélère LIKE '%motif%', l’équivalent des requêtes wildcard que ce type de champ servait."
    );
  const lows = cols
    .filter(c => /LowCardinality/.test(c.finalType) && c.esType !== 'constant_keyword' && !c.map && !c.array)
    .map(c => c.field);
  if (lows.length)
    note(
      'warn',
      'LowCardinality supposé',
      `${lows.join(', ')} : leur nom suggère peu de valeurs distinctes. Au-delà de quelques dizaines de milliers, String convient mieux ; vérifiez avec l’agrégation cardinality ci-dessous.`,
      `GET ${src.patterns[0] || src.name}/_search\n{ "size": 0, "aggs": { ${lows
        .slice(0, 6)
        .map(f => `"${f}": { "cardinality": { "field": "${f}" } }`)
        .join(', ')} } }`
    );
  const arrays = cols.filter(c => c.array).map(c => c.field);
  if (arrays.length)
    note(
      'info',
      'Champs multivalués',
      `${arrays.join(', ')} : la convention ECS les déclare multivalués, ils deviennent des colonnes Array. Un autre champ qui reçoit des tableaux doit être déclaré Array(…) à la main : un mapping Elasticsearch ne le dit pas.`
    );
  else
    note(
      'info',
      'Champs multivalués',
      'Un mapping Elasticsearch ne dit pas quels champs reçoivent des tableaux. Ceux qui en reçoivent doivent être déclarés Array(…) à la main, dans la table et dans le profil.'
    );
  if (!opts.compact && cols.some(c => /Nullable/.test(c.finalType)))
    note(
      'info',
      'Colonnes Nullable',
      'Un champ facultatif reste NULL quand il est absent, comme dans Elasticsearch : exists, must_not et les moyennes gardent leur sens. L’option --compact retire Nullable des chaînes (la chaîne vide vaut alors absence) pour un stockage plus léger.'
    );
  // Moteur, partition, TTL
  const cluster = cfg.clickhouse.cluster ? ` ON CLUSTER ${chIdent(cfg.clickhouse.cluster)}` : '';
  const engine = cfg.clickhouse.cluster ? 'ReplicatedMergeTree' : 'MergeTree';
  const partition = time ? `${daily ? 'toYYYYMMDD' : 'toYYYYMM'}(${ddlIdent(time.name)})` : null;
  const order = sortCols.length
    ? sortCols.length === 1
      ? ddlIdent(sortCols[0].name)
      : `(${sortCols.map(c => ddlIdent(c.name)).join(', ')})`
    : 'tuple()';
  const settingsSQL = [];
  // Une colonne Nullable dans la clé de tri demande allow_nullable_key ; NULL s’y classe en dernier
  if (sortCols.some(c => /Nullable/.test(c.finalType))) {
    settingsSQL.push('allow_nullable_key = 1');
    note(
      'info',
      'Clé de tri Nullable',
      `${sortCols
        .filter(c => /Nullable/.test(c.finalType))
        .map(c => c.name)
        .join(
          ', '
        )} : Nullable pour garder l’absence d’un champ, la colonne entre dans la clé de tri avec allow_nullable_key = 1.`
    );
  }
  if (daily && ttl.length && ret && ret.deleteSeconds % 86400 === 0) settingsSQL.push('ttl_only_drop_parts = 1');
  if (settings.codec === 'best_compression')
    note(
      'info',
      'index.codec: best_compression',
      'Les codecs ZSTD des colonnes de texte jouent ce rôle ; ZSTD(3) compresse davantage, au prix du temps d’insertion.'
    );
  const lines = cols.map(columnSQL).concat(indexes);
  const sql =
    [
      `-- Table tirée ${src.kind === 'index_template' ? 'du modèle d’index' : src.kind === 'legacy' ? 'du modèle d’index hérité' : 'de l’index'} ${src.name || src.patterns.join(', ')}${src.patterns.length && src.patterns.join(', ') !== src.name ? ` (${src.patterns.join(', ')})` : ''}`,
      `CREATE TABLE IF NOT EXISTS ${table}${cluster}`,
      '(',
      lines.map((l, i) => `    ${l}${i < lines.length - 1 ? ',' : ''}`).join('\n'),
      ')',
      `ENGINE = ${engine}`,
      partition ? `PARTITION BY ${partition}` : null,
      `ORDER BY ${order}`,
      ttl.length ? `TTL ${ttl.join(',\n    ')}` : null,
      settingsSQL.length ? `SETTINGS ${settingsSQL.join(', ')}` : null
    ]
      .filter(Boolean)
      .join('\n') + ';';
  // Profil de table pour la traduction
  const profile = {};
  if (time) profile.time_field = time.name;
  if (mc.text.length) profile.text_fields = [...new Set(mc.text)];
  if (Object.keys(mc.fieldMap).length) profile.field_mapping = mc.fieldMap;
  profile.columns = Object.fromEntries(cols.map(c => [c.name, c.finalType]));
  const maps = cols.filter(c => c.map).map(c => c.name);
  if (maps.length)
    profile.attributes = Object.fromEntries(maps.map(n => [n, [`${cols.find(c => c.name === n).field}.*`]]));
  if (opts.compact) profile.empty_as_missing = true;
  const analyzers = analyzersFor(src, cols);
  if (analyzers) profile.analyzers = analyzers;
  stats.ok++;
  return { table, sql, profile, notes, stats, patterns: src.patterns, source: { kind: src.kind, name: src.name } };
}
// Analyseurs des champs texte (voir analysis.js) : seuls les analyseurs déclarés dans les réglages de l’index sont repris
function analyzersFor(src, cols) {
  const analysis =
    (src.settings && (src.settings.analysis || (src.settings.index && src.settings.index.analysis))) || null;
  const out = {};
  for (const c of cols) {
    for (const a of [c.analyzer ? { field: c.field, analyzer: c.analyzer } : null]
      .concat(c.subAnalyzers || [])
      .filter(Boolean)) {
      if (a.analyzer === 'standard') continue;
      const def = analysis && analysis.analyzer && analysis.analyzer[a.analyzer];
      out[a.field] = def
        ? Object.assign(
            { name: a.analyzer },
            clone(def),
            analysis.filter || analysis.char_filter || analysis.tokenizer
              ? {
                  definitions: {
                    filter: analysis.filter || {},
                    char_filter: analysis.char_filter || {},
                    tokenizer: analysis.tokenizer || {}
                  }
                }
              : {}
          )
        : a.analyzer;
    }
  }
  return Object.keys(out).length ? out : null;
}

/*
 * Table OpenTelemetry (préréglages otel et otel-json). Le schéma est celui de l’exportateur ClickHouse d’OpenTelemetry ;
 * le mapping Elasticsearch ne sert qu’à typer les attributs : attribute_types pour une Map de chaînes, chemins typés
 * (Nullable, pour garder l’absence) pour une colonne JSON.
 */
function buildOtelTable(cfg, src, opts) {
  const preset = opts.preset;
  const json = preset === 'otel-json';
  const notes = [];
  const stats = { ok: 0, approx: 0, ko: 0 };
  const { table } = opts.table ? { table: opts.table } : tableNameFor(cfg, src.patterns, src.name);
  const mc = mappingColumns(src.mappings, { json, cfg, table });
  const P = PRESETS[preset];
  const columns = new Set(Object.keys(P.columns));
  const attrTypes = {};
  for (const c of mc.cols) {
    if (P.field_mapping[c.field] || columns.has(c.name) || c.map || c.nested || c.runtime) continue;
    const t = c.type.replace(/^Nullable\((.*)\)$/, '$1').replace(/, 'UTC'\)$/, ')');
    if (c.kind === 'number' || c.kind === 'bool' || c.kind === 'date') attrTypes[c.field] = t;
    stats.ok++;
  }
  const isResource = f => OTEL_RESOURCE.some(p => new RegExp(globToRe(p)).test(f));
  const typed = Object.entries(attrTypes).filter(([f]) => !isResource(f));
  const typedResource = Object.entries(attrTypes).filter(([f]) => isResource(f));
  const jsonOf = list =>
    json && list.length
      ? `JSON(${list.map(([f, t]) => `\`${f.replace(/`/g, '\\`')}\` Nullable(${t})`).join(', ')})`
      : 'JSON';
  const jsonType = jsonOf(typed);
  const jsonResource = jsonOf(typedResource);
  const mapType = 'Map(LowCardinality(String), String)';
  const attrCol = json ? jsonType : mapType;
  // Champs multivalués (convention ECS) : une Map de chaînes ne garde pas un tableau, ils deviennent des colonnes Array
  const arrays = mc.cols.filter(c => ECS_ARRAYS.has(c.field) && !P.field_mapping[c.field] && !c.map && !c.nested);
  const arrayCols = arrays.map(c => ({ name: c.name, type: `Array(${c.low ? 'LowCardinality(String)' : c.type})` }));
  const cluster = cfg.clickhouse.cluster ? ` ON CLUSTER ${chIdent(cfg.clickhouse.cluster)}` : '';
  const ret = src.ilm ? ilmRetention(src.ilm) : null;
  const ttl =
    ret && ret.deleteSeconds !== undefined
      ? (iv => `TTL Timestamp + INTERVAL ${iv.n} ${iv.unit} DELETE`)(intervalOf(ret.deleteSeconds))
      : null;
  const lines = [
    '`Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1))',
    '`TraceId` String CODEC(ZSTD(1))',
    '`SpanId` String CODEC(ZSTD(1))',
    '`TraceFlags` UInt8',
    '`SeverityText` LowCardinality(String) CODEC(ZSTD(1))',
    '`SeverityNumber` UInt8',
    '`ServiceName` LowCardinality(String) CODEC(ZSTD(1))',
    '`Body` String CODEC(ZSTD(1))',
    '`ResourceSchemaUrl` LowCardinality(String) CODEC(ZSTD(1))',
    `\`ResourceAttributes\` ${json ? jsonResource : mapType} CODEC(ZSTD(1))`,
    ...(json ? ['`ResourceAttributesKeys` Array(LowCardinality(String)) CODEC(ZSTD(1))'] : []),
    '`ScopeSchemaUrl` LowCardinality(String) CODEC(ZSTD(1))',
    '`ScopeName` String CODEC(ZSTD(1))',
    '`ScopeVersion` LowCardinality(String) CODEC(ZSTD(1))',
    `\`ScopeAttributes\` ${json ? 'JSON' : mapType} CODEC(ZSTD(1))`,
    ...(json ? ['`ScopeAttributesKeys` Array(LowCardinality(String)) CODEC(ZSTD(1))'] : []),
    `\`LogAttributes\` ${attrCol} CODEC(ZSTD(1))`,
    ...(json ? ['`LogAttributesKeys` Array(LowCardinality(String)) CODEC(ZSTD(1))'] : []),
    '`EventName` String CODEC(ZSTD(1))',
    ...arrayCols.map(c => `${ddlIdent(c.name)} ${c.type} CODEC(ZSTD(1))`),
    'INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1',
    ...(json
      ? [
          'INDEX idx_res_attr_keys ResourceAttributesKeys TYPE bloom_filter(0.01) GRANULARITY 1',
          'INDEX idx_log_attr_keys LogAttributesKeys TYPE bloom_filter(0.01) GRANULARITY 1'
        ]
      : [
          'INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1',
          'INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1',
          'INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1',
          'INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1'
        ]),
    'INDEX idx_body lowerUTF8(Body) TYPE text(tokenizer = splitByNonAlpha)'
  ];
  const sql =
    [
      `-- Table OpenTelemetry (${preset}) pour ${src.name || src.patterns.join(', ')}`,
      `CREATE TABLE IF NOT EXISTS ${table}${cluster}`,
      '(',
      lines.map((l, i) => `    ${l}${i < lines.length - 1 ? ',' : ''}`).join('\n'),
      ')',
      `ENGINE = ${cfg.clickhouse.cluster ? 'ReplicatedMergeTree' : 'MergeTree'}`,
      'PARTITION BY toDate(Timestamp)',
      'ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)',
      ttl,
      `SETTINGS index_granularity = 8192${ttl ? ', ttl_only_drop_parts = 1' : ''}`
    ]
      .filter(Boolean)
      .join('\n') + ';';
  notes.push({
    level: 'info',
    title: 'Schéma de l’exportateur OpenTelemetry',
    detail: `Colonnes, clé de tri et partition de l’exportateur ClickHouse d’OpenTelemetry (ClickStack). L’index de Body est construit sur lowerUTF8(Body), l’expression qu’emploie la traduction : l’index idx_lower_body de l’exportateur, sur lower(Body), ne la sert pas.`,
    code: ''
  });
  if (typed.length)
    notes.push({
      level: 'info',
      title: json ? 'Chemins JSON typés' : 'Types des attributs',
      detail: json
        ? `${typed.length} champ${typed.length > 1 ? 's' : ''} numérique${typed.length > 1 ? 's' : ''}, booléen${typed.length > 1 ? 's' : ''} ou date${typed.length > 1 ? 's' : ''} du mapping deviennent des chemins typés de LogAttributes, Nullable pour qu’un champ absent reste absent.`
        : `Les attributs numériques, booléens et dates du mapping sont déclarés dans attribute_types : la traduction les convertit à la lecture, la Map ne gardant que des chaînes.`,
      code: ''
    });
  mc.notes.filter(n => n.level !== 'info').forEach(n => notes.push(n));
  if (ret)
    ret.notes.forEach(n =>
      notes.push({ level: 'info', title: `Politique ILM ${src.ilmName || ''}`.trim(), detail: n, code: '' })
    );
  if (arrays.length)
    notes.push({
      level: 'info',
      title: 'Champs multivalués en colonnes',
      detail: `${arrays.map(c => c.field).join(', ')} : la convention ECS les déclare multivalués. Une Map de chaînes ne garde pas un tableau : ils deviennent des colonnes Array à côté du schéma OpenTelemetry, déclarées dans le profil.`,
      code: ''
    });
  const profile = { preset };
  if (!json && Object.keys(attrTypes).length) profile.attribute_types = attrTypes;
  const cols = {};
  if (json && typed.length) cols.LogAttributes = jsonType;
  if (json && typedResource.length) cols.ResourceAttributes = jsonResource;
  for (const c of arrayCols) cols[c.name] = c.type;
  if (Object.keys(cols).length) profile.columns = cols;
  const fm = {};
  for (const [f, col] of Object.entries(mc.fieldMap))
    if (!P.field_mapping[f] && /\./.test(f) && mc.cols.some(c => c.name === col && c.kind === 'text'))
      fm[f] = col === 'message' ? 'Body' : col;
  if (Object.keys(fm).length) profile.field_mapping = fm;
  stats.ok++;
  return { table, sql, profile, notes, stats, patterns: src.patterns, source: { kind: src.kind, name: src.name } };
}

/* ---------- Entrée principale ---------- */
export function schemaFromElastic(text, cfg, opts) {
  opts = opts || {};
  if (opts.preset && !PRESETS[opts.preset])
    return { error: `préréglage inconnu : ${opts.preset} (${Object.keys(PRESETS).join(' ou ')})` };
  const { docs, errors } = esDocsFrom(text);
  if (!docs.length) return errors && errors.length ? { error: errors[0] } : { empty: true };
  const components = new Map(docs.filter(d => d.kind === 'component').map(d => [d.name, d.body]));
  const policies = new Map(docs.filter(d => d.kind === 'ilm').map(d => [d.name, d.body]));
  const notes = makeNotes();
  (errors || []).forEach(e => notes.add('err', 'Document illisible', e));
  // Sources de table : modèles d’index (avec leurs composants), modèles hérités, index
  const sources = [];
  for (const d of docs) {
    if (d.kind === 'index_template') {
      const b = d.body;
      let mappings = {};
      let settings = {};
      for (const name of [].concat(b.composed_of || [])) {
        const comp = components.get(name) || BUILTIN_COMPONENTS[name];
        if (!comp) {
          if (!/@(custom|settings|package)$|^ecs@mappings$/.test(name))
            notes.add(
              'warn',
              `Composant ${name} non fourni`,
              `Le modèle ${d.name || ''} le compose ; ajoutez-le (GET _component_template/${name}) pour que ses champs deviennent des colonnes.`
            );
          continue;
        }
        const t = comp.template || comp;
        mappings = mergeMappings(mappings, t.mappings || {});
        settings = Object.assign(settings, flatSettings(t.settings || {}));
        if (name === 'ecs@mappings')
          notes.add(
            'info',
            'ecs@mappings',
            'Ce composant type les champs ECS par des modèles dynamiques : seuls les champs déclarés dans le mapping deviennent des colonnes.'
          );
      }
      const own = b.template || {};
      mappings = mergeMappings(mappings, own.mappings || {});
      settings = Object.assign(settings, flatSettings(own.settings || {}));
      sources.push({
        kind: 'index_template',
        name: d.name,
        patterns: [].concat(b.index_patterns || []),
        mappings,
        settings: unflatSettings(settings),
        dataStream: !!b.data_stream
      });
    } else if (d.kind === 'legacy')
      sources.push({
        kind: 'legacy',
        name: d.name,
        patterns: [].concat(d.body.index_patterns || d.body.template || []),
        mappings: d.body.mappings || {},
        settings: d.body.settings || {}
      });
    else if (d.kind === 'index')
      sources.push({
        kind: 'index',
        name: d.name,
        patterns: d.name ? [d.name] : [],
        mappings: d.body.mappings || {},
        settings: d.body.settings || {}
      });
  }
  if (!sources.length) {
    if (policies.size)
      return {
        error: 'Une politique ILM seule ne décrit pas de table : ajoutez le modèle d’index ou le mapping qui l’emploie.'
      };
    return { error: 'Aucun mapping ni modèle d’index dans les documents fournis.' };
  }
  const tables = [];
  for (const src of sources) {
    const lifecycle = flatSettings(src.settings)['lifecycle.name'];
    src.ilmName = lifecycle || (policies.size === 1 && sources.length === 1 ? [...policies.keys()][0] : '');
    src.ilm = src.ilmName
      ? policies.get(src.ilmName) || (policies.size === 1 && !lifecycle ? [...policies.values()][0] : null)
      : null;
    if (src.ilm && !lifecycle)
      notes.add(
        'info',
        'Politique ILM associée d’office',
        `Le modèle ne nomme pas de politique (index.lifecycle.name) : la seule politique fournie, ${src.ilmName || 'sans nom'}, lui est appliquée.`
      );
    const t = opts.preset ? buildOtelTable(cfg, src, opts) : buildTable(cfg, src, opts);
    tables.push(t);
  }
  const stats = { ok: 0, approx: 0, ko: 0 };
  for (const t of tables) for (const k of Object.keys(stats)) stats[k] += t.stats[k];
  const ok = tables.filter(t => !t.error);
  const profiles = { clickhouse: { index_mapping: {}, tables: {} } };
  for (const t of ok) {
    for (const p of t.patterns.length ? t.patterns : [])
      if (!cfg.clickhouse.index_mapping || !cfg.clickhouse.index_mapping[p])
        profiles.clickhouse.index_mapping[p] = t.table;
    profiles.clickhouse.tables[t.table] = t.profile;
  }
  if (!Object.keys(profiles.clickhouse.index_mapping).length) delete profiles.clickhouse.index_mapping;
  const yaml = `# Profils de table générés par Passerelle : à reporter dans passerelle.yaml (section clickhouse)\n${toYAML(profiles)}\n`;
  const allNotes = notes.list.concat(...tables.map(t => t.notes));
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  allNotes.sort((a, b) => order[a.level] - order[b.level]);
  return { tables, sql: ok.map(t => t.sql).join('\n\n') + '\n', yaml, profiles, notes: allNotes, stats };
}
function unflatSettings(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat || {})) out[`index.${k}`] = v;
  return out;
}

/* ---------- Lecture d’un schéma existant (passerelle schema pull) ---------- */
// Requêtes envoyées à ClickHouse pour décrire des tables : colonnes, clé de tri, index de saut
export function schemaPullQueries(tables) {
  const list = tables
    .map(t => {
      const [db, tb] = String(t).includes('.') ? String(t).split(/\.(.+)/) : ['', String(t)];
      return `(${chStr(db)}, ${chStr(tb)})`;
    })
    .join(', ');
  const filter = db => `(${db}.database, ${db}.table) IN (${list})`;
  return {
    columns: `SELECT database, table, name, type, default_kind, is_in_sorting_key FROM system.columns WHERE ${filter('system.columns')} ORDER BY database, table, position FORMAT JSONEachRow`,
    tables: `SELECT database, name AS table, engine, sorting_key, partition_key FROM system.tables WHERE (database, name) IN (${list}) FORMAT JSONEachRow`,
    indices: `SELECT database, table, name, type, type_full, expr FROM system.data_skipping_indices WHERE ${filter('system.data_skipping_indices')} FORMAT JSONEachRow`
  };
}
/*
 * Profils déduits de system.columns : le type de chaque colonne, la colonne temporelle (date de la clé de tri), les champs
 * texte (colonnes qui portent un index text ou tokenbf_v1), une colonne de clés JSON, une colonne TimestampTime.
 * Rien n’est inventé : ce qui ne se déduit pas du schéma (field_mapping, attributs) reste à écrire.
 */
export function profilesFromSystem(rows, tableRows, indexRows, wanted, cfg) {
  const out = {};
  const notes = [];
  for (const t of wanted) {
    const [db, tb] = String(t).includes('.')
      ? String(t).split(/\.(.+)/)
      : [cfg.clickhouse.database || 'default', String(t)];
    const cols = rows.filter(r => r.database === db && r.table === tb);
    if (!cols.length) {
      notes.push(`${db}.${tb} : table introuvable, ou sans droit de lecture sur system.columns`);
      continue;
    }
    const profile = {};
    const idx = indexRows.filter(r => r.database === db && r.table === tb);
    // Index qui découpe en mots (et non en n-grammes ou en valeurs entières) : la colonne est un champ texte
    const wordIndex = r =>
      /^(tokenbf_v1|full_text|inverted)$/.test(r.type) ||
      (r.type === 'text' && !/tokenizer\s*=\s*'?(ngrams|array|sparseGrams)/.test(r.type_full || ''));
    const textCols = [
      ...new Set(
        idx
          .filter(wordIndex)
          .map(r => (/(?:lowerUTF8|lower)\(\s*`?([^`)]+)`?\s*\)/.exec(r.expr) || [null, r.expr.replace(/`/g, '')])[1])
          .filter(x => cols.some(c => c.name === x))
      )
    ];
    const dates = cols.filter(c => /^(Nullable\()?DateTime/.test(c.type));
    const time =
      dates.find(c => +c.is_in_sorting_key === 1 && c.name !== 'TimestampTime') ||
      dates.find(c => /^(timestamp|Timestamp|time|ts|@timestamp)$/.test(c.name)) ||
      dates[0];
    const isOtel = ['Timestamp', 'Body', 'LogAttributes', 'ResourceAttributes', 'ServiceName'].every(n =>
      cols.some(c => c.name === n)
    );
    if (isOtel) {
      const json = /^JSON/.test(cols.find(c => c.name === 'LogAttributes').type);
      profile.preset = json ? 'otel-json' : 'otel';
      const presetCols = PRESETS[profile.preset].columns;
      const extra = Object.fromEntries(
        cols
          .filter(c => !presetCols[c.name] || presetCols[c.name] !== c.type)
          .filter(c => c.default_kind !== 'ALIAS')
          .map(c => [c.name, c.type])
      );
      if (Object.keys(extra).length) profile.columns = extra;
      if (cols.some(c => c.name === 'TimestampTime')) profile.time_key = 'TimestampTime';
    } else {
      if (time) profile.time_field = time.name;
      if (textCols.length) profile.text_fields = textCols;
      profile.columns = Object.fromEntries(cols.filter(c => c.default_kind !== 'ALIAS').map(c => [c.name, c.type]));
      const maps = cols.filter(c => /^(Map\(|JSON)/.test(c.type)).map(c => c.name);
      if (maps.length)
        notes.push(
          `${db}.${tb} : colonne${maps.length > 1 ? 's' : ''} ${maps.join(', ')} de type Map ou JSON : déclarez dans clickhouse.attributes les champs qu’elle${maps.length > 1 ? 's' : ''} range${maps.length > 1 ? 'nt' : ''}.`
        );
    }
    if (!time && !isOtel) notes.push(`${db}.${tb} : aucune colonne de date, time_field reste à définir`);
    out[`${db}.${tb}`] = profile;
  }
  return {
    profiles: out,
    notes,
    yaml: `# Profils lus dans ClickHouse (system.columns) : à reporter dans passerelle.yaml (section clickhouse)\n${toYAML({ clickhouse: { tables: out } })}\n`
  };
}
