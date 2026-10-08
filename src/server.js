/* Passerelle — serveur HTTP (interface + API) et ligne de commande */
const VERSION = '1.0.0';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/* ---------- Journalisation JSON (lue par journald) ---------- */
function log(level, msg, extra) {
  const line = Object.assign({ ts: new Date().toISOString(), level, msg }, extra || {});
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
function fail(msg, code) { process.stderr.write(`passerelle : ${msg}\n`); process.exit(code || 1); }

/* ---------- Configuration ---------- */
function loadConfig(file) {
  let over = {};
  if (file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`configuration illisible (${file}) : ${e.code || e.message}`); }
    over = /\.json$/i.test(file) ? JSON.parse(text) : parseYAMLConfig(text);
    if (!isObj(over)) throw new Error(`configuration invalide (${file})`);
  }
  return mergeConfig(DEFAULT_CONFIG, { clickhouse: over.clickhouse, kafka: over.kafka, vector: over.vector });
}
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
function expand(s) { return String(s || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => process.env[v] || ''); }
function configWarnings(cfg) {
  const w = [];
  for (const [sec, key] of [['clickhouse', 'password'], ['kafka', 'password']]) {
    const v = cfg[sec][key];
    if (v && !ENV_REF.test(v)) w.push(`${sec}.${key} est écrit en clair : remplacez-le par une référence \${VARIABLE} définie dans le fichier d’environnement.`);
  }
  if (!cfg.clickhouse.endpoint) w.push('clickhouse.endpoint est vide : /v1/validate/sql sera indisponible.');
  return w;
}
/* Configuration diffusée (interface, GET /v1/config) : aucun secret en clair */
function publicConfig(cfg) {
  const c = clone(cfg);
  if (c.clickhouse.password && !ENV_REF.test(c.clickhouse.password)) c.clickhouse.password = '${CLICKHOUSE_PASSWORD}';
  if (c.kafka.password && !ENV_REF.test(c.kafka.password)) c.kafka.password = '${KAFKA_PASSWORD}';
  return c;
}
function coverage(stats) { const t = stats.ok + stats.approx + stats.ko || 1; return Object.assign({}, stats, { percent: Math.round((100 * (stats.ok + stats.approx)) / t) }); }

/* ---------- Interface embarquée ---------- */
function loadUIHtml() {
  try { const sea = require('node:sea'); if (sea.isSea()) return sea.getAsset('index.html', 'utf8'); } catch (e) { /* hors binaire */ }
  const p = process.env.PASSERELLE_UI || path.join(__dirname, 'passerelle.html');
  return fs.readFileSync(p, 'utf8');
}
function buildUI(cfg) {
  const raw = loadUIHtml();
  const data = JSON.stringify(publicConfig(cfg)).replace(/</g, '\\u003c');
  const html = raw.replace('<script>', `<script type="application/json" id="server-config">${data}</script>\n<script>`);
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  const csp = [
    "default-src 'none'", `script-src ${hashes.join(' ')}`, "style-src 'unsafe-inline'",
    "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
  ].join('; ');
  return { html, csp };
}

/* ---------- Outils HTTP ---------- */
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'cache-control': 'no-store'
};
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SEC_HEADERS, headers || {}, { 'content-length': Buffer.byteLength(body) }));
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj, null, 2) + '\n', { 'content-type': 'application/json; charset=utf-8' }); }
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function readBody(req, limit) {
  const tooBig = () => new HttpError(413, `corps de requête limité à ${Math.round(limit / 1024)} Kio`);
  if (+req.headers['content-length'] > limit) return Promise.reject(tooBig());
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; reject(tooBig()); } else chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req) {
  const token = process.env.PASSERELLE_TOKEN;
  if (!token) return true;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return !!m && crypto.timingSafeEqual(sha(m[1]), sha(token));
}
function isLoopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }

/* ---------- Validation par les moteurs réels ---------- */
let running = 0; const MAX_JOBS = 2;
function runProcess(bin, args, env, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new HttpError(503, `binaire introuvable : ${bin}. Installez Vector ou définissez PASSERELLE_VECTOR_BIN.`));
      if (err && err.killed) return reject(new HttpError(504, 'validation interrompue : délai dépassé'));
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
async function validateVector(text, format) {
  if (running >= MAX_JOBS) throw new HttpError(429, 'trop de validations en cours, réessayez dans quelques secondes');
  running++;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'passerelle-'));
  try {
    const dataDir = path.join(dir, 'data'); await fsp.mkdir(dataDir);
    const ext = format === 'toml' ? 'toml' : format === 'json' ? 'json' : 'yaml';
    let body = String(text);
    if (ext === 'yaml') body = /^data_dir:/m.test(body) ? body.replace(/^data_dir:.*$/m, `data_dir: ${dataDir}`) : `data_dir: ${dataDir}\n${body}`;
    if (ext === 'toml') body = /^data_dir\s*=/m.test(body) ? body.replace(/^data_dir\s*=.*$/m, `data_dir = ${JSON.stringify(dataDir)}`) : `data_dir = ${JSON.stringify(dataDir)}\n${body}`;
    const file = path.join(dir, `vector.${ext}`);
    await fsp.writeFile(file, body, { mode: 0o600 });
    // Les variables ${…} absentes reçoivent une valeur factice : on valide la structure, pas les secrets.
    const env = Object.assign({}, process.env);
    for (const m of body.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) if (env[m[1]] === undefined) env[m[1]] = 'validation';
    const bin = process.env.PASSERELLE_VECTOR_BIN || 'vector';
    const r = await runProcess(bin, ['--color', 'never', 'validate', '--skip-healthchecks', file], env, 90000);
    const output = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n')
      .filter(l => l.trim() && !/librdkafka|rdkafka::|base_producer|Log level is enabled/.test(l)).join('\n').replaceAll(dir, '<tmp>');
    return { valid: r.code === 0, exit_code: r.code, output };
  } finally { running--; await fsp.rm(dir, { recursive: true, force: true }); }
}
function withoutStrings(s) { return s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/--[^\n]*/g, ''); }
async function validateSQL(cfg, sql) {
  const ep = expand(cfg.clickhouse.endpoint).replace(/\/+$/, '');
  if (!ep) throw new HttpError(503, 'clickhouse.endpoint n’est pas configuré');
  const stmt = String(sql).trim().replace(/;\s*$/, '');
  const bare = withoutStrings(stmt);
  if (/;/.test(bare)) throw new HttpError(400, 'une seule requête à la fois');
  if (!/^\s*(WITH|SELECT)\b/i.test(bare.replace(/^(\s*--[^\n]*\n)*/, ''))) throw new HttpError(400, 'seules les requêtes SELECT (éventuellement précédées de WITH) sont acceptées');
  const url = new URL(ep + '/');
  url.searchParams.set('database', expand(cfg.clickhouse.database) || 'default');
  url.searchParams.set('readonly', '2');
  url.searchParams.set('max_execution_time', '15');
  const headers = { 'content-type': 'text/plain; charset=utf-8' };
  const user = expand(cfg.clickhouse.user);
  if (user) { headers['x-clickhouse-user'] = user; headers['x-clickhouse-key'] = expand(cfg.clickhouse.password); }
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body: `EXPLAIN indexes = 1 ${stmt} FORMAT TSVRaw`, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new HttpError(502, `ClickHouse injoignable : ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
  const text = await r.text();
  return { valid: r.ok, status: r.status, plan: text.trim() };
}

/* ---------- Serveur ---------- */
function parseListen(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s) || /^()(\d+)$/.exec(s);
  if (!m) throw new Error(`adresse d’écoute invalide : ${s} (attendu hôte:port)`);
  return { host: m[1] || '127.0.0.1', port: +m[2] };
}
function serve(opts) {
  const cfgFile = opts.config || process.env.PASSERELLE_CONFIG || null;
  let cfg = loadConfig(cfgFile);
  let ui = buildUI(cfg);
  const { host, port } = parseListen(opts.listen || process.env.PASSERELLE_LISTEN || '127.0.0.1:8080');
  const LIMIT = 2 * 1024 * 1024;
  configWarnings(cfg).forEach(w => log('warn', w));
  if (!process.env.PASSERELLE_TOKEN) log(isLoopback(host) ? 'info' : 'warn', 'PASSERELLE_TOKEN absent : l’API /v1 est accessible sans authentification', { listen: `${host}:${port}` });

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    res.on('finish', () => log('info', 'requête', { method: req.method, path: url.pathname, status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1000000n), ip: req.socket.remoteAddress }));
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, ui.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ui.csp });
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok', version: VERSION });
      if (!url.pathname.startsWith('/v1/')) return json(res, 404, { error: 'ressource inconnue' });
      if (!authorized(req)) return json(res, 401, { error: 'jeton absent ou invalide (Authorization: Bearer …)' });
      if (req.method === 'GET' && url.pathname === '/v1/config') return json(res, 200, publicConfig(cfg));
      if (req.method !== 'POST') return json(res, 405, { error: 'méthode non autorisée' });
      const body = await readBody(req, LIMIT);
      switch (url.pathname) {
        case '/v1/translate/dsl': {
          const r = translateDSL(body, cfg, { index: url.searchParams.get('index') || '' });
          if (r.empty) return json(res, 400, { error: 'requête vide' });
          if (r.error) return json(res, 422, { error: r.error });
          return json(res, 200, { table: r.table, sql: r.sql, statements: r.statements, notes: r.notes, coverage: coverage(r.stats), summary: r.sentence });
        }
        case '/v1/translate/logstash': {
          const fmt = url.searchParams.get('format') === 'toml' ? 'toml' : 'yaml';
          const r = translateLogstash(body, cfg);
          if (r.empty) return json(res, 400, { error: 'pipeline vide' });
          if (r.error) return json(res, 422, { error: r.error });
          return json(res, 200, { format: fmt, config: r[fmt], notes: r.notes, coverage: coverage(r.stats), topology: r.graph, env: r.env, summary: r.sentence });
        }
        case '/v1/validate/vector': return json(res, 200, await validateVector(body, url.searchParams.get('format') || 'yaml'));
        case '/v1/validate/sql': return json(res, 200, await validateSQL(cfg, body));
        default: return json(res, 404, { error: 'ressource inconnue' });
      }
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) { res.setHeader('connection', 'close'); res.on('finish', () => req.socket.destroy()); }
        return json(res, e.status, { error: e.message });
      }
      log('error', 'erreur interne', { error: e.message, stack: e.stack });
      return json(res, 500, { error: 'erreur interne' });
    }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  server.on('error', e => { log('error', `écoute impossible sur ${host}:${port}`, { error: e.code || e.message }); process.exit(1); });
  server.listen(port, host, () => log('info', 'Passerelle démarrée', { version: VERSION, listen: `${host}:${port}`, config: cfgFile || '(valeurs par défaut)', node: process.version }));
  process.on('SIGHUP', () => {
    try { cfg = loadConfig(cfgFile); ui = buildUI(cfg); configWarnings(cfg).forEach(w => log('warn', w)); log('info', 'configuration rechargée', { config: cfgFile }); }
    catch (e) { log('error', 'rechargement refusé, configuration précédente conservée', { error: e.message }); }
  });
  const stop = sig => { log('info', 'arrêt demandé', { signal: sig }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}

/* ---------- Ligne de commande ---------- */
const HELP = `Passerelle ${VERSION} — traduction Elasticsearch/Logstash vers ClickHouse/Vector

Utilisation :
  passerelle serve       [--config FICHIER] [--listen HÔTE:PORT]
  passerelle dsl2sql     <fichier|dossier>... [--config FICHIER] [--index MOTIF] [--out DOSSIER] [--fail-on todo]
  passerelle ls2vector   <fichier|dossier>... [--config FICHIER] [--format yaml|toml] [--out DOSSIER] [--fail-on todo]
  passerelle check-config [--config FICHIER] [--quiet]
  passerelle version

Variables d’environnement :
  PASSERELLE_CONFIG      fichier de configuration (passerelle.yaml)
  PASSERELLE_LISTEN      adresse d’écoute, 127.0.0.1:8080 par défaut
  PASSERELLE_TOKEN       jeton exigé sur /v1/* (Authorization: Bearer …)
  PASSERELLE_VECTOR_BIN  binaire Vector pour /v1/validate/vector (vector par défaut)
  CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, KAFKA_USERNAME, KAFKA_PASSWORD : secrets référencés par la configuration

Codes de sortie : 0 succès, 1 erreur, 2 éléments à reprendre (avec --fail-on todo).`;
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
      else o[a.slice(2)] = true;
    } else o._.push(a);
  }
  return o;
}
function collect(inputs, exts) {
  const out = [];
  const walk = p => {
    let st; try { st = fs.statSync(p); } catch (e) { fail(`introuvable : ${p}`); }
    if (st.isDirectory()) fs.readdirSync(p).sort().forEach(n => walk(path.join(p, n)));
    else if (exts.test(p) || inputs.includes(p)) out.push(p);
  };
  inputs.forEach(walk);
  return out;
}
function batch(kind, o) {
  if (!o._.length) fail(`aucun fichier à traduire. Exemple : passerelle ${kind === 'dsl' ? 'dsl2sql requetes/' : 'ls2vector pipelines/'}`);
  let cfg;
  try { cfg = loadConfig(o.config || process.env.PASSERELLE_CONFIG || null); } catch (e) { fail(e.message); }
  const fmt = o.format === 'toml' ? 'toml' : kind === 'ls' ? cfg.vector.format : 'sql';
  const files = collect(o._, kind === 'dsl' ? /\.(json|txt|es)$/i : /\.(conf|cfg|logstash)$/i);
  if (!files.length) fail('aucun fichier correspondant trouvé');
  if (o.out) fs.mkdirSync(o.out, { recursive: true });
  let errors = 0, todos = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const r = kind === 'dsl' ? translateDSL(text, cfg, { index: o.index || '' }) : translateLogstash(text, cfg);
    if (r.error || r.empty) { errors++; process.stderr.write(`✗ ${f} : ${r.error || 'fichier vide'}\n`); continue; }
    const cov = coverage(r.stats); if (r.stats.ko) todos++;
    const content = kind === 'dsl' ? `-- Traduit par Passerelle ${VERSION} depuis ${path.basename(f)}\n-- Table ClickHouse : ${r.table}\n\n${r.sql}\n` : r[fmt];
    if (o.out) {
      const target = path.join(o.out, path.basename(f).replace(/\.[^.]+$/, '') + (kind === 'dsl' ? '.sql' : `.${fmt}`));
      fs.writeFileSync(target, content);
      process.stderr.write(`${r.stats.ko ? '!' : '✓'} ${f} → ${target} (${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre)\n`);
    } else {
      process.stdout.write(content + (files.length > 1 ? '\n' : ''));
      process.stderr.write(`${r.stats.ko ? '!' : '✓'} ${f} (${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre)\n`);
    }
    if (o.verbose) r.notes.forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`));
  }
  if (errors) process.exit(1);
  if (todos && o['fail-on'] === 'todo') { process.stderr.write(`${todos} fichier(s) contiennent des éléments à reprendre.\n`); process.exit(2); }
}
function main(argv) {
  const [cmd, ...rest] = argv; const o = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || o.help) { process.stdout.write(HELP + '\n'); return; }
  switch (cmd) {
    case 'version': case '--version': case '-v': process.stdout.write(`passerelle ${VERSION} (node ${process.version})\n`); return;
    case 'serve': try { serve(o); } catch (e) { fail(e.message); } return;
    case 'dsl2sql': return batch('dsl', o);
    case 'ls2vector': return batch('ls', o);
    case 'check-config': {
      const file = o.config || process.env.PASSERELLE_CONFIG || null;
      let cfg; try { cfg = loadConfig(file); } catch (e) { fail(e.message); }
      const w = configWarnings(cfg);
      if (!o.quiet) process.stdout.write(configToYAML(publicConfig(cfg)));
      w.forEach(x => process.stderr.write(`attention : ${x}\n`));
      process.stderr.write(`${file || '(valeurs par défaut)'} : configuration lisible${w.length ? `, ${w.length} avertissement(s)` : ''}.\n`);
      return;
    }
    default: fail(`commande inconnue : ${cmd}\n\n${HELP}`);
  }
}
main(process.argv.slice(2));
