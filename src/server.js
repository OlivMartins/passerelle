/* Passerelle — serveur HTTP (interface + API) et ligne de commande */
const VERSION = '1.3.0';
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
    // Une clé mal écrite laisserait la valeur par défaut en place sans que personne ne le voie
    const unknown = unknownKeys(over, Object.assign({ version: 1 }, DEFAULT_CONFIG), '');
    if (unknown.length) throw new Error(`clé${unknown.length > 1 ? 's' : ''} inconnue${unknown.length > 1 ? 's' : ''} dans ${file} : ${unknown.join(', ')}`);
    for (const [t, profile] of Object.entries((over.clickhouse && over.clickhouse.tables) || {})) {
      if (profile.preset !== undefined && !PRESETS[profile.preset]) throw new Error(`préréglage inconnu pour la table ${t} dans ${file} : ${profile.preset} (${Object.keys(PRESETS).join(' ou ')})`);
    }
    const out = over.vector && over.vector.elasticsearch_output;
    if (out !== undefined && !['elasticsearch', 'clickhouse'].includes(out)) throw new Error(`vector.elasticsearch_output attend elasticsearch ou clickhouse, pas « ${out} » (${file})`);
  }
  return mergeConfig(DEFAULT_CONFIG, { clickhouse: over.clickhouse, kafka: over.kafka, vector: over.vector });
}
// Les tables de correspondance ont des clés libres, comme dans mergeConfig
function unknownKeys(src, ref, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(src)) {
    const p = prefix + k;
    if (!Object.hasOwn(ref, k)) out.push(p);
    // Profils de table : le nom de la table est libre, pas les clés du profil
    else if (k === 'tables' && prefix === 'clickhouse.' && isObj(v)) {
      for (const [t, profile] of Object.entries(v)) {
        if (!isObj(profile)) { out.push(`${p}.${t}`); continue; }
        for (const pk of Object.keys(profile)) if (!PROFILE_KEYS.includes(pk)) out.push(`${p}.${t}.${pk}`);
      }
    } else if (isObj(v) && isObj(ref[k]) && !FREE_MAPS.includes(k)) out.push(...unknownKeys(v, ref[k], p + '.'));
  }
  return out;
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
// Une page web ouverte sur le poste ne doit pas pouvoir appeler l’API : requête intersite (CSRF),
// ou nom de domaine qui pointe soudain vers 127.0.0.1 (DNS rebinding), ce que seul un jeton empêchait.
function crossSiteRefusal(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return 'requête intersite refusée';
  if (process.env.PASSERELLE_TOKEN) return '';
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(req.headers.host || '');
  const host = m ? m[1].replace(/^\[|\]$/g, '').toLowerCase() : '';
  return isLoopback(host) ? '' : 'sans PASSERELLE_TOKEN, l’API ne répond qu’aux requêtes adressées à localhost, 127.0.0.1 ou [::1]';
}

/* ---------- Validation par les moteurs réels ---------- */
// Validations Vector et SQL confondues : chacune occupe un processus ou une requête ClickHouse jusqu’à son délai
let running = 0; const MAX_JOBS = 2;
async function limited(job) {
  if (running >= MAX_JOBS) throw new HttpError(429, 'trop de validations en cours, réessayez dans quelques secondes');
  running++;
  try { return await job(); } finally { running--; }
}
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'passerelle-'));
  try {
    const dataDir = path.join(dir, 'data'); await fsp.mkdir(dataDir);
    const ext = format === 'toml' ? 'toml' : format === 'json' ? 'json' : 'yaml';
    let body = String(text);
    if (ext === 'yaml') body = /^data_dir:/m.test(body) ? body.replace(/^data_dir:.*$/m, `data_dir: ${dataDir}`) : `data_dir: ${dataDir}\n${body}`;
    if (ext === 'toml') body = /^data_dir\s*=/m.test(body) ? body.replace(/^data_dir\s*=.*$/m, `data_dir = ${JSON.stringify(dataDir)}`) : `data_dir = ${JSON.stringify(dataDir)}\n${body}`;
    const file = path.join(dir, `vector.${ext}`);
    await fsp.writeFile(file, body, { mode: 0o600 });
    // Vector ne reçoit aucun secret du service : sa sortie revient au client, et la configuration soumise
    // peut lire un fichier (remap « file: /proc/self/environ »). Les variables ${…} reçoivent une valeur factice :
    // on valide la structure, pas les secrets.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (k === 'PATH' || k === 'HOME' || k === 'TZ' || k.startsWith('VECTOR_')) env[k] = v;
    for (const m of body.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) env[m[1]] = 'validation';
    // Vector 0.57 et suivants : l’interpolation que demande l’en-tête des configurations générées (sauf réglage contraire du service)
    if (env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION === undefined) env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION = 'true';
    const bin = process.env.PASSERELLE_VECTOR_BIN || 'vector';
    const r = await runProcess(bin, ['--color', 'never', 'validate', '--skip-healthchecks', file], env, 90000);
    const output = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n')
      .filter(l => l.trim() && !/librdkafka|rdkafka::|base_producer|Log level is enabled/.test(l)).join('\n').replaceAll(dir, '<tmp>');
    return { valid: r.code === 0, exit_code: r.code, output };
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}
function withoutStrings(s) { return s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/--[^\n]*/g, ''); }
/*
 * EXPLAIN indexes = 1 évalue les sous-requêtes scalaires et imprime leur valeur dans le plan : sans garde,
 * la validation lirait toute table accessible au compte du service (vérifié sur ClickHouse 26.9).
 * La requête est donc d’abord analysée par EXPLAIN AST, qui ne lit aucune donnée : seules les tables de la
 * configuration (index_mapping, default_table, listes nommées) et les CTE de la requête sont acceptées,
 * sans fonction de table (url, file, remote…) ni lecture hors requête (dictGet, joinGet, file).
 */
function allowedTables(cfg) {
  const ch = cfg.clickhouse; const db = expand(ch.database) || 'default';
  const qualify = t => (String(t).includes('.') ? String(t) : `${db}.${t}`);
  return new Set([...Object.values(ch.index_mapping || {}), ch.default_table, (ch.lists && ch.lists.table) || `${db}.passerelle_lists`].filter(Boolean).map(qualify));
}
function parseAST(text) {
  const root = { text: '', children: [] }; const stack = [{ indent: -1, node: root }];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length; const node = { text: line.trim(), children: [] };
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node); stack.push({ indent, node });
  }
  return root;
}
function astReferences(root) {
  const refs = []; const todo = [[root, null]];
  while (todo.length) {
    const [n, parent] = todo.pop();
    let m;
    if ((m = /^TableIdentifier (\S+)/.exec(n.text))) refs.push({ kind: 'table', name: m[1] });
    else if ((m = /^Function (\w+)/.exec(n.text))) {
      if (parent && parent.text.startsWith('TableExpression')) refs.push({ kind: 'function', name: m[1] });
      // Fonctions qui lisent hors de la requête : dictionnaires, tables Join, fichiers du serveur
      else if (/^(dict\w*|joinGet\w*|file)$/i.test(m[1])) refs.push({ kind: 'reader', name: m[1] });
      else if (/^(global)?(not)?(null)?in$/i.test(m[1])) {
        // x IN db.table : la table est un simple identifiant à droite de IN
        const args = n.children[0] ? n.children[0].children : [];
        if (args[1] && /^Identifier \S+$/.test(args[1].text.replace(/ \(alias .*\)$/, ''))) refs.push({ kind: 'table', name: args[1].text.split(' ')[1] });
      }
    }
    for (const c of n.children) todo.push([c, n]);
  }
  return refs;
}
async function clickhouseQuery(cfg, body, params) {
  const ep = expand(cfg.clickhouse.endpoint).replace(/\/+$/, '');
  const url = new URL(ep + '/');
  url.searchParams.set('database', expand(cfg.clickhouse.database) || 'default');
  // readonly=1 et non 2 : en 2, la requête peut changer ses réglages (SETTINGS max_execution_time = 0)
  // et appeler d’autres hôtes par url() ; vérifié sur ClickHouse 26.9
  url.searchParams.set('readonly', '1');
  url.searchParams.set('max_execution_time', '15');
  for (const [k, v] of params) url.searchParams.set(k, v);
  const headers = { 'content-type': 'text/plain; charset=utf-8' };
  const user = expand(cfg.clickhouse.user);
  if (user) { headers['x-clickhouse-user'] = user; headers['x-clickhouse-key'] = expand(cfg.clickhouse.password); }
  let r;
  try { r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new HttpError(502, `ClickHouse injoignable : ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
  return { ok: r.ok, status: r.status, text: (await r.text()).trim() };
}
async function validateSQL(cfg, sql, query) {
  if (!expand(cfg.clickhouse.endpoint)) throw new HttpError(503, 'clickhouse.endpoint n’est pas configuré');
  const stmt = String(sql).trim().replace(/;\s*$/, '');
  const bare = withoutStrings(stmt);
  if (/;/.test(bare)) throw new HttpError(400, 'une seule requête à la fois');
  if (!/^\s*(WITH|SELECT)\b/i.test(bare.replace(/^(\s*--[^\n]*\n)*/, ''))) throw new HttpError(400, 'seules les requêtes SELECT (éventuellement précédées de WITH) sont acceptées');
  // Paramètres de requête ({nom:Type}) : param_nom=… dans l’adresse de l’appel, transmis à ClickHouse
  const params = [...query].filter(([k]) => /^param_[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  const ast = await clickhouseQuery(cfg, `EXPLAIN AST ${stmt}`, params);
  if (!ast.ok) return { valid: false, status: ast.status, plan: ast.text };
  const db = expand(cfg.clickhouse.database) || 'default';
  const allowed = allowedTables(cfg);
  const ctes = new Set([...bare.matchAll(/(?:\bWITH\b|,)\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s+AS\s*\(/gi)].map(m => m[1]));
  for (const ref of astReferences(parseAST(ast.text))) {
    if (ref.kind === 'function') throw new HttpError(400, `fonction de table refusée : ${ref.name}()`);
    if (ref.kind === 'reader') throw new HttpError(400, `fonction refusée : ${ref.name}() lit des données hors de la requête`);
    const name = ref.name.replace(/`/g, '');
    if (!name.includes('.') && ctes.has(name)) continue;
    const table = name.includes('.') ? name : `${db}.${name}`;
    if (!allowed.has(table)) throw new HttpError(400, `table ${table} hors de la configuration : la validation ne lit que ${[...allowed].join(', ')} (clickhouse.index_mapping, default_table, lists.table)`);
  }
  const r = await clickhouseQuery(cfg, `EXPLAIN indexes = 1 ${stmt} FORMAT TSVRaw`, params);
  return { valid: r.ok, status: r.status, plan: r.text };
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
  const LIMIT = 2 * 1024 * 1024; const INVENTORY_LIMIT = 32 * 1024 * 1024;
  configWarnings(cfg).forEach(w => log('warn', w));
  if (!process.env.PASSERELLE_TOKEN) log(isLoopback(host) ? 'info' : 'warn', 'PASSERELLE_TOKEN absent : l’API /v1 est accessible sans authentification, pour les seules requêtes adressées à localhost', { listen: `${host}:${port}` });

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    let url = null;
    res.on('finish', () => log('info', 'requête', { method: req.method, path: url ? url.pathname : String(req.url).slice(0, 200), status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1000000n), ip: req.socket.remoteAddress }));
    // Une adresse comme « // » ne s’analyse pas : sans cette garde, l’exception arrêterait le processus
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return json(res, 400, { error: 'adresse de requête invalide' }); }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, ui.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ui.csp });
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok', version: VERSION });
      if (!url.pathname.startsWith('/v1/')) return json(res, 404, { error: 'ressource inconnue' });
      const refusal = crossSiteRefusal(req);
      if (refusal) return json(res, 403, { error: refusal });
      if (!authorized(req)) return json(res, 401, { error: 'jeton absent ou invalide (Authorization: Bearer …)' });
      if (req.method === 'GET' && url.pathname === '/v1/config') return json(res, 200, publicConfig(cfg));
      if (req.method !== 'POST') return json(res, 405, { error: 'méthode non autorisée' });
      // Un export Kibana complet ou un gros tableau de bord dépassent vite 2 Mio : leurs routes acceptent davantage
      const body = await readBody(req, url.pathname === '/v1/inventory/kibana' || url.pathname === '/v1/translate/grafana' || url.pathname === '/v1/translate/ingest' || url.pathname === '/v1/translate/logstash/pipelines' ? INVENTORY_LIMIT : LIMIT);
      switch (url.pathname) {
        case '/v1/translate/dsl': {
          const r = translateDSL(body, cfg, { index: url.searchParams.get('index') || '' });
          if (r.empty) return json(res, 400, { error: 'requête vide', verdict: 'unrecognized' });
          if (r.error) return json(res, 422, { error: r.error, verdict: 'unrecognized' });
          return json(res, 200, { verdict: verdictOf(r), table: r.table, sql: r.sql, statements: r.statements, parameters: r.parameters, lists: r.lists, notes: r.notes, coverage: coverage(r.stats), summary: r.sentence });
        }
        case '/v1/translate/logstash': {
          const fmt = url.searchParams.get('format') === 'toml' ? 'toml' : 'yaml';
          const r = translateLogstash(body, cfg);
          if (r.empty) return json(res, 400, { error: 'pipeline vide', verdict: 'unrecognized' });
          if (r.error) return json(res, 422, { error: r.error, verdict: 'unrecognized' });
          return json(res, 200, { verdict: verdictOf(r), format: fmt, config: r[fmt], notes: r.notes, coverage: coverage(r.stats), topology: r.graph, env: r.env, summary: r.sentence });
        }
        case '/v1/translate/logstash/pipelines': {
          // Corps : pipelines.yml seul (config.string), ou JSON { "pipelines": "<pipelines.yml>", "files": { "chemin": "contenu" } }
          const fmt = url.searchParams.get('format') === 'toml' ? 'toml' : 'yaml';
          let yml = body; let files = {};
          if (/^\s*\{/.test(body)) {
            let j; try { j = JSON.parse(body); } catch (e) { return json(res, 400, { error: `JSON invalide : ${e.message}` }); }
            if (typeof j.pipelines !== 'string') return json(res, 400, { error: 'champ « pipelines » attendu : le texte de pipelines.yml' });
            if (j.files !== undefined && (typeof j.files !== 'object' || Array.isArray(j.files) || Object.values(j.files).some(x => typeof x !== 'string'))) return json(res, 400, { error: '« files » attend un objet { chemin: contenu }' });
            yml = j.pipelines; files = j.files || {};
          }
          let list;
          try { list = pipelinesFromYML(yml, Object.keys(files), f => files[f]); } catch (e) { return json(res, 422, { error: e.message, verdict: 'unrecognized' }); }
          const r = translatePipelines(list, cfg);
          if (r.error) return json(res, 422, { error: r.error, verdict: 'unrecognized', notes: r.notes, pipelines: r.pipelines });
          r.pipelines.forEach((p, k) => Object.assign(p, { from: list[k].from, matched: list[k].matched }));
          return json(res, 200, { verdict: verdictOf(r), format: fmt, config: r[fmt], notes: r.notes, coverage: coverage(r.stats), topology: r.graph, env: r.env, summary: r.sentence, pipelines: r.pipelines });
        }
        case '/v1/translate/ingest': {
          // Corps : un pipeline (YAML, JSON, ou requête PUT _ingest/pipeline de la console Kibana), ou JSON { "files": { "nom": "contenu" } }
          const fmt = url.searchParams.get('format') === 'toml' ? 'toml' : 'yaml';
          let inputs;
          try { const j = JSON.parse(body); inputs = isObj(j) && isObj(j.files) ? Object.entries(j.files).map(([name, text]) => ({ name: name.replace(/^.*\//, '').replace(/\.(ya?ml|json)$/i, ''), text: String(text) })) : null; } catch (e) { inputs = null; }
          if (!inputs) inputs = [{ name: url.searchParams.get('name') || 'pipeline', text: body }];
          if (!inputs.length) return json(res, 400, { error: 'aucun pipeline', verdict: 'unrecognized' });
          const r = translateIngest(inputs, cfg);
          if (r.error) return json(res, 422, { error: r.error, verdict: 'unrecognized', notes: r.notes });
          return json(res, 200, { verdict: verdictOf(r), format: fmt, config: r[fmt], notes: r.notes, coverage: coverage(r.stats), topology: r.graph, summary: r.sentence, pipelines: r.pipelines.map(({ vrl, ...p }) => p) });
        }
        case '/v1/inventory/kibana': {
          const fmt = url.searchParams.get('format') || 'json';
          if (!['json', 'md', 'html', 'csv'].includes(fmt)) return json(res, 400, { error: `format inconnu « ${fmt} » (json, md, html ou csv)` });
          const tz = url.searchParams.get('timezone') || null;
          if (tz && !validTimeZone(tz)) return json(res, 400, { error: `fuseau inconnu « ${tz} »` });
          const inv = kibanaInventory(body, cfg, { timeZone: tz });
          if (!inv.summary.objects && !Object.keys(inv.source.ignored).length) return json(res, 422, { error: `aucun objet sauvegardé lisible${inv.source.errors.length ? ` (${inv.source.errors[0]})` : ''}` });
          if (fmt === 'md') return send(res, 200, inventoryMarkdown(inv), { 'content-type': 'text/markdown; charset=utf-8' });
          if (fmt === 'html') return send(res, 200, inventoryHTML(inv, 'Inventaire Kibana'), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
          if (fmt === 'csv') return send(res, 200, inventoryCSV(inv), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="inventaire.csv"' });
          return json(res, 200, inv);
        }
        case '/v1/translate/grafana': {
          const r = grafanaDashboard(body, cfg, { index: url.searchParams.get('index') || '' });
          if (r.error) return json(res, 422, { error: r.error, verdict: 'unrecognized' });
          if (r.empty) return json(res, 422, { error: 'aucune requête Elasticsearch dans ce tableau de bord', verdict: 'unrecognized' });
          if (url.searchParams.get('format') === 'md') return send(res, 200, grafanaReportMarkdown(r), { 'content-type': 'text/markdown; charset=utf-8' });
          return json(res, 200, { verdict: r.verdict, summary: r.summary, report: r.report, dashboard: r.dashboard });
        }
        case '/v1/validate/vector': return json(res, 200, await limited(() => validateVector(body, url.searchParams.get('format') || 'yaml')));
        case '/v1/validate/sql': return json(res, 200, await limited(() => validateSQL(cfg, body, url.searchParams)));
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
  passerelle dsl2sql     <fichier|dossier>... [--config FICHIER] [--index MOTIF] [--out DOSSIER] [--fail-on todo|review] [--verbose]
  passerelle ls2vector   <fichier|dossier|pipelines.yml>... [--config FICHIER] [--format yaml|toml] [--out DOSSIER] [--fail-on todo|review] [--verbose]
  passerelle ingest      <fichier|dossier>... [--config FICHIER] [--format yaml|toml] [--out DOSSIER] [--fail-on todo|review] [--verbose]
  passerelle schema ddl  <fichier|dossier>... [--config FICHIER] [--preset otel|otel-json] [--compact] [--json] [--table NOM] [--format sql|yaml] [--out DOSSIER]
  passerelle schema pull [--config FICHIER] [--table NOM]...
  passerelle kibana      <export.ndjson>... [--config FICHIER] [--timezone FUSEAU] [--format md|html|csv|json] [--out DOSSIER] [--fail-on todo|review]
  passerelle grafana     <tableau.json>... [--config FICHIER] [--index MOTIF] [--out DOSSIER] [--fail-on todo|review]
  passerelle check-config [--config FICHIER] [--quiet]
  passerelle version

Variables d’environnement :
  PASSERELLE_CONFIG      fichier de configuration (passerelle.yaml)
  PASSERELLE_LISTEN      adresse d’écoute, 127.0.0.1:8080 par défaut
  PASSERELLE_TOKEN       jeton exigé sur /v1/* (Authorization: Bearer …)
  PASSERELLE_VECTOR_BIN  binaire Vector pour /v1/validate/vector (vector par défaut)
  CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, KAFKA_USERNAME, KAFKA_PASSWORD : secrets référencés par la configuration

Verdict de chaque fichier : prête, à vérifier, à reprendre, non reconnue.
Codes de sortie : 0 succès, 1 erreur ou fichier non reconnu,
  2 fichier à reprendre (--fail-on todo), ou à vérifier ou à reprendre (--fail-on review).`;
// Options déclarées : une option mal écrite ou une valeur inconnue est une erreur, pas une option ignorée
// (« --fail-on todos » désactivait en silence le contrôle d’une intégration continue).
const OPTIONS = {
  config: { type: 'string' }, listen: { type: 'string' }, index: { type: 'string' }, out: { type: 'string' },
  format: { type: 'string' }, 'fail-on': { type: 'string' }, quiet: { type: 'boolean' }, verbose: { type: 'boolean' },
  preset: { type: 'string' }, compact: { type: 'boolean' }, json: { type: 'boolean' }, table: { type: 'string', multiple: true },
  timezone: { type: 'string' },
  help: { type: 'boolean', short: 'h' }
};
function parseArgs(argv) {
  let r;
  try { r = require('node:util').parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (e) {
    const opt = /'(-[^' ]+)/.exec(e.message);
    if (!opt) fail(`option invalide : ${e.message}`);
    fail(`${e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'option inconnue' : 'option sans sa valeur, ou avec une valeur en trop'} : ${opt[1]} (passerelle --help)`);
  }
  const o = Object.assign({ _: r.positionals }, r.values);
  if (o['fail-on'] !== undefined && o['fail-on'] !== 'todo' && o['fail-on'] !== 'review') fail(`--fail-on attend todo ou review, pas « ${o['fail-on']} »`);
  if (o.format !== undefined && !['yaml', 'toml', 'sql', 'md', 'html', 'csv', 'json'].includes(o.format)) fail(`--format attend yaml ou toml (pipelines, ingest), sql ou yaml (schéma), md, html, csv ou json (inventaire), pas « ${o.format} »`);
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
// --format : chaque commande n’accepte que ses propres formats
function formatFor(o, allowed, what) {
  if (o.format !== undefined && !allowed.includes(o.format)) fail(`--format attend ${allowed.slice(0, -1).join(', ')}${allowed.length > 1 ? ' ou ' : ''}${allowed[allowed.length - 1]} pour ${what}, pas « ${o.format} »`);
  return o.format;
}
/*
 * pipelines.yml et les fichiers de configuration qu’il désigne. path.config est cherché à côté de pipelines.yml :
 * tel quel s’il est relatif, par ses fins successives s’il est absolu (/etc/logstash/conf.d/web/*.conf → conf.d/web/*.conf,
 * web/*.conf, puis *.conf), ce qui permet de copier l’arborescence de la machine Logstash telle quelle.
 */
function pipelineSet(file, cfg) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { fatal: `lecture impossible (${e.code || e.message})` }; }
  const dir = path.dirname(file);
  const available = [];
  const walk = (d, rel, depth) => {
    if (depth > 8 || available.length > 20000) return;
    let names; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const n of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (n.name.startsWith('.') || n.name === 'node_modules') continue;
      const r = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) walk(path.join(d, n.name), r, depth + 1);
      else if (n.isFile()) available.push(r);
    }
  };
  walk(dir, '', 0);
  let list;
  try { list = pipelinesFromYML(text, available, f => fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return { fatal: e.message }; }
  const r = translatePipelines(list, cfg);
  r.pipelines.forEach((p, k) => Object.assign(p, { from: list[k] && list[k].from, matched: list[k] && list[k].matched }));
  return r;
}
// Dossier de sortie (--out) : une erreur lisible plutôt qu’une pile Node.js
function outDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { fail(`--out : impossible de créer le dossier ${dir} (${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'un fichier porte ce nom' : e.code || e.message})`); }
}
function batch(kind, o) {
  if (kind === 'ls') formatFor(o, ['yaml', 'toml'], 'ls2vector');
  else if (o.format !== undefined) fail('--format ne s’applique pas à dsl2sql');
  if (!o._.length) fail(`aucun fichier à traduire. Exemple : passerelle ${kind === 'dsl' ? 'dsl2sql requetes/' : 'ls2vector pipelines/'}`);
  let cfg;
  try { cfg = loadConfig(o.config || process.env.PASSERELLE_CONFIG || null); } catch (e) { fail(e.message); }
  const fmt = kind === 'ls' ? o.format || cfg.vector.format : 'sql';
  // pipelines.yml : l’ensemble est traduit d’un bloc, avec les liaisons pipeline { send_to }
  const sets = kind === 'ls' ? o._.filter(p => /\.ya?ml$/i.test(p)) : [];
  const files = collect(o._.filter(p => !sets.includes(p)), kind === 'dsl' ? /\.(json|txt|es)$/i : /\.(conf|cfg|logstash)$/i);
  if (!files.length && !sets.length) fail('aucun fichier correspondant trouvé');
  // Un dossier qui porte pipelines.yml : chaque fichier traduit seul perd les liaisons entre pipelines
  if (kind === 'ls') for (const p of o._.filter(x => !sets.includes(x))) {
    let dir = false; try { dir = fs.statSync(p).isDirectory(); } catch (e) { /* signalé par collect */ }
    const yml = ['pipelines.yml', 'pipelines.yaml'].map(n => path.join(p, n)).find(f => dir && fs.existsSync(f));
    if (yml) process.stderr.write(`ℹ ${p} contient ${path.basename(yml)} : « passerelle ls2vector ${yml} » traduit l’ensemble avec les liaisons entre pipelines.\n`);
  }
  if (o.out) outDir(o.out);
  let errors = 0, failing = 0;
  const threshold = o['fail-on'] ? VERDICT_RANK[o['fail-on']] : Infinity;
  const MARK = { ready: '✓', review: '~', todo: '!', unrecognized: '✗' };
  for (const set of sets) {
    const r = pipelineSet(set, cfg);
    if (r.fatal) { errors++; process.stderr.write(`✗ ${set} (non reconnu) : ${r.fatal}\n`); continue; }
    const cov = coverage(r.stats); const verdict = r.error ? 'unrecognized' : verdictOf(r);
    if (verdict === 'unrecognized') errors++;
    else if (VERDICT_RANK[verdict] >= threshold) failing++;
    const summary = `${VERDICTS[verdict]} : ${r.pipelines.length} pipeline${r.pipelines.length > 1 ? 's' : ''}, ${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre`;
    if (o.out) {
      const target = path.join(o.out, path.basename(set).replace(/\.[^.]+$/, '') + `.${fmt}`);
      fs.writeFileSync(target, r[fmt]);
      process.stderr.write(`${MARK[verdict]} ${set} → ${target} (${summary})\n`);
    } else {
      process.stdout.write(r[fmt]);
      process.stderr.write(`${MARK[verdict]} ${set} (${summary})\n`);
    }
    for (const p of r.pipelines) {
      const where = p.from === 'config.string' ? 'config.string' : Array.isArray(p.from) ? `${p.matched}, ${p.from.length} fichier${p.from.length > 1 ? 's' : ''}` : '';
      const links = [p.addresses.length ? `écoute ${p.addresses.join(', ')}` : '', p.sendTo.length ? `envoie vers ${p.sendTo.join(', ')}` : ''].filter(Boolean).join(' ; ');
      process.stderr.write(`    ${p.error ? '✗' : MARK[p.verdict]} ${p.id || '(sans pipeline.id)'}${where ? ` (${where})` : ''}${p.error ? ` : ${p.error}` : ''}${links ? ` — ${links}` : ''}\n`);
    }
    if (o.verbose) r.notes.forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`));
  }
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const r = kind === 'dsl' ? translateDSL(text, cfg, { index: o.index || '' }) : translateLogstash(text, cfg);
    if (r.error || r.empty) { errors++; process.stderr.write(`✗ ${f} (non reconnue) : ${r.error || 'fichier vide'}\n`); continue; }
    const cov = coverage(r.stats); const verdict = verdictOf(r);
    if (VERDICT_RANK[verdict] >= threshold) failing++;
    const params = kind === 'dsl' && r.parameters.length ? `-- Paramètres : ${r.parameters.map(p => `{${p.name}} ← ${p.source}`).join(', ')}\n` : '';
    const content = kind === 'dsl' ? `-- Traduit par Passerelle ${VERSION} depuis ${path.basename(f)}\n-- Table ClickHouse : ${r.table}\n-- Verdict : ${VERDICTS[verdict]}\n${params}\n${r.sql}\n` : r[fmt];
    const summary = `${VERDICTS[verdict]} : ${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre`;
    if (o.out) {
      const target = path.join(o.out, path.basename(f).replace(/\.[^.]+$/, '') + (kind === 'dsl' ? '.sql' : `.${fmt}`));
      fs.writeFileSync(target, content);
      // Listes nommées : la table et ses lignes, à exécuter avant la requête
      const lists = kind === 'dsl' ? r.lists : [];
      if (lists.length) fs.writeFileSync(target.replace(/\.sql$/, '.lists.sql'), lists.map(l => l.sql).join('\n\n') + '\n');
      process.stderr.write(`${MARK[verdict]} ${f} → ${target} (${summary}${lists.length ? `, ${lists.length} liste(s) nommée(s)` : ''})\n`);
    } else {
      process.stdout.write(content + (files.length > 1 ? '\n' : ''));
      process.stderr.write(`${MARK[verdict]} ${f} (${summary})\n`);
      if (kind === 'dsl' && r.lists.length) process.stderr.write(`    ${r.lists.length} liste(s) nommée(s) : ajoutez --out pour écrire leur fichier .lists.sql\n`);
    }
    if (o.verbose) r.notes.forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`));
  }
  if (errors) process.exit(1);
  if (failing) {
    process.stderr.write(`${failing} fichier(s) ${o['fail-on'] === 'todo' ? 'à reprendre' : 'à vérifier ou à reprendre'}.\n`);
    process.exit(2);
  }
}
/* ---------- Pipelines d’ingestion Elasticsearch (passerelle ingest) ---------- */
function ingestConvert(o) {
  if (!o._.length) fail('aucun pipeline à traduire. Exemple : passerelle ingest pipelines/ --out ingest/');
  formatFor(o, ['yaml', 'toml'], 'ingest');
  const cfg = loadCfgOrFail(o);
  const fmt = o.format || cfg.vector.format;
  const files = collect(o._, /\.(ya?ml|json)$/i);
  if (!files.length) fail('aucun fichier .yml, .yaml ou .json trouvé');
  // Les pipelines d’un même dossier s’appellent entre eux (processeur pipeline) : ils sont lus ensemble
  const inputs = files.map(f => ({ name: path.basename(f).replace(/\.(ya?ml|json)$/i, ''), text: fs.readFileSync(f, 'utf8') }));
  const r = translateIngest(inputs, cfg);
  const MARK = { ready: '✓', review: '~', todo: '!', unrecognized: '✗' };
  if (r.error) { r.notes.forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`)); fail(`aucun pipeline traduit : ${r.error}`); }
  const verdict = verdictOf(r); const cov = coverage(r.stats);
  if (o.out) {
    outDir(o.out);
    const target = path.join(o.out, `ingest.${fmt}`);
    fs.writeFileSync(target, r[fmt]);
    // Un fichier .vrl par transform, pour les rejouer avec « vector vrl »
    const vrlDir = path.join(o.out, 'vrl');
    outDir(vrlDir);
    for (const p of r.pipelines) p.chain.forEach((id, k) => fs.writeFileSync(path.join(vrlDir, `${id}.vrl`), p.vrls[k]));
    process.stderr.write(`${MARK[verdict]} ${files.length} fichier(s) → ${target} et ${vrlDir}/ (${VERDICTS[verdict]} : ${r.pipelines.length} pipeline(s), ${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre)\n`);
  } else {
    process.stdout.write(r[fmt]);
    process.stderr.write(`${MARK[verdict]} ${files.length} fichier(s) (${VERDICTS[verdict]} : ${r.pipelines.length} pipeline(s), ${cov.percent} % traduit, ${r.stats.approx} à vérifier, ${r.stats.ko} à reprendre)\n`);
  }
  for (const p of r.pipelines) process.stderr.write(`    ${MARK[p.verdict]} ${p.name} — ${p.processors} processeur(s)${p.chain.length > 1 ? `, ${p.chain.length} transforms` : ''}${p.calls.length ? `, appelle ${p.calls.join(', ')}` : ''}\n`);
  const shown = r.notes.filter(n => o.verbose || n.level === 'err' || n.level === 'warn');
  shown.forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`));
  if (o['fail-on'] && VERDICT_RANK[verdict] >= VERDICT_RANK[o['fail-on']]) process.exit(2);
}

/* ---------- Schéma (passerelle schema ddl | pull) ---------- */
function loadCfgOrFail(o) {
  try { return loadConfig(o.config || process.env.PASSERELLE_CONFIG || null); } catch (e) { return fail(e.message); }
}
function schemaDDL(o) {
  if (!o._.length) fail('aucun fichier à lire. Exemple : passerelle schema ddl modeles/ --out build/schema');
  formatFor(o, ['sql', 'yaml'], 'schema ddl');
  const cfg = loadCfgOrFail(o);
  const files = collect(o._, /\.(json|txt|es)$/i);
  if (!files.length) fail('aucun fichier correspondant trouvé');
  // Les documents d’une même migration se complètent (modèle, composants, politique ILM) : ils sont lus ensemble
  const r = schemaFromDocuments(files.map(f => fs.readFileSync(f, 'utf8').trim()), cfg, { preset: o.preset, compact: !!o.compact, json: !!o.json, table: o.table && o.table[0] });
  if (r.error || r.empty) fail(r.error || 'aucun mapping lisible');
  const verdict = verdictOf(r);
  if (o.out) {
    outDir(o.out);
    fs.writeFileSync(path.join(o.out, 'schema.sql'), `-- Généré par Passerelle ${VERSION} — verdict : ${VERDICTS[verdict]}\n\n${r.sql}`);
    fs.writeFileSync(path.join(o.out, 'passerelle.tables.yaml'), r.yaml);
    process.stderr.write(`${r.tables.length} table(s) → ${path.join(o.out, 'schema.sql')} et ${path.join(o.out, 'passerelle.tables.yaml')} (${VERDICTS[verdict]})\n`);
  } else process.stdout.write(o.format === 'yaml' ? r.yaml : `${r.sql}`);
  for (const t of r.tables) process.stderr.write(`${t.error ? '✗' : '✓'} ${t.table}${t.error ? ` : ${t.error}` : ''}\n`);
  if (o.verbose || verdict !== 'ready') r.notes.filter(n => o.verbose || n.level === 'warn' || n.level === 'err').forEach(n => process.stderr.write(`    [${n.level}] ${n.title}${n.detail ? ' — ' + n.detail : ''}\n`));
  if (o['fail-on'] && VERDICT_RANK[verdict] >= VERDICT_RANK[o['fail-on']]) process.exit(2);
}
// Plusieurs fichiers JSON (réponses d’API) : chacun est lu pour lui-même, puis tous sont traduits ensemble
function schemaFromDocuments(blocks, cfg, opts) {
  const wrapped = blocks.map(b => (/^(GET|PUT|POST)\s/i.test(b) ? b : `POST _passerelle\n${b}`)).join('\n\n');
  return schemaFromElastic(wrapped, cfg, opts);
}
async function schemaPull(o) {
  const cfg = loadCfgOrFail(o);
  if (!expand(cfg.clickhouse.endpoint)) fail('clickhouse.endpoint n’est pas configuré');
  const ch = cfg.clickhouse;
  const tables = o.table && o.table.length ? o.table : [...new Set([...Object.values(ch.index_mapping || {}), ch.default_table].filter(Boolean))];
  const Q = schemaPullQueries(tables);
  const rows = async q => {
    let r;
    try { r = await clickhouseQuery(cfg, q, []); } catch (e) { fail(e.message); }
    if (!r.ok) fail(`ClickHouse répond ${r.status} : ${r.text.slice(0, 300)}`);
    return r.text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  };
  const out = profilesFromSystem(await rows(Q.columns), await rows(Q.tables), await rows(Q.indices), tables, cfg);
  process.stdout.write(out.yaml);
  out.notes.forEach(n => process.stderr.write(`attention : ${n}\n`));
  process.stderr.write(`${Object.keys(out.profiles).length} table(s) décrite(s) sur ${tables.length}.\n`);
  if (Object.keys(out.profiles).length < tables.length) process.exit(1);
}

/* ---------- Inventaire Kibana (passerelle kibana) ---------- */
// Fuseau IANA (Europe/Paris) ou décalage en heures entières (+02:00), comme le paramètre time_zone d’Elasticsearch
function validTimeZone(tz) {
  if (/^[+-]\d{2}:?00$/.test(tz)) return true;
  try { new Intl.DateTimeFormat('fr', { timeZone: tz }); return true; } catch (e) { return false; }
}
function kibanaReport(o) {
  if (o.timezone !== undefined && !validTimeZone(o.timezone)) fail(`--timezone attend un fuseau IANA (Europe/Paris) ou un décalage en heures (+02:00), pas « ${o.timezone} »`);
  if (!o._.length) fail('aucun export à lire. Exemple : passerelle kibana export.ndjson --out inventaire/');
  const fmt = formatFor(o, ['md', 'html', 'csv', 'json'], 'kibana') || 'md';
  const cfg = loadCfgOrFail(o);
  const files = collect(o._, /\.(ndjson|json)$/i);
  if (!files.length) fail('aucun fichier .ndjson trouvé');
  const inv = kibanaInventory(files.map(f => fs.readFileSync(f, 'utf8')), cfg, { names: files.map(f => path.basename(f)), timeZone: o.timezone || null });
  if (!inv.summary.objects && !Object.keys(inv.source.ignored).length) fail(`aucun objet sauvegardé lisible${inv.source.errors.length ? ` (${inv.source.errors[0]})` : ''}`);
  const title = `Inventaire Kibana — ${files.map(f => path.basename(f)).join(', ')}`;
  const render = f => (f === 'md' ? inventoryMarkdown(inv) : f === 'html' ? inventoryHTML(inv, title) : f === 'csv' ? inventoryCSV(inv) : JSON.stringify(inv, null, 2) + '\n');
  if (o.out) {
    outDir(path.join(o.out, 'sql'));
    for (const f of ['md', 'html', 'csv', 'json']) fs.writeFileSync(path.join(o.out, `inventaire.${f}`), render(f));
    const sqlFiles = inventorySQLFiles(inv);
    for (const f of sqlFiles) fs.writeFileSync(path.join(o.out, 'sql', f.name), f.content);
    process.stderr.write(`inventaire → ${path.join(o.out, 'inventaire.{md,html,csv,json}')}, ${sqlFiles.length} fichier(s) SQL dans ${path.join(o.out, 'sql')}\n`);
  } else process.stdout.write(render(fmt));
  const s = inv.summary; const v = s.byVerdict;
  process.stderr.write(`${s.objects} objet(s) : ${v.ready} prêt(s), ${v.review} à vérifier, ${v.todo} à reprendre${v.unrecognized ? `, ${v.unrecognized} non reconnu(s)` : ''}. Effort estimé : ${String(s.effort.hours).replace('.', ',')} h (${String(s.effort.days).replace('.', ',')} j).\n`);
  inv.source.errors.forEach(e => process.stderr.write(`attention : ${e}\n`));
  if (o['fail-on'] && inv.entries.some(x => VERDICT_RANK[x.verdict] >= VERDICT_RANK[o['fail-on']])) process.exit(2);
}

/* ---------- Tableaux de bord Grafana (passerelle grafana) ---------- */
function grafanaConvert(o) {
  if (!o._.length) fail('aucun tableau de bord à convertir. Exemple : passerelle grafana tableau.json --index logs-* --out grafana/');
  if (o.format !== undefined) fail('--format ne s’applique pas à grafana (le résultat est un tableau de bord JSON et son rapport)');
  const cfg = loadCfgOrFail(o);
  const files = collect(o._, /\.json$/i);
  if (!files.length) fail('aucun fichier .json trouvé');
  if (files.length > 1 && !o.out) fail('plusieurs tableaux de bord : précisez --out DOSSIER');
  if (o.out) outDir(o.out);
  let errors = 0, failing = 0;
  const MARK = { ready: '✓', review: '~', todo: '!', unrecognized: '✗' };
  for (const f of files) {
    const r = grafanaDashboard(fs.readFileSync(f, 'utf8'), cfg, { index: o.index || '' });
    if (r.error) { errors++; process.stderr.write(`✗ ${f} (non reconnu) : ${r.error}\n`); continue; }
    if (r.empty) { errors++; process.stderr.write(`✗ ${f} : aucune requête Elasticsearch dans ce tableau de bord\n`); continue; }
    const v = r.summary.byVerdict;
    const summary = `${VERDICTS[r.verdict]} : ${r.summary.panels} panneau(x), ${v.ready} prêt(s), ${v.review} à vérifier, ${v.todo} à reprendre`;
    if (o.out) {
      const base = path.join(o.out, path.basename(f).replace(/\.json$/i, ''));
      fs.writeFileSync(`${base}.clickhouse.json`, JSON.stringify(r.dashboard, null, 2) + '\n');
      fs.writeFileSync(`${base}.rapport.md`, grafanaReportMarkdown(r, path.basename(f)));
      process.stderr.write(`${MARK[r.verdict]} ${f} → ${base}.clickhouse.json, ${base}.rapport.md (${summary})\n`);
    } else {
      process.stdout.write(JSON.stringify(r.dashboard, null, 2) + '\n');
      process.stderr.write(`${MARK[r.verdict]} ${f} (${summary})\n`);
    }
    for (const n of r.report.notes) process.stderr.write(`    ${n}\n`);
    if (o.verbose) for (const p of r.report.panels) process.stderr.write(`    ${MARK[p.verdict]} ${p.title} — ${[...new Set(p.targets.flatMap(t => t.issues.map(i => i.label).concat(t.notes.map(n => n.title))))].join(' ; ') || VERDICTS[p.verdict]}\n`);
    if (o['fail-on'] && VERDICT_RANK[r.verdict] >= VERDICT_RANK[o['fail-on']]) failing++;
  }
  if (errors) process.exit(1);
  if (failing) process.exit(2);
}

function main(argv) {
  const [cmd, ...rest] = argv; const o = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || o.help) { process.stdout.write(HELP + '\n'); return; }
  switch (cmd) {
    case 'version': case '--version': case '-v': process.stdout.write(`passerelle ${VERSION} (node ${process.version})\n`); return;
    case 'serve': try { serve(o); } catch (e) { fail(e.message); } return;
    case 'dsl2sql': return batch('dsl', o);
    case 'schema': {
      const sub = o._.shift();
      if (o.preset !== undefined && !['otel', 'otel-json'].includes(o.preset)) fail(`--preset attend otel ou otel-json, pas « ${o.preset} »`);
      if (sub === 'ddl') return schemaDDL(o);
      if (sub === 'pull') return schemaPull(o).catch(e => fail(e.message));
      return fail(`sous-commande inconnue : schema ${sub || ''}`.trim() + ' (ddl ou pull)');
    }
    case 'ls2vector': return batch('ls', o);
    case 'ingest': return ingestConvert(o);
    case 'kibana': return kibanaReport(o);
    case 'grafana': return grafanaConvert(o);
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
