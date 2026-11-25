/*
 * Passerelle — d’un échantillon de journaux à un pipeline VRL (« Log vers Vector »).
 *
 * L’utilisateur colle quelques lignes d’un journal : le moteur reconnaît le format (accès HTTP, journaux applicatifs,
 * syslog, JSON, logfmt…), écrit le programme VRL qui découpe chaque ligne en champs typés et nommés selon une
 * convention (OpenTelemetry ou ECS), et une configuration Vector complète dont les tests unitaires rejouent les lignes
 * de l’échantillon : « vector test » vérifie, champ par champ, la valeur que Passerelle annonce.
 *
 * Pour que l’annonce soit exacte, chaque format est décrit une seule fois (expression régulière et opérations sur les
 * champs capturés) ; deux interprètes lisent cette description : l’un écrit le VRL, l’autre calcule en JavaScript
 * l’événement que ce VRL produira. Le banc tests/logs/vector.mjs les confronte dans un vrai Vector.
 *
 * Les expressions régulières sont écrites dans la syntaxe commune à Rust (VRL) et à JavaScript : groupes nommés
 * (?P<nom>…), pas de retour arrière (\1) ni d’assertion (?=…) ; \z (fin du texte, sans $ que Vector pourrait prendre
 * pour une variable d’environnement) devient $ côté JavaScript.
 */
import { isObj, makeNotes, segName, vq, vraw } from './base.js';
import { toTOML, toYAML } from './logstash.js';

/* ---------- Valeurs typées : VRL distingue entier et flottant, JavaScript non ---------- */
export class LogFloat {
  constructor(v) {
    this.v = v;
  }
}
// Horodatage : nanosecondes depuis l’époque (BigInt) ; sans année dans le journal, l’année est celle du jour
export class LogTime {
  constructor(ns, yearless) {
    this.ns = ns;
    this.yearless = !!yearless;
  }
}
const isInt = v => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
// Un objet « simple » : ni horodatage ni flottant typés
const isPlain = v => isObj(v) && !(v instanceof LogTime) && !(v instanceof LogFloat);

/* Analyseur JSON qui garde la différence entre 1 et 1.0, et les entiers au-delà de 2^53, comme serde_json */
function jparse(text) {
  let i = 0;
  const s = text;
  const ws = () => {
    while (i < s.length && ' \t\n\r'.includes(s[i])) i++;
  };
  const fail = () => {
    throw new Error(`JSON invalide (position ${i})`);
  };
  function str() {
    let out = '';
    i++;
    for (;;) {
      if (i >= s.length) fail();
      const c = s[i++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = s[i++];
        if (e === 'u') {
          const h = s.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else if ('"\\/bfnrt'.includes(e)) out += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] || e;
        else fail();
      } else if (c < ' ') fail();
      else out += c;
    }
  }
  function val() {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const o = {};
      ws();
      if (s[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        const k = str();
        ws();
        if (s[i++] !== ':') fail();
        o[k] = val();
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i++] === '}') return o;
        fail();
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (s[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(val());
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i++] === ']') return a;
        fail();
      }
    }
    if (c === '"') return str();
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      if (m[1] || m[2]) return new LogFloat(Number(m[0]));
      const n = Number(m[0]);
      return Number.isSafeInteger(n) ? n : BigInt(m[0]);
    }
    for (const [w, v] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ])
      if (s.startsWith(w, i)) {
        i += w.length;
        return v;
      }
    fail();
  }
  const v = val();
  ws();
  if (i !== s.length) fail();
  return v;
}

/* ---------- Horodatages ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/*
 * Chaque forme d’horodatage : l’expression qui la reconnaît (JavaScript), le format strptime de VRL, et ce qu’il faut
 * préparer avant (virgule décimale, année absente). zoned : le texte porte son fuseau ; sinon, celui des options.
 */
const TS_KINDS = {
  iso: {
    label: 'ISO 8601 avec fuseau',
    re: /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
    fmt: m => `%Y-%m-%d${m[4]}%H:%M:%S%.f%#z`,
    zoned: true
  },
  isoSpaceZone: {
    label: 'date, heure et décalage séparés',
    re: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))? ([+-]\d{4})$/,
    fmt: () => '%Y-%m-%d %H:%M:%S%.f %z',
    zoned: true
  },
  isoLocal: {
    label: 'ISO 8601 sans fuseau',
    re: /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/,
    fmt: m => `%Y-%m-%d${m[4]}%H:%M:%S%.f`
  },
  clf: {
    label: 'format Apache (CLF)',
    re: /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? ([+-]\d{4})$/,
    fmt: () => '%d/%b/%Y:%H:%M:%S%.f %z',
    zoned: true
  },
  slash: {
    label: 'AAAA/MM/JJ',
    re: /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
    fmt: () => '%Y/%m/%d %H:%M:%S%.f'
  },
  dots: {
    label: 'AAAA.MM.JJ',
    re: /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
    fmt: () => '%Y.%m.%d %H:%M:%S%.f'
  },
  ctime: {
    label: 'format ctime (Apache)',
    re: /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4})$/,
    fmt: () => '%a %b %e %H:%M:%S%.f %Y'
  },
  bsd: {
    label: 'syslog BSD, sans année',
    re: /^([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2})$/,
    fmt: () => '%Y %b %e %H:%M:%S',
    yearless: true
  },
  klog: {
    label: 'klog, sans année',
    re: /^(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/,
    fmt: () => '%Y %m%d %H:%M:%S%.f',
    yearless: true
  },
  epochDec: { label: 'secondes Unix (texte)', re: /^(\d{9,11})(?:\.(\d{1,9}))?$/, fmt: () => '%s%.f', zoned: true },
  epochMicro: { label: 'microsecondes Unix (texte)', re: /^(\d{15,17})$/, zoned: true }
};
// Parties d’un horodatage, dans l’ordre : année, mois, jour, heure, minute, seconde, fraction, décalage
function tsParts(kind, s) {
  const m = TS_KINDS[kind].re.exec(s);
  if (!m) return null;
  const mon = x => MONTHS.indexOf(x) + 1;
  switch (kind) {
    case 'iso':
      return { y: +m[1], mo: +m[2], d: +m[3], h: +m[5], mi: +m[6], s: +m[7], frac: m[8] || '', off: m[9] };
    case 'isoSpaceZone':
      return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], frac: m[7] || '', off: m[8] };
    case 'isoLocal':
      return { y: +m[1], mo: +m[2], d: +m[3], h: +m[5], mi: +m[6], s: +m[7], frac: m[8] || '' };
    case 'clf':
      return { y: +m[3], mo: mon(m[2]), d: +m[1], h: +m[4], mi: +m[5], s: +m[6], frac: m[7] || '', off: m[8] };
    case 'slash':
    case 'dots':
      return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], frac: m[7] || '' };
    case 'ctime':
      return { y: +m[7], mo: mon(m[1]), d: +m[2], h: +m[3], mi: +m[4], s: +m[5], frac: m[6] || '' };
    case 'bsd':
      return { y: null, mo: mon(m[1]), d: +m[2], h: +m[3], mi: +m[4], s: +m[5], frac: '' };
    case 'klog':
      return { y: null, mo: +m[1], d: +m[2], h: +m[3], mi: +m[4], s: +m[5], frac: m[6] };
    default:
      return null;
  }
}
export function tsKindOf(s) {
  if (typeof s !== 'string') return null;
  for (const k of Object.keys(TS_KINDS)) if (TS_KINDS[k].re.test(s) && (tsParts(k, s) || /^epoch/.test(k))) return k;
  return null;
}
// Décalage d’un fuseau IANA (en minutes) à un instant local donné, par l’API Intl
function zoneOffset(zone, y, mo, d, h, mi, s) {
  if (!zone || zone === 'UTC') return 0;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  });
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const offAt = utc => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map(x => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utc) / 60000;
  };
  let off = offAt(local);
  off = offAt(local - off * 60000);
  return off;
}
export function validZone(z) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}
// L’année que Vector donnera à un horodatage sans année : celle du jour, ou la précédente si la date tombe à plus d’un jour dans le futur
function guessYear(p, zone, now) {
  const y = now.getUTCFullYear();
  const at = yy =>
    Date.UTC(yy, p.mo - 1, p.d, p.h, p.mi, p.s) - zoneOffset(zone, yy, p.mo, p.d, p.h, p.mi, p.s) * 60000;
  return at(y) > now.getTime() + 86400000 ? y - 1 : y;
}
// Valeur prédite (LogTime) d’un horodatage, comme parse_timestamp la donnera
function tsValue(kind, s, zone, now) {
  if (kind === 'epochDec') {
    const m = TS_KINDS.epochDec.re.exec(s);
    return new LogTime(BigInt(m[1]) * 1000000000n + BigInt((m[2] || '').padEnd(9, '0')));
  }
  if (kind === 'epochMicro') return new LogTime(BigInt(s) * 1000n);
  const p = tsParts(kind, s);
  if (!p) return null;
  const yearless = p.y === null;
  if (yearless) p.y = guessYear(p, zone, now);
  let offMin;
  if (p.off !== undefined) {
    if (p.off === 'Z') offMin = 0;
    else {
      const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(p.off);
      offMin = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
    }
  } else offMin = zoneOffset(zone, p.y, p.mo, p.d, p.h, p.mi, p.s);
  const ms = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - offMin * 60000;
  const frac = BigInt((p.frac || '').slice(0, 9).padEnd(9, '0'));
  return new LogTime(BigInt(ms) * 1000000n + frac, yearless);
}
// Rendu RFC 3339 (UTC) d’un horodatage prédit, à la nanoseconde, sans zéros inutiles
export function timeText(t) {
  const ms = Number(t.ns / 1000000n);
  const sub = t.ns % 1000000000n;
  const base = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, '');
  const frac = sub ? '.' + String(sub).padStart(9, '0').replace(/0+$/, '') : '';
  return `${base}${frac}Z`;
}

/* ---------- Conventions de nommage ---------- */
/*
 * Pour chaque rôle, son emplacement en OpenTelemetry puis en ECS.
 * OpenTelemetry suit la forme des événements de la source opentelemetry de Vector (celle qu’attend sa sortie OTLP) :
 * .message (le corps), .timestamp, .severity_text, .severity_number, .attributes et .resources (des tables à clés
 * pointées, comme LogAttributes et ResourceAttributes de ClickStack), .scope.name, .trace_id, .span_id.
 * « a: » désigne un attribut, « r: » un attribut de ressource ; ECS écrit des objets imbriqués.
 */
const PLACES = {
  message: ['message', 'message'],
  original: ['a:log.record.original', 'event.original'],
  time: ['timestamp', '@timestamp'],
  level: ['severity_text', 'log.level'],
  logger: ['scope.name', 'log.logger'],
  thread: ['a:thread.name', 'process.thread.name'],
  thread_id: ['a:thread.id', 'process.thread.id'],
  pid: ['r:process.pid', 'process.pid'],
  app: ['r:service.name', 'process.name'],
  service: ['r:service.name', 'service.name'],
  host: ['r:host.name', 'host.name'],
  client_ip: ['a:client.address', 'source.address'],
  client_port: ['a:client.port', 'source.port'],
  source_ip: ['a:source.address', 'source.ip'],
  source_port: ['a:source.port', 'source.port'],
  user: ['a:user.name', 'user.name'],
  effective_user: ['a:user.effective.name', 'user.effective.name'],
  method: ['a:http.request.method', 'http.request.method'],
  path: ['a:url.path', 'url.path'],
  query: ['a:url.query', 'url.query'],
  request: ['a:http.request.line', 'http.request.line'],
  protocol: ['a:network.protocol.name', 'network.protocol'],
  protocol_version: ['a:network.protocol.version', 'http.version'],
  status: ['a:http.response.status_code', 'http.response.status_code'],
  bytes: ['a:http.response.body.size', 'http.response.body.bytes'],
  referrer: ['a:http.request.header.referer', 'http.request.referrer'],
  user_agent: ['a:user_agent.original', 'user_agent.original'],
  forwarded: ['a:http.request.header.x-forwarded-for', 'network.forwarded_ip'],
  duration: ['a:http.server.request.duration', 'event.duration'],
  server: ['a:server.address', 'server.address'],
  host_header: ['a:http.request.header.host', 'url.domain'],
  file: ['a:code.file.path', 'log.origin.file.name'],
  line: ['a:code.line.number', 'log.origin.file.line'],
  trace_id: ['trace_id', 'trace.id'],
  span_id: ['span_id', 'span.id'],
  exc_type: ['a:exception.type', 'error.type'],
  exc_message: ['a:exception.message', 'error.message'],
  exc_stack: ['a:exception.stacktrace', 'error.stack_trace'],
  uptime: ['a:host.uptime', 'host.uptime'],
  pri: ['a:syslog.priority', 'log.syslog.priority'],
  facility: ['a:syslog.facility', 'log.syslog.facility.name'],
  syslog_severity: ['a:syslog.severity', 'log.syslog.severity.name'],
  msgid: ['a:syslog.msgid', 'log.syslog.msgid'],
  sd: ['a:syslog.structured_data', 'log.syslog.structured_data'],
  syslog_version: ['a:syslog.version', 'log.syslog.version'],
  outcome: ['a:event.outcome', 'event.outcome'],
  ssh_method: ['a:ssh.method', 'system.auth.ssh.method'],
  tty: ['a:sudo.tty', 'system.auth.sudo.tty'],
  pwd: ['a:sudo.pwd', 'system.auth.sudo.pwd'],
  command: ['a:process.command_line', 'process.command_line'],
  stream: ['a:log.iostream', 'stream'],
  parse_error: ['a:log.parse.error', 'error.message']
};
export const CONVENTIONS = { otel: 'OpenTelemetry', ecs: 'ECS (Elastic Common Schema)' };
// Rôles et emplacements, pour la documentation (docs/LOG-VERS-VECTOR.md)
export const LOG_FIELD_PLACES = PLACES;

// Emplacement : { root: 'attributes'|'resources', key } ou { segs: […] }
function parsePlace(p) {
  const m = /^([ar]):(.+)$/.exec(p);
  if (m) return { root: m[1] === 'a' ? 'attributes' : 'resources', key: m[2] };
  return { segs: p === '@timestamp' ? ['@timestamp'] : p.split('.') };
}
function placeOf(conv, what) {
  if (typeof what === 'string') {
    const p = PLACES[what];
    return p && p[conv === 'otel' ? 0 : 1] ? parsePlace(p[conv === 'otel' ? 0 : 1]) : null;
  }
  return parsePlace(what[conv === 'otel' ? 0 : 1]);
}
const vrlPath = pl => (pl.root ? `.${pl.root}.${vq(pl.key)}` : '.' + pl.segs.map(segName).join('.'));
export const placeName = pl => (pl.root ? `${pl.root}["${pl.key}"]` : pl.segs.join('.'));
function setAt(ev, pl, v) {
  if (pl.root) {
    if (!isPlain(ev[pl.root])) ev[pl.root] = {};
    ev[pl.root][pl.key] = v;
    return;
  }
  let o = ev;
  pl.segs.slice(0, -1).forEach(k => {
    if (!isPlain(o[k])) o[k] = {};
    o = o[k];
  });
  o[pl.segs[pl.segs.length - 1]] = v;
}
function getAt(ev, pl) {
  if (pl.root) return ev[pl.root] ? ev[pl.root][pl.key] : undefined;
  return pl.segs.reduce((o, k) => (isPlain(o) ? o[k] : undefined), ev);
}

/* ---------- Niveaux de sévérité ---------- */
// Numéros du modèle de données OpenTelemetry, à partir du texte du niveau mis en minuscules
const SEVERITY = [
  [1, ['trace', 'finest', 'finer', 'trace1', 'trace2', 'trace3', 'trace4', 'trace5', 'trace6', 'trace7', 'trace8']],
  [5, ['debug', 'fine', 'dbg', 'config', 'verbose']],
  [9, ['info', 'information', 'informational']],
  [10, ['notice']],
  [13, ['warn', 'warning']],
  [17, ['error', 'err', 'severe']],
  [21, ['fatal', 'critical', 'crit', 'alert', 'emerg', 'emergency', 'panic', 'dpanic']]
];
const sevNumber = text => {
  const n = String(text).toLowerCase();
  const hit = SEVERITY.find(([, l]) => l.includes(n));
  return hit ? hit[0] : 0;
};
const sevVRL = v =>
  SEVERITY.map(([n, l], i) => `${i ? ' else ' : ''}if includes([${l.map(x => vq(x)).join(', ')}], ${v}) { ${n} }`).join(
    ''
  ) + ' else { 0 }';
const LETTERS = { I: 'INFO', W: 'WARN', E: 'ERROR', F: 'FATAL', D: 'DEBUG', T: 'TRACE' };
const SYSLOG_SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const SYSLOG_SEV_NUMBERS = [21, 21, 21, 17, 13, 10, 9, 5];
const SYSLOG_FACILITIES = [
  'kern',
  'user',
  'mail',
  'daemon',
  'auth',
  'syslog',
  'lpr',
  'news',
  'uucp',
  'cron',
  'authpriv',
  'ftp',
  'ntp',
  'security',
  'console',
  'solaris-cron',
  'local0',
  'local1',
  'local2',
  'local3',
  'local4',
  'local5',
  'local6',
  'local7'
];
// Niveaux numériques de pino et bunyan (Node.js)
const PINO = [
  [10, 'trace'],
  [20, 'debug'],
  [30, 'info'],
  [40, 'warn'],
  [50, 'error'],
  [60, 'fatal']
];
const pinoText = n => (PINO.find(([k]) => n <= k) || [0, 'fatal'])[1];

/* ---------- Analyse de texte comme VRL : parse_key_value et parse_logfmt ---------- */
// Paires clé=valeur séparées par des espaces ; guillemets doubles ou simples retirés, \" et \\ résolus
function keyValues(s, standalone) {
  const out = {};
  const re = /([^\s=]+)(?:=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']\S*|))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[2] === undefined) {
      if (standalone) out[m[1]] = true;
      continue;
    }
    let v = m[2];
    if (/^["']/.test(v)) v = v.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    out[m[1]] = v;
  }
  return out;
}
// flatten de VRL : objets imbriqués en clés pointées, tableaux gardés tels quels, objets vides retirés
function flattenObj(o, pre, out) {
  out = out || {};
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? `${pre}.${k}` : k;
    if (isPlain(v)) flattenObj(v, key, out);
    else out[key] = v;
  }
  return out;
}
function unflattenObj(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) setAt(out, { segs: k.split('.') }, v);
  return out;
}
const deepMerge = (a, b) => {
  for (const [k, v] of Object.entries(b)) {
    if (isPlain(v) && isPlain(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
};
const typeName = v =>
  v instanceof LogTime
    ? 'horodatage'
    : v instanceof LogFloat
      ? 'flottant'
      : isInt(v)
        ? 'entier'
        : typeof v === 'boolean'
          ? 'booléen'
          : Array.isArray(v)
            ? 'tableau'
            : isPlain(v)
              ? 'objet'
              : v === null
                ? 'nul'
                : 'texte';

/* ---------- Formats à expression régulière ---------- */
const RX = {
  isoZ: String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})`,
  isoAny: String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?`,
  quoted: String.raw`(?:[^"\\]|\\.)*`,
  javaLevel: 'TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE'
};
// Suite d’une trace de pile : lignes qui commencent par une espace, « at », « Caused by: », « ... n more », ou le nom d’une exception
const CONTINUATION =
  /^(?:\s|at |Caused by:|Suppressed:|\.\.\. \d+ (?:more|common)|Traceback \(|(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error|Throwable|Interrupt|Exit)\b|goroutine \d+ \[|panic: )/;
const EXC_RE = String.raw`(?m)^(?:Caused by: )?(?P<type>(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error|Throwable|Interrupt|Exit))(?::[ \t]*(?P<message>.*))?`;

/*
 * Opérations sur les groupes capturés :
 *   str, int, float     recopie (dash : « - » ou vide = absent ; opt : groupe facultatif)
 *   lower               texte en minuscules (nom de protocole)
 *   ts                  horodatage (forme déduite de l’échantillon)
 *   level               niveau (letters : I, W, E… ; syslog : sévérité d’un PRI)
 *   msg                 le message ; ses lignes suivantes donnent l’exception (stack : groupe de la trace)
 *   kv                  paires clé=valeur (parse_key_value) rangées sous un préfixe
 *   json                objet JSON rangé dans les attributs (OpenTelemetry) ou sous un préfixe (ECS)
 *   pri                 priorité syslog : facilité et sévérité
 *   caller              « fichier:ligne »
 *   epochDur            durée en secondes : event.duration (ECS) en nanosecondes
 * Une opération vise un rôle de PLACES, ou un emplacement propre [OpenTelemetry, ECS].
 */
export const LOG_FORMATS = [
  {
    id: 'auditd',
    label: 'Linux auditd (audit.log)',
    family: 'linux',
    re: String.raw`^type=(?P<type>\S+) msg=audit\((?P<epoch>\d+\.\d+):(?P<serial>\d+)\): ?(?P<kv>[\s\S]*)\z`,
    ops: [
      { k: 'str', g: 'type', to: ['a:auditd.record_type', 'auditd.log.record_type'] },
      { k: 'ts', g: 'epoch' },
      { k: 'int', g: 'serial', to: ['a:auditd.sequence', 'auditd.log.sequence'] },
      { k: 'kv', g: 'kv', prefix: ['auditd.', 'auditd.log.'] }
    ]
  },
  {
    id: 'syslog5424',
    label: 'Syslog RFC 5424',
    family: 'linux',
    native: 'parse_syslog',
    re: String.raw`^<(?P<pri>\d{1,3})>(?P<version>\d{1,2}) (?P<time>\S+) (?P<host>\S+) (?P<app>\S+) (?P<procid>\S+) (?P<msgid>\S+) (?P<sd>-|(?:\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*"|\\.)*\])+)(?: (?P<msg>[\s\S]*))?\z`,
    ops: [
      { k: 'pri', g: 'pri' },
      { k: 'int', g: 'version', to: 'syslog_version' },
      { k: 'ts', g: 'time', dash: true },
      { k: 'str', g: 'host', to: 'host', dash: true },
      { k: 'str', g: 'app', to: 'app', dash: true },
      { k: 'int', g: 'procid', to: 'pid', dash: true, digits: true },
      { k: 'str', g: 'msgid', to: 'msgid', dash: true },
      { k: 'str', g: 'sd', to: 'sd', dash: true },
      { k: 'msg', g: 'msg', opt: true, enrich: ['sshd', 'sudo', 'kernel'], app: 'app' }
    ]
  },
  {
    id: 'syslog3164',
    label: 'Syslog BSD (/var/log/messages, syslog, auth.log, kern.log)',
    family: 'linux',
    native: 'parse_syslog',
    re: String.raw`^(?:<(?P<pri>\d{1,3})>)?(?P<time>[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}) (?P<host>\S+) (?P<app>[^\s\[:]+)(?:\[(?P<pid>\d+)\])?: +(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'pri', g: 'pri', opt: true },
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'host', to: 'host' },
      { k: 'str', g: 'app', to: 'app' },
      { k: 'int', g: 'pid', to: 'pid', opt: true },
      { k: 'msg', g: 'msg', enrich: ['sshd', 'sudo', 'kernel'], app: 'app' }
    ]
  },
  {
    id: 'syslogIso',
    label: 'Syslog horodaté ISO 8601 (rsyslog, journalctl -o short-iso)',
    family: 'linux',
    re: String.raw`^(?:<(?P<pri>\d{1,3})>)?(?P<time>${RX.isoZ}) (?P<host>\S+) (?P<app>[^\s\[:]+)(?:\[(?P<pid>\d+)\])?: +(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'pri', g: 'pri', opt: true },
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'host', to: 'host' },
      { k: 'str', g: 'app', to: 'app' },
      { k: 'int', g: 'pid', to: 'pid', opt: true },
      { k: 'msg', g: 'msg', enrich: ['sshd', 'sudo', 'kernel'], app: 'app' }
    ]
  },
  {
    id: 'dmesg',
    label: 'Noyau Linux (dmesg)',
    family: 'linux',
    re: String.raw`^\[ *(?P<uptime>\d+\.\d+)\] (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'float', g: 'uptime', to: 'uptime' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'combined',
    label: 'Journal d’accès HTTP (combined ou common : nginx, Apache)',
    family: 'web',
    native: 'parse_nginx_log ou parse_apache_log',
    re: String.raw`^(?P<client>\S+) (?P<ident>\S+) (?P<user>\S+) \[(?P<time>[^\]]+)\] "(?:(?P<method>[A-Z]+) (?P<path>[^\s?"]*)(?:\?(?P<query>[^\s"]*))?(?: (?P<protocol>[A-Za-z]+)/(?P<pver>[0-9.]+))?|(?P<request>${RX.quoted}))" (?P<status>\d{3}) (?P<bytes>\d+|-)(?: "(?P<referrer>${RX.quoted})" "(?P<agent>${RX.quoted})"(?: "(?P<xff>${RX.quoted})")?)?(?: (?P<duration>\d+\.\d+))?\z`,
    ops: [
      { k: 'str', g: 'client', to: 'client_ip' },
      { k: 'str', g: 'user', to: 'user', dash: true },
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'method', to: 'method', opt: true },
      { k: 'str', g: 'path', to: 'path', opt: true },
      { k: 'str', g: 'query', to: 'query', opt: true, dash: true },
      { k: 'lower', g: 'protocol', to: 'protocol', opt: true },
      { k: 'str', g: 'pver', to: 'protocol_version', opt: true },
      { k: 'str', g: 'request', to: 'request', opt: true, dash: true },
      { k: 'int', g: 'status', to: 'status' },
      { k: 'int', g: 'bytes', to: 'bytes', dash: true },
      { k: 'str', g: 'referrer', to: 'referrer', opt: true, dash: true },
      { k: 'str', g: 'agent', to: 'user_agent', opt: true, dash: true },
      { k: 'str', g: 'xff', to: 'forwarded', opt: true, dash: true },
      { k: 'epochDur', g: 'duration', to: 'duration', opt: true }
    ]
  },
  {
    id: 'nginxError',
    label: 'Journal d’erreurs nginx',
    family: 'web',
    re: String.raw`^(?P<time>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(?P<level>[a-z]+)\] (?P<pid>\d+)#(?P<tid>\d+): (?:\*(?P<cid>\d+) )?(?P<msg>[\s\S]*?)(?:, client: (?P<client>[^,]+))?(?:, server: (?P<server>[^,]*))?(?:, request: "(?P<method>[A-Z]+) (?P<path>[^\s?"]*)(?:\?(?P<query>[^\s"]*))? (?P<protocol>[A-Za-z]+)/(?P<pver>[0-9.]+)")?(?:, upstream: "(?P<upstream>[^"]*)")?(?:, host: "(?P<host>[^"]*)")?(?:, referrer: "(?P<referrer>[^"]*)")?\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'int', g: 'pid', to: 'pid' },
      { k: 'int', g: 'tid', to: 'thread_id' },
      { k: 'int', g: 'cid', to: ['a:nginx.connection_id', 'nginx.error.connection_id'], opt: true },
      { k: 'msg', g: 'msg' },
      { k: 'str', g: 'client', to: 'client_ip', opt: true },
      { k: 'str', g: 'server', to: 'server', opt: true, dash: true },
      { k: 'str', g: 'method', to: 'method', opt: true },
      { k: 'str', g: 'path', to: 'path', opt: true },
      { k: 'str', g: 'query', to: 'query', opt: true, dash: true },
      { k: 'lower', g: 'protocol', to: 'protocol', opt: true },
      { k: 'str', g: 'pver', to: 'protocol_version', opt: true },
      { k: 'str', g: 'upstream', to: ['a:nginx.upstream', 'nginx.error.upstream'], opt: true },
      { k: 'str', g: 'host', to: 'host_header', opt: true, dash: true },
      { k: 'str', g: 'referrer', to: 'referrer', opt: true, dash: true }
    ]
  },
  {
    id: 'apacheError',
    label: 'Journal d’erreurs Apache httpd',
    family: 'web',
    re: String.raw`^\[(?P<time>[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}(?:\.\d+)? \d{4})\] \[(?:(?P<module>[^:\]]+):)?(?P<level>[a-z]+\d?)\](?: \[pid (?P<pid>\d+)(?::tid (?P<tid>\d+))?\])?(?: \[client (?P<client>[^\]]+?)(?::(?P<cport>\d+))?\])? (?:(?P<code>AH\d{5}): )?(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'module', to: ['a:apache.module', 'apache.error.module'], opt: true },
      { k: 'level', g: 'level' },
      { k: 'int', g: 'pid', to: 'pid', opt: true },
      { k: 'int', g: 'tid', to: 'thread_id', opt: true },
      { k: 'str', g: 'client', to: 'client_ip', opt: true },
      { k: 'int', g: 'cport', to: 'client_port', opt: true },
      { k: 'str', g: 'code', to: ['a:apache.error.code', 'error.code'], opt: true },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'springBoot',
    label: 'Java Spring Boot (format par défaut)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]\d+(?:Z|[+-]\d{2}:?\d{2})?) +(?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL) +(?P<pid>\d+) +--- +(?:\[(?P<app>[^\]]*)\] +)?\[ *(?P<thread>[^\]]*?) *\] +(?P<logger>\S+) +: (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'int', g: 'pid', to: 'pid' },
      { k: 'str', g: 'app', to: 'service', opt: true, dash: true },
      { k: 'str', g: 'thread', to: 'thread' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'javaThreadFirst',
    label: 'Java Logback ou Log4j 2 (date [thread] NIVEAU logger - message)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>${RX.isoAny}) +\[(?P<thread>[^\]]+)\] +(?P<level>${RX.javaLevel}) +(?P<logger>\S+) +- (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'thread', to: 'thread' },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'javaLevelFirst',
    label: 'Java Log4j 2 ou Logback (date NIVEAU [thread] logger - message)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>${RX.isoAny}) +(?P<level>${RX.javaLevel}) +\[(?P<thread>[^\]]+)\] +(?P<logger>\S+?)(?: +-|:) (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'thread', to: 'thread' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'kafka',
    label: 'Apache Kafka (log4j : [date] NIVEAU message (classe))',
    family: 'app',
    multiline: true,
    re: String.raw`^\[(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\] (?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL) (?:\[(?P<component>[^\]]+)\] )?(?P<msg>[^\n]*?)(?: \((?P<logger>[^()\s]+)\))?(?P<stack>\n[\s\S]*)?\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'component', to: ['a:kafka.component', 'kafka.log.component'], opt: true },
      { k: 'str', g: 'logger', to: 'logger', opt: true },
      { k: 'msg', g: 'msg', stack: 'stack' }
    ]
  },
  {
    id: 'elasticsearchText',
    label: 'Elasticsearch, journal texte (versions 7 et antérieures)',
    family: 'app',
    multiline: true,
    re: String.raw`^\[(?P<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2},\d{3}(?:Z|[+-]\d{2}:?\d{2})?)\]\[(?P<level>[A-Z]+) *\]\[(?P<logger>[^\]]*?) *\] (?:\[(?P<node>[^\]]+)\] )?(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'str', g: 'node', to: ['a:elasticsearch.node.name', 'elasticsearch.node.name'], opt: true },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'clickhouse',
    label: 'ClickHouse, journal du serveur (texte)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d+) \[ *(?P<tid>\d+) *\] \{(?P<qid>[^}]*)\} <(?P<level>[A-Za-z]+)> (?P<logger>[^:]*?): (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'int', g: 'tid', to: 'thread_id' },
      { k: 'str', g: 'qid', to: ['a:clickhouse.query_id', 'clickhouse.query_id'], dash: true },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'hclog',
    label: 'HashiCorp hclog (Nomad, Vault, Consul)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>${RX.isoZ}) \[(?P<level>TRACE|DEBUG|INFO|WARN|ERROR)\] +(?:(?P<module>[A-Za-z0-9_.\-/]+): )?(?P<msg>[\s\S]*?)(?::? (?P<kv>[A-Za-z0-9_.\-]+=(?:"${RX.quoted}"|\S*)(?: [A-Za-z0-9_.\-]+=(?:"${RX.quoted}"|\S*))*))?\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'str', g: 'module', to: 'logger', opt: true },
      { k: 'msg', g: 'msg' },
      { k: 'kv', g: 'kv', opt: true, prefix: ['', 'labels.'] }
    ]
  },
  {
    id: 'otelZap',
    label: 'Go zap, format console (collecteur OpenTelemetry…)',
    family: 'app',
    re: String.raw`^(?P<time>${RX.isoZ})\t(?P<level>[a-zA-Z]+)\t(?:(?P<caller>[^\t]+:\d+)\t)?(?P<msg>[^\t]*)(?:\t(?P<fields>\{[\s\S]*\}))?\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'level', g: 'level' },
      { k: 'caller', g: 'caller', opt: true },
      { k: 'msg', g: 'msg' },
      { k: 'json', g: 'fields', opt: true, prefix: ['', 'labels.'] }
    ]
  },
  {
    id: 'pythonDash',
    label: 'Python logging (date - logger - NIVEAU - message)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) - (?P<logger>\S+) - (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL|NOTSET) - (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'level', g: 'level' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'pythonBasic',
    label: 'Python logging, basicConfig (NIVEAU:logger:message)',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL):(?P<logger>[^:\s]+):(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'level', g: 'level' },
      { k: 'str', g: 'logger', to: 'logger' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'gunicorn',
    label: 'Python Gunicorn',
    family: 'app',
    multiline: true,
    re: String.raw`^\[(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\] \[(?P<pid>\d+)\] \[(?P<level>[A-Z]+)\] (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'int', g: 'pid', to: 'pid' },
      { k: 'level', g: 'level' },
      { k: 'msg', g: 'msg' }
    ]
  },
  {
    id: 'klog',
    label: 'Go klog ou glog (Kubernetes)',
    family: 'app',
    native: 'parse_klog',
    multiline: true,
    re: String.raw`^(?P<level>[IWEF])(?P<time>\d{4} \d{2}:\d{2}:\d{2}\.\d+) +(?P<tid>\d+) (?P<file>[^:\s\]]+):(?P<line>\d+)\] (?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'level', g: 'level', letters: true },
      { k: 'ts', g: 'time' },
      { k: 'int', g: 'tid', to: 'thread_id' },
      { k: 'str', g: 'file', to: 'file' },
      { k: 'int', g: 'line', to: 'line' },
      { k: 'msg', g: 'msg', enrich: ['klogStructured'] }
    ]
  },
  {
    id: 'goStd',
    label: 'Go, paquet log standard',
    family: 'app',
    multiline: true,
    re: String.raw`^(?P<time>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (?:(?P<file>[^\s:]+\.go):(?P<line>\d+): )?(?P<msg>[\s\S]*)\z`,
    ops: [
      { k: 'ts', g: 'time' },
      { k: 'str', g: 'file', to: 'file', opt: true },
      { k: 'int', g: 'line', to: 'line', opt: true },
      { k: 'msg', g: 'msg' }
    ]
  }
];
const FORMAT_IDS = ['json', 'logfmt', ...LOG_FORMATS.map(f => f.id), 'generic'];
export const LOG_FORMAT_LABELS = Object.assign(
  {
    json: 'JSON (un objet par ligne)',
    logfmt: 'logfmt (clé=valeur)',
    generic: 'Format générique (horodatage, niveau, message)'
  },
  Object.fromEntries(LOG_FORMATS.map(f => [f.id, f.label]))
);
const jsRe = (src, flags) => new RegExp(src.replace(/\(\?P</g, '(?<').replace(/\\z/g, '$'), flags || '');

/* ---------- Enrichissements du message (selon l’échantillon) ---------- */
const ENRICH = {
  sshd: {
    label: 'connexions SSH (sshd)',
    app: 'sshd',
    re: String.raw`^(?:(?P<outcome>Accepted|Failed) (?P<method>[\w-]+) for (?:invalid user )?|Invalid user )(?P<user>\S+) from (?P<ip>\S+)(?: port (?P<port>\d+))?`,
    ops: [
      { k: 'str', g: 'user', to: 'user' },
      { k: 'str', g: 'ip', to: 'source_ip' },
      { k: 'int', g: 'port', to: 'source_port', opt: true },
      { k: 'str', g: 'method', to: 'ssh_method', opt: true },
      { k: 'outcome', g: 'outcome' }
    ]
  },
  sudo: {
    label: 'commandes sudo',
    app: 'sudo',
    re: String.raw`^\s*(?P<user>\S+) : (?:[A-Z]+=[^;]* ; )*?TTY=(?P<tty>\S+) ; PWD=(?P<pwd>[^;]+?) ; USER=(?P<runas>\S+) ;(?: [A-Z]+=[^;]* ;)* COMMAND=(?P<cmd>.+)`,
    ops: [
      { k: 'str', g: 'user', to: 'user' },
      { k: 'str', g: 'tty', to: 'tty' },
      { k: 'str', g: 'pwd', to: 'pwd' },
      { k: 'str', g: 'runas', to: 'effective_user' },
      { k: 'str', g: 'cmd', to: 'command' }
    ]
  },
  kernel: {
    label: 'horloge du noyau ([secondes depuis le démarrage])',
    app: 'kernel',
    re: String.raw`^\[ *(?P<uptime>\d+\.\d+)\] (?P<rest>[\s\S]*)\z`,
    ops: [
      { k: 'float', g: 'uptime', to: 'uptime' },
      { k: 'remsg', g: 'rest' }
    ]
  },
  klogStructured: {
    label: 'klog structuré ("message" clé=valeur…)',
    re: String.raw`^"(?P<m>(?:[^"\\]|\\.)*)"(?: (?P<kv>[\s\S]+))?\z`,
    ops: [
      { k: 'jsonstr', g: 'm' },
      { k: 'kv', g: 'kv', opt: true, prefix: ['', 'labels.'] }
    ]
  }
};

/* ---------- Clés reconnues dans un objet (JSON, logfmt) ---------- */
const KEYED = [
  [
    'time',
    [
      '@timestamp',
      'timestamp',
      'time',
      'ts',
      '@t',
      't',
      'date_time',
      'date_time_utc',
      '__REALTIME_TIMESTAMP',
      'datetime',
      'date',
      'asctime',
      'eventTime'
    ]
  ],
  [
    'level',
    ['log.level', 'level', '@level', 'lvl', 'severity', 'levelname', 'loglevel', '@l', 'PRIORITY', 'log_level']
  ],
  ['message', ['message', '@message', 'msg', '@m', 'MESSAGE', 'log', 'text']],
  ['logger', ['log.logger', 'logger', 'logger_name', '@module', 'loggerName', 'category']],
  ['thread', ['process.thread.name', 'thread', 'thread_name', 'threadName']],
  ['caller', ['caller']],
  ['trace_id', ['trace.id', 'trace_id', 'traceId', 'traceID', 'dd.trace_id']],
  ['span_id', ['span.id', 'span_id', 'spanId', 'spanID', 'dd.span_id']],
  ['exc_type', ['error.type', 'err.type', 'exception.type']],
  ['exc_message', ['error.message', 'err.message', 'error', 'err', 'exception.message']],
  ['exc_stack', ['error.stack_trace', 'stacktrace', 'stack_trace', 'err.stack', 'stack', 'exception.stacktrace']],
  ['host', ['host.name', 'hostname', '_HOSTNAME']],
  ['service', ['service.name', 'SYSLOG_IDENTIFIER', 'application', 'app']],
  ['pid', ['process.pid', 'pid', '_PID']],
  ['stream', ['stream']]
];

// Origine probable d’un journal JSON, d’après ses clés (aplaties) : seulement pour le nommer
const JSON_PROFILES = [
  ['journald (journalctl -o json)', k => k.has('__REALTIME_TIMESTAMP') && k.has('MESSAGE')],
  ['Docker (pilote json-file)', k => k.has('log') && k.has('stream') && k.has('time')],
  ['HashiCorp hclog (Nomad, Vault, Consul en -log-json)', k => k.has('@level') && k.has('@message')],
  ['audit de Vault', k => k.has('type') && k.has('request.path') && k.has('time')],
  ['Elasticsearch 8 et ECS', k => k.has('@timestamp') && k.has('log.level') && k.has('ecs.version')],
  ['ClickHouse (format JSON du serveur)', k => k.has('date_time') && k.has('logger_name') && k.has('query_id')],
  ['Go zap', k => k.has('ts') && k.has('msg') && k.has('level') && (k.has('caller') || k.has('logger'))],
  ['Node.js pino ou bunyan', k => k.has('msg') && k.has('pid') && k.has('hostname') && k.has('time')],
  ['Logback (logstash-logback-encoder)', k => k.has('@timestamp') && k.has('logger_name') && k.has('thread_name')],
  ['Python (python-json-logger)', k => k.has('levelname') && k.has('name')],
  ['Go slog', k => k.has('time') && k.has('level') && k.has('msg')]
];
function jsonLabel(objs) {
  const keys = new Set(objs.flatMap(o => Object.keys(flattenObj(o))));
  const hit = JSON_PROFILES.find(([, t]) => t(keys));
  return hit ? `JSON — ${hit[0]}` : LOG_FORMAT_LABELS.json;
}

/* ---------- Analyse de l’échantillon ---------- */
function splitLines(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(l => l.trim());
}
// Regroupe les lignes en événements : une ligne qui ne commence pas un événement et ressemble à une suite y est rattachée
function groupEvents(lines, match, multiline) {
  const events = [];
  for (const l of lines) {
    const caps = match(l);
    const prev = events[events.length - 1];
    if (!caps && multiline && prev && prev.start && CONTINUATION.test(l)) {
      prev.text += '\n' + l;
      prev.cont = true;
      continue;
    }
    events.push({ text: l, caps, cont: false, start: !!caps });
  }
  for (const e of events) if (e.cont) e.caps = match(e.text);
  return events;
}
function regexMatcher(src) {
  const re = jsRe(src);
  return line => {
    const m = re.exec(line);
    return m ? Object.assign({}, m.groups) : null;
  };
}
function tryJSON(line) {
  if (!/^\s*\{/.test(line)) return null;
  try {
    const v = jparse(line.trim());
    return isPlain(v) ? v : null;
  } catch {
    return null;
  }
}
const LOGFMT_LINE = /^\s*(?:[A-Za-z_@][\w.@\-/]*=(?:"(?:[^"\\]|\\.)*"|[^\s"]*)\s*){2,}$/;
function tryLogfmt(line) {
  return LOGFMT_LINE.test(line) ? keyValues(line, true) : null;
}

// Format générique : un horodatage en tête, un niveau, le reste
const GENERIC_TS = [
  String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?`,
  String.raw`\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?`,
  String.raw`\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?`,
  String.raw`[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}`
];
const GENERIC_LEVELS =
  'TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|CRIT|CRITICAL|FATAL|SEVERE|trace|debug|info|notice|warn|warning|error|fatal|Trace|Debug|Info|Information|Notice|Warn|Warning|Error|Fatal|Critical';
function genericFormat(lines) {
  // L’horodatage en tête de la majorité des lignes, entre crochets ou non
  let best = null;
  for (const ts of GENERIC_TS) {
    for (const br of [false, true]) {
      const t = br ? String.raw`\[(?P<time>${ts})\]` : `(?P<time>${ts})`;
      const re = jsRe(`^${t}`);
      const n = lines.filter(l => re.test(l)).length;
      if (n && (!best || n > best.n)) best = { n, t };
    }
  }
  const lvl = String.raw`[\[<]? *(?P<level>${GENERIC_LEVELS}) *[\]>]?:?`;
  const head = best ? `${best.t}[ \\t]+` : '';
  const withLevel = `^${head}${lvl}[ \\t]+(?P<msg>[\\s\\S]*)\\z`;
  const reL = jsRe(withLevel);
  const nL = lines.filter(l => reL.test(l)).length;
  if (!best && !nL) return null;
  const re = nL ? withLevel : `^${head}(?P<msg>[\\s\\S]*)\\z`;
  const ops = [];
  if (best) ops.push({ k: 'ts', g: 'time' });
  if (nL) ops.push({ k: 'level', g: 'level' });
  ops.push({ k: 'msg', g: 'msg' });
  return {
    id: 'generic',
    label: LOG_FORMAT_LABELS.generic,
    family: 'generic',
    multiline: true,
    re,
    ops,
    start: best ? `^${best.t.replace(/\(\?P<time>/, '(?:')}` : `^[\\[<]? *(?:${GENERIC_LEVELS})\\b`
  };
}

/* ---------- Écriture du VRL et prédiction ---------- */
class Gen {
  constructor(conv, opts, notes) {
    this.conv = conv;
    this.opts = opts;
    this.notes = notes;
    this.lines = [];
    this.ind = 0;
    this.n = 0;
    this.yearHelper = false;
  }
  line(s) {
    this.lines.push(s ? '  '.repeat(this.ind) + s : '');
  }
  block(head, fn, tail) {
    this.line(head + ' {');
    this.ind++;
    fn();
    this.ind--;
    this.line(tail ? `} ${tail}` : '}');
  }
  v(base) {
    return `${base}${++this.n}`;
  }
  pair(a, b) {
    const n = ++this.n;
    return [`${a}${n}`, `${b}${n}`];
  }
  place(to) {
    return placeOf(this.conv, to);
  }
}

// Valeur prédite d’un groupe : null si absent (groupe non pris), ou « - » / vide quand dash
const capOf = (caps, op) => {
  const v = caps[op.g];
  if (v === undefined || v === null) return null;
  if (op.dash && (v === '-' || v === '')) return null;
  return v;
};
const groupRef = (src, g) => `${src}.${segName(g)}`;
// Les groupes d’une capture sont typés « texte ou nul » : en argument d’une fonction qui attend du texte, string!()
// est sûr, car un groupe obligatoire est toujours pris et un groupe facultatif n’est lu qu’après « != null »
const strOf = ref => `string!(${ref})`;

/*
 * Prépare les opérations d’un format pour l’échantillon : forme des horodatages, enrichissements présents.
 * Renvoie la liste des opérations « résolues » ; chaque opération porte ce qu’il faut pour écrire et prédire.
 */
function resolveOps(ops, events, ctx) {
  return ops.map(op => {
    const o = Object.assign({}, op);
    const vals = events.filter(e => e.caps).map(e => capOf(e.caps, o));
    const present = vals.filter(v => v !== null);
    o.seen = present.length;
    if (o.k === 'ts') {
      const kinds = [...new Set(present.map(v => tsKindOf(String(v).replace(/,/g, '.'))))];
      o.kind = kinds.length === 1 ? kinds[0] : kinds.find(Boolean) || null;
      o.comma = present.some(v => /,\d/.test(v));
      if (kinds.length > 1 && kinds.every(Boolean))
        ctx.notes.add(
          'warn',
          'Plusieurs formes d’horodatage',
          `L’échantillon mêle plusieurs écritures de la date (${kinds.map(k => TS_KINDS[k].label).join(', ')}) : seule la première est lue (${TS_KINDS[o.kind].label}).`
        );
      if (!o.kind && present.length)
        ctx.notes.add(
          'err',
          'Horodatage non reconnu',
          `« ${present[0]} » n’est pas une forme de date que Passerelle sait lire : le champ timestamp garde l’heure d’arrivée dans Vector. Ajoutez parse_timestamp avec le bon format strptime.`
        );
    }
    if (o.k === 'msg') {
      o.multi = events.some(
        e => e.caps && /\n/.test(String(capOf(e.caps, o) || '') + (o.stack ? e.caps[o.stack] || '' : ''))
      );
      o.enrich = (op.enrich || []).filter(id => {
        const en = ENRICH[id];
        const re = jsRe(en.re);
        return events.some(
          e => e.caps && (!en.app || !op.app || e.caps[op.app] === en.app) && re.test(String(capOf(e.caps, o) || ''))
        );
      });
    }
    if (o.k === 'level' && !op.letters) o.letters = false;
    return o;
  });
}

// Écrit le VRL d’une opération (src : la variable des groupes capturés)
function emitOp(G, op, src) {
  const ref = groupRef(src, op.g);
  const guard = (fn, extra) => {
    const conds = [];
    if (op.opt) conds.push(`${ref} != null`);
    if (op.dash) conds.push(`${ref} != "-"`, `${ref} != ""`);
    if (extra) conds.push(extra);
    if (!conds.length) return fn();
    G.block(`if ${conds.join(' && ')}`, fn);
  };
  switch (op.k) {
    case 'str':
      guard(() => G.line(`${vrlPath(G.place(op.to))} = ${ref}`));
      return;
    case 'lower':
      guard(() => G.line(`${vrlPath(G.place(op.to))} = downcase(${strOf(ref)})`));
      return;
    case 'int':
      guard(
        () => G.line(`${vrlPath(G.place(op.to))} = to_int(${ref}) ?? null`),
        op.digits ? `match(${strOf(ref)}, r'^\\d+\\z')` : ''
      );
      return;
    case 'float':
      guard(() => G.line(`${vrlPath(G.place(op.to))} = to_float(${ref}) ?? null`));
      return;
    case 'epochDur': {
      const pl = G.place(op.to);
      guard(() =>
        G.conv === 'ecs'
          ? G.line(`${vrlPath(pl)} = to_int((to_float(${ref}) ?? 0.0) * 1000000000.0)`)
          : G.line(`${vrlPath(pl)} = to_float(${ref}) ?? null`)
      );
      return;
    }
    case 'ts':
      if (!op.kind) return;
      guard(() => emitTime(G, op, ref));
      return;
    case 'level':
      emitLevel(G, op, ref);
      return;
    case 'pri':
      guard(() => {
        const p = G.v('priorite');
        G.line(`${p} = to_int(${ref}) ?? 0`);
        G.line(`${vrlPath(G.place('pri'))} = ${p}`);
        G.line(
          `${vrlPath(G.place('facility'))} = get([${SYSLOG_FACILITIES.map(x => vq(x)).join(', ')}], [to_int(floor(${p} / 8))]) ?? null`
        );
        const s = G.v('severite');
        G.line(`${s} = get([${SYSLOG_SEVERITIES.map(x => vq(x)).join(', ')}], [mod(${p}, 8)]) ?? null`);
        G.line(`${vrlPath(G.place('syslog_severity'))} = ${s}`);
        if (G.conv === 'otel') {
          G.line(`.severity_text = ${s}`);
          G.line(`.severity_number = get([${SYSLOG_SEV_NUMBERS.join(', ')}], [mod(${p}, 8)]) ?? 0`);
        }
      });
      return;
    case 'caller':
      guard(() => {
        const c = G.v('appelant');
        G.line(`${c} = parse_regex(${strOf(ref)}, r'^(?P<fichier>.+):(?P<ligne>\\d+)\\z') ?? {}`);
        G.line(`${vrlPath(G.place('file'))} = ${c}.fichier`);
        G.line(`${vrlPath(G.place('line'))} = to_int(${c}.ligne) ?? null`);
      });
      return;
    case 'kv':
      guard(() => {
        const kv = G.v('paires');
        G.line(`${kv} = parse_key_value(${strOf(ref)}, field_delimiter: " ", key_value_delimiter: "=") ?? {}`);
        emitIntoAttributes(G, kv, op.prefix);
      });
      return;
    case 'json':
      guard(() => {
        const j = G.v('objet');
        G.line(`${j} = object(parse_json(${strOf(ref)}) ?? {}) ?? {}`);
        emitIntoAttributes(G, `flatten(${j})`, op.prefix);
      });
      return;
    case 'msg':
      guard(() => emitMessage(G, op, ref, src));
      return;
    case 'outcome':
      guard(() => G.line(`${vrlPath(G.place('outcome'))} = if ${ref} == "Accepted" { "success" } else { "failure" }`));
      return;
    case 'remsg':
      G.line(`${vrlPath(G.place('message'))} = ${ref}`);
      return;
    case 'jsonstr':
      G.line(`${vrlPath(G.place('message'))} = parse_json("\\"" + ${strOf(ref)} + "\\"") ?? ${ref}`);
      return;
    default:
      throw new Error(`opération inconnue ${op.k}`);
  }
}
// Un objet de paires rangé dans les attributs (OpenTelemetry) ou sous un préfixe (ECS, ou attributs préfixés)
function emitIntoAttributes(G, expr, prefix) {
  const pre = prefix[G.conv === 'otel' ? 0 : 1];
  if (G.conv === 'otel') {
    if (!pre) G.line(`.attributes = merge(.attributes, ${expr})`);
    else G.line(`.attributes = merge(.attributes, map_keys(${expr}) -> |cle| { ${vq(pre)} + cle })`);
    return;
  }
  // Fusion profonde à la racine : l’objet visé existe peut-être déjà (champs posés plus haut)
  const segs = pre.replace(/\.$/, '').split('.');
  G.line(`. = merge(., ${segs.reduceRight((acc, k) => `{ ${vq(k)}: ${acc} }`, expr)}, deep: true)`);
}
function emitTime(G, op, ref) {
  const k = TS_KINDS[op.kind];
  const tz = G.opts.timezone || 'UTC';
  const val = op.comma ? `replace(${strOf(ref)}, ",", ".")` : strOf(ref);
  const [h, e] = G.pair('horodatage', 'erreur_horodatage');
  const zone = k.zoned ? '' : `, timezone: ${vq(tz)}`;
  if (op.kind === 'epochMicro') {
    G.line(`${h}, ${e} = from_unix_timestamp(to_int(${val}) ?? 0, unit: "microseconds")`);
  } else if (k.yearless) {
    G.yearHelper = true;
    G.line(`${h}, ${e} = parse_timestamp(annee + " " + ${val}, ${vq(k.fmt([]))}${zone})`);
    G.block(`if ${e} == null && to_unix_timestamp(${h}) > to_unix_timestamp(now()) + 86400`, () => {
      G.line(
        '# Date à plus d’un jour dans le futur : elle est de l’année précédente (journal de décembre lu en janvier)'
      );
      G.line(
        `${h} = parse_timestamp(to_string((to_int(annee) ?? 0) - 1) + " " + ${val}, ${vq(k.fmt([]))}${zone}) ?? ${h}`
      );
    });
  } else {
    G.line(`${h}, ${e} = parse_timestamp(${val}, ${vq(k.fmt(k.re.exec(op.sample || '') || []))}${zone})`);
  }
  setTime(G, e, h);
}
// L’horodatage lu remplace celui de Vector ; en ECS, il va dans @timestamp et le champ timestamp de Vector (l’heure
// d’arrivée) est retiré, pour qu’une sortie Elasticsearch ne le recopie pas par-dessus
function setTime(G, e, h) {
  G.block(`if ${e} == null`, () => {
    G.line(`${vrlPath(G.place('time'))} = ${h}`);
    if (G.conv === 'ecs') G.line('del(.timestamp)');
  });
}
function emitLevel(G, op, ref) {
  const n = G.v('niveau');
  if (op.letters)
    G.line(
      `${n} = ${Object.entries(LETTERS)
        .map(([l, w], i) => `${i ? ' else ' : ''}if ${ref} == ${vq(l)} { ${vq(w)} }`)
        .join('')} else { ${strOf(ref)} }`
    );
  else G.line(`${n} = ${strOf(ref)}`);
  G.line(`${vrlPath(G.place('level'))} = ${n}`);
  emitSeverity(G, n);
}
// Numéro de sévérité OpenTelemetry, d’après le texte du niveau
function emitSeverity(G, n) {
  if (G.conv !== 'otel') return;
  const low = G.v('niveau_min');
  G.line(`${low} = downcase(${n})`);
  G.line(`.severity_number = ${sevVRL(low)}`);
}
// Message : première ligne, et l’exception que portent les lignes suivantes
function emitMessage(G, op, ref, src) {
  const m = G.v('message');
  if (op.stack) {
    G.line(`${m} = ${strOf(ref)}`);
    G.line(`${vrlPath(G.place('message'))} = ${m}`);
    G.block(`if ${groupRef(src, op.stack)} != null`, () =>
      emitException(G, `strip_whitespace(${strOf(groupRef(src, op.stack))})`)
    );
  } else if (op.multi) {
    const parts = G.v('lignes');
    G.line(`${parts} = split(${strOf(ref)}, "\\n", limit: 2)`);
    G.line(`${m} = string(${parts}[0]) ?? ""`);
    G.line(`${vrlPath(G.place('message'))} = ${m}`);
    G.block(`if length(${parts}) > 1`, () => emitException(G, `string(${parts}[1]) ?? ""`));
  } else {
    G.line(`${m} = ${strOf(ref)}`);
    G.line(`${vrlPath(G.place('message'))} = ${m}`);
  }
  for (const id of op.enrich || []) {
    const en = ENRICH[id];
    const cond = en.app && op.app ? `${groupRef(src, op.app)} == ${vq(en.app)}` : '';
    const [c, ce] = G.pair('detail', 'detail_erreur');
    G.line(`# Enrichissement : ${en.label}`);
    const body = () => {
      G.line(`${c}, ${ce} = parse_regex(${m}, ${vraw(en.re, 'r')})`);
      G.block(`if ${ce} == null`, () => {
        for (const sub of en.ops) emitOp(G, Object.assign({ seen: 1 }, sub), c);
      });
    };
    if (cond) G.block(`if ${cond}`, body);
    else body();
  }
}
function emitException(G, stackExpr) {
  const st = G.v('trace');
  G.line(`${st} = ${stackExpr}`);
  G.line(`${vrlPath(G.place('exc_stack'))} = ${st}`);
  const [x, xe] = G.pair('exception', 'exception_erreur');
  G.line(`${x}, ${xe} = parse_regex(${st}, ${vraw(EXC_RE, 'r')})`);
  G.block(`if ${xe} == null`, () => {
    G.line(`${vrlPath(G.place('exc_type'))} = ${x}.type`);
    G.block(`if ${x}.message != null`, () => G.line(`${vrlPath(G.place('exc_message'))} = ${x}.message`));
  });
}

/* Prédiction : ce que le VRL écrit pour un événement */
function applyOp(P, ev, op, caps) {
  const v = capOf(caps, op);
  if (v === null && op.k !== 'remsg' && op.k !== 'jsonstr') return;
  const set = (to, x) => setAt(ev, placeOf(P.conv, to), x);
  switch (op.k) {
    case 'str':
      set(op.to, v);
      return;
    case 'lower':
      set(op.to, v.toLowerCase());
      return;
    case 'int':
      if (op.digits && !/^\d+$/.test(v)) return;
      set(op.to, toIntValue(v));
      return;
    case 'float':
      set(op.to, new LogFloat(Number(v)));
      return;
    case 'epochDur':
      set(op.to, P.conv === 'ecs' ? Math.trunc(Number(v) * 1000000000) : new LogFloat(Number(v)));
      return;
    case 'ts': {
      if (!op.kind) return;
      const t = tsValue(op.kind, op.comma ? v.replace(/,/g, '.') : v, P.opts.timezone || 'UTC', P.now);
      if (t) set('time', t);
      return;
    }
    case 'level': {
      const text = op.letters ? LETTERS[v] || v : v;
      if (!text) return;
      set('level', text);
      if (P.conv === 'otel') ev.severity_number = sevNumber(text);
      return;
    }
    case 'pri': {
      const p = Number(v);
      set('pri', p);
      set('facility', SYSLOG_FACILITIES[Math.floor(p / 8)] ?? null);
      const s = SYSLOG_SEVERITIES[p % 8];
      set('syslog_severity', s);
      if (P.conv === 'otel') {
        ev.severity_text = s;
        ev.severity_number = SYSLOG_SEV_NUMBERS[p % 8];
      }
      return;
    }
    case 'caller': {
      const m = /^(.+):(\d+)$/.exec(v);
      set('file', m ? m[1] : null);
      set('line', m ? Number(m[2]) : null);
      return;
    }
    case 'kv':
      intoAttributes(P, ev, keyValues(v, true), op.prefix);
      return;
    case 'json': {
      let o;
      try {
        o = jparse(v);
      } catch {
        o = {};
      }
      intoAttributes(P, ev, flattenObj(isPlain(o) ? o : {}), op.prefix);
      return;
    }
    case 'msg':
      applyMessage(P, ev, op, v, caps);
      return;
    case 'outcome':
      set('outcome', v === 'Accepted' ? 'success' : 'failure');
      return;
    case 'remsg':
      set('message', caps[op.g]);
      return;
    case 'jsonstr': {
      let s = caps[op.g];
      try {
        s = JSON.parse(`"${s}"`);
      } catch {
        /* parse_json échoue : le texte reste tel quel */
      }
      set('message', s);
      return;
    }
  }
}
function toIntValue(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : BigInt(v);
}
function intoAttributes(P, ev, obj, prefix) {
  const pre = prefix[P.conv === 'otel' ? 0 : 1];
  if (P.conv === 'otel') {
    if (!isPlain(ev.attributes)) ev.attributes = {};
    for (const [k, x] of Object.entries(obj)) ev.attributes[pre + k] = x;
    return;
  }
  const segs = pre.replace(/\.$/, '').split('.');
  const cur = getAt(ev, { segs });
  setAt(ev, { segs }, Object.assign(isPlain(cur) ? cur : {}, obj));
}
function applyMessage(P, ev, op, v, caps) {
  const set = (to, x) => setAt(ev, placeOf(P.conv, to), x);
  let m = v;
  let stack = null;
  if (op.stack) {
    if (caps[op.stack] != null) stack = caps[op.stack].trim();
  } else if (op.multi) {
    const i = v.indexOf('\n');
    if (i >= 0) {
      m = v.slice(0, i);
      stack = v.slice(i + 1);
    }
  }
  set('message', m);
  if (stack !== null) {
    set('exc_stack', stack);
    const x = jsRe(EXC_RE.replace('(?m)', ''), 'm').exec(stack);
    if (x) {
      set('exc_type', x.groups.type);
      if (x.groups.message !== undefined) set('exc_message', x.groups.message);
    }
  }
  for (const id of op.enrich || []) {
    const en = ENRICH[id];
    if (en.app && op.app && caps[op.app] !== en.app) continue;
    const r = jsRe(en.re).exec(m);
    if (!r) continue;
    for (const sub of en.ops) applyOp(P, ev, sub, Object.assign({}, r.groups));
  }
}

/* ---------- Objets (JSON, logfmt) ---------- */
// Choisit, pour chaque rôle, la clé présente dans l’échantillon et le traitement de sa valeur
function keyedPlan(objs, family, notes) {
  const keys = new Map();
  objs.forEach(o =>
    Object.entries(o).forEach(([k, v]) => {
      if (!keys.has(k)) keys.set(k, []);
      keys.get(k).push(v);
    })
  );
  const used = new Set();
  const plan = [];
  for (const [role, cands] of KEYED) {
    for (const key of cands) {
      if (!keys.has(key) || used.has(key)) continue;
      const vals = keys.get(key);
      const item = { role, key };
      if (role === 'time') {
        const v = vals[0];
        if (typeof v === 'string') {
          item.kind = tsKindOf(v.replace(/,/g, '.'));
          item.comma = vals.some(x => typeof x === 'string' && /,\d/.test(x));
          item.sample = v;
          if (!item.kind) continue;
        } else if (isInt(v)) {
          const n = Number(v);
          item.kind = n > 1e17 ? 'ns' : n > 1e14 ? 'us' : n > 1e11 ? 'ms' : 's';
        } else if (v instanceof LogFloat) item.kind = 'float';
        else continue;
      } else if (role === 'level') {
        if (vals.every(x => typeof x === 'string' && /^\d$/.test(x)) && key === 'PRIORITY') item.numeric = 'syslog';
        else if (vals.every(x => isInt(x))) item.numeric = 'pino';
        else if (!vals.every(x => typeof x === 'string')) continue;
      } else if (role === 'pid') {
        if (!vals.every(x => isInt(x) || (typeof x === 'string' && /^\d+$/.test(x)))) continue;
      } else if (role !== 'message' && !vals.every(x => typeof x === 'string')) continue;
      if (role === 'message') item.trim = vals.some(x => typeof x === 'string' && /\s$/.test(x));
      used.add(key);
      plan.push(item);
      break;
    }
  }
  if (!plan.some(p => p.role === 'time'))
    notes.add(
      'warn',
      'Pas d’horodatage reconnu',
      `Aucune clé de l’objet ${family === 'logfmt' ? 'logfmt' : 'JSON'} ne porte une date lisible : le champ timestamp garde l’heure d’arrivée dans Vector.`
    );
  return plan;
}
const fieldRef = (v, key) => `${v}.${vq(key)}`;
function emitKeyed(G, plan, v) {
  for (const it of plan) {
    const ref = fieldRef(v, it.key);
    G.line(
      `# ${it.role === 'time' ? 'Horodatage' : it.role === 'level' ? 'Niveau' : it.role === 'message' ? 'Message' : 'Rôle ' + it.role} : clé ${JSON.stringify(it.key)}`
    );
    G.block(`if exists(${ref})`, () => {
      if (it.role === 'time') {
        const [h, e] = G.pair('horodatage', 'erreur_horodatage');
        if (it.kind === 's' || it.kind === 'ms' || it.kind === 'us' || it.kind === 'ns') {
          const unit = { s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds' }[it.kind];
          G.line(`${h}, ${e} = from_unix_timestamp(to_int(${ref}) ?? 0, unit: ${vq(unit)})`);
        } else if (it.kind === 'float') {
          G.line(
            `${h}, ${e} = from_unix_timestamp(to_int((to_float(${ref}) ?? 0.0) * 1000000.0), unit: "microseconds")`
          );
        } else emitTimeKeyed(G, it, `string(${ref}) ?? ""`, h, e);
        setTime(G, e, h);
      } else if (it.role === 'level') {
        const n = G.v('niveau');
        if (it.numeric === 'pino') {
          const x = G.v('code');
          G.line(`${x} = to_int(${ref}) ?? 0`);
          G.line(
            `${n} = ${PINO.map(([k, t], i) => `${i ? ' else ' : ''}if ${x} <= ${k} { ${vq(t)} }`).join('')} else { "fatal" }`
          );
        } else if (it.numeric === 'syslog') {
          G.line(
            `${n} = string(get([${SYSLOG_SEVERITIES.map(x => vq(x)).join(', ')}], [to_int(${ref}) ?? 6]) ?? "info") ?? "info"`
          );
        } else G.line(`${n} = string(${ref}) ?? ""`);
        G.line(`${vrlPath(G.place('level'))} = ${n}`);
        emitSeverity(G, n);
      } else if (it.role === 'message') {
        G.line(`${vrlPath(G.place('message'))} = ${it.trim ? `strip_whitespace(string(${ref}) ?? "")` : ref}`);
      } else if (it.role === 'caller') {
        const c = G.v('appelant');
        G.line(`${c} = parse_regex(string(${ref}) ?? "", r'^(?P<fichier>.+):(?P<ligne>\\d+)\\z') ?? {}`);
        G.line(`${vrlPath(G.place('file'))} = ${c}.fichier`);
        G.line(`${vrlPath(G.place('line'))} = to_int(${c}.ligne) ?? null`);
      } else if (it.role === 'pid') {
        G.line(`${vrlPath(G.place('pid'))} = to_int(${ref}) ?? null`);
      } else G.line(`${vrlPath(G.place(it.role))} = ${ref}`);
      G.line(`del(${ref})`);
    });
  }
}
function emitTimeKeyed(G, it, val, h, e) {
  const k = TS_KINDS[it.kind];
  const v = it.comma ? `replace(${val}, ",", ".")` : val;
  const zone = k.zoned ? '' : `, timezone: ${vq(G.opts.timezone || 'UTC')}`;
  if (it.kind === 'epochMicro') {
    G.line(`${h}, ${e} = from_unix_timestamp(to_int(${val}) ?? 0, unit: "microseconds")`);
    return;
  }
  if (k.yearless) {
    G.yearHelper = true;
    G.line(`${h}, ${e} = parse_timestamp(annee + " " + ${v}, ${vq(k.fmt([]))}${zone})`);
    return;
  }
  G.line(`${h}, ${e} = parse_timestamp(${v}, ${vq(k.fmt(k.re.exec(it.sample.replace(/,/g, '.')) || []))}${zone})`);
}
function applyKeyed(P, ev, plan, obj) {
  const set = (to, x) => setAt(ev, placeOf(P.conv, to), x);
  for (const it of plan) {
    if (!(it.key in obj)) continue;
    const v = obj[it.key];
    delete obj[it.key];
    if (it.role === 'time') {
      let t = null;
      if (['s', 'ms', 'us', 'ns'].includes(it.kind)) {
        const mul = { s: 1000000000n, ms: 1000000n, us: 1000n, ns: 1n }[it.kind];
        const n = typeof v === 'bigint' ? v : isInt(v) ? BigInt(v) : null;
        if (n !== null) t = new LogTime(n * mul);
      } else if (it.kind === 'float') {
        const f = v instanceof LogFloat ? v.v : isInt(v) ? Number(v) : null;
        if (f !== null) t = new LogTime(BigInt(Math.trunc(f * 1000000)) * 1000n);
      } else if (typeof v === 'string') {
        t = tsValue(it.kind, it.comma ? v.replace(/,/g, '.') : v, P.opts.timezone || 'UTC', P.now);
      }
      if (t) set('time', t);
    } else if (it.role === 'level') {
      let text;
      if (it.numeric === 'pino') text = pinoText(isInt(v) ? Number(v) : 0);
      else if (it.numeric === 'syslog') text = SYSLOG_SEVERITIES[Number(v)] || 'info';
      else text = typeof v === 'string' ? v : '';
      set('level', text);
      if (P.conv === 'otel') ev.severity_number = sevNumber(text);
    } else if (it.role === 'message') {
      set('message', it.trim && typeof v === 'string' ? v.trim() : v);
    } else if (it.role === 'caller') {
      const m = /^(.+):(\d+)$/.exec(String(v));
      set('file', m ? m[1] : null);
      set('line', m ? Number(m[2]) : null);
    } else if (it.role === 'pid') {
      set('pid', toIntValue(String(v)));
    } else set(it.role, v);
  }
}

/* ---------- Programme complet ---------- */
function header(G, fmt, stats) {
  G.line(`# Passerelle — analyse des lignes au format « ${fmt.label} »`);
  G.line(
    `# Écrit à partir d’un échantillon de ${stats.total} événement${stats.total > 1 ? 's' : ''} (${stats.ok} reconnu${stats.ok > 1 ? 's' : ''}). Convention : ${CONVENTIONS[G.conv]}.`
  );
  if (G.conv === 'otel')
    G.line(
      '# Forme des événements de la source opentelemetry de Vector : .message (corps), .attributes, .resources, .severity_text.'
    );
  if (fmt.id !== 'none') G.line('ligne = string(.message) ?? ""');
  if (G.conv === 'otel') {
    G.line('.attributes = object(.attributes) ?? {}');
    G.line('.resources = object(.resources) ?? {}');
  }
}
function failure(G, what) {
  if (G.conv === 'otel') G.line(`${vrlPath(G.place('parse_error'))} = ${vq(what)}`);
  else {
    G.line(`.error.message = ${vq(what)}`);
    G.line('.tags = push(array(.tags) ?? [], "_vrl_parse_failure")');
  }
}
// Le format a-t-il un message distinct de la ligne ? (les objets en ont un, un journal d’accès non)
const hasMessage = fmt => fmt.id === 'json' || fmt.id === 'logfmt' || (fmt.ops || []).some(o => o.k === 'msg');
function keepOriginal(G, fmt) {
  if (!G.opts.keepOriginal) return;
  // En OpenTelemetry, le corps d’un journal d’accès reste la ligne : la recopier n’apporte rien
  if (G.conv === 'otel' && !hasMessage(fmt)) return;
  G.line(`${vrlPath(G.place('original'))} = ligne`);
}

function buildRegexProgram(G, fmt, ops) {
  G.line(`champs, erreur = parse_regex(ligne, ${vraw(fmt.re, 'r')})`);
  G.line('if erreur != null {');
  G.ind++;
  failure(G, `ligne non reconnue : format « ${fmt.label} » attendu`);
  G.ind--;
  G.line('} else {');
  G.ind++;
  keepOriginal(G, fmt);
  for (const op of ops) emitOp(G, op, 'champs');
  G.ind--;
  G.line('}');
}
function buildKeyedProgram(G, fmt, plan) {
  if (fmt.id === 'json') {
    G.line('objet, erreur = parse_json(ligne)');
    G.line('if erreur != null || !is_object(objet) {');
  } else {
    G.line('objet, erreur = parse_logfmt(ligne)');
    G.line('if erreur != null {');
  }
  G.ind++;
  failure(G, `ligne non reconnue : ${fmt.id === 'json' ? 'un objet JSON' : 'des paires clé=valeur (logfmt)'} attendu`);
  G.ind--;
  G.line('} else {');
  G.ind++;
  keepOriginal(G, fmt);
  G.line(fmt.id === 'json' ? 'champs = flatten(object!(objet))' : 'champs = objet');
  emitKeyed(G, plan, 'champs');
  G.line(
    G.conv === 'otel'
      ? '# Les autres clés deviennent des attributs'
      : '# Les autres clés sont recopiées à la racine de l’événement'
  );
  if (G.conv === 'otel') G.line('.attributes = merge(.attributes, champs)');
  else G.line('. = merge(., unflatten(champs), deep: true)');
  G.ind--;
  G.line('}');
}

/* ---------- Prédiction d’un événement complet ---------- */
function predict(P, fmt, ops, plan, e) {
  const ev = {};
  if (P.conv === 'otel') {
    ev.attributes = {};
    ev.resources = {};
  }
  const keep = () => {
    if (!P.opts.keepOriginal) return;
    if (P.conv === 'otel' && !hasMessage(fmt)) return;
    setAt(ev, placeOf(P.conv, 'original'), e.text);
  };
  const fail = what => {
    if (P.conv === 'otel') setAt(ev, placeOf('otel', 'parse_error'), what);
    else {
      setAt(ev, { segs: ['error', 'message'] }, what);
      ev.tags = ['_vrl_parse_failure'];
    }
  };
  if (plan) {
    const obj = e.obj;
    if (!obj) {
      fail(`ligne non reconnue : ${fmt.id === 'json' ? 'un objet JSON' : 'des paires clé=valeur (logfmt)'} attendu`);
      return ev;
    }
    keep();
    const flat = fmt.id === 'json' ? flattenObj(obj) : Object.assign({}, obj);
    applyKeyed(P, ev, plan, flat);
    if (P.conv === 'otel') Object.assign(ev.attributes, flat);
    else deepMerge(ev, unflattenObj(flat));
    return ev;
  }
  if (!e.caps) {
    fail(`ligne non reconnue : format « ${fmt.label} » attendu`);
    return ev;
  }
  keep();
  for (const op of ops) applyOp(P, ev, op, e.caps);
  return ev;
}

/* ---------- Littéraux VRL des valeurs prédites (tests unitaires) ---------- */
export function logLiteral(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof LogTime) return `t'${timeText(v)}'`;
  if (v instanceof LogFloat) {
    const s = String(v.v);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return s.includes('.') ? s : `${s}.0`;
  }
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return vq(v);
  if (Array.isArray(v)) {
    const parts = v.map(logLiteral);
    return parts.includes(null) ? null : `[${parts.join(', ')}]`;
  }
  if (isPlain(v)) {
    const parts = Object.entries(v).map(([k, x]) => [k, logLiteral(x)]);
    return parts.some(([, x]) => x === null) ? null : `{ ${parts.map(([k, x]) => `${vq(k)}: ${x}`).join(', ')} }`;
  }
  return null;
}
// Les champs posés par le VRL, à plat : [emplacement, valeur]
function leaves(ev, conv) {
  const out = [];
  for (const [k, v] of Object.entries(ev)) {
    if (conv === 'otel' && (k === 'attributes' || k === 'resources')) {
      for (const [kk, vv] of Object.entries(v)) out.push([{ root: k, key: kk }, vv]);
      continue;
    }
    (function walk(segs, x) {
      if (isPlain(x) && !(x instanceof LogTime) && Object.keys(x).length) {
        for (const [kk, vv] of Object.entries(x)) walk(segs.concat(kk), vv);
      } else out.push([{ segs }, x]);
    })([k], v);
  }
  return out;
}
function assertions(ev, conv) {
  const lines = [];
  for (const [pl, v] of leaves(ev, conv)) {
    const path = vrlPath(pl);
    if (v instanceof LogTime && v.yearless) {
      const ns = String(v.ns % 1000000000n).padStart(9, '0');
      const d = new Date(Number(v.ns / 1000000n));
      const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${d.toISOString().slice(11, 19)}.${ns}`;
      lines.push(`assert_eq!(format_timestamp!(${path}, "%m-%dT%H:%M:%S%.9f", timezone: "UTC"), ${vq(md)})`);
      continue;
    }
    const lit = logLiteral(v);
    if (lit === null) lines.push(`assert!(exists(${path}))`);
    else lines.push(`assert_eq!(${path}, ${lit})`);
  }
  return lines;
}

// Événement prédit en JSON lisible (aperçu, API)
export function eventJSON(v) {
  if (v instanceof LogTime) return timeText(v);
  if (v instanceof LogFloat) return v.v;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(eventJSON);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, eventJSON(x)]));
  return v;
}
function eventText(ev) {
  const fmt = (v, ind) => {
    const pad = '  '.repeat(ind);
    if (v instanceof LogTime) return JSON.stringify(timeText(v));
    if (v instanceof LogFloat) return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
    if (typeof v === 'bigint') return String(v);
    if (Array.isArray(v)) return v.length ? `[${v.map(x => fmt(x, ind + 1)).join(', ')}]` : '[]';
    if (isPlain(v)) {
      const e = Object.entries(v);
      if (!e.length) return '{}';
      return `{\n${e.map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${fmt(x, ind + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(v);
  };
  const shown = Object.assign({}, ev);
  if (isPlain(shown.attributes) && !Object.keys(shown.attributes).length) delete shown.attributes;
  if (isPlain(shown.resources) && !Object.keys(shown.resources).length) delete shown.resources;
  return fmt(shown, 0);
}

/* ---------- Choix du format ---------- */
function candidates(lines, opts) {
  const out = [];
  const forced = opts.format && opts.format !== 'auto' ? opts.format : null;
  const consider = id => !forced || forced === id;
  if (consider('json')) {
    const events = lines.map(l => ({ text: l, obj: tryJSON(l), cont: false }));
    const objs = events.filter(e => e.obj).map(e => e.obj);
    out.push({ fmt: { id: 'json', label: jsonLabel(objs), family: 'json' }, events, ok: objs.length });
  }
  // Les formats précis d’abord : à égalité, le premier l’emporte ; logfmt, plus général, vient après
  for (const f of LOG_FORMATS) {
    if (!consider(f.id)) continue;
    const events = groupEvents(lines, regexMatcher(f.re), f.multiline);
    out.push({ fmt: f, events, ok: events.filter(e => e.caps).length });
  }
  if (consider('logfmt')) {
    const events = lines.map(l => ({ text: l, obj: tryLogfmt(l), cont: false }));
    out.push({
      fmt: { id: 'logfmt', label: LOG_FORMAT_LABELS.logfmt, family: 'logfmt' },
      events,
      ok: events.filter(e => e.obj).length
    });
  }
  if (consider('generic')) {
    const g = genericFormat(lines);
    if (g) {
      const events = groupEvents(lines, regexMatcher(g.re), true);
      out.push({ fmt: g, events, ok: events.filter(e => e.caps).length, generic: true });
    }
  }
  return out;
}
function choose(cands) {
  const rate = c => (c.events.length ? c.ok / c.events.length : 0);
  let best = null;
  for (const c of cands) {
    if (!c.ok) continue;
    // Le format générique ne l’emporte que s’il reconnaît strictement plus d’événements
    if (!best || rate(c) > rate(best) + (c.generic ? 1e-9 : 0)) best = c;
  }
  return best;
}

/* ---------- Configuration Vector et tests ---------- */
const MAX_TESTS = 12;
function vectorConfig(name, fmt, vrl, tests, multiline, startPattern) {
  const transform = `analyse_${name}`;
  const config = {};
  if (multiline) config.data_dir = '/var/lib/vector';
  config.sources = {
    journaux: multiline
      ? {
          type: 'file',
          include: ['./echantillon.log'],
          read_from: 'beginning',
          multiline: {
            start_pattern: startPattern,
            mode: 'halt_before',
            condition_pattern: startPattern,
            timeout_ms: 1000
          }
        }
      : { type: 'stdin' }
  };
  config.transforms = { [transform]: { type: 'remap', inputs: ['journaux'], source: vrl } };
  config.sinks = { sortie: { type: 'console', inputs: [transform], encoding: { codec: 'json' } } };
  config.tests = tests.map(t => ({
    name: t.name,
    inputs: [{ insert_at: transform, type: 'log', log_fields: { message: t.text } }],
    outputs: [{ extract_from: transform, conditions: [{ type: 'vrl', source: t.asserts.join('\n') + '\n' }] }]
  }));
  return { config, transform };
}
// Le début d’un événement, pour la source file (multiline) : ce par quoi commence une ligne du format
const START = {
  javaThreadFirst: String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`,
  javaLevelFirst: String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`,
  springBoot: String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`,
  kafka: String.raw`^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\]`,
  elasticsearchText: String.raw`^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`,
  clickhouse: String.raw`^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}`,
  hclog: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`,
  pythonDash: String.raw`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}`,
  pythonBasic: '^(?:DEBUG|INFO|WARNING|ERROR|CRITICAL):',
  gunicorn: String.raw`^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`,
  klog: String.raw`^[IWEF]\d{4} \d{2}:\d{2}:\d{2}`,
  goStd: String.raw`^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}`
};
const startPatternOf = fmt => fmt.start || START[fmt.id] || '^\\S';

/*
 * logToVRL(texte, cfg, options)
 *   options.convention  otel (défaut) ou ecs
 *   options.timezone    fuseau des dates écrites sans fuseau (défaut UTC)
 *   options.format      auto (défaut) ou l’identifiant d’un format (LOG_FORMAT_LABELS)
 *   options.keepOriginal  garde la ligne d’origine (log.record.original, event.original) ; vrai par défaut
 *   options.name        nom du journal (le transform s’appelle analyse_<nom>)
 *   options.now         date de référence des horodatages sans année (tests)
 */
const MAX_LINES = 2000;
export function logToVRL(text, cfg, options) {
  const opts = Object.assign(
    { convention: 'otel', timezone: 'UTC', format: 'auto', keepOriginal: true },
    options || {}
  );
  if (!CONVENTIONS[opts.convention]) return { error: `convention inconnue « ${opts.convention} » (otel ou ecs)` };
  if (opts.format !== 'auto' && !FORMAT_IDS.includes(opts.format))
    return { error: `format inconnu « ${opts.format} » (${FORMAT_IDS.join(', ')})` };
  if (!validZone(opts.timezone)) return { error: `fuseau inconnu « ${opts.timezone} »` };
  const all = splitLines(text);
  if (!all.length) return { empty: true };
  const notes = makeNotes();
  const lines = all.slice(0, MAX_LINES);
  if (all.length > MAX_LINES)
    notes.add('info', 'Échantillon tronqué', `Seules les ${MAX_LINES} premières lignes sont analysées.`);
  const name =
    String(opts.name || 'journal')
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'journal';
  const cands = candidates(lines, opts);
  const best = choose(cands);
  const now = opts.now ? new Date(opts.now) : new Date();
  const conv = opts.convention;
  const G = new Gen(conv, opts, notes);
  let fmt;
  let events;
  let plan = null;
  let ops = [];
  if (!best) {
    // Rien de reconnu : le message reste tel quel, à reprendre
    fmt = { id: 'none', label: 'non reconnu', family: 'none', ops: [] };
    events = lines.map(l => ({ text: l, caps: null }));
    notes.add(
      'err',
      'Format non reconnu',
      opts.format !== 'auto'
        ? `Aucune ligne ne correspond au format « ${LOG_FORMAT_LABELS[opts.format]} ». Essayez la détection automatique.`
        : 'Aucun format connu ne correspond à ces lignes : ni JSON, ni logfmt, ni un journal reconnu, ni un horodatage en tête. Le pipeline garde le message tel quel ; écrivez l’expression avec parse_regex ou parse_grok.'
    );
  } else {
    fmt = best.fmt;
    events = best.events;
  }
  const stats = { total: events.length, ok: 0, approx: 0, ko: 0 };
  // Une ligne que le format retenu ne lit pas est « à vérifier » (le pipeline la laisse passer, marquée) ; sans
  // aucun format, tout est « à reprendre »
  events.forEach(e => {
    const ok = !!(e.caps || e.obj);
    if (!ok) stats[fmt.id === 'none' ? 'ko' : 'approx']++;
    else if (fmt.id === 'generic') stats.approx++;
    else stats.ok++;
  });
  stats.recognized = events.filter(e => e.caps || e.obj).length;
  header(G, fmt, { total: stats.total, ok: stats.recognized });
  let multiline = false;
  if (fmt.id === 'json' || fmt.id === 'logfmt') {
    plan = keyedPlan(
      events.filter(e => e.obj).map(e => (fmt.id === 'json' ? flattenObj(e.obj) : e.obj)),
      fmt.id,
      notes
    );
    const body = new Gen(conv, opts, notes);
    buildKeyedProgram(body, fmt, plan);
    if (body.yearHelper) G.line('annee = format_timestamp!(now(), "%Y", timezone: "UTC")');
    G.lines.push(...body.lines);
  } else if (fmt.id !== 'none') {
    ops = resolveOps(fmt.ops, events, { notes });
    // L’exemple de chaque horodatage sert à choisir le séparateur date / heure (T ou espace)
    for (const op of ops)
      if (op.k === 'ts') {
        const e = events.find(x => x.caps && capOf(x.caps, op) !== null);
        op.sample = e ? capOf(e.caps, op).replace(/,/g, '.') : '';
      }
    multiline = events.some(e => e.cont);
    const body = new Gen(conv, opts, notes);
    body.ind = 0;
    buildRegexProgram(body, fmt, ops);
    if (body.yearHelper) {
      G.line('# Le journal ne donne pas l’année : celle du jour, ou la précédente pour une date dans le futur');
      G.line('annee = format_timestamp!(now(), "%Y", timezone: "UTC")');
    }
    G.lines.push(...body.lines);
  } else {
    G.line('# Format non reconnu : la ligne reste dans .message. À compléter avec parse_regex ou parse_grok.');
    failure(G, 'format non reconnu par Passerelle');
  }
  const vrl = G.lines.join('\n') + '\n';

  // Prédiction, événement par événement
  const P = { conv, opts, now };
  const predicted = events.map(e => ({
    text: e.text,
    ok: !!(e.caps || e.obj),
    event: fmt.id === 'none' ? predictNone(conv) : predict(P, fmt, ops, plan, e)
  }));

  // Champs produits : emplacement, type, exemple, nombre d’événements
  const fields = new Map();
  for (const p of predicted) {
    if (!p.ok) continue;
    for (const [pl, v] of leaves(p.event, conv)) {
      const key = placeName(pl);
      if (!fields.has(key))
        fields.set(key, { name: key, path: vrlPath(pl), type: typeName(v), example: eventJSON(v), count: 0 });
      fields.get(key).count++;
    }
  }

  // Tests unitaires : les premiers événements reconnus, puis un non reconnu s’il y en a
  const chosen = predicted.filter(p => p.ok).slice(0, MAX_TESTS - 1);
  const miss = predicted.find(p => !p.ok);
  if (miss) chosen.push(miss);
  const tests = chosen.map(p => ({
    name: `${p.ok ? 'reconnue' : 'non reconnue'} : ${p.text.split('\n')[0].slice(0, 60)}${p.text.length > 60 ? '…' : ''}`,
    text: p.text,
    asserts: assertions(p.event, conv)
  }));
  const startPattern = multiline ? startPatternOf(fmt) : '';
  const { config, transform } = vectorConfig(name, fmt, vrl, tests, multiline, startPattern);

  notesFor(notes, fmt, ops, plan, predicted, stats, opts, multiline, best, cands);
  const head = [
    `Configuration Vector générée par Passerelle depuis un échantillon de journaux (${fmt.label})`,
    `Tests : vector test <fichier> rejoue les ${tests.length} ligne${tests.length > 1 ? 's' : ''} de l’échantillon et vérifie chaque champ`,
    multiline
      ? 'Essai : placez l’échantillon dans ./echantillon.log, créez /var/lib/vector, puis vector --config <fichier>'
      : 'Essai : vector --config <fichier> < echantillon.log',
    'En production : remplacez la source « journaux » (file, kafka, journald, opentelemetry…) et la sortie « sortie »'
  ]
    .map(l => '# ' + l)
    .join('\n');
  const yaml = `${head}\n\n${toYAML(config)}\n`;
  const toml = `${head}\n\n${toTOML(config)}\n`;
  const sentence = sentenceOf(fmt, stats, fields.size, conv);
  return {
    format: { id: fmt.id, label: fmt.label, family: fmt.family },
    convention: conv,
    candidates: cands
      .filter(c => c.ok)
      .map(c => ({ id: c.fmt.id, label: c.fmt.label, matched: c.ok, events: c.events.length }))
      .sort((a, b) => b.matched / b.events - a.matched / a.events),
    transform,
    vrl,
    yaml,
    toml,
    config,
    multiline,
    events: predicted.map(p => ({ text: p.text, recognized: p.ok, event: p.event, preview: eventText(p.event) })),
    // La ligne d’origine en dernier : c’est le champ le moins parlant du tableau
    fields: [...fields.values()].sort(
      (a, b) => (a.name === placeName(placeOf(conv, 'original'))) - (b.name === placeName(placeOf(conv, 'original')))
    ),
    tests: tests.length,
    notes: notes.list,
    stats: { ok: stats.ok, approx: stats.approx, ko: stats.ko },
    sentence
  };
}
function predictNone(conv) {
  return conv === 'otel'
    ? { attributes: { 'log.parse.error': 'format non reconnu par Passerelle' }, resources: {} }
    : { error: { message: 'format non reconnu par Passerelle' }, tags: ['_vrl_parse_failure'] };
}
function sentenceOf(fmt, stats, nFields, conv) {
  if (fmt.id === 'none')
    return `Aucun format reconnu sur ${stats.total} ligne${stats.total > 1 ? 's' : ''} : le pipeline est à écrire.`;
  const ev = `${stats.recognized} événement${stats.recognized > 1 ? 's' : ''} sur ${stats.total}`;
  return `${fmt.label} : ${ev} découpé${stats.recognized > 1 ? 's' : ''} en ${nFields} champ${nFields > 1 ? 's' : ''}, nommés selon ${CONVENTIONS[conv]}.`;
}
function notesFor(notes, fmt, ops, plan, predicted, stats, opts, multiline, best, cands) {
  if (fmt.id === 'none') return;
  notes.add(
    'info',
    'Format détecté',
    `${fmt.label}${best && best.events.length ? ` : ${best.ok} événement${best.ok > 1 ? 's' : ''} sur ${best.events.length} correspondent` : ''}.${
      cands.filter(c => c.ok && c !== best).length
        ? ` Autres formats possibles : ${cands
            .filter(c => c.ok && c !== best)
            .slice(0, 3)
            .map(c => `${c.fmt.label} (${c.ok}/${c.events.length})`)
            .join(', ')}.`
        : ''
    }`
  );
  if (stats.ko) {
    const first = predicted.find(p => !p.ok);
    notes.add(
      'warn',
      `${stats.ko} événement${stats.ko > 1 ? 's' : ''} non reconnu${stats.ko > 1 ? 's' : ''}`,
      `Ces lignes ne suivent pas le format retenu ; le VRL les laisse passer avec ${opts.convention === 'otel' ? 'l’attribut log.parse.error' : 'l’étiquette _vrl_parse_failure et error.message'}. Première ligne concernée : ${first.text.split('\n')[0].slice(0, 160)}`
    );
  }
  if (fmt.id === 'generic')
    notes.add(
      'warn',
      'Format générique',
      'Aucun format connu ne décrit ces lignes : Passerelle lit l’horodatage et le niveau en tête, le reste devient le message. Vérifiez le découpage, et complétez-le avec parse_regex si le message porte d’autres champs.'
    );
  const ts = ops.find(o => o.k === 'ts' && o.kind);
  const kind = ts ? ts.kind : plan && (plan.find(p => p.role === 'time') || {}).kind;
  if (kind && TS_KINDS[kind] && TS_KINDS[kind].yearless)
    notes.add(
      'warn',
      'Horodatage sans année',
      'Le journal n’écrit pas l’année : le VRL prend celle du jour, ou la précédente si la date tombe à plus d’un jour dans le futur (un journal de décembre lu en janvier). Rejouer de vieux journaux leur donnerait une année fausse. Les tests vérifient le mois, le jour et l’heure.'
    );
  if (kind && TS_KINDS[kind] && !TS_KINDS[kind].zoned)
    notes.add(
      opts.timezone === 'UTC' ? 'warn' : 'info',
      'Horodatage sans fuseau',
      `Les dates du journal n’indiquent pas de fuseau : elles sont lues dans le fuseau ${opts.timezone}${opts.timezone === 'UTC' ? ', à changer dans les options si le serveur écrit en heure locale' : ''} (paramètre timezone de parse_timestamp).`
    );
  if (multiline)
    notes.add(
      'info',
      'Événements sur plusieurs lignes',
      'Des traces de pile suivent certains messages : la source file de la configuration les regroupe (multiline, mode halt_before) avant le VRL, qui range la première ligne dans le message et la suite dans la trace de l’exception. Avec une autre source (Kafka, OpenTelemetry), le regroupement doit être fait en amont.'
    );
  if (fmt.native)
    notes.add(
      'opt',
      'Fonction native de VRL',
      `VRL a ${fmt.native}, plus rapide qu’une expression régulière, mais aux noms de champs imposés. Passerelle écrit parse_regex pour nommer les champs selon ${CONVENTIONS[opts.convention]} et pour que les tests vérifient chaque valeur ; la fonction native reste une option une fois le pipeline validé.`
    );
  if (fmt.id === 'json' && plan && plan.some(p => p.key === '__REALTIME_TIMESTAMP'))
    notes.add(
      'opt',
      'Source journald',
      'Ces lignes viennent de journalctl -o json. En production, la source journald de Vector lit le journal directement, sans cette étape ; ce VRL sert à rejouer des exports.'
    );
  for (const op of ops.filter(o => o.k === 'msg'))
    for (const id of op.enrich || [])
      notes.add(
        'info',
        `Enrichissement : ${ENRICH[id].label}`,
        'Les messages concernés de l’échantillon sont découpés en champs supplémentaires (utilisateur, adresse, commande…).'
      );
  notes.add(
    'info',
    `Convention ${CONVENTIONS[opts.convention]}`,
    opts.convention === 'otel'
      ? 'Les champs suivent les conventions sémantiques d’OpenTelemetry, dans la forme de la source opentelemetry de Vector : attributs et ressources sont des tables à clés pointées, qu’une sortie OTLP ou ClickHouse (LogAttributes, ResourceAttributes de ClickStack) reprend telles quelles.'
      : 'Les champs suivent ECS, en objets imbriqués, comme les écrirait un pipeline d’ingestion Elasticsearch ou Logstash. Les sources de Vector ajoutent un champ host en texte (le nom de la machine qui lit), contraire à ECS où host est un objet : réglez log_schema.host_key sur host.name dans la configuration globale de Vector.'
  );
}
