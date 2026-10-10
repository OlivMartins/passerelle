/* Passerelle — moteur de traduction (partie 1 : socle, Painless, Lucene, grok) */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

const DEFAULT_CONFIG = {
  clickhouse: {
    endpoint: 'https://clickhouse.internal:8443',
    database: 'logs',
    user: '${CLICKHOUSE_USER}',
    password: '${CLICKHOUSE_PASSWORD}',
    cluster: '',
    default_table: 'logs.events',
    time_field: 'timestamp',
    timezone: '',
    text_fields: ['message', 'error.message'],
    index_mapping: { 'logs-*': 'logs.events', 'nginx-*': 'logs.nginx_access', 'metrics-*': 'metrics.samples' },
    field_mapping: { '@timestamp': 'timestamp' },
    columns: {},
    empty_as_missing: false,
    composite_mode: 'page',
    lists: { threshold: 0, table: '', names: {} },
    text_match: 'tokens'
  },
  kafka: {
    bootstrap_servers: '',
    security_protocol: '',
    sasl_mechanism: 'SCRAM-SHA-512',
    username: '${KAFKA_USERNAME}',
    password: '${KAFKA_PASSWORD}',
    ca_file: '/etc/vector/certs/ca.pem',
    consumer_group: '',
    input_topics: [],
    output_topic: ''
  },
  vector: { format: 'yaml', log_namespace: true, logstash_compat: true, acknowledgements: true, shadow_mode: false }
};

function mergeConfig(base, over) {
  const out = clone(base);
  (function walk(dst, src) {
    if (!isObj(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && isObj(dst[k]) && !['index_mapping', 'field_mapping', 'columns', 'names'].includes(k)) walk(dst[k], v);
      else if (v !== undefined) dst[k] = clone(v);
    }
  })(out, over);
  return out;
}

/*
 * Fuseau des calculs de date.
 *
 * Elasticsearch calcule en UTC, sauf fuseau donné par la requête. ClickHouse suit le fuseau du serveur
 * ou de la colonne : sur un serveur en Europe/Paris, toStartOfDay(), toStartOfInterval(), toHour()
 * ou une date écrite sans fuseau sont décalés d’une heure ou deux, donc les jours et les tranches aussi.
 * Le fuseau est donc passé explicitement aux fonctions de date, sauf si la configuration déclare
 * clickhouse.timezone: UTC (serveur et colonnes en UTC) : le SQL reste alors sans argument de fuseau.
 */
function zoneOf(cfg, tz) {
  if (tz) return String(tz);
  return String(cfg.clickhouse.timezone || '').toUpperCase() === 'UTC' ? null : 'UTC';
}
function tzArg(cfg, tz) {
  const zone = zoneOf(cfg, tz);
  return zone ? `, ${chStr(zone)}` : '';
}

/*
 * Schéma des colonnes.
 *
 * clickhouse.columns associe à chaque colonne son type ClickHouse (env: LowCardinality(Nullable(String))).
 * Il est facultatif, mais sans lui la traduction ignore si une colonne accepte NULL, si elle est un tableau,
 * une date ou un entier : autant de cas où Elasticsearch et ClickHouse ne répondent pas pareil.
 * Une clé peut être préfixée par la table (logs.events.env) quand deux tables n’ont pas le même type.
 *
 * columnType renvoie { nullable, array, kind } ou null si le type n’est pas connu.
 *   kind : 'string' | 'int' | 'float' | 'date' | 'bool' | 'other' (celui des éléments pour un tableau)
 */
function parseColumnType(raw) {
  let t = String(raw).trim();
  const unwrap = name => {
    if (!t.startsWith(`${name}(`) || !t.endsWith(')')) return false;
    t = t.slice(name.length + 1, -1).trim();
    return true;
  };
  unwrap('LowCardinality');
  const array = unwrap('Array');
  if (array) unwrap('LowCardinality');
  const nullable = unwrap('Nullable');
  let kind = 'other';
  if (/^U?Int\d+$/.test(t)) kind = 'int';
  else if (/^(Float\d+|Decimal)/.test(t)) kind = 'float';
  else if (/^Date/.test(t)) kind = 'date';
  else if (/^(String|FixedString|Enum|UUID|IPv[46])/.test(t)) kind = 'string';
  else if (t === 'Bool') kind = 'bool';
  // Un tableau n’est jamais NULL lui-même : seul le caractère Nullable d’une colonne simple compte ici
  return { array, nullable: !array && nullable, kind };
}
function columnType(cfg, table, column) {
  const columns = cfg.clickhouse.columns;
  if (!isObj(columns)) return null;
  const qualified = columns[`${table}.${column}`];
  const raw = qualified !== undefined ? qualified : columns[column];
  return raw === undefined || raw === null || raw === '' ? null : parseColumnType(raw);
}
const hasSchema = cfg => isObj(cfg.clickhouse.columns) && Object.keys(cfg.clickhouse.columns).length > 0;

function makeNotes() {
  const list = [];
  return {
    list,
    add(level, title, detail, code) {
      if (!list.some(n => n.title === title && n.detail === (detail || ''))) list.push({ level, title, detail: detail || '', code: code || '' });
    }
  };
}

/* ---------- ClickHouse : littéraux et identifiants ---------- */
const CH_KW = new Set('select from where order group by limit and or not as in is null like between case when then else end with having prewhere final sample union all distinct join on using interval format settings offset asc desc'.split(' '));
function chIdent(n) {
  n = String(n);
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(n) && !CH_KW.has(n.toLowerCase())) return n;
  return '`' + n.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}
function chStr(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function chVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return chStr(v);
}
/*
 * Nombre fourni par la requête et recopié tel quel dans le SQL (taille, intervalle, coordonnée…).
 * Seul un nombre fini est accepté, ou une chaîne purement numérique comme le tolère Elasticsearch :
 * toute autre valeur est refusée, comme Elasticsearch le fait avec une erreur 400.
 */
function chNum(v, what) {
  const n = typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${what} : nombre attendu, reçu ${JSON.stringify(v)}`);
  return n;
}
function chInt(v, what) {
  const n = chNum(v, what);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} : entier positif attendu, reçu ${JSON.stringify(v)}`);
  return n;
}
/* Texte libre placé dans un commentaire SQL : il ne doit pas pouvoir le refermer */
function chComment(s) { return String(s).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' '); }

/* Analyse lexicale légère pour savoir si une expression SQL doit être parenthésée */
function scanTop(s, cb) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '`') { i++; while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') d--;
    else if (d === 0 && cb(i, c) === false) return false;
  }
  return true;
}
function isWrapped(s) {
  if (s[0] !== '(' || s[s.length - 1] !== ')') return false;
  let d = 0, ok = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '`') { i++; while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; } continue; }
    if (c === '(') d++; else if (c === ')') { d--; if (d === 0 && i < s.length - 1) { ok = false; break; } }
  }
  return ok;
}
function topHas(s, re) {
  let found = false;
  scanTop(s, i => { if (re.test(s.slice(i, i + 6))) { found = true; return false; } });
  return found;
}
function paren(s, ctxOp) {
  if (isWrapped(s)) return s;
  if (ctxOp === 'AND' && topHas(s, /^ OR /)) return `(${s})`;
  if (ctxOp === 'OR' && topHas(s, /^ AND /)) return `(${s})`;
  if (ctxOp === 'ARG' && topHas(s, /^ (AND|OR|[-+*/=<>!]|IN |NOT|LIKE|ILIKE)/)) return `(${s})`;
  return s;
}
function andJoin(list) {
  const xs = list.filter(x => x !== null && x !== undefined && x !== '1' && x !== 'true');
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  return xs.map(x => paren(x, 'AND')).join(' AND ');
}
function orJoin(list) {
  if (!list.length) return null;
  if (list.some(x => x === null || x === '1' || x === 'true')) return null;
  const xs = [...new Set(list)];
  if (xs.length === 1) return xs[0];
  return '(' + xs.map(x => paren(x, 'OR')).join(' OR ') + ')';
}

/* ---------- Grok & dissect → expressions régulières (RE2) ---------- */
const GROK = {
  USERNAME: String.raw`[a-zA-Z0-9._-]+`, USER: '%{USERNAME}',
  EMAILLOCALPART: String.raw`[a-zA-Z0-9!#$%&'*+/=?^_{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_{|}~-]+)*`,
  EMAILADDRESS: '%{EMAILLOCALPART}@%{HOSTNAME}', HTTPDUSER: '(?:%{EMAILADDRESS}|%{USER})',
  INT: String.raw`(?:[+-]?(?:[0-9]+))`, BASE10NUM: String.raw`(?:[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))`,
  NUMBER: '(?:%{BASE10NUM})', BASE16NUM: String.raw`(?:0[xX]?[0-9a-fA-F]+)`,
  POSINT: String.raw`\b(?:[1-9][0-9]*)\b`, NONNEGINT: String.raw`\b(?:[0-9]+)\b`,
  WORD: String.raw`\b\w+\b`, NOTSPACE: String.raw`\S+`, SPACE: String.raw`\s*`, DATA: '.*?', GREEDYDATA: '.*',
  QUOTEDSTRING: String.raw`"(?:[^"\\]|\\.)*"`, QS: '%{QUOTEDSTRING}',
  UUID: String.raw`[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}`,
  IPV4: String.raw`(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9]{1,2})\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9]{1,2})`,
  IPV6: String.raw`(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}`, IP: '(?:%{IPV6}|%{IPV4})',
  HOSTNAME: String.raw`\b(?:[0-9A-Za-z][0-9A-Za-z-]{0,62})(?:\.(?:[0-9A-Za-z][0-9A-Za-z-]{0,62}))*\.?`,
  IPORHOST: '(?:%{IP}|%{HOSTNAME})', HOST: '%{HOSTNAME}', HOSTPORT: '%{IPORHOST}:%{POSINT}',
  PATH: String.raw`(?:/[^\s]*)`, URIPROTO: String.raw`[A-Za-z][A-Za-z0-9+\-.]+`,
  URIPATH: String.raw`(?:/[A-Za-z0-9$.+!*'(){},~:;=@#%&_\-]*)+`, URIPARAM: String.raw`\?[A-Za-z0-9$.+!*'|(){},~@#%&/=:;_?\-\[\]<>]*`,
  URIPATHPARAM: '%{URIPATH}(?:%{URIPARAM})?', URI: String.raw`%{URIPROTO}://(?:[^@\s]+@)?(?:%{IPORHOST})?(?::%{POSINT})?(?:%{URIPATHPARAM})?`,
  MONTH: String.raw`\b(?:[Jj]an(?:uary)?|[Ff]eb(?:ruary)?|[Mm]ar(?:ch)?|[Aa]pr(?:il)?|[Mm]ay|[Jj]un(?:e)?|[Jj]ul(?:y)?|[Aa]ug(?:ust)?|[Ss]ep(?:tember)?|[Oo]ct(?:ober)?|[Nn]ov(?:ember)?|[Dd]ec(?:ember)?)\b`,
  MONTHNUM: '(?:0?[1-9]|1[0-2])', MONTHDAY: '(?:(?:0[1-9])|(?:[12][0-9])|(?:3[01])|[1-9])',
  DAY: '(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)',
  YEAR: String.raw`(?:\d\d){1,2}`, HOUR: '(?:2[0123]|[01]?[0-9])', MINUTE: '(?:[0-5][0-9])',
  SECOND: '(?:(?:[0-5]?[0-9]|60)(?:[:.,][0-9]+)?)', TIME: '%{HOUR}:%{MINUTE}(?::%{SECOND})?',
  ISO8601_TIMEZONE: '(?:Z|[+-]%{HOUR}(?::?%{MINUTE}))',
  TIMESTAMP_ISO8601: '%{YEAR}-%{MONTHNUM}-%{MONTHDAY}[T ]%{HOUR}:?%{MINUTE}(?::?%{SECOND})?%{ISO8601_TIMEZONE}?',
  HTTPDATE: '%{MONTHDAY}/%{MONTH}/%{YEAR}:%{TIME} %{INT}', SYSLOGTIMESTAMP: '%{MONTH} +%{MONTHDAY} %{TIME}',
  LOGLEVEL: '(?:[Tt]race|TRACE|[Dd]ebug|DEBUG|[Nn]otice|NOTICE|[Ii]nfo|INFO|[Ww]arn(?:ing)?|WARN(?:ING)?|[Ee]rr(?:or)?|ERR(?:OR)?|[Cc]rit(?:ical)?|CRIT(?:ICAL)?|[Ff]atal|FATAL|[Ss]evere|SEVERE|EMERG(?:ENCY)?|[Ee]merg(?:ency)?)',
  COMMONAPACHELOG: String.raw`%{IPORHOST:clientip} %{HTTPDUSER:ident} %{HTTPDUSER:auth} \[%{HTTPDATE:timestamp}\] "(?:%{WORD:verb} %{NOTSPACE:request}(?: HTTP/%{NUMBER:httpversion})?|%{DATA:rawrequest})" %{NUMBER:response} (?:%{NUMBER:bytes}|-)`,
  COMBINEDAPACHELOG: '%{COMMONAPACHELOG} %{QS:referrer} %{QS:agent}'
};
function reSafeName(n) { return String(n).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'); }
/* target : nom de capture à extraire seule (ClickHouse extract) ; null : toutes les captures nommées */
function grokRegex(pattern, target, custom, depth) {
  custom = custom || {}; depth = depth || 0;
  if (depth > 15) throw new Error('motif grok trop imbriqué');
  let p = String(pattern).replace(/\(\?<(\w+)>/g, (m, n) => (target === null ? `(?P<${reSafeName(n)}>` : n === target ? '(' : '(?:'));
  return p.replace(/%\{(\w+)(?::([^:}]+))?(?::(\w+))?\}/g, (m, name, field) => {
    const def = custom[name] !== undefined ? custom[name] : GROK[name];
    if (def === undefined) throw new Error(`motif grok inconnu : ${name}`);
    const inner = grokRegex(def, target, custom, depth + 1);
    if (field) {
      if (target === null) return `(?P<${reSafeName(field)}>${inner})`;
      if (field === target) return `(${inner})`;
    }
    return `(?:${inner})`;
  });
}
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function dissectParts(pattern) {
  const parts = []; let last = 0; const re = /%\{([^}]*)\}/g; let m;
  while ((m = re.exec(pattern))) { parts.push({ lit: pattern.slice(last, m.index) }); parts.push({ key: m[1] }); last = re.lastIndex; }
  parts.push({ lit: pattern.slice(last) });
  return parts;
}
/* Renvoie { regex, fields:[{group, field}], warnings } */
function dissectRegex(pattern, target, named) {
  const ps = dissectParts(pattern); let out = '^'; const fields = []; const warnings = [];
  const keyIdx = ps.map((p, i) => (p.key !== undefined ? i : -1)).filter(i => i >= 0);
  let padPrev = false;
  ps.forEach((p, i) => {
    if (p.lit !== undefined) {
      if (p.lit) out += padPrev ? `(?:${escRe(p.lit)})+` : escRe(p.lit);
      padPrev = false; return;
    }
    let k = p.key; const pad = k.endsWith('->'); if (pad) k = k.slice(0, -2);
    padPrev = pad;
    const isLast = i === keyIdx[keyIdx.length - 1] && !(ps[i + 1] && ps[i + 1].lit);
    const g = isLast ? '.*' : '.*?';
    if (/^[+&*]/.test(k)) { warnings.push(`modificateur « ${k[0]} » de dissect ignoré (${k})`); k = ''; }
    const skip = k === '' || k.startsWith('?');
    if (skip) { out += `(?:${g})`; return; }
    if (named) { const grp = reSafeName(k); fields.push({ group: grp, field: k }); out += `(?P<${grp}>${g})`; }
    else out += k === target ? `(${g})` : `(?:${g})`;
  });
  return { regex: out + '$', fields, warnings };
}

/* ---------- Painless → expression ClickHouse ---------- */
const P_OPS = ['==~', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '?.', '?:', '=~', '++', '--', '+=', '-=', '*=', '/=', '->', '::'];
function ptokens(src) {
  const t = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) { const e = src[j + 1]; v += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; } else v += src[j++];
      }
      t.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (c === '/' && t.length && (t[t.length - 1].v === '=~' || t[t.length - 1].v === '==~')) {
      let j = i + 1, v = '';
      while (j < n && src[j] !== '/') { if (src[j] === '\\' && src[j + 1] === '/') { v += '/'; j += 2; } else v += src[j++]; }
      j++; while (/[a-zA-Z]/.test(src[j] || '')) j++;
      t.push({ t: 're', v }); i = j; continue;
    }
    let m = /^(\d+\.\d+|\d+)([eE][+-]?\d+)?[LlFfDd]?/.exec(src.slice(i));
    // int : littéral entier (12, 12L), par opposition à 1.5, 1e3, 12f ou 12d ; la division en dépend
    if (m) { t.push({ t: 'num', v: m[0].replace(/[LlFfDd]$/, ''), int: !/[.eEFfDd]/.test(m[0]) }); i += m[0].length; continue; }
    m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (m) { t.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const op = P_OPS.find(o => src.startsWith(o, i));
    if (op) { t.push({ t: 'op', v: op }); i += op.length; continue; }
    t.push({ t: 'op', v: c }); i++;
  }
  return t;
}
const P_TYPES = new Set(['def', 'var', 'String', 'int', 'long', 'double', 'float', 'boolean', 'short', 'byte', 'char', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'ZonedDateTime', 'Instant', 'LocalDate', 'LocalDateTime', 'List', 'Map', 'ArrayList', 'HashMap']);
const P_BIN = { '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '===': 7, '!==': 7, '<': 8, '>': 8, '<=': 8, '>=': 8, '=~': 8, '==~': 8, 'instanceof': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
function pparse(src) {
  const toks = ptokens(src); let p = 0;
  const peek = k => toks[p + (k || 0)];
  const is = (v, k) => { const t = toks[p + (k || 0)]; return !!t && t.t !== 'str' && t.v === v; };
  const next = () => toks[p++];
  const expect = v => { if (!is(v)) throw new Error(`« ${v} » attendu dans le script`); p++; };
  function block() { const out = []; while (p < toks.length && !is('}')) out.push(stmt()); return out; }
  function endStmt() { if (is(';')) p++; }
  function stmt() {
    if (is('{')) { next(); const b = block(); expect('}'); return { k: 'block', body: b }; }
    if (is(';')) { next(); return { k: 'nop' }; }
    const t = peek();
    if (t.t === 'id' && t.v === 'if') {
      next(); expect('('); const c = expr(0); expect(')');
      const th = stmt(); let el = null;
      if (peek() && peek().t === 'id' && peek().v === 'else') { next(); el = stmt(); }
      return { k: 'if', c, th, el };
    }
    if (t.t === 'id' && t.v === 'return') {
      next();
      if (!peek() || is(';') || is('}')) { endStmt(); return { k: 'ret' }; }
      const v = expr(0); endStmt(); return { k: 'ret', v };
    }
    if (t.t === 'id' && ['for', 'while', 'do', 'try', 'throw', 'switch'].includes(t.v)) throw new Error(`instruction « ${t.v} » non prise en charge`);
    if (t.t === 'id' && P_TYPES.has(t.v)) {
      let k = 1;
      if (is('<', 1)) { let d = 0; do { if (is('<', k)) d++; else if (is('>', k)) d--; k++; } while (d > 0 && p + k < toks.length); }
      while (is('[', k) && is(']', k + 1)) k += 2;
      const nt = peek(k);
      if (nt && nt.t === 'id') {
        p += k; const name = next().v; let v = null;
        if (is('=')) { next(); v = expr(0); }
        endStmt(); return { k: 'let', name, v };
      }
    }
    if (t.t === 'id' && is('=', 1)) { const name = next().v; next(); const v = expr(0); endStmt(); return { k: 'let', name, v }; }
    if (t.t === 'id' && ['+=', '-=', '*=', '/='].some(o => is(o, 1))) {
      const name = next().v; const op = next().v[0]; const r = expr(0); endStmt();
      return { k: 'let', name, v: { k: 'bin', op, l: { k: 'id', v: name }, r } };
    }
    const e = expr(0); endStmt(); return { k: 'expr', e };
  }
  function expr(min) {
    let l = unary();
    for (;;) {
      const t = peek(); if (!t || t.t === 'str' || t.t === 'num') break;
      if (t.v === '?' && min <= 1) { next(); const a = expr(0); expect(':'); const b = expr(1); l = { k: 'tern', c: l, a, b }; continue; }
      if (t.v === '?:' && min <= 1) { next(); const b = expr(1); l = { k: 'elvis', a: l, b }; continue; }
      const pr = P_BIN[t.v]; if (!pr || pr <= min) break;
      next(); const r = expr(pr); l = { k: 'bin', op: t.v, l, r };
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t && t.t === 'op' && ['!', '-', '+', '~'].includes(t.v)) { next(); return { k: 'un', op: t.v, e: unary() }; }
    if (t && t.t === 'op' && t.v === '(' && peek(1) && peek(1).t === 'id' && P_TYPES.has(peek(1).v) && is(')', 2)) {
      const type = peek(1).v; p += 3; return { k: 'cast', type, e: unary() };
    }
    return postfix(primary());
  }
  function args() { const a = []; while (!is(')')) { a.push(expr(0)); if (is(',')) next(); else break; } expect(')'); return a; }
  function primary() {
    const t = next();
    if (!t) throw new Error('expression incomplète');
    if (t.t === 'num') return { k: 'num', v: t.v, int: t.int };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 're') return { k: 're', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = expr(0); expect(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      while (!is(']')) { if (is(':')) throw new Error('littéral Map non pris en charge'); items.push(expr(0)); if (is(',')) next(); else break; }
      expect(']'); return { k: 'list', items };
    }
    if (t.t === 'id') {
      if (t.v === 'new') throw new Error('« new » non pris en charge');
      if (is('(')) { next(); return { k: 'call', name: t.v, args: args() }; }
      return { k: 'id', v: t.v };
    }
    throw new Error(`symbole inattendu « ${t.v} »`);
  }
  function postfix(e) {
    for (;;) {
      if (is('.') || is('?.')) {
        const safe = next().v === '?.'; const nm = next();
        if (!nm || nm.t !== 'id') throw new Error('nom de membre attendu');
        if (is('(')) { next(); e = { k: 'mcall', obj: e, name: nm.v, args: args(), safe }; }
        else e = { k: 'member', obj: e, name: nm.v, safe };
        continue;
      }
      if (is('[')) { next(); const idx = expr(0); expect(']'); e = { k: 'index', obj: e, idx }; continue; }
      if (is('++') || is('--')) { next(); continue; }
      break;
    }
    return e;
  }
  const prog = block();
  if (p < toks.length) throw new Error(`fin de script inattendue près de « ${toks[p].v} »`);
  return prog;
}

const P_CLASSES = new Set(['Math', 'Integer', 'Long', 'Double', 'Float', 'String', 'ZoneId', 'ZoneOffset', 'DateTimeFormatter', 'Instant', 'ChronoUnit', 'TextStyle', 'Locale', 'Objects', 'Boolean']);
/*
 * Valeurs numériques d’un script. « int » dit si la valeur est entière au sens de Java : true, false,
 * ou absent quand on ne sait pas (champ dont le type n’est pas fourni par clickhouse.columns).
 * Seule la division en dépend : entre deux entiers elle est entière en Painless, décimale dans ClickHouse.
 */
const pNum = sql => ({ sql, ty: 'num' });
const pInt = sql => ({ sql, ty: 'num', int: true });
const pFloat = sql => ({ sql, ty: 'num', int: false });
const bothInt = (a, b) => (a.int === true && b.int === true ? true : a.int === false || b.int === false ? false : undefined);
const pStr = sql => ({ sql, ty: 'str' });
const pBool = sql => ({ sql, ty: 'bool' });

function guessType(ctx, field) {
  const rt = ctx.runtime && ctx.runtime[field];
  if (rt) return rt.type === 'keyword' ? 'str' : rt.type === 'date' ? 'date' : ['long', 'double'].includes(rt.type) ? 'num' : 'any';
  // Le schéma des colonnes fait foi ; à défaut, le nom du champ sert d’indice pour les dates
  const kind = ctx.kindOf ? ctx.kindOf(field) : null;
  if (kind) return kind === 'string' ? 'str' : kind === 'date' ? 'date' : kind === 'int' || kind === 'float' ? 'num' : 'any';
  if (/(^|[._@])(timestamp|date|time|ts)$|_at$/i.test(field)) return 'date';
  return 'any';
}
function pval(ctx, x) {
  if (!x) throw new Error('valeur vide');
  if (x.kind === 'field') {
    const name = x.field.replace(/\.keyword$/, '');
    const rt = ctx.runtime && ctx.runtime[name];
    const kind = rt ? { long: 'int', double: 'float' }[rt.type] : ctx.kindOf ? ctx.kindOf(name) : null;
    const v = { sql: ctx.mapField(x.field), ty: guessType(ctx, name) };
    if (kind === 'int') v.int = true; else if (kind === 'float') v.int = false;
    return v;
  }
  if (x.kind === 'dow') return pStr(`upper(dateName('weekday', ${x.sql}${x.zone}))`);
  if (x.kind === 'mon') return pStr(`upper(dateName('month', ${x.sql}${x.zone}))`);
  // doc[champ].size() : nombre de valeurs du document pour ce champ
  if (x.kind === 'size') return isArrayField(ctx, x.field) ? pInt(`length(${ctx.mapField(x.field)})`) : pInt(`toUInt8(${presentSQL(ctx, x.field)})`);
  if (x.kind) throw new Error(`expression « ${x.kind} » inutilisable comme valeur`);
  return x;
}
function pArg(s) { return paren(s, 'ARG'); }
function asStrSQL(v) { return v.ty === 'str' ? v.sql : `toString(${v.sql})`; }
function concatOf(parts) {
  const flat = [];
  for (const p of parts) { if (p.concat) flat.push(...p.concat); else flat.push(asStrSQL(p)); }
  return { sql: `concat(${flat.join(', ')})`, ty: 'str', concat: flat };
}
function paramVal(ctx, name, o) {
  // Les valeurs de buckets_path arrivent au script en double, _count compris
  if (o.paramSQL && name in o.paramSQL) return pFloat(o.paramSQL[name]);
  if (o.params && name in o.params) {
    const v = o.params[name];
    if (typeof v === 'number') return Number.isInteger(v) ? pInt(String(v)) : pFloat(String(v));
    if (typeof v === 'boolean') return pBool(String(v));
    if (typeof v === 'string') return { sql: chStr(v), ty: 'str', lit: v };
    if (Array.isArray(v)) return { sql: `[${v.map(chVal).join(', ')}]`, ty: 'arr' };
    return { sql: chVal(JSON.stringify(v)), ty: 'str' };
  }
  throw new Error(`paramètre params.${name} introuvable`);
}
const JAVA_UNIT = { NANOS: 'nanosecond', MILLIS: 'millisecond', SECONDS: 'second', MINUTES: 'minute', HOURS: 'hour', DAYS: 'day', WEEKS: 'week', MONTHS: 'month', YEARS: 'year' };
function pconv(ctx, n, env, o) {
  switch (n.k) {
    case 'num': return n.int ? pInt(n.v) : pFloat(n.v);
    case 'str': return { sql: chStr(n.v), ty: 'str', lit: n.v };
    case 're': return { sql: chStr(n.v), ty: 're', lit: n.v };
    case 'list': { const it = n.items.map(x => pval(ctx, pconv(ctx, x, env, o))); return { sql: `[${it.map(x => x.sql).join(', ')}]`, ty: 'arr' }; }
    case 'id': {
      if (Object.prototype.hasOwnProperty.call(env, n.v)) return env[n.v];
      if (n.v === 'doc') return { kind: 'doc' };
      if (n.v === 'params') return { kind: 'params' };
      if (n.v === 'null') return { sql: 'NULL', ty: 'null' };
      if (n.v === 'true' || n.v === 'false') return pBool(n.v);
      if (n.v === '_value' && o.valueSQL) return pNum(o.valueSQL);
      if (P_CLASSES.has(n.v)) return { kind: 'class', name: n.v };
      throw new Error(`variable inconnue « ${n.v} »`);
    }
    case 'index': {
      const obj = pconv(ctx, n.obj, env, o); const idx = pconv(ctx, n.idx, env, o);
      if (obj.kind === 'doc' || obj.kind === 'source') { if (idx.lit === undefined) throw new Error('nom de champ dynamique non pris en charge'); return { kind: 'field', field: idx.lit }; }
      if (obj.kind === 'params') { if (idx.lit === undefined) throw new Error('paramètre dynamique'); if (idx.lit === '_source') return { kind: 'source' }; return paramVal(ctx, idx.lit, o); }
      if (obj.kind === 'field') return pval(ctx, obj);
      const v = pval(ctx, obj); const iv = pval(ctx, idx);
      const i1 = /^\d+$/.test(iv.sql) ? String(+iv.sql + 1) : `${pArg(iv.sql)} + 1`;
      return { sql: `arrayElement(${v.sql}, ${i1})`, ty: 'str' };
    }
    case 'member': {
      const obj = pconv(ctx, n.obj, env, o);
      if (obj.kind === 'doc') return { kind: 'field', field: n.name };
      if (obj.kind === 'params') return n.name === '_source' ? { kind: 'source' } : paramVal(ctx, n.name, o);
      if (obj.kind === 'source') return { kind: 'field', field: n.name };
      if (obj.kind === 'field') {
        if (n.name === 'value') return pval(ctx, obj);
        if (n.name === 'empty') return pBool(absentSQL(ctx, obj.field));
        if (n.name === 'length') return { kind: 'size', field: obj.field };
      }
      if (obj.kind === 'grok') {
        let rx;
        if (obj.type === 'grok') rx = grokRegex(obj.pattern, n.name);
        else { const d = dissectRegex(obj.pattern, n.name, false); rx = d.regex; }
        ctx.notes.add('info', 'grok/dissect → extract()', 'Le motif est converti en expression régulière RE2 et évalué par extract(). Pour un volume élevé, matérialisez la colonne à l’ingestion.');
        return pStr(`extract(${obj.src}, ${chStr(rx)})`);
      }
      if (obj.kind === 'class') {
        if (obj.name === 'TextStyle') return { kind: 'style', v: n.name };
        if (obj.name === 'ChronoUnit') return { kind: 'unit', v: n.name };
        if (obj.name === 'ZoneOffset' && n.name === 'UTC') return { kind: 'zone', v: 'UTC' };
        if (obj.name === 'Locale') return { kind: 'locale', v: n.name };
        if (obj.name === 'Integer' || obj.name === 'Long') { if (n.name === 'MAX_VALUE') return pNum(obj.name === 'Integer' ? '2147483647' : '9223372036854775807'); if (n.name === 'MIN_VALUE') return pNum(obj.name === 'Integer' ? '-2147483648' : '-9223372036854775808'); }
      }
      const v = pval(ctx, obj);
      if (n.name === 'millis') return pInt(`toUnixTimestamp64Milli(toDateTime64(${v.sql}, 3))`);
      if (n.name === 'length') return pInt(`length(${v.sql})`);
      throw new Error(`accès « .${n.name} » non pris en charge`);
    }
    case 'call': {
      if (n.name === 'grok' || n.name === 'dissect') {
        const pat = pconv(ctx, n.args[0], env, o);
        if (pat.lit === undefined) throw new Error(`${n.name}() attend un motif littéral`);
        return { kind: 'pat', type: n.name, pattern: pat.lit };
      }
      if (n.name === 'emit') throw new Error('emit() imbriqué dans une expression');
      throw new Error(`fonction « ${n.name}() » non prise en charge`);
    }
    case 'mcall': return pmcall(ctx, n, env, o);
    case 'un': {
      const e = pval(ctx, pconv(ctx, n.e, env, o));
      if (n.op === '!') return pBool(`NOT ${pArg(e.sql)}`);
      if (n.op === '-') return { sql: `-${pArg(e.sql)}`, ty: 'num', int: e.int };
      if (n.op === '~') return pInt(`bitNot(${e.sql})`);
      return e;
    }
    case 'cast': {
      const e = pval(ctx, pconv(ctx, n.e, env, o));
      const m = { int: 'toInt32', Integer: 'toInt32', long: 'toInt64', Long: 'toInt64', short: 'toInt16', byte: 'toInt8', double: 'toFloat64', Double: 'toFloat64', float: 'toFloat32', Float: 'toFloat32', String: 'toString', boolean: 'toBool' }[n.type];
      if (!m) return e;
      if (m === 'toString') return pStr(`${m}(${e.sql})`);
      if (m === 'toBool') return pBool(`${m}(${e.sql})`);
      return /Int/.test(m) ? pInt(`${m}(${e.sql})`) : pFloat(`${m}(${e.sql})`);
    }
    case 'tern': {
      const c = pval(ctx, pconv(ctx, n.c, env, o)), a = pval(ctx, pconv(ctx, n.a, env, o)), b = pval(ctx, pconv(ctx, n.b, env, o));
      return { sql: `if(${c.sql}, ${a.sql}, ${b.sql})`, ty: a.ty !== 'null' ? a.ty : b.ty, int: bothInt(a, b) };
    }
    case 'elvis': {
      const a = pval(ctx, pconv(ctx, n.a, env, o)), b = pval(ctx, pconv(ctx, n.b, env, o));
      return { sql: `ifNull(${a.sql}, ${b.sql})`, ty: a.ty };
    }
    case 'bin': return pbin(ctx, n, env, o);
  }
  throw new Error('construction de script non prise en charge');
}
function pbin(ctx, n, env, o) {
  const L = pconv(ctx, n.l, env, o), R = pconv(ctx, n.r, env, o); const op = n.op;
  if (L.kind === 'size' && R.sql === '0') {
    if (op === '==' || op === '<=') return pBool(absentSQL(ctx, L.field));
    if (op === '!=' || op === '>') return pBool(presentSQL(ctx, L.field));
  }
  const l = pval(ctx, L), r = pval(ctx, R);
  switch (op) {
    case '==': case '===':
      if (r.ty === 'null') return pBool(`isNull(${l.sql})`);
      if (l.ty === 'null') return pBool(`isNull(${r.sql})`);
      return pBool(`${pArg(l.sql)} = ${pArg(r.sql)}`);
    case '!=': case '!==':
      if (r.ty === 'null') return pBool(`isNotNull(${l.sql})`);
      if (l.ty === 'null') return pBool(`isNotNull(${r.sql})`);
      return pBool(`${pArg(l.sql)} != ${pArg(r.sql)}`);
    case '<': case '>': case '<=': case '>=': return pBool(`${pArg(l.sql)} ${op} ${pArg(r.sql)}`);
    case '&&': if (l.sql === '1') return r; if (r.sql === '1') return l; return pBool(`${paren(l.sql, 'AND')} AND ${paren(r.sql, 'AND')}`);
    case '||': return pBool(`${paren(l.sql, 'OR')} OR ${paren(r.sql, 'OR')}`);
    case '=~': return pBool(`match(${l.sql}, ${r.sql})`);
    case '==~': return pBool(`match(${l.sql}, ${chStr('^(?:' + (r.lit || '') + ')$')})`);
    case '+':
      if (l.ty === 'str' || r.ty === 'str' || l.concat || r.concat || (o.rtType === 'keyword' && !(l.ty === 'num' && r.ty === 'num'))) return concatOf([l, r]);
      return { sql: `${l.sql} + ${pArg(r.sql)}`, ty: 'num', int: bothInt(l, r) };
    case '-': case '*': case '%': return { sql: `${pArg(l.sql)} ${op} ${pArg(r.sql)}`, ty: 'num', int: bothInt(l, r) };
    case '/': {
      // Entre deux entiers, la division de Painless est entière (7 / 2 = 3) ; celle de ClickHouse ne l’est jamais
      const int = bothInt(l, r);
      if (int === true) return pInt(`intDiv(${l.sql}, ${r.sql})`);
      if (int === undefined) ctx.notes.add('warn', 'Division dans un script', 'Le type des opérandes n’est pas connu. Entre deux entiers, Painless fait une division entière (7 / 2 = 3) alors que ClickHouse renvoie 3.5 : il faudrait intDiv(). Renseignez clickhouse.columns pour que le bon opérateur soit choisi.');
      return pFloat(`${pArg(l.sql)} / ${pArg(r.sql)}`);
    }
    case '&': return pInt(`bitAnd(${l.sql}, ${r.sql})`);
    case '|': return pInt(`bitOr(${l.sql}, ${r.sql})`);
    case '^': return pInt(`bitXor(${l.sql}, ${r.sql})`);
  }
  throw new Error(`opérateur « ${op} » non pris en charge`);
}
function pmcall(ctx, n, env, o) {
  const obj = pconv(ctx, n.obj, env, o);
  const A = () => n.args.map(a => pval(ctx, pconv(ctx, a, env, o)));
  const name = n.name;
  const lit = i => { const x = pconv(ctx, n.args[i], env, o); if (x.lit === undefined) throw new Error(`argument littéral attendu pour ${name}()`); return x.lit; };
  if (obj.kind === 'pat' && name === 'extract') { const src = pval(ctx, pconv(ctx, n.args[0], env, o)); return { kind: 'grok', type: obj.type, pattern: obj.pattern, src: src.sql }; }
  if (obj.kind === 'doc') {
    if (name === 'containsKey') { ctx.notes.add('info', 'doc.containsKey() toujours vrai', 'En SQL la présence d’une colonne est garantie par le schéma ; les valeurs absentes se testent avec isNull().'); return pBool('1'); }
    if (name === 'get') return { kind: 'field', field: lit(0) };
  }
  if (obj.kind === 'params') { if (name === 'get') return paramVal(ctx, lit(0), o); if (name === 'containsKey') return pBool(o.params && lit(0) in o.params ? '1' : '0'); }
  if (obj.kind === 'source' && name === 'get') return { kind: 'field', field: lit(0) };
  if (obj.kind === 'field') {
    if (name === 'size') return { kind: 'size', field: obj.field };
    if (name === 'isEmpty') return pBool(absentSQL(ctx, obj.field));
    if (name === 'getValue' || name === 'get') return pval(ctx, obj);
  }
  if (obj.kind === 'unit' && name === 'between') {
    const [a, b] = A(); const u = JAVA_UNIT[obj.v];
    if (!u) throw new Error(`unité ChronoUnit.${obj.v} non prise en charge`);
    // ChronoUnit.between compte les unités entières écoulées, comme age() ; dateDiff() compte les changements de jour, de mois…
    return pInt(`age('${u}', ${a.sql}, ${b.sql}${a.zoned || b.zoned ? '' : tzArg(ctx.cfg)})`);
  }
  if (obj.kind === 'class') {
    const a = A(); const c = obj.name;
    if (c === 'Math') {
      const m = { abs: 'abs', floor: 'floor', ceil: 'ceil', round: 'round', sqrt: 'sqrt', pow: 'pow', max: 'greatest', min: 'least', log: 'log', log10: 'log10', exp: 'exp', signum: 'sign' }[name];
      if (m) {
        const call = `${m}(${a.map(x => x.sql).join(', ')})`;
        // Types de retour de Java : abs, max et min gardent celui des arguments, round renvoie un long, le reste un double
        if (name === 'abs') return { sql: call, ty: 'num', int: a[0].int };
        if (name === 'max' || name === 'min') return { sql: call, ty: 'num', int: bothInt(a[0], a[1]) };
        return name === 'round' ? pInt(`toInt64(${call})`) : pFloat(call);
      }
    }
    if ((c === 'Integer' || c === 'Long') && ['parseInt', 'parseLong', 'valueOf'].includes(name)) return a[0].ty === 'num' ? a[0] : pInt(`toInt64OrNull(${a[0].sql})`);
    if ((c === 'Double' || c === 'Float') && ['parseDouble', 'parseFloat', 'valueOf'].includes(name)) return pFloat(a[0].ty === 'num' ? a[0].sql : `toFloat64OrNull(${a[0].sql})`);
    if (c === 'Boolean' && name === 'parseBoolean') return pBool(`lower(${a[0].sql}) = 'true'`);
    if (['String', 'Integer', 'Long', 'Double'].includes(c) && ['valueOf', 'toString'].includes(name)) return pStr(asStrSQL(a[0]));
    if (c === 'String' && name === 'join') return pStr(`arrayStringConcat(${a[1].sql}, ${a[0].sql})`);
    if (c === 'ZoneId' && name === 'of') return { kind: 'zone', v: lit(0) };
    if (c === 'DateTimeFormatter' && name === 'ofPattern') return { kind: 'fmt', v: lit(0) };
    if (c === 'Instant' && name === 'ofEpochMilli') return { sql: `fromUnixTimestamp64Milli(toInt64(${a[0].sql}))`, ty: 'date' };
    if (c === 'Instant' && name === 'ofEpochSecond') return { sql: `toDateTime(${a[0].sql})`, ty: 'date' };
    if (c === 'Objects' && name === 'equals') return pBool(`${pArg(a[0].sql)} = ${pArg(a[1].sql)}`);
    if (c === 'Objects' && name === 'isNull') return pBool(`isNull(${a[0].sql})`);
    if (c === 'Objects' && name === 'nonNull') return pBool(`isNotNull(${a[0].sql})`);
    throw new Error(`${c}.${name}() non pris en charge`);
  }
  if (obj.kind === 'dow' || obj.kind === 'mon') {
    const unit = obj.kind === 'dow' ? 'weekday' : 'month';
    if (name === 'getValue') return pInt(obj.kind === 'dow' ? `toDayOfWeek(${obj.sql}${obj.zone ? `, 0${obj.zone}` : ''})` : `toMonth(${obj.sql}${obj.zone})`);
    if (name === 'getDisplayName') {
      const st = n.args[0] ? pconv(ctx, n.args[0], env, o) : null;
      const full = `dateName('${unit}', ${obj.sql}${obj.zone})`;
      return pStr(st && st.v && /SHORT|NARROW/.test(st.v) ? `substring(${full}, 1, 3)` : full);
    }
    if (name === 'toString' || name === 'name') return pval(ctx, obj);
    if (name === 'equals') { const a = A(); return pBool(`${pval(ctx, obj).sql} = ${a[0].sql}`); }
  }
  const v = pval(ctx, obj); const s = v.sql;
  const a = () => A();
  const intervalOp = (sign, unit) => { const x = a()[0]; return { sql: `${s} ${sign} INTERVAL ${x.sql} ${unit}`, ty: 'date', zoned: v.zoned }; };
  // Les composantes d’une date se lisent en UTC, comme dans Painless, sauf si le script a déjà choisi un fuseau (withZoneSameInstant)
  const zone = v.zoned ? '' : tzArg(ctx.cfg);
  switch (name) {
    case 'getHour': return pInt(`toHour(${s}${zone})`);
    case 'getMinute': return pInt(`toMinute(${s}${zone})`);
    case 'getSecond': return pInt(`toSecond(${s})`);
    case 'getDayOfMonth': return pInt(`toDayOfMonth(${s}${zone})`);
    case 'getDayOfYear': return pInt(`toDayOfYear(${s}${zone})`);
    case 'getMonthValue': return pInt(`toMonth(${s}${zone})`);
    case 'getYear': return pInt(`toYear(${s}${zone})`);
    case 'getDayOfWeek': case 'getDayOfWeekEnum': return { kind: 'dow', sql: s, zone };
    case 'getMonth': return { kind: 'mon', sql: s, zone };
    case 'toInstant': case 'toLocalDateTime': return { sql: s, ty: 'date', zoned: v.zoned };
    case 'toLocalDate': return { sql: `toDate(${s}${zone})`, ty: 'date', zoned: v.zoned };
    case 'toEpochMilli': case 'getMillis': return pInt(`toUnixTimestamp64Milli(toDateTime64(${s}, 3))`);
    case 'toEpochSecond': case 'getEpochSecond': return pInt(`toUnixTimestamp(${s})`);
    case 'withZoneSameInstant': case 'atZone': { const z = pconv(ctx, n.args[0], env, o); if (z.kind !== 'zone') throw new Error('fuseau attendu (ZoneId.of)'); return { sql: `toTimeZone(${s}, ${chStr(z.v)})`, ty: 'date', zoned: true }; }
    case 'format': { const f = pconv(ctx, n.args[0], env, o); if (f.kind !== 'fmt') throw new Error('format attendu (DateTimeFormatter.ofPattern)'); return pStr(`formatDateTimeInJodaSyntax(${s}, ${chStr(f.v)}${zone})`); }
    case 'plusSeconds': return intervalOp('+', 'SECOND'); case 'plusMinutes': return intervalOp('+', 'MINUTE');
    case 'plusHours': return intervalOp('+', 'HOUR'); case 'plusDays': return intervalOp('+', 'DAY');
    case 'plusWeeks': return intervalOp('+', 'WEEK'); case 'plusMonths': return intervalOp('+', 'MONTH'); case 'plusYears': return intervalOp('+', 'YEAR');
    case 'minusSeconds': return intervalOp('-', 'SECOND'); case 'minusMinutes': return intervalOp('-', 'MINUTE');
    case 'minusHours': return intervalOp('-', 'HOUR'); case 'minusDays': return intervalOp('-', 'DAY');
    case 'minusWeeks': return intervalOp('-', 'WEEK'); case 'minusMonths': return intervalOp('-', 'MONTH'); case 'minusYears': return intervalOp('-', 'YEAR');
    case 'isAfter': return pBool(`${s} > ${a()[0].sql}`);
    case 'isBefore': return pBool(`${s} < ${a()[0].sql}`);
    case 'isEqual': return pBool(`${s} = ${a()[0].sql}`);
    case 'truncatedTo': {
      const u = pconv(ctx, n.args[0], env, o);
      const f = { SECONDS: 'toStartOfSecond', MINUTES: 'toStartOfMinute', HOURS: 'toStartOfHour', DAYS: 'toStartOfDay' }[u.v];
      if (!f) throw new Error('unité de troncature non prise en charge');
      return { sql: `${f}(${s}${f === 'toStartOfSecond' ? '' : zone})`, ty: 'date', zoned: v.zoned };
    }
    // Java replie la casse de toutes les lettres : lowerUTF8() et upperUTF8(), là où lower() et upper() ne connaissent que l’ASCII
    case 'toLowerCase': return pStr(`lowerUTF8(${s})`);
    case 'toUpperCase': return pStr(`upperUTF8(${s})`);
    case 'trim': case 'strip': return pStr(`trimBoth(${s})`);
    case 'length': return pInt(`lengthUTF8(${s})`);
    case 'size': return pInt(`length(${s})`);
    case 'isEmpty': return pBool(`empty(${s})`);
    case 'substring': {
      const x = a(); const b = x[0], e = x[1];
      const start = /^\d+$/.test(b.sql) ? String(+b.sql + 1) : `${pArg(b.sql)} + 1`;
      if (!e) return pStr(`substringUTF8(${s}, ${start})`);
      const len = /^\d+$/.test(b.sql) && /^\d+$/.test(e.sql) ? String(+e.sql - +b.sql) : `${pArg(e.sql)} - ${pArg(b.sql)}`;
      return pStr(`substringUTF8(${s}, ${start}, ${len})`);
    }
    case 'indexOf': return pInt(`(positionUTF8(${s}, ${a()[0].sql}) - 1)`);
    case 'contains': { const x = a()[0]; return pBool(v.ty === 'arr' ? `has(${s}, ${x.sql})` : `positionUTF8(${s}, ${x.sql}) > 0`); }
    case 'startsWith': return pBool(`startsWith(${s}, ${a()[0].sql})`);
    case 'endsWith': return pBool(`endsWith(${s}, ${a()[0].sql})`);
    case 'equals': return pBool(`${pArg(s)} = ${pArg(a()[0].sql)}`);
    case 'equalsIgnoreCase': return pBool(`lowerUTF8(${s}) = lowerUTF8(${a()[0].sql})`);
    case 'replace': { const x = a(); return pStr(`replaceAll(${s}, ${x[0].sql}, ${x[1].sql})`); }
    case 'replaceAll': case 'replaceFirst': {
      const re = lit(0); const rep = lit(1).replace(/\$(\d)/g, '\\$1');
      return pStr(`${name === 'replaceAll' ? 'replaceRegexpAll' : 'replaceRegexpOne'}(${s}, ${chStr(re)}, ${chStr(rep)})`);
    }
    case 'matches': return pBool(`match(${s}, ${chStr('^(?:' + lit(0) + ')$')})`);
    case 'split': case 'splitOnToken': return { sql: `splitByString(${a()[0].sql}, ${s})`, ty: 'arr' };
    case 'charAt': { const x = a()[0]; return pStr(`substringUTF8(${s}, ${/^\d+$/.test(x.sql) ? +x.sql + 1 : pArg(x.sql) + ' + 1'}, 1)`); }
    case 'toString': return pStr(asStrSQL(v));
    case 'get': { const x = a()[0]; return { sql: `arrayElement(${s}, ${/^\d+$/.test(x.sql) ? +x.sql + 1 : pArg(x.sql) + ' + 1'})`, ty: 'any' }; }
    case 'getValue': return v;
    case 'hashCode': return pInt(`cityHash64(${s})`);
  }
  throw new Error(`méthode « .${name}() » non prise en charge`);
}
const P_NONE = { k: 'none' };
/*
 * Chaque « if » sans else recopie la suite du script dans ses deux branches : n conditions successives
 * donnent 2^n chemins, donc un SQL illisible puis un temps de traduction déraisonnable.
 * Au-delà de ce plafond, le script est déclaré « à reprendre ».
 */
const PAINLESS_MAX_STEPS = 500;
function hasEmit(stmts) { return JSON.stringify(stmts).includes('"name":"emit"'); }
function pexec(ctx, stmts, env, o) {
  o.steps = (o.steps || 0) + 1;
  if (o.steps > PAINLESS_MAX_STEPS) throw new Error('script trop ramifié (conditions successives) pour une expression SQL lisible');
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]; const rest = stmts.slice(i + 1);
    if (s.k === 'nop') continue;
    if (s.k === 'block') return pexec(ctx, s.body.concat(rest), env, o);
    if (s.k === 'let') { env = Object.assign({}, env, { [s.name]: s.v ? pconv(ctx, s.v, env, o) : { sql: 'NULL', ty: 'null' } }); continue; }
    if (s.k === 'if') {
      const c = pval(ctx, pconv(ctx, s.c, env, o));
      const t = pexec(ctx, [s.th].concat(rest), env, o);
      const e = pexec(ctx, (s.el ? [s.el] : []).concat(rest), env, o);
      if (t.k === 'none' && e.k === 'none') return P_NONE;
      return { k: 'if', c: c.sql, t, e };
    }
    if (s.k === 'ret') return s.v ? { k: 'val', v: pval(ctx, pconv(ctx, s.v, env, o)) } : P_NONE;
    if (s.k === 'expr') {
      const e = s.e;
      if (e.k === 'call' && e.name === 'emit') {
        if (e.args.length !== 1) throw new Error('emit() à plusieurs arguments (champ composite) non pris en charge');
        if (hasEmit(rest)) ctx.notes.add('warn', 'Plusieurs emit()', 'Un champ runtime qui émet plusieurs valeurs devient un tableau dans Elasticsearch ; seule la première est gardée ici.');
        return { k: 'val', v: pval(ctx, pconv(ctx, e.args[0], env, o)) };
      }
      if (o.mode === 'expr' && !rest.some(x => x.k !== 'nop')) return { k: 'val', v: pval(ctx, pconv(ctx, e, env, o)) };
    }
  }
  return P_NONE;
}
function prender(r) {
  if (r.k === 'none') return 'NULL';
  if (r.k === 'val') return r.v.sql;
  const parts = []; let cur = r;
  while (cur.k === 'if') { parts.push(cur.c, prender(cur.t)); cur = cur.e; }
  const els = prender(cur);
  return parts.length === 2 ? `if(${parts[0]}, ${parts[1]}, ${els})` : `multiIf(${parts.join(', ')}, ${els})`;
}
function prType(r) { if (r.k === 'val') return r.v.ty; if (r.k === 'if') { const a = prType(r.t); return a && a !== 'null' ? a : prType(r.e); } return null; }
function painlessToSQL(ctx, src, o) {
  o = o || {};
  const prog = pparse(String(src));
  const r = pexec(ctx, prog, {}, o);
  // tree : l’arbre de décision du script (conditions et valeurs émises), dont un filtre peut remonter les branches
  return { sql: prender(r), ty: prType(r), tree: r };
}

/* ---------- Lucene (query_string) ---------- */
function luceneTokens(qs) {
  const toks = []; let i = 0;
  while (i < qs.length) {
    const c = qs[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    if (qs.startsWith('&&', i)) { toks.push({ t: 'AND' }); i += 2; continue; }
    if (qs.startsWith('||', i)) { toks.push({ t: 'OR' }); i += 2; continue; }
    if ((c === '+' || c === '-' || c === '!') && qs[i + 1] && !/\s/.test(qs[i + 1])) { toks.push({ t: c === '+' ? 'PLUS' : 'NOT' }); i++; continue; }
    if (c === '"') {
      let j = i + 1, v = '';
      while (j < qs.length && qs[j] !== '"') { if (qs[j] === '\\') { v += qs[j + 1] || ''; j += 2; } else v += qs[j++]; }
      if (j >= qs.length) throw new Error('guillemet non fermé');
      i = j + 1; if (qs[i] === '~') { i++; while (/\d/.test(qs[i] || '')) i++; }
      toks.push({ t: 'phrase', v }); continue;
    }
    if (c === '[' || c === '{') {
      let j = i + 1; while (j < qs.length && qs[j] !== ']' && qs[j] !== '}') j++;
      if (j >= qs.length) throw new Error('intervalle non fermé');
      toks.push({ t: 'range', v: qs.slice(i + 1, j), lo: c === '[', hi: qs[j] === ']' }); i = j + 1; continue;
    }
    if (c === '/') {
      let j = i + 1, v = '';
      while (j < qs.length && qs[j] !== '/') { if (qs[j] === '\\' && qs[j + 1] === '/') { v += '/'; j += 2; } else v += qs[j++]; }
      if (j >= qs.length) throw new Error('expression régulière non fermée');
      toks.push({ t: 'regex', v }); i = j + 1; continue;
    }
    let s = '';
    while (i < qs.length && !/[\s()]/.test(qs[i])) {
      if (qs[i] === '\\' && i + 1 < qs.length) { s += qs[i + 1]; i += 2; continue; }
      if (qs[i] === ':') break;
      s += qs[i++];
    }
    if (qs[i] === ':') { toks.push({ t: 'field', v: s }); i++; continue; }
    if (s === 'AND' || s === 'OR' || s === 'NOT') toks.push({ t: s }); else if (s) toks.push({ t: 'term', v: s });
  }
  return toks;
}
function luceneParse(qs, defaultOp) {
  const toks = luceneTokens(qs); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  const defOp = String(defaultOp || 'OR').toUpperCase();
  const starts = t => t && ['term', 'phrase', 'range', 'regex', 'field', '(', 'NOT', 'PLUS'].includes(t.t);
  function assign(node, f) { if (node.op === 'leaf') { if (!node.field) node.field = f; } else node.a.forEach(x => assign(x, f)); }
  function orE() {
    let l = andE();
    for (;;) {
      const t = peek();
      if (t && t.t === 'OR') { next(); l = { op: 'or', a: [l, andE()] }; }
      else if (defOp === 'OR' && starts(t) && t.t !== 'NOT') l = { op: 'or', a: [l, andE()] };
      else break;
    }
    return l;
  }
  function andE() {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t && t.t === 'AND') { next(); l = { op: 'and', a: [l, unary()] }; }
      else if (t && t.t === 'NOT') l = { op: 'and', a: [l, unary()] };
      else if (defOp === 'AND' && starts(t)) l = { op: 'and', a: [l, unary()] };
      else break;
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (!t) throw new Error('requête query_string incomplète');
    if (t.t === 'NOT') { next(); return { op: 'not', a: [unary()] }; }
    if (t.t === 'PLUS') { next(); return unary(); }
    return primary();
  }
  // Elasticsearch refuse une requête mal formée (HTTP 400) : l’analyse doit échouer de la même façon
  function close() {
    if (!peek() || peek().t !== ')') throw new Error('parenthèse non fermée');
    next();
  }
  function primary() {
    const t = next();
    if (!t) throw new Error('requête query_string incomplète');
    if (t.t === '(') { const e = orE(); close(); return e; }
    if (t.t === 'field') {
      const nt = peek();
      if (nt && nt.t === '(') { next(); const e = orE(); close(); assign(e, t.v); return e; }
      const leaf = primary(); assign(leaf, t.v); return leaf;
    }
    if (t.t === ')') throw new Error('parenthèse fermante inattendue');
    if (t.t === 'AND' || t.t === 'OR' || t.t === 'NOT' || t.t === 'PLUS') throw new Error(`opérateur ${t.t} inattendu`);
    return { op: 'leaf', field: null, tok: t };
  }
  const e = orE();
  if (p < toks.length) throw new Error(toks[p].t === ')' ? 'parenthèse fermante en trop' : 'fin de requête inattendue');
  return e;
}

/* ---------- simple_query_string ---------- */
/*
 * Syntaxe distincte de query_string, et jamais refusée par Elasticsearch : un caractère en trop est ignoré.
 *   +  ET      |  OU      -mot  négation      "…"  phrase      mot*  préfixe      mot~N  flou      ( )  priorité
 * Les opérateurs s’appliquent de gauche à droite, sans priorité entre eux : a | b + c vaut (a OU b) ET c.
 * Sans opérateur, deux termes sont reliés par l’opérateur par défaut. Une négation forme une clause à part
 * entière : avec OU par défaut, « a -b » vaut a OU (NON b).
 */
function simpleQueryParse(qs, defaultOp) {
  const text = String(qs);
  const defOp = String(defaultOp || 'OR').toUpperCase() === 'AND' ? 'and' : 'or';
  const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const endsToken = c => c === '"' || c === '|' || c === '+' || c === '(' || c === ')' || isSpace(c);

  function parse(from, to) {
    let i = from;
    let top = null; let pending = null; let previous = null; let negations = 0;
    function add(branch) {
      if (negations % 2 === 1) branch = { op: 'not', a: [branch] };
      negations = 0;
      if (top === null) { top = branch; pending = null; return; }
      const op = pending || defOp;
      if (previous !== op) top = { op, a: [top] };
      top.a.push(branch);
      previous = op; pending = null;
    }
    while (i < to) {
      const c = text[i];
      if (c === '(') {
        // Cherche la parenthèse fermante correspondante, hors des phrases
        let depth = 1; let j = i + 1; let inPhrase = false;
        for (; j < to && depth > 0; j++) {
          if (text[j] === '"') inPhrase = !inPhrase;
          else if (!inPhrase && text[j] === '(') depth++;
          else if (!inPhrase && text[j] === ')') depth--;
        }
        if (depth > 0) { i++; negations = 0; continue; }
        const sub = parse(i + 1, j - 1);
        i = j;
        if (sub) add(sub); else negations = 0;
        continue;
      }
      if (c === ')') { i++; negations = 0; continue; }
      if (c === '"') {
        const end = text.indexOf('"', i + 1);
        if (end < 0 || end >= to) { i++; negations = 0; continue; }
        const phrase = text.slice(i + 1, end);
        i = end + 1;
        if (text[i] === '~') { i++; while (i < to && /\d/.test(text[i])) i++; }
        if (phrase.trim()) add({ op: 'leaf', field: null, tok: { t: 'phrase', v: phrase } }); else negations = 0;
        continue;
      }
      if (c === '+') { if (pending === null && top !== null) pending = 'and'; i++; negations = 0; continue; }
      if (c === '|') { if (pending === null && top !== null) pending = 'or'; i++; negations = 0; continue; }
      if (c === '-') { negations++; i++; continue; }
      if (isSpace(c)) { i++; negations = 0; continue; }
      let word = '';
      while (i < to) {
        if (text[i] === '\\' && i + 1 < to) { word += text[i + 1]; i += 2; continue; }
        if (endsToken(text[i])) break;
        word += text[i++];
      }
      const fuzzy = /^(.+)~(\d*)$/.exec(word);
      if (fuzzy) add({ op: 'leaf', field: null, tok: { t: 'fuzzy', v: fuzzy[1], n: fuzzy[2] === '' ? null : +fuzzy[2] } });
      else if (word.length > 1 && word.endsWith('*')) add({ op: 'leaf', field: null, tok: { t: 'prefix', v: word.slice(0, -1) } });
      else if (word) add({ op: 'leaf', field: null, tok: { t: 'term', v: word } });
    }
    return top;
  }
  return parse(0, text.length);
}


