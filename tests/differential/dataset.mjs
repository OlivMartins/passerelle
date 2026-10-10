/*
 * Jeu de données du banc différentiel, chargé à l’identique dans Elasticsearch et dans ClickHouse.
 *
 * Il est déterministe (aucun appel à l’horloge ni au hasard du système) et contient exprès
 * les situations où les deux moteurs divergent facilement : champs absents, chaînes vides,
 * champs multivalués, documents autour de minuit (UTC et Europe/Paris), textes avec
 * ponctuation, accents et casse mixte.
 */
export const BASE = Date.UTC(2026, 2, 8); // 2026-03-08T00:00:00Z
export const DAY = 86400000;
export const DOCS = 3000;
export const INDEX = 'logs-test';
export const TABLE = 'logs.events';

function generator(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export function dataset() {
  const rnd = generator(42);
  const pick = list => list[Math.floor(rnd() * list.length)];
  const docs = [];
  for (let i = 0; i < DOCS; i++) {
    // Un document toutes les 115 secondes environ, sur quatre jours
    const ts = BASE + Math.floor((i * 4 * DAY) / DOCS) + Math.floor(rnd() * 1000);
    const k = Math.floor(rnd() * 9) + 1;
    const user = i % 3 === 0 ? undefined : i % 7 === 1 ? '' : pick(['alice', 'bob', 'Carol', 'dave']);
    const messages = [
      `Connection reset by peer from 10.0.0.${k}`,
      `connection-reset upstream timeout after ${k * 100}ms`,
      `GET /index.html user_id=${k} took 3.14s`,
      `user ${user || 'anonymous'} logged in`,
      'Échec réseau: délai dépassé',
      "can't parse payload; don't retry",
      'Connection   Reset (double space)',
      `disk usage 9${k}% on /dev/sda1`,
      'TIMEOUT waiting for payment-service',
      `request id=abc-12${k} ok`
    ];
    docs.push({
      _id: String(i),
      '@timestamp': new Date(ts).toISOString(),
      // « Search » est volontairement rare : ses histogrammes ont des tranches vides
      service: i % 50 === 7 ? 'Search' : pick(['checkout', 'checkout', 'payment', 'cart', 'api', 'api', 'api']),
      host: pick(['web-1', 'web-2', 'web-3', 'web-4', 'web-5', 'web-6', 'Web-A', 'élan-1', 'db_01']),
      env: i % 5 === 0 ? undefined : pick(['prod', 'prod', 'staging', 'dev']),
      level: pick(['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG']),
      status: pick([200, 200, 200, 201, 301, 404, 500, 503]),
      latency_ms: Math.floor(rnd() * 3000),
      bytes: Math.floor(rnd() * 100000),
      ratio: Math.round(rnd() * 10000) / 10000,
      user,
      tags: i % 4 === 0 ? undefined : i % 4 === 1 ? [] : i % 4 === 2 ? ['a'] : pick([['a', 'b'], ['b', 'c', 'a'], ['c']]),
      method: pick(['GET', 'POST', 'PUT']),
      message: messages[i % 10]
    });
  }
  return docs;
}

export const ES_INDEX = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      '@timestamp': { type: 'date' },
      service: { type: 'keyword' },
      host: { type: 'keyword' },
      env: { type: 'keyword' },
      level: { type: 'keyword' },
      status: { type: 'integer' },
      latency_ms: { type: 'long' },
      bytes: { type: 'long' },
      ratio: { type: 'double' },
      user: { type: 'keyword' },
      tags: { type: 'keyword' },
      http: { properties: { method: { type: 'keyword' } } },
      message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 1024 } } }
    }
  }
};

/*
 * Deux conventions de schéma ClickHouse, toutes deux courantes :
 *   N : les champs facultatifs sont Nullable (absent = NULL) ;
 *   D : les champs facultatifs ont une valeur par défaut (absent = chaîne vide).
 * Une traduction fiable doit donner le même résultat qu’Elasticsearch dans les deux cas.
 */
export const VARIANTS = { N: 'colonnes Nullable', D: 'valeurs par défaut' };

export function columns(variant) {
  return {
    _id: 'String',
    timestamp: 'DateTime64(3)',
    service: 'LowCardinality(String)',
    host: 'String',
    env: variant === 'N' ? 'LowCardinality(Nullable(String))' : 'LowCardinality(String)',
    level: 'LowCardinality(String)',
    status: 'UInt16',
    latency_ms: 'Int64',
    bytes: 'Int64',
    ratio: 'Float64',
    user: variant === 'N' ? 'Nullable(String)' : 'String',
    tags: 'Array(String)',
    'http.method': 'LowCardinality(String)',
    message: 'String'
  };
}

export function clickhouseDDL(variant) {
  const cols = Object.entries(columns(variant)).map(([name, type]) => `    \`${name}\` ${type}`).join(',\n');
  // L’index text est celui que la traduction recommande : la recherche plein texte est vérifiée index compris
  const index = '    INDEX idx_message_text lowerUTF8(message) TYPE text(tokenizer = splitByNonAlpha)';
  return `CREATE DATABASE IF NOT EXISTS logs;\nCREATE TABLE ${TABLE} (\n${cols},\n${index}\n) ENGINE = MergeTree ORDER BY (service, timestamp);`;
}

/*
 * Configuration Passerelle utilisée par le banc (une par schéma) et par les instantanés (schéma N).
 * Le schéma des colonnes est fourni : c’est lui qui permet une traduction fidèle sur les champs facultatifs,
 * les tableaux et les entiers. Avec le schéma D, la chaîne vide représente un champ absent.
 */
export function configOverride(variant = 'N') {
  return {
    clickhouse: {
      default_table: TABLE,
      time_field: 'timestamp',
      text_fields: ['message'],
      index_mapping: { 'logs-*': TABLE },
      field_mapping: { '@timestamp': 'timestamp' },
      columns: columns(variant),
      empty_as_missing: variant === 'D'
    }
  };
}

export function esDocument(d) {
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || k === '_id') continue;
    if (k === 'method') o.http = { method: v }; else o[k] = v;
  }
  return o;
}

export function clickhouseRow(d) {
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined) continue;
    if (k === '@timestamp') o.timestamp = v;
    else if (k === 'method') o['http.method'] = v;
    else o[k] = v;
  }
  return o;
}
