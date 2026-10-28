/* Passerelle — Node.js : exploitation du service (identifiant de requête, jetons à portée, identité du reverse proxy, journal d’audit, /metrics, traces OpenTelemetry) */
/*
 * Ce code ne s’exécute pas à son chargement : il emploie les modules et les fonctions que src/server.js déclare
 * (crypto, fs, log, expand, VERSION…), dans ses fonctions seulement. Tous ses noms commencent par « ops ».
 *
 * Ce que les trois sorties (journal d’audit, métriques, traces) ne contiennent jamais : une requête, un pipeline,
 * un SQL ou un jeton. Elles décrivent l’appel (qui, quoi, quand, combien de temps, avec quel résultat), pas son contenu ;
 * le journal d’audit n’en garde qu’une empreinte (SHA-256, 16 premiers caractères) pour retrouver quel texte a été soumis.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const opsNet = require('node:net');

// La requête en cours, accessible de toute fonction qu’elle appelle (pour les spans enfants, sans passer la requête partout)
const opsContext = new AsyncLocalStorage();

/* ---------- Configuration du service (section « server ») ---------- */
const OPS_SCOPES = ['translate', 'validate', 'metrics'];
const OPS_LEGACY_TOKEN = 'principal';

// Contrôle de forme, sans variable d’environnement : il vaut pour toutes les commandes qui lisent la configuration
function opsCheckConfig(s, file) {
  const where = file ? ` (${file})` : '';
  const err = m => { throw new Error(m + where); };
  if (!isObj(s)) err('server attend une table (tokens, trusted_proxies, identity_header, metrics, audit_log, tracing)');
  if (!Array.isArray(s.tokens)) err('server.tokens attend une liste de jetons (name, token, scopes)');
  const names = new Set([OPS_LEGACY_TOKEN]);
  s.tokens.forEach((t, i) => {
    const at = `server.tokens[${i}]`;
    if (!isObj(t)) err(`${at} : attendu name, token et scopes`);
    const unknown = Object.keys(t).filter(k => !['name', 'token', 'scopes'].includes(k));
    if (unknown.length) err(`${at} : clé inconnue ${unknown.join(', ')}`);
    if (typeof t.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(t.name)) err(`${at}.name attend un nom de 1 à 64 caractères (lettres, chiffres, point, tiret, tiret bas)`);
    if (names.has(t.name)) err(`${at}.name « ${t.name} » est déjà pris${t.name === OPS_LEGACY_TOKEN ? ' (c’est le nom de PASSERELLE_TOKEN)' : ''}`);
    names.add(t.name);
    if (typeof t.token !== 'string' || !t.token) err(`${at}.token attend une référence à une variable d’environnement, par exemple '\${TOKEN_${String(t.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}}'`);
    if (!Array.isArray(t.scopes) || !t.scopes.length || t.scopes.some(x => !OPS_SCOPES.includes(x))) err(`${at}.scopes attend une liste parmi ${OPS_SCOPES.join(', ')}`);
  });
  if (!Array.isArray(s.trusted_proxies)) err('server.trusted_proxies attend une liste d’adresses IP ou de réseaux CIDR');
  try { opsProxyList(s.trusted_proxies); } catch (e) { err(e.message); }
  if (typeof s.identity_header !== 'string' || (s.identity_header && !/^[A-Za-z0-9-]{1,64}$/.test(s.identity_header))) err('server.identity_header attend un nom d’en-tête HTTP, par exemple X-Forwarded-User');
  if (typeof s.metrics !== 'boolean') err('server.metrics attend true ou false');
  if (typeof s.audit_log !== 'string') err('server.audit_log attend un chemin de fichier');
  const t = s.tracing;
  if (!isObj(t)) err('server.tracing attend une table (endpoint, headers, sample_ratio, service_name)');
  if (typeof t.endpoint !== 'string') err('server.tracing.endpoint attend l’adresse d’un collecteur OTLP/HTTP');
  if (typeof t.service_name !== 'string' || !t.service_name.trim()) err('server.tracing.service_name ne peut pas être vide');
  if (typeof t.sample_ratio !== 'number' || !(t.sample_ratio >= 0 && t.sample_ratio <= 1)) err('server.tracing.sample_ratio attend un nombre de 0 à 1');
  if (!isObj(t.headers) || Object.values(t.headers).some(v => typeof v !== 'string')) err('server.tracing.headers attend une table nom: valeur');
}

// Adresses des reverse proxies de confiance → net.BlockList (null si aucun)
function opsProxyList(list) {
  if (!list.length) return null;
  const bl = new opsNet.BlockList();
  for (const raw of list) {
    const text = String(raw).trim();
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(text);
    const family = m ? opsNet.isIP(m[1]) : 0;
    if (!family || (m[2] !== undefined && Number(m[2]) > (family === 4 ? 32 : 128))) throw new Error(`server.trusted_proxies : « ${text} » n’est ni une adresse IP ni un réseau CIDR (10.0.0.0/8)`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (m[2] === undefined) bl.addAddress(m[1], type); else bl.addSubnet(m[1], Number(m[2]), type);
  }
  return bl;
}

const opsDigest = s => crypto.createHash('sha256').update(String(s)).digest();

/*
 * Ce que le service applique, avec les variables d’environnement résolues. Il refuse de démarrer (ou de recharger)
 * plutôt que de laisser l’API ouverte : un jeton dont la variable est absente ne disparaît pas en silence.
 */
function opsRuntime(cfg) {
  const s = cfg.server;
  const tokens = []; const seen = new Map();
  const add = (name, secret, scopes, from) => {
    if (!secret) throw new Error(`${from} : la variable d’environnement est absente ou vide, le jeton « ${name} » n’aurait aucune valeur`);
    const digest = opsDigest(secret); const hex = digest.toString('hex');
    if (seen.has(hex)) throw new Error(`${from} a la même valeur que le jeton « ${seen.get(hex)} » : deux jetons ne peuvent pas être identiques`);
    seen.set(hex, name);
    tokens.push({ name, scopes: new Set(scopes), digest });
  };
  if (process.env.PASSERELLE_TOKEN) add(OPS_LEGACY_TOKEN, process.env.PASSERELLE_TOKEN, OPS_SCOPES, 'PASSERELLE_TOKEN');
  s.tokens.forEach((t, i) => add(t.name, expand(t.token), t.scopes, `server.tokens[${i}] (${t.name})`));

  let tracing = null;
  if (s.tracing.endpoint) {
    const endpoint = expand(s.tracing.endpoint);
    let u; try { u = new URL(endpoint); } catch (e) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`server.tracing.endpoint : « ${endpoint} » n’est pas une adresse http:// ou https:// (collecteur OTLP/HTTP, par exemple http://collecteur:4318/v1/traces)`);
    const headers = {};
    for (const [k, v] of Object.entries(s.tracing.headers)) if (!/^(content-type|content-length|host)$/i.test(k)) headers[k.toLowerCase()] = expand(v);
    tracing = { endpoint, headers, ratio: s.tracing.sample_ratio, service: s.tracing.service_name.trim() };
  }
  return {
    tokens, authRequired: tokens.length > 0,
    proxies: opsProxyList(s.trusted_proxies), identityHeader: s.identity_header.toLowerCase(),
    metrics: s.metrics, auditLog: expand(s.audit_log), tracing
  };
}

// Configuration montrée par check-config : les jetons y sont des références, jamais des valeurs
// Une valeur d’en-tête qui ne contient que des références ${VARIABLE} et, au plus, un mot de schéma (« Bearer ${JETON} »).
const opsHeaderRef = v => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v) && /^[A-Za-z]*\s*$/.test(String(v).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''));
function opsShown(server) {
  const c = clone(server);
  c.tokens = c.tokens.map(t => ({ name: t.name, token: ENV_REF.test(t.token) ? t.token : '(en clair, masqué)', scopes: t.scopes }));
  for (const k of Object.keys(c.tracing.headers)) if (!opsHeaderRef(c.tracing.headers[k])) c.tracing.headers[k] = '(en clair, masqué)';
  return c;
}

/* ---------- Adresse du client, identité, jeton ---------- */
const opsNormIp = addr => { const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(addr || '')); return m ? m[1] : String(addr || ''); };
function opsTrusted(rt, addr) {
  if (!rt.proxies) return false;
  const a = opsNormIp(addr); const family = opsNet.isIP(a);
  return family !== 0 && rt.proxies.check(a, family === 4 ? 'ipv4' : 'ipv6');
}
// Le client est le premier saut, en partant de la droite de X-Forwarded-For, qui n’est pas un proxy de confiance.
// L’en-tête n’est lu que si la connexion vient d’un proxy de confiance : n’importe qui peut en écrire un.
function opsClientIp(req, rt) {
  const peer = opsNormIp(req.socket.remoteAddress);
  if (!opsTrusted(rt, peer)) return peer;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => opsNormIp(x.trim())).filter(Boolean);
  if (!hops.length || hops.some(h => !opsNet.isIP(h))) return peer;
  for (let i = hops.length - 1; i >= 0; i--) if (!opsTrusted(rt, hops[i])) return hops[i];
  return hops[0];
}
function opsIdentity(req, rt, trusted) {
  if (!rt.identityHeader) return {};
  const raw = req.headers[rt.identityHeader];
  if (typeof raw !== 'string' || !raw.trim()) return {};
  if (!trusted) return { identityUntrusted: true };
  return { identity: raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) };
}
// Sans jeton configuré, l’API reste ouverte (aux seuls appels adressés à localhost : voir crossSiteRefusal)
function opsAuth(req, rt) {
  if (!rt.authRequired) return { ok: true, name: null, scopes: new Set(OPS_SCOPES) };
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return { ok: false, reason: 'absent' };
  const digest = opsDigest(m[1]);
  let found = null;
  // Tous les jetons sont comparés, sans sortie anticipée : la durée ne dit pas lequel a répondu
  for (const t of rt.tokens) if (crypto.timingSafeEqual(digest, t.digest) && !found) found = t;
  return found ? { ok: true, name: found.name, scopes: found.scopes } : { ok: false, reason: 'invalide' };
}
function opsScopeOf(pathname) {
  if (pathname === '/metrics') return 'metrics';
  if (pathname === '/v1/config' || /^\/v1\/(translate|inventory|schema)\//.test(pathname)) return 'translate';
  if (/^\/v1\/validate\//.test(pathname)) return 'validate';
  return null;
}

/* ---------- Cycle de vie d’une requête ---------- */
const OPS_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const OPS_ROUTES = new Set(['/', '/healthz', '/metrics', '/v1/config', '/v1/translate/dsl', '/v1/translate/logstash', '/v1/translate/logstash/pipelines', '/v1/translate/ingest', '/v1/translate/grafana', '/v1/inventory/kibana', '/v1/schema/ddl', '/v1/schema/analyzers', '/v1/validate/vector', '/v1/validate/sql']);
const OPS_METHODS = new Set(['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']);
const opsLive = { inflight: 0 };
const opsRouteOf = pathname => (pathname === '/index.html' ? '/' : OPS_ROUTES.has(pathname) ? pathname : 'autre');
// /v1/translate/dsl → translate.dsl ; ce qui n’est pas une route connue → autre
const opsActionOf = pathname => (pathname === '/metrics' ? 'metrics' : pathname === '/v1/config' ? 'config' : pathname.startsWith('/v1/') && OPS_ROUTES.has(pathname) ? pathname.slice(4).replace(/\//g, '.') : 'autre');

/*
 * L’identifiant de requête est toujours produit par le service, sauf quand un proxy de confiance en fournit un
 * (X-Request-Id) : c’est alors celui de son propre journal d’accès. Celui d’un autre client est gardé à part
 * (client_request_id) : il peut être choisi pour semer la confusion dans le journal.
 */
function opsBegin(req, res, rt) {
  const peer = opsNormIp(req.socket.remoteAddress);
  const trusted = opsTrusted(rt, peer);
  const supplied = req.headers['x-request-id'];
  const valid = typeof supplied === 'string' && OPS_ID.test(supplied);
  const rq = {
    rt, t0: process.hrtime.bigint(), method: req.method, path: String(req.url).split('?')[0].slice(0, 200),
    id: valid && trusted ? supplied : crypto.randomUUID(), clientRequestId: valid && !trusted ? supplied : null,
    peer, ip: opsClientIp(req, rt), route: 'autre', action: 'autre', token: null, refused: null, verdict: null, valid: null,
    bodyBytes: null, bodySha: null, done: false, span: null, traceId: null, sampled: false
  };
  Object.assign(rq, opsIdentity(req, rt, trusted));
  res.setHeader('x-request-id', rq.id);
  res.opsRq = rq;
  opsLive.inflight++;
  opsTraceBegin(rq, req, rt);
  return rq;
}
// Ce que la réponse dit de la requête, sans en garder le contenu : verdict d’une traduction, validité d’une validation
function opsNote(rq, obj) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.verdict === 'string') rq.verdict = obj.verdict;
  if (typeof obj.valid === 'boolean') rq.valid = obj.valid;
}
function opsBody(rq, body) {
  rq.bodyBytes = Buffer.byteLength(body);
  rq.bodySha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function opsEnd(rq, res) {
  if (rq.done) return;
  rq.done = true;
  opsLive.inflight--;
  const status = res.writableFinished ? res.statusCode : 499;   // 499 : le client est parti avant la réponse
  const elapsed = process.hrtime.bigint() - rq.t0;
  const ms = Number(elapsed / 1000000n);
  const route = rq.route || 'autre';
  const labels = { method: OPS_METHODS.has(rq.method) ? rq.method : 'autre', route, status };
  opsInc('passerelle_http_requests_total', labels);
  opsObserve('passerelle_http_request_duration_seconds', { route }, Number(elapsed) / 1e9);
  if (rq.token) opsInc('passerelle_token_requests_total', { token: rq.token });
  if (rq.refused) opsInc('passerelle_auth_failures_total', { reason: rq.refused });
  if (rq.verdict && /^(translate|inventory|schema)\./.test(rq.action)) opsInc('passerelle_translations_total', { action: rq.action, verdict: rq.verdict });
  // Un moteur injoignable ou trop lent est une erreur ; une requête refusée avant d’arriver à lui (SQL qui n’est pas un SELECT, table hors configuration) est « rejected »
  if (rq.action.startsWith('validate.') && !rq.refused) opsInc('passerelle_validations_total', { action: rq.action, result: rq.valid === true ? 'valid' : rq.valid === false ? 'invalid' : status >= 500 ? 'error' : 'rejected' });

  log('info', 'requête', Object.assign(
    { method: rq.method, path: rq.path, status, ms, ip: rq.ip },
    rq.peer !== rq.ip ? { peer: rq.peer } : {}, { request_id: rq.id },
    rq.token ? { token: rq.token } : {}, rq.identity ? { identity: rq.identity } : {}, rq.traceId ? { trace_id: rq.traceId } : {}
  ));

  // Journal d’audit : tout appel à l’API, refusé ou non ; les relevés de /metrics seulement quand ils sont refusés
  if (rq.path.startsWith('/v1/') || (rq.path === '/metrics' && rq.refused)) {
    const outcome = status === 499 ? 'aborted' : rq.refused ? 'refused' : status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'ok';
    opsAudit(Object.assign({ request_id: rq.id }, rq.clientRequestId ? { client_request_id: rq.clientRequestId } : {}, {
      method: rq.method, path: rq.path, action: rq.action, status, outcome, ms,
      token: rq.token, identity: rq.identity || null, client_ip: rq.ip
    }, rq.peer !== rq.ip ? { peer_ip: rq.peer } : {}, rq.identityUntrusted ? { identity_untrusted: true } : {},
    rq.refused ? { reason: rq.refused } : {}, rq.verdict ? { verdict: rq.verdict } : {}, rq.valid !== null ? { valid: rq.valid } : {},
    rq.bodyBytes !== null ? { body_bytes: rq.bodyBytes, body_sha256: rq.bodySha } : {}, rq.traceId ? { trace_id: rq.traceId } : {}));
  }

  if (rq.span) {
    opsSpanEnd(rq.span, status >= 500 ? 2 : 0, {
      'http.request.method': OPS_METHODS.has(rq.method) ? rq.method : '_OTHER', 'url.path': rq.path, 'http.route': rq.route || 'autre',
      'http.response.status_code': status, 'client.address': rq.ip, 'passerelle.request_id': rq.id,
      'passerelle.action': rq.action, 'passerelle.token': rq.token || undefined, 'enduser.id': rq.identity, 'passerelle.verdict': rq.verdict || undefined
    });
  }
}

/* ---------- Journal d’audit ---------- */
let opsAuditFd = null; let opsAuditFile = '';
// Ouvre (ou rouvre, après une rotation) le fichier d’audit : l’erreur remonte, le service ne démarre pas sans son audit
function opsAuditOpen(file) {
  const fd = file ? fs.openSync(file, 'a', 0o600) : null;
  if (opsAuditFd !== null) { try { fs.closeSync(opsAuditFd); } catch (e) { /* déjà fermé */ } }
  opsAuditFd = fd; opsAuditFile = file || '';
}
function opsAudit(entry) {
  opsInc('passerelle_audit_events_total');
  if (opsAuditFd === null) { log('info', 'audit', Object.assign({ audit: true }, entry)); return; }
  try { fs.writeSync(opsAuditFd, JSON.stringify(Object.assign({ ts: new Date().toISOString(), audit: true }, entry)) + '\n'); }
  catch (e) { opsInc('passerelle_audit_write_errors_total'); opsWarnOnce('audit', `écriture impossible dans le journal d’audit ${opsAuditFile} : ${e.code || e.message}`); }
}
const opsWarned = new Map();
function opsWarnOnce(key, msg) {
  const now = Date.now();
  if (now - (opsWarned.get(key) || 0) < 60000) return;
  opsWarned.set(key, now); log('warn', msg);
}

/* ---------- Métriques (format texte de Prometheus) ---------- */
const OPS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
// nom → [type, aide]. Les étiquettes ont toutes un ensemble de valeurs fermé (routes connues, statuts, verdicts, noms de jetons de la configuration).
const OPS_METRICS = {
  passerelle_build_info: ['gauge', 'Version de Passerelle et de Node.js (valeur 1).'],
  passerelle_http_requests_total: ['counter', 'Requêtes HTTP traitées, par méthode, route et statut.'],
  passerelle_http_request_duration_seconds: ['histogram', 'Durée de traitement des requêtes HTTP, par route.'],
  passerelle_http_requests_in_flight: ['gauge', 'Requêtes HTTP en cours.'],
  passerelle_token_requests_total: ['counter', 'Requêtes authentifiées, par nom de jeton.'],
  passerelle_auth_failures_total: ['counter', 'Requêtes refusées avant traitement, par raison (absent, invalide, portee, intersite).'],
  passerelle_translations_total: ['counter', 'Traductions rendues, par action et verdict (ready, review, todo, unrecognized).'],
  passerelle_validations_total: ['counter', 'Validations par un moteur réel, par action (validate.sql, validate.vector) et résultat (valid, invalid, rejected, error).'],
  passerelle_validation_jobs_running: ['gauge', 'Validations en cours (le service en accepte deux à la fois).'],
  passerelle_validation_rejected_total: ['counter', 'Validations refusées parce que deux étaient déjà en cours.'],
  passerelle_config_reloads_total: ['counter', 'Rechargements de la configuration (SIGHUP), par résultat.'],
  passerelle_audit_events_total: ['counter', 'Événements écrits dans le journal d’audit.'],
  passerelle_audit_write_errors_total: ['counter', 'Écritures du journal d’audit qui ont échoué.'],
  passerelle_trace_spans_exported_total: ['counter', 'Spans envoyés au collecteur OpenTelemetry.'],
  passerelle_trace_spans_dropped_total: ['counter', 'Spans perdus : file pleine ou export échoué.'],
  passerelle_trace_export_errors_total: ['counter', 'Envois au collecteur OpenTelemetry qui ont échoué.'],
  process_start_time_seconds: ['gauge', 'Démarrage du processus, en secondes depuis l’epoch Unix.'],
  process_resident_memory_bytes: ['gauge', 'Mémoire résidente du processus.'],
  process_cpu_seconds_total: ['counter', 'Temps processeur utilisateur et système du processus.']
};
// Séries calculées à chaque relevé
const OPS_LIVE = {
  passerelle_build_info: () => [[opsLabels({ version: VERSION, node: process.version }), 1]],
  passerelle_http_requests_in_flight: () => [['', opsLive.inflight]],
  passerelle_validation_jobs_running: () => [['', running]],
  process_start_time_seconds: () => [['', Math.round(Date.now() / 1000 - process.uptime())]],
  process_resident_memory_bytes: () => [['', process.memoryUsage().rss]],
  process_cpu_seconds_total: () => { const u = process.cpuUsage(); return [['', (u.user + u.system) / 1e6]]; }
};
const opsStore = new Map();
function opsLabels(labels) {
  return Object.keys(labels || {}).sort().map(n => `${n}="${String(labels[n]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');
}
function opsInc(name, labels, n) {
  let series = opsStore.get(name);
  if (!series) opsStore.set(name, series = new Map());
  const key = opsLabels(labels);
  series.set(key, (series.get(key) || 0) + (n === undefined ? 1 : n));
}
function opsObserve(name, labels, seconds) {
  let series = opsStore.get(name);
  if (!series) opsStore.set(name, series = new Map());
  const key = opsLabels(labels);
  let h = series.get(key);
  if (!h) series.set(key, h = { b: new Array(OPS_BUCKETS.length).fill(0), sum: 0, count: 0 });
  const i = OPS_BUCKETS.findIndex(le => seconds <= le);
  if (i >= 0) h.b[i]++;
  h.sum += seconds; h.count++;
}
// Les compteurs sans étiquette existent dès le démarrage, à zéro : rate() et les alertes n’attendent pas le premier événement
const OPS_PLAIN_COUNTERS = ['passerelle_validation_rejected_total', 'passerelle_audit_events_total', 'passerelle_audit_write_errors_total', 'passerelle_trace_spans_exported_total', 'passerelle_trace_spans_dropped_total', 'passerelle_trace_export_errors_total'];
function opsMetricsInit() {
  for (const name of OPS_PLAIN_COUNTERS) opsInc(name, {}, 0);
}
const opsNum = v => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12))));
function opsRender() {
  const out = [];
  const line = (name, labels, v) => out.push(`${name}${labels ? `{${labels}}` : ''} ${opsNum(v)}`);
  for (const [name, [type, help]] of Object.entries(OPS_METRICS)) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    if (OPS_LIVE[name]) { for (const [labels, v] of OPS_LIVE[name]()) line(name, labels, v); continue; }
    const series = [...(opsStore.get(name) || new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [labels, v] of series) {
      if (type !== 'histogram') { line(name, labels, v); continue; }
      let cumulative = 0;
      OPS_BUCKETS.forEach((le, i) => { cumulative += v.b[i]; line(`${name}_bucket`, `${labels}${labels ? ',' : ''}le="${le}"`, cumulative); });
      line(`${name}_bucket`, `${labels}${labels ? ',' : ''}le="+Inf"`, v.count);
      line(`${name}_sum`, labels, v.sum); line(`${name}_count`, labels, v.count);
    }
  }
  return out.join('\n') + '\n';
}

/* ---------- Traces OpenTelemetry (OTLP/HTTP, JSON) ---------- */
/*
 * Une requête = un span « serveur », et un span enfant pour chaque appel à ClickHouse et à Vector. Le contexte
 * W3C (traceparent) de l’appelant est repris ; il est aussi transmis à ClickHouse, qui le comprend. Aucun SQL, aucune
 * requête, aucun nom de fichier dans les attributs : seulement la route, le statut, les identifiants et les durées.
 */
const OPS_TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const OPS_QUEUE_MAX = 2048;
let opsTraceCfg = null; let opsTraceQueue = []; let opsTraceTimer = null; let opsTraceFlushing = null;
const opsRand = bytes => crypto.randomBytes(bytes).toString('hex');

function opsTraceBegin(rq, req, rt) {
  if (!rt.tracing) return;
  const m = OPS_TRACEPARENT.exec(String(req.headers.traceparent || '').trim().toLowerCase());
  const parent = m && !/^0+$/.test(m[1]) && !/^0+$/.test(m[2]) ? { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 } : null;
  rq.traceId = parent ? parent.traceId : opsRand(16);
  // La décision de l’appelant est respectée ; sans appelant, le taux d’échantillonnage de la configuration décide
  rq.sampled = parent ? parent.sampled : Math.random() < rt.tracing.ratio;
  if (rq.sampled) rq.span = opsSpanNew(rq, 'HTTP', 2, parent ? parent.spanId : '', {});
}
function opsSpanNew(rq, name, kind, parentId, attrs) {
  return { traceId: rq.traceId, spanId: opsRand(8), parentId: parentId || '', name, kind, startMs: Date.now(), t0: process.hrtime.bigint(), attrs: Object.assign({}, attrs), ended: false };
}
function opsAttrs(o) {
  const out = [];
  for (const [key, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    out.push({ key, value: typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v).slice(0, 500) } });
  }
  return out;
}
// code : 0 non défini, 2 erreur (le statut d’une requête mal formée n’est pas une erreur du service)
function opsSpanEnd(span, code, attrs) {
  if (!span || span.ended || !opsTraceCfg) return;
  span.ended = true;
  Object.assign(span.attrs, attrs || {});
  const start = BigInt(span.startMs) * 1000000n;
  if (span.name === 'HTTP') span.name = `${span.attrs['http.request.method']} ${span.attrs['http.route']}`;
  const json = {
    traceId: span.traceId, spanId: span.spanId, name: span.name, kind: span.kind,
    startTimeUnixNano: String(start), endTimeUnixNano: String(start + (process.hrtime.bigint() - span.t0)),
    attributes: opsAttrs(span.attrs), status: { code }
  };
  if (span.parentId) json.parentSpanId = span.parentId;
  if (opsTraceQueue.length >= OPS_QUEUE_MAX) { opsTraceQueue.shift(); opsInc('passerelle_trace_spans_dropped_total'); }
  opsTraceQueue.push(json);
  if (opsTraceQueue.length >= 64) opsTraceFlush();
}
async function opsWithSpan(name, kind, attrs, fn) {
  const rq = opsContext.getStore();
  if (!rq || !rq.span) return fn(null);
  const span = opsSpanNew(rq, name, kind, rq.span.spanId, attrs);
  try {
    const r = await fn(span);
    opsSpanEnd(span, 0);
    return r;
  } catch (e) {
    opsSpanEnd(span, 2, { 'error.type': e && e.status ? String(e.status) : (e && e.name) || 'erreur' });
    throw e;
  }
}
// En-tête traceparent à transmettre à un service appelé depuis le span donné
function opsTraceparent(span) {
  const rq = opsContext.getStore();
  if (!rq || !rq.traceId) return '';
  return `00-${rq.traceId}-${span ? span.spanId : rq.span ? rq.span.spanId : opsRand(8)}-${rq.sampled ? '01' : '00'}`;
}
function opsTraceConfigure(rt) {
  opsTraceCfg = rt.tracing;
  if (opsTraceTimer) { clearInterval(opsTraceTimer); opsTraceTimer = null; }
  if (!opsTraceCfg) { opsTraceQueue = []; return; }
  opsTraceTimer = setInterval(() => { opsTraceFlush(); }, 5000);
  opsTraceTimer.unref();
}
function opsTraceFlush() {
  if (!opsTraceCfg || !opsTraceQueue.length) return Promise.resolve();
  // Un envoi à la fois : ce qui arrive pendant ce temps part au suivant
  if (opsTraceFlushing) return opsTraceFlushing;
  const cfg = opsTraceCfg;
  const batch = opsTraceQueue.splice(0, 512);
  const body = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: opsAttrs({ 'service.name': cfg.service, 'service.version': VERSION }) },
      scopeSpans: [{ scope: { name: 'passerelle', version: VERSION }, spans: batch }]
    }]
  });
  const sent = (async () => {
    try {
      const r = await fetch(cfg.endpoint, { method: 'POST', headers: Object.assign({}, cfg.headers, { 'content-type': 'application/json' }), body, signal: AbortSignal.timeout(5000) });
      await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      opsInc('passerelle_trace_spans_exported_total', {}, batch.length);
    } catch (e) {
      opsInc('passerelle_trace_export_errors_total');
      opsInc('passerelle_trace_spans_dropped_total', {}, batch.length);
      opsWarnOnce('traces', `export des traces impossible vers ${cfg.endpoint.replace(/^(\w+:\/\/)[^/@]*@/, '$1')} : ${e.name === 'TimeoutError' ? 'délai dépassé' : (e.cause && (e.cause.code || e.cause.message)) || e.message}`);
    }
  })();
  opsTraceFlushing = sent;
  sent.then(() => { if (opsTraceFlushing === sent) opsTraceFlushing = null; });
  return sent;
}
// À l’arrêt : ce qui attend part, dans la limite de deux secondes
async function opsShutdown() {
  if (opsTraceFlushing) await Promise.race([opsTraceFlushing, new Promise(r => setTimeout(r, 2000))]);
  if (opsTraceQueue.length) await Promise.race([opsTraceFlush(), new Promise(r => setTimeout(r, 2000))]);
}
