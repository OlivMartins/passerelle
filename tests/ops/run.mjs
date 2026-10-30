#!/usr/bin/env node
/*
 * Tests de l'exploitation du service (src/node/ops.js) : le serveur est assemblé comme le fait scripts/build.mjs,
 * puis interrogé à travers une fausse instance ClickHouse et un faux collecteur OpenTelemetry.
 *   A  fonctions de l'exploitation, sans serveur (proxys de confiance, adresse du client, configuration)
 *   B  configuration refusée ou signalée au démarrage
 *   C  identifiant de requête
 *   D  jetons à portée
 *   E  identité transmise par le reverse proxy
 *   F  journal d'audit
 *   G  /metrics
 *   H  traces OpenTelemetry
 * Linux seulement.
 *   node tests/ops/run.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { engineSource, nodeSource, serverSource } from '../../scripts/engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'essai-ops-'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${String(detail).slice(0, 700)}`}\n`);
  if (!ok) failures++;
};
const J = JSON.stringify;
const section = name => process.stdout.write(`\n${name}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  return fn();
};

const BIN = join(TMP, 'passerelle.cjs');
writeFileSync(BIN, "'use strict';\n" + engineSource() + serverSource());
const UI = join(TMP, 'passerelle.html');
writeFileSync(UI, '<!doctype html><html><body><script>void 0;</script></body></html>');
const DSL = J({ size: 0, query: { term: { champ_secret_8841: 'valeur_secrete_5521' } } });

/* ---------- Faux ClickHouse (note les en-têtes reçus, répond après un délai réglable) ---------- */
const chSeen = [];
let chDelay = 0;
const fakeAST = sql => {
  const lines = ['SelectWithUnionQuery (children 1)'];
  for (const m of sql.matchAll(/\bFROM\s+([A-Za-z_][\w.]*)(\()?/g))
    lines.push(
      '   TableExpression (children 1)',
      m[2] ? `    Function ${m[1]} (children 1)` : `    TableIdentifier ${m[1]}`
    );
  return lines.join('\n') + '\n';
};
const ch = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => {
    body += d;
  });
  req.on('end', () => {
    chSeen.push({ headers: req.headers, body });
    setTimeout(() => {
      res.writeHead(200);
      res.end(/^EXPLAIN AST /.test(body) ? fakeAST(body) : 'Expression\n');
    }, chDelay);
  });
});
await new Promise(r => ch.listen(0, '127.0.0.1', r));
const CH_URL = `http://127.0.0.1:${ch.address().port}`;

/* ---------- Faux collecteur OTLP/HTTP ---------- */
const otlp = [];
let otlpStatus = 200;
const collector = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => {
    body += d;
  });
  req.on('end', () => {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch (e) {
      /* corps illisible : noté tel quel */
    }
    otlp.push({ method: req.method, url: req.url, headers: req.headers, json, raw: body });
    res.writeHead(otlpStatus, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise(r => collector.listen(0, '127.0.0.1', r));
const OTLP_URL = `http://127.0.0.1:${collector.address().port}/v1/traces`;
const spansOf = () =>
  otlp.flatMap(p => (p.json ? p.json.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)) : []));
const attr = (span, key) => {
  const a = (span.attributes || []).find(x => x.key === key);
  return a ? Object.values(a.value)[0] : undefined;
};

/* ---------- Serveurs lancés pour les tests ---------- */
const freePort = () =>
  new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const servers = [];
let nconf = 0;
function writeConfig(server, extra) {
  const file = join(TMP, `config-${++nconf}.json`);
  writeFileSync(
    file,
    J(Object.assign({ clickhouse: { endpoint: CH_URL } }, server === undefined ? {} : { server }, extra || {}))
  );
  return file;
}
async function start(server, env, extra) {
  const port = await freePort();
  const config = typeof server === 'string' ? server : writeConfig(server, extra);
  const p = spawn(process.execPath, [BIN, 'serve', '--listen', `127.0.0.1:${port}`], {
    env: Object.assign({ PATH: process.env.PATH, PASSERELLE_UI: UI, PASSERELLE_CONFIG: config }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  p.stdout.on('data', d => {
    out += d;
  });
  p.stderr.on('data', d => {
    err += d;
  });
  const jsonLines = text =>
    text
      .split('\n')
      .filter(l => l.startsWith('{'))
      .map(l => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  // logs() : sortie standard (info) ; alertes() : erreur standard (warn, error), comme le fait journald
  const srv = {
    port,
    proc: p,
    config,
    exited: null,
    logs: () => jsonLines(out),
    alertes: () => jsonLines(err),
    stderr: () => err,
    stdout: () => out
  };
  p.on('exit', code => {
    srv.exited = code;
  });
  servers.push(srv);
  for (let i = 0; i < 150; i++) {
    if (srv.exited !== null) throw new Error(`le serveur s'est arrêté au démarrage : ${err}`);
    try {
      await request(srv, 'GET', '/healthz');
      return srv;
    } catch (e) {
      await sleep(40);
    }
  }
  throw new Error('le serveur ne répond pas');
}
function request(srv, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: srv.port, method, path, headers: Object.assign({}, headers) },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', d => {
          text += d;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: text,
            json: () => {
              try {
                return JSON.parse(text);
              } catch (e) {
                return null;
              }
            }
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const bearer = t => ({ authorization: `Bearer ${t}` });
const stop = async srv => {
  if (srv.exited === null) {
    srv.proc.kill('SIGTERM');
    await until(() => srv.exited !== null, 5000);
  }
};
const cli = (args, env, config) =>
  spawnSync(process.execPath, [BIN, ...args], {
    env: Object.assign({ PATH: process.env.PATH }, config ? { PASSERELLE_CONFIG: config } : {}, env),
    encoding: 'utf8',
    timeout: 20000
  });
const auditFile = file =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];
// L'audit s'écrit à la fin de la réponse : un client rapide peut lire le fichier un instant avant
const auditWait = async (file, n) => {
  await until(() => auditFile(file).length >= n, 4000);
  return auditFile(file);
};
const metricsOf = text => {
  const m = new Map();
  for (const l of text.split('\n')) {
    if (!l || l.startsWith('#')) continue;
    const i = l.lastIndexOf(' ');
    m.set(l.slice(0, i), Number(l.slice(i + 1)));
  }
  return m;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ====================================================================== */
section('A. Fonctions de l’exploitation (sans serveur)');
{
  const code = `'use strict';\n${engineSource()}${nodeSource()}
const crypto = require('node:crypto'); const fs = require('node:fs'); const log = () => {}; const expand = s => String(s || '').replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (m, v) => process.env[v] || '');
const VERSION = '0.0.0'; let running = 0; const ENV_REF = /^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$/;
return { opsProxyList, opsTrusted, opsClientIp, opsNormIp, opsIdentity, opsCheckConfig, opsRuntime, opsScopeOf, opsActionOf, opsRouteOf, opsInc, opsObserve, opsRender, opsLabels, opsShown, DEFAULT_CONFIG, mergeConfig };`;
  const O = new Function('require', code)(createRequire(import.meta.url));
  const rt = list => ({ proxies: O.opsProxyList(list) });
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers: headers || {} });

  check(O.opsProxyList([]) === null, 'aucun proxy de confiance : liste vide');
  const t4 = rt(['127.0.0.1', '10.0.0.0/8', 'fd00::/8', '2001:db8::1']);
  check(
    ['127.0.0.1', '10.1.2.3', '::ffff:10.1.2.3', '::ffff:127.0.0.1', 'fd12::5', '2001:db8::1'].every(a =>
      O.opsTrusted(t4, a)
    ),
    'adresses de confiance : IPv4, IPv6, réseaux CIDR, IPv4 écrite en IPv6'
  );
  check(
    ['11.0.0.1', '::1', '192.168.1.1', '2001:db8::2', 'pas-une-adresse', '', undefined].every(
      a => !O.opsTrusted(t4, a)
    ),
    'adresses hors de la liste ou illisibles : sans confiance'
  );
  check(
    O.opsNormIp('::ffff:1.2.3.4') === '1.2.3.4' && O.opsNormIp('::1') === '::1',
    'une IPv4 écrite en IPv6 est ramenée à l’IPv4'
  );
  for (const bad of ['10.0.0.0/33', 'abc', '10.0.0.0/8/9', 'fd00::/129', '256.1.1.1']) {
    let msg = '';
    try {
      O.opsProxyList([bad]);
    } catch (e) {
      msg = e.message;
    }
    check(/n’est ni une adresse IP ni un réseau CIDR/.test(msg), `proxy « ${bad} » refusé`, msg);
  }

  const proxies = rt(['127.0.0.1', '10.0.0.0/8']);
  check(
    O.opsClientIp(req('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' }), proxies) === '203.0.113.7',
    'X-Forwarded-For d’un pair qui n’est pas de confiance : ignoré'
  );
  check(
    O.opsClientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), proxies) === '203.0.113.9',
    'pair de confiance : le client est le saut de X-Forwarded-For'
  );
  check(
    O.opsClientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 10.1.2.3' }), proxies) === '203.0.113.9',
    'plusieurs proxys : le premier saut qui n’est pas de confiance, en partant de la droite'
  );
  check(
    O.opsClientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.1.2.3' }), proxies) === '203.0.113.9',
    'un faux saut ajouté par le client, à gauche, ne compte pas'
  );
  check(
    O.opsClientIp(req('127.0.0.1', { 'x-forwarded-for': '10.1.1.1, 10.1.2.3' }), proxies) === '10.1.1.1',
    'tous les sauts de confiance : le premier'
  );
  check(
    O.opsClientIp(req('127.0.0.1', { 'x-forwarded-for': 'n’importe quoi, 1.1.1.1' }), proxies) === '127.0.0.1',
    'X-Forwarded-For illisible : l’adresse du pair'
  );
  check(O.opsClientIp(req('127.0.0.1', {}), proxies) === '127.0.0.1', 'sans X-Forwarded-For : l’adresse du pair');
  check(
    O.opsClientIp(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1' }), { proxies: null }) === '127.0.0.1',
    'sans proxy de confiance configuré : l’adresse du pair'
  );

  const idrt = { identityHeader: 'x-forwarded-user', proxies: O.opsProxyList(['127.0.0.1']) };
  check(
    J(O.opsIdentity(req('127.0.0.1', { 'x-forwarded-user': '  alice@example.org ' }), idrt, true)) ===
      '{"identity":"alice@example.org"}',
    'identité d’un proxy de confiance : reprise, espaces retirés'
  );
  check(
    J(O.opsIdentity(req('9.9.9.9', { 'x-forwarded-user': 'alice' }), idrt, false)) === '{"identityUntrusted":true}',
    'identité d’un pair sans confiance : ignorée, signalée'
  );
  check(
    O.opsIdentity(req('127.0.0.1', { 'x-forwarded-user': 'a'.repeat(500) }), idrt, true).identity.length === 200,
    'identité tronquée à 200 caractères'
  );
  check(
    J(O.opsIdentity(req('127.0.0.1', {}), idrt, true)) === '{}' &&
      J(O.opsIdentity(req('127.0.0.1', { 'x-forwarded-user': 'a' }), { identityHeader: '' }, true)) === '{}',
    'sans en-tête, ou sans en-tête configuré : pas d’identité'
  );

  check(
    O.opsScopeOf('/v1/translate/dsl') === 'translate' &&
      O.opsScopeOf('/v1/translate/logstash/pipelines') === 'translate' &&
      O.opsScopeOf('/v1/inventory/kibana') === 'translate' &&
      O.opsScopeOf('/v1/schema/ddl') === 'translate' &&
      O.opsScopeOf('/v1/config') === 'translate',
    'portée « translate » : traductions, inventaire, schéma, configuration'
  );
  check(
    O.opsScopeOf('/v1/validate/sql') === 'validate' &&
      O.opsScopeOf('/v1/validate/vector') === 'validate' &&
      O.opsScopeOf('/metrics') === 'metrics' &&
      O.opsScopeOf('/v1/inconnu') === null &&
      O.opsScopeOf('/') === null,
    'portées « validate » et « metrics » ; une route inconnue n’en a pas'
  );
  check(
    O.opsActionOf('/v1/translate/dsl') === 'translate.dsl' &&
      O.opsActionOf('/v1/validate/sql') === 'validate.sql' &&
      O.opsActionOf('/v1/translate/logstash/pipelines') === 'translate.logstash.pipelines' &&
      O.opsActionOf('/v1/n-importe/quoi') === 'autre' &&
      O.opsActionOf('/metrics') === 'metrics',
    'action d’une route : nom court, « autre » pour ce qui n’existe pas'
  );
  check(
    O.opsRouteOf('/v1/translate/dsl') === '/v1/translate/dsl' &&
      O.opsRouteOf('/index.html') === '/' &&
      O.opsRouteOf('/v1/../etc/passwd') === 'autre' &&
      O.opsRouteOf('/a/' + 'b'.repeat(500)) === 'autre',
    'étiquette de route : fermée, jamais le chemin demandé'
  );

  // Métriques : échappement, histogramme cumulatif
  check(
    O.opsLabels({ b: 'x"y\\z\nw', a: 1 }) === 'a="1",b="x\\"y\\\\z\\nw"',
    'étiquettes : triées, valeurs échappées (guillemet, barre oblique, saut de ligne)'
  );
  O.opsInc('passerelle_http_requests_total', { method: 'GET', route: '/x', status: 200 }, 2);
  for (const s of [0.004, 0.2, 0.2, 7, 500])
    O.opsObserve('passerelle_http_request_duration_seconds', { route: '/x' }, s);
  const m = metricsOf(O.opsRender());
  check(
    m.get('passerelle_http_requests_total{method="GET",route="/x",status="200"}') === 2,
    'compteur rendu avec ses étiquettes'
  );
  check(
    m.get('passerelle_http_request_duration_seconds_bucket{route="/x",le="0.005"}') === 1 &&
      m.get('passerelle_http_request_duration_seconds_bucket{route="/x",le="0.25"}') === 3 &&
      m.get('passerelle_http_request_duration_seconds_bucket{route="/x",le="10"}') === 4 &&
      m.get('passerelle_http_request_duration_seconds_bucket{route="/x",le="+Inf"}') === 5,
    'histogramme : seaux cumulatifs, +Inf compte tout (même 500 s, au-delà du dernier seau)'
  );
  check(
    m.get('passerelle_http_request_duration_seconds_count{route="/x"}') === 5 &&
      Math.abs(m.get('passerelle_http_request_duration_seconds_sum{route="/x"}') - 507.404) < 1e-9,
    'histogramme : somme et nombre'
  );

  // Configuration
  const base = () => JSON.parse(J(O.DEFAULT_CONFIG.server));
  const bad = (patch, re, label) => {
    const s = Object.assign(base(), patch);
    let msg = '';
    try {
      O.opsCheckConfig(s, 'x.yaml');
    } catch (e) {
      msg = e.message;
    }
    check(re.test(msg), `configuration refusée : ${label}`, msg || 'aucune erreur');
  };
  let ok = true;
  try {
    O.opsCheckConfig(base(), 'x');
  } catch (e) {
    ok = false;
  }
  check(ok, 'la configuration par défaut est valide');
  bad(
    { tokens: [{ name: 'a', token: '${A}', scopes: ['lire'] }] },
    /scopes attend une liste parmi translate, validate, metrics/,
    'portée inconnue'
  );
  bad({ tokens: [{ name: 'a', token: '${A}', scopes: [] }] }, /scopes attend une liste/, 'aucune portée');
  bad(
    { tokens: [{ name: 'a', token: '${A}', scopes: 'translate' }] },
    /scopes attend une liste/,
    'portée qui n’est pas une liste'
  );
  bad(
    { tokens: [{ name: 'a', token: '${A}', scopes: ['translate'], extra: 1 }] },
    /clé inconnue extra/,
    'clé inconnue dans un jeton'
  );
  bad(
    { tokens: [{ name: 'a b', token: '${A}', scopes: ['translate'] }] },
    /name attend un nom/,
    'nom de jeton avec une espace'
  );
  bad(
    {
      tokens: [
        { name: 'a', token: '${A}', scopes: ['translate'] },
        { name: 'a', token: '${B}', scopes: ['validate'] }
      ]
    },
    /« a » est déjà pris/,
    'deux jetons du même nom'
  );
  bad(
    { tokens: [{ name: 'principal', token: '${A}', scopes: ['translate'] }] },
    /nom de PASSERELLE_TOKEN/,
    'le nom réservé à PASSERELLE_TOKEN'
  );
  bad(
    { tokens: [{ name: 'a', token: '', scopes: ['translate'] }] },
    /token attend une référence à une variable d’environnement/,
    'jeton vide'
  );
  bad({ tokens: 'x' }, /server\.tokens attend une liste/, 'tokens qui n’est pas une liste');
  bad({ trusted_proxies: ['10.0.0.0/99'] }, /n’est ni une adresse IP ni un réseau CIDR/, 'réseau CIDR faux');
  bad(
    { identity_header: 'X Forwarded' },
    /identity_header attend un nom d’en-tête/,
    'en-tête d’identité avec une espace'
  );
  bad({ metrics: 'oui' }, /metrics attend true ou false/, 'metrics qui n’est pas un booléen');
  bad(
    { tracing: { endpoint: '', headers: {}, sample_ratio: 2, service_name: 'p' } },
    /sample_ratio attend un nombre de 0 à 1/,
    'taux d’échantillonnage hors de 0..1'
  );
  bad(
    { tracing: { endpoint: '', headers: { a: 1 }, sample_ratio: 1, service_name: 'p' } },
    /headers attend une table nom: valeur/,
    'en-têtes de collecteur qui ne sont pas des textes'
  );
  bad(
    { tracing: { endpoint: '', headers: {}, sample_ratio: 1, service_name: ' ' } },
    /service_name ne peut pas être vide/,
    'nom de service vide'
  );

  // Variables d'environnement : un jeton sans valeur n'est jamais un jeton absent
  const cfgWith = server => O.mergeConfig(O.DEFAULT_CONFIG, { server });
  const saved = { ...process.env };
  delete process.env.PASSERELLE_TOKEN;
  delete process.env.OPS_T1;
  process.env.OPS_T2 = 'deux';
  let msg = '';
  try {
    O.opsRuntime(cfgWith({ tokens: [{ name: 'un', token: '${OPS_T1}', scopes: ['translate'] }] }));
  } catch (e) {
    msg = e.message;
  }
  check(
    /server\.tokens\[0\] \(un\) : la variable d’environnement est absente ou vide/.test(msg),
    'jeton dont la variable est absente : refusé, pas ignoré',
    msg
  );
  msg = '';
  try {
    O.opsRuntime(
      cfgWith({
        tokens: [
          { name: 'un', token: '${OPS_T2}', scopes: ['translate'] },
          { name: 'deux', token: '${OPS_T2}', scopes: ['validate'] }
        ]
      })
    );
  } catch (e) {
    msg = e.message;
  }
  check(/a la même valeur que le jeton « un »/.test(msg), 'deux jetons de même valeur : refusés', msg);
  const none = O.opsRuntime(cfgWith({}));
  check(
    none.authRequired === false && none.tokens.length === 0 && none.metrics === true && none.tracing === null,
    'sans jeton : l’API reste ouverte (aux seuls appels adressés à localhost), traces coupées'
  );
  process.env.PASSERELLE_TOKEN = 'legacy-secret';
  const withLegacy = O.opsRuntime(cfgWith({ tokens: [{ name: 'un', token: '${OPS_T2}', scopes: ['metrics'] }] }));
  check(
    withLegacy.authRequired &&
      withLegacy.tokens.map(t => t.name).join() === 'principal,un' &&
      withLegacy.tokens[0].scopes.size === 3 &&
      withLegacy.tokens[1].scopes.size === 1,
    'PASSERELLE_TOKEN reste un jeton de toutes les portées, nommé « principal »'
  );
  const shown = O.opsShown(
    cfgWith({
      tokens: [
        { name: 'un', token: 'en-clair-secret', scopes: ['metrics'] },
        { name: 'deux', token: '${OPS_T2}', scopes: ['metrics'] }
      ],
      tracing: {
        endpoint: 'http://c',
        headers: { authorization: 'Bearer secret-otel' },
        sample_ratio: 1,
        service_name: 'p'
      }
    }).server
  );
  check(
    !J(shown).includes('en-clair-secret') && !J(shown).includes('secret-otel') && J(shown).includes('${OPS_T2}'),
    'check-config : un jeton en clair est masqué, une référence est montrée'
  );
  Object.keys(process.env).forEach(k => {
    if (!(k in saved)) delete process.env[k];
  });
  Object.assign(process.env, saved);
}

/* ====================================================================== */
section('B. Configuration refusée ou signalée au démarrage');
{
  const env = { OPS_T_A: 'secret-a', OPS_T_B: 'secret-b' };
  const serveFails = (server, e, re, label) => {
    const r = cli(['serve', '--listen', '127.0.0.1:0'], Object.assign({ PASSERELLE_UI: UI }, e), writeConfig(server));
    check(r.status === 1 && re.test(r.stderr), label, `${r.status} ${r.stderr}`);
  };
  serveFails(
    { tokens: [{ name: 'a', token: '${OPS_ABSENT}', scopes: ['translate'] }] },
    env,
    /server\.tokens\[0\] \(a\).*absente ou vide/,
    'serve : un jeton dont la variable est absente empêche le démarrage (l’API ne reste pas ouverte)'
  );
  serveFails(
    {
      tokens: [
        { name: 'a', token: '${OPS_T_A}', scopes: ['translate'] },
        { name: 'b', token: '${OPS_T_A}', scopes: ['validate'] }
      ]
    },
    env,
    /même valeur/,
    'serve : deux jetons identiques empêchent le démarrage'
  );
  serveFails(
    { tokens: [{ name: 'a', token: '${OPS_T_A}', scopes: ['translate'] }] },
    Object.assign({ PASSERELLE_TOKEN: 'secret-a' }, env),
    /même valeur que le jeton « principal »/,
    'serve : un jeton identique à PASSERELLE_TOKEN empêche le démarrage'
  );
  serveFails(
    { audit_log: join(TMP, 'absent', 'audit.jsonl') },
    env,
    /server\.audit_log : .*ne s’ouvre pas en écriture.*sans son journal d’audit/,
    'serve : un journal d’audit inaccessible empêche le démarrage'
  );
  serveFails(
    { tracing: { endpoint: 'ftp://collecteur', headers: {}, sample_ratio: 1, service_name: 'p' } },
    env,
    /n’est pas une adresse http:\/\/ ou https:\/\//,
    'serve : un collecteur qui n’est pas en http(s) est refusé'
  );

  const check1 = (server, re, label) => {
    const r = cli(['check-config'], env, writeConfig(server));
    check(r.status === 1 && re.test(r.stderr), label, `${r.status} ${r.stderr}`);
  };
  check1(
    { tokens: [{ name: 'a', token: '${X}', scopes: ['tout'] }] },
    /scopes attend une liste/,
    'check-config : portée inconnue refusée'
  );
  check1(
    { trusted_proxies: ['10.0.0.0/40'] },
    /ni une adresse IP ni un réseau CIDR/,
    'check-config : CIDR faux refusé'
  );
  check1(
    { tokens: [{ name: 'a', token: '${X}', scopes: ['metrics'], secret: 'x' }] },
    /clé inconnue secret/,
    'check-config : clé inconnue dans un jeton refusée'
  );
  const unknownKey = cli(['check-config'], env, writeConfig({ metriques: true }));
  check(
    unknownKey.status === 1 && /clé inconnue dans .*: server\.metriques/.test(unknownKey.stderr),
    'check-config : clé inconnue de la section server refusée',
    unknownKey.stderr
  );

  // YAML : liste de jetons en blocs, proxys en liste, jeton en clair masqué et signalé
  const yml = join(TMP, 'server.yaml');
  writeFileSync(
    yml,
    `clickhouse:
  endpoint: ${CH_URL}
server:
  tokens:
    - name: ci
      token: '\${OPS_T_A}'
      scopes: [translate, validate]
    - name: prometheus
      token: 'jeton-prometheus-en-clair'
      scopes:
        - metrics
  trusted_proxies: [127.0.0.1, 10.0.0.0/8]
  identity_header: X-Forwarded-User
  tracing:
    endpoint: http://collecteur:4318/v1/traces
    headers:
      authorization: 'Bearer \${OTEL_TOKEN}'
`
  );
  const r = cli(['check-config'], env, yml);
  check(
    r.status === 0 &&
      /name: ci/.test(r.stdout) &&
      /name: prometheus/.test(r.stdout) &&
      /scopes: \[translate, validate\]/.test(r.stdout) &&
      /trusted_proxies: \['127\.0\.0\.1', '10\.0\.0\.0\/8'\]/.test(r.stdout),
    'check-config : la section server en YAML (liste de blocs, proxys) est lue et affichée',
    r.stdout + r.stderr
  );
  check(
    !r.stdout.includes('jeton-prometheus-en-clair') && /\(en clair, masqué\)/.test(r.stdout),
    'check-config : un jeton écrit en clair n’est jamais affiché'
  );
  check(
    /server\.tokens\[1\] \(prometheus\) : le jeton est écrit en clair/.test(r.stderr),
    'check-config : un jeton écrit en clair est signalé'
  );
  check(
    /OTEL_TOKEN/.test(r.stdout) && !/server\.tracing\.headers\.authorization est écrit en clair/.test(r.stderr),
    'check-config : un en-tête de collecteur qui cite une variable n’est pas signalé'
  );
  const w = cli(['check-config'], env, writeConfig({ identity_header: 'X-Forwarded-User' }));
  check(
    w.status === 0 && /server\.identity_header est renseigné sans server\.trusted_proxies/.test(w.stderr),
    'check-config : une identité sans proxy de confiance est signalée'
  );
  const missing = cli(['check-config'], {}, join(TMP, 'server.yaml'));
  check(
    missing.status === 0 &&
      /attention : server\.tokens\[0\] \(ci\) : la variable d’environnement est absente ou vide/.test(missing.stderr),
    'check-config : une variable de jeton absente est signalée (sans bloquer un contrôle en intégration continue)',
    missing.stderr
  );
}

/* ====================================================================== */
section('C. Identifiant de requête');
{
  const open = await start({});
  let r = await request(open, 'GET', '/healthz');
  const id1 = r.headers['x-request-id'];
  check(UUID.test(id1), 'chaque réponse porte un X-Request-Id (UUID)', id1);
  r = await request(open, 'GET', '/healthz');
  check(r.headers['x-request-id'] !== id1, 'un identifiant par requête');
  for (const [m, p, status] of [
    ['GET', '/inconnu', 404],
    ['GET', '/v1/translate/dsl', 405],
    ['POST', '/v1/translate/dsl', 200],
    ['POST', '/v1/translate/dsl', 400],
    ['GET', '/', 200]
  ]) {
    r = await request(open, m, p, {
      body: p === '/v1/translate/dsl' && m === 'POST' ? (status === 200 ? DSL : '') : undefined
    });
    check(
      r.status === status && UUID.test(r.headers['x-request-id'] || ''),
      `${m} ${p} (${status}) : l’identifiant est dans la réponse`,
      `${r.status} ${r.headers['x-request-id']}`
    );
  }
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { host: 'attaquant.example' } });
  check(r.status === 403 && UUID.test(r.headers['x-request-id']), 'un refus (403) porte aussi son identifiant');

  // Identifiant fourni par un client sans confiance : jamais adopté, gardé à part
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { 'x-request-id': 'correlation-12345' } });
  const rid = r.headers['x-request-id'];
  check(rid !== 'correlation-12345' && UUID.test(rid), 'X-Request-Id d’un client sans confiance : non adopté');
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { 'x-request-id': 'pas valide !' } });
  const rid2 = r.headers['x-request-id'];
  await sleep(100);
  const logs = open.logs();
  const reqLog = logs.find(l => l.msg === 'requête' && l.request_id === rid);
  const audit = logs.find(l => l.msg === 'audit' && l.request_id === rid);
  check(
    reqLog && reqLog.status === 200 && reqLog.path === '/v1/translate/dsl' && reqLog.ip === '127.0.0.1',
    'la ligne « requête » du journal porte request_id',
    J(reqLog)
  );
  check(
    audit && audit.client_request_id === 'correlation-12345' && audit.audit === true,
    'l’audit garde l’identifiant du client à part (client_request_id)',
    J(audit)
  );
  check(!logs.some(l => l.request_id === rid2 && l.client_request_id), 'un identifiant mal formé est écarté');
  check(
    r.headers['x-request-id'] === rid2 && logs.some(l => l.msg === 'requête' && l.request_id === rid2),
    'l’identifiant de la réponse est celui du journal'
  );
  await stop(open);
}

/* ====================================================================== */
section('D. Jetons à portée');
const TOK = { ci: 'jeton-ci-7f3a91', ops: 'jeton-ops-c20b44', prom: 'jeton-prom-91de08', admin: 'jeton-admin-5a6f2c' };
const tokenServer = {
  tokens: [
    { name: 'ci-lecture', token: '${OPS_TOK_CI}', scopes: ['translate'] },
    { name: 'validation', token: '${OPS_TOK_OPS}', scopes: ['validate'] },
    { name: 'prometheus', token: '${OPS_TOK_PROM}', scopes: ['metrics'] }
  ]
};
const tokenEnv = { OPS_TOK_CI: TOK.ci, OPS_TOK_OPS: TOK.ops, OPS_TOK_PROM: TOK.prom };
const AUDIT_D = join(TMP, 'audit-d.jsonl');
const sqlBody = 'SELECT count() FROM logs.events';
let dsrv;
{
  dsrv = await start(
    Object.assign({ audit_log: AUDIT_D }, tokenServer),
    Object.assign({ PASSERELLE_TOKEN: TOK.admin }, tokenEnv)
  );
  const call = (token, method, path, body) =>
    request(dsrv, method, path, { body, headers: token ? bearer(token) : {} });
  const t = (m, p, b) => [m, p, b];
  const matrix = [
    // [libellé, jeton, requête, statut attendu]
    ['sans jeton', null, t('POST', '/v1/translate/dsl', DSL), 401],
    ['jeton inconnu', 'faux', t('POST', '/v1/translate/dsl', DSL), 401],
    ['translate sur une route translate', TOK.ci, t('POST', '/v1/translate/dsl', DSL), 200],
    ['translate sur la configuration', TOK.ci, t('GET', '/v1/config'), 200],
    ['translate sur une validation', TOK.ci, t('POST', '/v1/validate/sql', sqlBody), 403],
    ['translate sur /metrics', TOK.ci, t('GET', '/metrics'), 403],
    ['validate sur une validation', TOK.ops, t('POST', '/v1/validate/sql', sqlBody), 200],
    ['validate sur une traduction', TOK.ops, t('POST', '/v1/translate/dsl', DSL), 403],
    ['validate sur la configuration', TOK.ops, t('GET', '/v1/config'), 403],
    ['metrics sur /metrics', TOK.prom, t('GET', '/metrics'), 200],
    ['metrics sur une traduction', TOK.prom, t('POST', '/v1/translate/dsl', DSL), 403],
    ['metrics sur une validation', TOK.prom, t('POST', '/v1/validate/sql', sqlBody), 403],
    ['PASSERELLE_TOKEN sur une traduction', TOK.admin, t('POST', '/v1/translate/dsl', DSL), 200],
    ['PASSERELLE_TOKEN sur une validation', TOK.admin, t('POST', '/v1/validate/sql', sqlBody), 200],
    ['PASSERELLE_TOKEN sur /metrics', TOK.admin, t('GET', '/metrics'), 200],
    ['méthode inconnue avec la bonne portée', TOK.ci, t('GET', '/v1/translate/dsl'), 405],
    ['route inconnue avec un jeton valide', TOK.ci, t('POST', '/v1/inconnue', 'x'), 404],
    ['route inconnue sans jeton', null, t('POST', '/v1/inconnue', 'x'), 401]
  ];
  for (const [label, token, [m, p, b], status] of matrix) {
    const r = await call(token, m, p, b);
    check(r.status === status, `${label} : ${status}`, `${r.status} ${r.body.slice(0, 120)}`);
  }
  const forbidden = await call(TOK.ci, 'POST', '/v1/validate/sql', sqlBody);
  check(
    /ce jeton n’a pas la portée « validate »/.test(forbidden.json().error) && !forbidden.body.includes(TOK.ci),
    'le refus dit la portée qui manque, sans répéter le jeton'
  );
  const unauth = await call('faux', 'POST', '/v1/translate/dsl', DSL);
  check(
    unauth.json().error === 'jeton absent ou invalide (Authorization: Bearer …)',
    'le message d’un jeton invalide est inchangé'
  );
  let r = await request(dsrv, 'POST', '/v1/translate/dsl', {
    body: DSL,
    headers: { authorization: `Bearer ${TOK.ci}`, 'sec-fetch-site': 'cross-site' }
  });
  check(r.status === 403 && /intersite/.test(r.body), 'une requête intersite reste refusée même avec un bon jeton');
  r = await request(dsrv, 'POST', '/v1/translate/dsl', { body: DSL, headers: { authorization: `bearer ${TOK.ci}` } });
  check(r.status === 200, 'le schéma Bearer ne dépend pas de la casse');
  r = await request(dsrv, 'POST', '/v1/translate/dsl', { body: DSL, headers: { authorization: `Basic ${TOK.ci}` } });
  check(r.status === 401, 'un autre schéma d’autorisation est refusé');

  // Ce qui est servi sans authentification ne dit rien des jetons
  r = await request(dsrv, 'GET', '/');
  const everything =
    r.body + (await call(TOK.ci, 'GET', '/v1/config')).body + (await request(dsrv, 'GET', '/healthz')).body;
  check(
    !/ci-lecture|validation|prometheus|trusted_proxies|audit_log|jeton-/.test(everything.replace(/validation/g, '')),
    'ni la page, ni /v1/config, ni /healthz ne citent un jeton, un nom de jeton ou la section server',
    everything.slice(0, 300)
  );
  check(!('server' in (await call(TOK.ci, 'GET', '/v1/config')).json()), '/v1/config n’a pas de section server');
  r = await request(dsrv, 'GET', '/healthz');
  check(r.status === 200, '/healthz reste ouvert aux sondes sans jeton');
  const started = dsrv.logs().find(l => l.msg === 'exploitation');
  check(
    started &&
      J(started.jetons) === '["principal","ci-lecture","validation","prometheus"]' &&
      started.metrics === true &&
      !J(started).includes('jeton-'),
    'le démarrage liste les noms de jetons (jamais les valeurs)',
    J(started)
  );
}

/* ====================================================================== */
section('E. Identité transmise par le reverse proxy');
{
  const AUDIT_E = join(TMP, 'audit-e.jsonl');
  const trusted = await start({
    audit_log: AUDIT_E,
    trusted_proxies: ['127.0.0.1', '10.0.0.0/8'],
    identity_header: 'X-Forwarded-User'
  });
  const hdr = {
    'x-forwarded-user': 'alice@example.org',
    'x-forwarded-for': '203.0.113.9, 10.1.2.3',
    'x-request-id': 'proxy-req-0001'
  };
  let r = await request(trusted, 'POST', '/v1/translate/dsl', { body: DSL, headers: hdr });
  check(
    r.status === 200 && r.headers['x-request-id'] === 'proxy-req-0001',
    'proxy de confiance : son X-Request-Id est adopté'
  );
  r = await request(trusted, 'POST', '/v1/translate/dsl', {
    body: DSL,
    headers: Object.assign({}, hdr, { 'x-forwarded-user': 'b'.repeat(300), 'x-request-id': 'pas valide' })
  });
  r = await request(trusted, 'POST', '/v1/translate/dsl', { body: DSL });
  let a = await auditWait(AUDIT_E, 3);
  check(
    a[0] &&
      a[0].identity === 'alice@example.org' &&
      a[0].client_ip === '203.0.113.9' &&
      a[0].peer_ip === '127.0.0.1' &&
      a[0].request_id === 'proxy-req-0001' &&
      !('identity_untrusted' in a[0]),
    'audit : identité, adresse du client (X-Forwarded-For), adresse du pair',
    J(a[0])
  );
  check(
    a[1] && a[1].identity.length === 200 && /^b+$/.test(a[1].identity) && UUID.test(a[1].request_id),
    'identité tronquée à 200 caractères ; un X-Request-Id mal formé est écarté même d’un proxy',
    J(a[1])
  );
  check(
    a[2] && a[2].identity === null && a[2].client_ip === '127.0.0.1' && !('peer_ip' in a[2]),
    'sans en-tête : pas d’identité, adresse du pair',
    J(a[2])
  );
  const line = trusted.logs().find(l => l.msg === 'requête' && l.request_id === 'proxy-req-0001');
  check(
    line && line.identity === 'alice@example.org' && line.ip === '203.0.113.9' && line.peer === '127.0.0.1',
    'la ligne « requête » porte l’identité et l’adresse du client',
    J(line)
  );
  await stop(trusted);

  const AUDIT_E2 = join(TMP, 'audit-e2.jsonl');
  const untrusted = await start({
    audit_log: AUDIT_E2,
    trusted_proxies: ['10.0.0.0/8'],
    identity_header: 'X-Forwarded-User'
  });
  r = await request(untrusted, 'POST', '/v1/translate/dsl', { body: DSL, headers: hdr });
  a = await auditWait(AUDIT_E2, 1);
  check(
    r.status === 200 &&
      r.headers['x-request-id'] !== 'proxy-req-0001' &&
      a[0] &&
      a[0].identity === null &&
      a[0].identity_untrusted === true &&
      a[0].client_ip === '127.0.0.1' &&
      a[0].client_request_id === 'proxy-req-0001',
    'pair sans confiance : identité ignorée mais signalée, X-Forwarded-For ignoré, X-Request-Id gardé à part',
    J(a[0])
  );
  await stop(untrusted);
}

/* ====================================================================== */
section('F. Journal d’audit');
{
  const a = auditFile(AUDIT_D);
  check(
    a.length > 0 &&
      a.every(
        e =>
          e.audit === true &&
          !isNaN(Date.parse(e.ts)) &&
          UUID.test(e.request_id) &&
          typeof e.status === 'number' &&
          typeof e.ms === 'number' &&
          e.action &&
          e.outcome
      ),
    `le journal est un fichier de lignes JSON complètes (${a.length} lignes)`
  );
  check((statSync(AUDIT_D).mode & 0o777) === 0o600, 'le fichier d’audit est créé en 0600');
  const first = a.find(e => e.token === 'ci-lecture' && e.action === 'translate.dsl' && e.status === 200);
  check(
    first &&
      first.outcome === 'ok' &&
      first.verdict &&
      first.method === 'POST' &&
      first.path === '/v1/translate/dsl' &&
      first.body_bytes === Buffer.byteLength(DSL) &&
      first.body_sha256 === crypto.createHash('sha256').update(DSL).digest('hex').slice(0, 16),
    'audit d’une traduction : jeton, action, verdict, taille et empreinte du corps',
    J(first)
  );
  check(
    !readFileSync(AUDIT_D, 'utf8').includes('champ_secret_8841') &&
      !readFileSync(AUDIT_D, 'utf8').includes('valeur_secrete_5521') &&
      !/jeton-(ci|ops|prom|admin)-/.test(readFileSync(AUDIT_D, 'utf8')),
    'le journal ne contient ni la requête, ni un jeton'
  );
  const refused = a.find(e => e.reason === 'absent');
  check(
    refused &&
      refused.outcome === 'refused' &&
      refused.status === 401 &&
      refused.token === null &&
      !('body_sha256' in refused),
    'un appel sans jeton est audité : refusé, raison « absent », sans corps lu',
    J(refused)
  );
  check(
    a.some(e => e.reason === 'invalide' && e.status === 401) &&
      a.some(e => e.reason === 'portee' && e.status === 403 && e.token === 'ci-lecture') &&
      a.some(e => e.reason === 'intersite'),
    'refus audités : jeton invalide, portée manquante, requête intersite'
  );
  const valid = a.find(e => e.action === 'validate.sql' && e.status === 200);
  check(
    valid && valid.token === 'validation' && valid.valid === true,
    'audit d’une validation : le résultat (valid)',
    J(valid)
  );
  check(
    a.some(e => e.status === 405 && e.outcome === 'rejected') &&
      a.some(e => e.status === 404 && e.action === 'autre' && e.outcome === 'rejected'),
    'méthode ou route inconnue : « rejected », action « autre »'
  );
  check(
    !a.some(e => e.path === '/healthz' || e.path === '/' || (e.path === '/metrics' && e.status === 200)),
    'ni /healthz, ni la page, ni un relevé de /metrics réussi ne sont audités'
  );
  check(
    a.some(e => e.path === '/metrics' && e.status === 403),
    'un relevé de /metrics refusé est audité'
  );
  check(
    a.every(e => e.client_ip === '127.0.0.1' && !('peer_ip' in e)),
    'sans proxy : l’adresse du client est celle du pair'
  );

  // La chaîne de requête (param_*, text=…) peut porter des données : elle n'entre ni dans l'audit ni dans le journal
  const q = await request(dsrv, 'POST', '/v1/validate/sql?contexte=valeur_confidentielle_77&param_x=autre_valeur_88', {
    body: sqlBody,
    headers: bearer(TOK.ops)
  });
  const withQuery = (await auditWait(AUDIT_D, a.length + 1))
    .filter(e => e.path === '/v1/validate/sql' && e.status === q.status)
    .pop();
  await sleep(100);
  check(
    withQuery &&
      !readFileSync(AUDIT_D, 'utf8').includes('valeur_confidentielle_77') &&
      !readFileSync(AUDIT_D, 'utf8').includes('autre_valeur_88') &&
      ![...dsrv.logs(), ...dsrv.alertes()].some(l => J(l).includes('valeur_confidentielle_77')),
    'la chaîne de requête n’est ni dans l’audit ni dans le journal : le chemin seul',
    J(withQuery)
  );

  // Rotation : le fichier déplacé, SIGHUP, et le journal reprend dans un fichier neuf
  const before = auditFile(AUDIT_D).length;
  renameSync(AUDIT_D, `${AUDIT_D}.1`);
  await request(dsrv, 'POST', '/v1/translate/dsl', { body: DSL, headers: bearer(TOK.ci) });
  await auditWait(`${AUDIT_D}.1`, before + 1);
  check(
    auditFile(AUDIT_D).length === 0 && auditFile(`${AUDIT_D}.1`).length === before + 1,
    'avant SIGHUP, l’écriture suit le fichier déplacé (comme tout programme qui garde son fichier ouvert)'
  );
  dsrv.proc.kill('SIGHUP');
  await until(() => dsrv.logs().some(l => l.msg === 'configuration rechargée'));
  await request(dsrv, 'POST', '/v1/translate/dsl', { body: DSL, headers: bearer(TOK.ci) });
  await auditWait(AUDIT_D, 1);
  check(
    auditFile(AUDIT_D).length === 1 && auditFile(AUDIT_D)[0].token === 'ci-lecture',
    'après SIGHUP, le journal est rouvert : la rotation est prise en compte'
  );

  // Un rechargement refusé ne change rien
  const good = readFileSync(dsrv.config, 'utf8');
  writeFileSync(dsrv.config, good.replace('"translate"', '"nimporte"'));
  dsrv.proc.kill('SIGHUP');
  await until(() => dsrv.logs().some(l => l.msg === 'rechargement refusé, configuration précédente conservée'));
  let r = await request(dsrv, 'POST', '/v1/translate/dsl', { body: DSL, headers: bearer(TOK.ci) });
  check(
    r.status === 200,
    'configuration invalide au rechargement : refusée, la précédente (et ses jetons) reste en place'
  );
  writeFileSync(dsrv.config, good);

  // Sans fichier, l'audit passe par le journal du service
  const stdoutMode = await start(tokenServer, tokenEnv);
  await request(stdoutMode, 'POST', '/v1/translate/dsl', { body: DSL, headers: bearer(TOK.ci) });
  await sleep(100);
  const line = stdoutMode.logs().find(l => l.msg === 'audit');
  check(
    line && line.audit === true && line.token === 'ci-lecture' && line.level === 'info' && line.body_sha256,
    'sans server.audit_log, l’audit est écrit dans le journal du service (msg « audit »)',
    J(line)
  );
  await stop(stdoutMode);

  // Un client qui part avant la réponse est audité aussi
  const slow = await start({ audit_log: join(TMP, 'audit-f3.jsonl') });
  chDelay = 600;
  await new Promise(resolve => {
    const rq = http.request({ host: '127.0.0.1', port: slow.port, method: 'POST', path: '/v1/validate/sql' }, () => {});
    rq.on('error', () => resolve());
    rq.write(sqlBody);
    rq.end();
    setTimeout(() => {
      rq.destroy();
      resolve();
    }, 150);
  });
  const aborted = await until(() => auditFile(join(TMP, 'audit-f3.jsonl')).find(e => e.outcome === 'aborted'), 4000);
  chDelay = 0;
  check(
    aborted && aborted.status === 499 && aborted.action === 'validate.sql',
    'un client parti avant la réponse : audité « aborted » (499)',
    J(aborted)
  );
  await stop(slow);
}

/* ====================================================================== */
section('G. /metrics');
{
  const call = (token, method, path, body) =>
    request(dsrv, method, path, { body, headers: token ? bearer(token) : {} });
  // Une série de requêtes connue, puis un relevé
  const before = metricsOf((await call(TOK.prom, 'GET', '/metrics')).body);
  const count = (m, k) => m.get(k) || 0;
  await call(TOK.ci, 'POST', '/v1/translate/dsl', DSL);
  await call(TOK.ci, 'POST', '/v1/translate/dsl', J({ size: 0, query: { match_all: {} } }));
  await call(TOK.ci, 'POST', '/v1/translate/dsl', '{ pas du json');
  await call(TOK.ci, 'POST', '/v1/translate/logstash', 'input { stdin {} }\noutput { stdout {} }');
  await call(TOK.ops, 'POST', '/v1/validate/sql', sqlBody);
  await call(TOK.ops, 'POST', '/v1/validate/sql', 'DROP TABLE logs.events');
  await call(TOK.ops, 'POST', '/v1/translate/dsl', DSL);
  await call('faux', 'POST', '/v1/translate/dsl', DSL);
  await call(null, 'POST', '/v1/translate/dsl', DSL);
  for (let i = 0; i < 25; i++) await request(dsrv, 'GET', `/chemin-${i}-${'x'.repeat(i)}`);
  const res = await call(TOK.prom, 'GET', '/metrics');
  const m = metricsOf(res.body);
  const d = k => count(m, k) - count(before, k);
  check(
    res.status === 200 && /^text\/plain; version=0\.0\.4; charset=utf-8$/.test(res.headers['content-type']),
    '/metrics : texte Prometheus 0.0.4',
    res.headers['content-type']
  );
  check(
    d('passerelle_http_requests_total{method="POST",route="/v1/translate/dsl",status="200"}') === 2 &&
      d('passerelle_http_requests_total{method="POST",route="/v1/translate/dsl",status="422"}') +
        d('passerelle_http_requests_total{method="POST",route="/v1/translate/dsl",status="400"}') ===
        1,
    'requêtes par méthode, route et statut',
    [...m.keys()].filter(k => k.startsWith('passerelle_http_requests_total')).join('\n')
  );
  check(
    d('passerelle_http_requests_total{method="GET",route="autre",status="404"}') === 25,
    '25 chemins différents inconnus : une seule série « autre » (aucune étiquette ne vient du client)'
  );
  check(
    [...m.keys()].filter(k => k.startsWith('passerelle_http_requests_total{')).length < 20,
    'le nombre de séries reste borné',
    [...m.keys()].filter(k => k.startsWith('passerelle_http_requests_total{')).length
  );
  check(
    ![...m.keys()].some(k => k.includes('chemin-') || k.includes('xxxx')),
    'aucune série ne cite un chemin demandé'
  );
  check(
    d('passerelle_auth_failures_total{reason="absent"}') === 1 &&
      d('passerelle_auth_failures_total{reason="invalide"}') === 1 &&
      d('passerelle_auth_failures_total{reason="portee"}') === 1,
    'refus par raison : absent, invalide, portée'
  );
  check(
    d('passerelle_token_requests_total{token="ci-lecture"}') === 4 &&
      d('passerelle_token_requests_total{token="validation"}') >= 3,
    'requêtes par nom de jeton',
    [...m.keys()].filter(k => k.startsWith('passerelle_token')).join(' ')
  );
  check(
    d('passerelle_translations_total{action="translate.dsl",verdict="ready"}') +
      d('passerelle_translations_total{action="translate.dsl",verdict="review"}') ===
      2 &&
      d('passerelle_translations_total{action="translate.dsl",verdict="unrecognized"}') === 1 &&
      [...m.keys()].some(k => k.startsWith('passerelle_translations_total{action="translate.logstash"')),
    'traductions par action et verdict (la requête illisible est « unrecognized »)',
    [...m.keys()].filter(k => k.startsWith('passerelle_translations')).join(' ')
  );
  check(
    d('passerelle_validations_total{action="validate.sql",result="valid"}') === 1 &&
      d('passerelle_validations_total{action="validate.sql",result="rejected"}') === 1,
    'validations par résultat : valide, et rejetée avant d’arriver à ClickHouse (DROP)',
    [...m.keys()].filter(k => k.startsWith('passerelle_validations')).join(' ')
  );
  check(
    count(m, 'passerelle_http_requests_in_flight') >= 1 && count(m, 'passerelle_validation_jobs_running') === 0,
    'requêtes en cours (au moins ce relevé) et validations en cours'
  );
  check(
    count(m, 'process_resident_memory_bytes') > 1e6 &&
      count(m, 'process_cpu_seconds_total') > 0 &&
      count(m, 'process_start_time_seconds') > 1.7e9 &&
      [...m.keys()].some(k =>
        new RegExp(`^passerelle_build_info\\{node="v\\d+[^"]*",version="${VERSION.replace(/\./g, '\\.')}"\\} 1$`).test(
          `${k} ${m.get(k)}`
        )
      ),
    'processus et version'
  );
  // Histogrammes cohérents : +Inf = count, seaux croissants, somme positive
  const routes = [
    ...new Set(
      [...m.keys()]
        .filter(k => k.startsWith('passerelle_http_request_duration_seconds_count{'))
        .map(k => /route="([^"]*)"/.exec(k)[1])
    )
  ];
  const sane = routes.every(rt => {
    const les = [...m.keys()]
      .filter(k => k.startsWith(`passerelle_http_request_duration_seconds_bucket{route="${rt}",le=`))
      .map(k => m.get(k));
    return (
      les.length === 15 &&
      les.every((v, i) => i === 0 || v >= les[i - 1]) &&
      les[les.length - 1] === m.get(`passerelle_http_request_duration_seconds_count{route="${rt}"}`) &&
      m.get(`passerelle_http_request_duration_seconds_sum{route="${rt}"}`) >= 0
    );
  });
  check(routes.length >= 3 && sane, `durées : histogramme cohérent pour ${routes.length} routes`);
  // Chaque famille a son HELP et son TYPE
  const families = [...res.body.matchAll(/^# TYPE (\S+) (\S+)$/gm)];
  const helps = [...res.body.matchAll(/^# HELP (\S+) .+$/gm)].map(x => x[1]);
  check(
    families.length >= 19 &&
      families.every(([, n]) => helps.includes(n) && /^[a-z_:][a-z0-9_:]*$/.test(n)) &&
      families.every(([, , t]) => ['counter', 'gauge', 'histogram'].includes(t)),
    `${families.length} familles, chacune avec HELP et TYPE, noms valides`
  );
  check(
    m.has('passerelle_audit_events_total') &&
      m.has('passerelle_trace_export_errors_total') &&
      m.get('passerelle_validation_rejected_total') === 0,
    'les compteurs sans étiquette existent dès le démarrage, à zéro'
  );
  check(
    !res.body.includes(TOK.ci) && !res.body.includes('champ_secret') && !/token="(faux|jeton)/.test(res.body),
    'aucun jeton ni contenu de requête dans les métriques'
  );
  check(
    count(m, 'passerelle_config_reloads_total{result="ok"}') >= 1 &&
      count(m, 'passerelle_config_reloads_total{result="refused"}') >= 1,
    'rechargements de configuration comptés : acceptés et refusés'
  );
  check(count(m, 'passerelle_audit_events_total') > 10, 'événements d’audit comptés');

  // Validations simultanées : deux au plus, la troisième est refusée (429) et comptée
  chDelay = 500;
  const base429 = count(m, 'passerelle_validation_rejected_total');
  const three = await Promise.all([0, 1, 2].map(() => call(TOK.ops, 'POST', '/v1/validate/sql', sqlBody)));
  chDelay = 0;
  const statuses = three.map(x => x.status).sort();
  const after = metricsOf((await call(TOK.prom, 'GET', '/metrics')).body);
  check(
    J(statuses) === '[200,200,429]' && after.get('passerelle_validation_rejected_total') === base429 + 1,
    'trois validations en même temps : 200, 200, 429, et le refus est compté',
    J(statuses)
  );
  check(
    after.get('passerelle_http_requests_total{method="POST",route="/v1/validate/sql",status="429"}') >= 1,
    'le 429 figure aussi dans les statuts HTTP'
  );

  // Sans jeton, /metrics n'existe qu'en boucle locale (même règle que l'API)
  const open = await start({});
  let r = await request(open, 'GET', '/metrics');
  check(
    r.status === 200 && /passerelle_build_info/.test(r.body),
    'sans jeton configuré : /metrics répond en boucle locale'
  );
  r = await request(open, 'GET', '/metrics', { headers: { host: 'attaquant.example' } });
  check(r.status === 403, 'sans jeton configuré : /metrics refuse une requête adressée à un autre nom (DNS rebinding)');
  r = await request(open, 'POST', '/metrics', { body: 'x' });
  check(r.status === 405, '/metrics n’accepte que GET');
  await stop(open);
  const off = await start({ metrics: false }, { PASSERELLE_TOKEN: TOK.admin });
  r = await request(off, 'GET', '/metrics', { headers: bearer(TOK.admin) });
  check(r.status === 404, 'server.metrics: false : /metrics n’existe pas, même avec un jeton');
  await stop(off);
}

/* ====================================================================== */
section('H. Traces OpenTelemetry');
{
  otlp.length = 0;
  chSeen.length = 0;
  const TRACE = 'a'.repeat(32);
  const PARENT = 'b'.repeat(16);
  const tracing = {
    endpoint: OTLP_URL,
    headers: { authorization: 'Bearer ${OPS_OTEL}' },
    sample_ratio: 1,
    service_name: 'passerelle-test'
  };
  const t1 = await start(Object.assign({ tracing }, tokenServer), Object.assign({ OPS_OTEL: 'otel-secret' }, tokenEnv));
  const hdr = extra => Object.assign(bearer(TOK.ci), extra);

  let r = await request(t1, 'POST', '/v1/translate/dsl', {
    body: DSL,
    headers: hdr({ traceparent: `00-${TRACE}-${PARENT}-01` })
  });
  const rid = r.headers['x-request-id'];
  const r2 = await request(t1, 'POST', '/v1/translate/dsl', {
    body: DSL,
    headers: hdr({ traceparent: `00-${'c'.repeat(32)}-${PARENT}-00` })
  });
  const r3 = await request(t1, 'POST', '/v1/translate/dsl', { body: DSL, headers: hdr() });
  const r4 = await request(t1, 'POST', '/v1/validate/sql?contexte=valeur_confidentielle_77', {
    body: sqlBody,
    headers: { authorization: `Bearer ${TOK.ops}`, traceparent: `00-${'d'.repeat(32)}-${PARENT}-01` }
  });
  const r5 = await request(t1, 'GET', '/introuvable', { headers: { traceparent: 'pas un traceparent' } });
  check(
    r.status === 200 && r2.status === 200 && r3.status === 200 && r4.status === 200 && r5.status === 404,
    'les requêtes se déroulent comme sans traces'
  );
  await sleep(100);
  const logLine = t1.logs().find(l => l.msg === 'requête' && l.request_id === rid);
  check(
    logLine && logLine.trace_id === TRACE,
    'la ligne « requête » du journal porte le trace_id (lien journal ↔ trace)',
    J(logLine)
  );
  check(otlp.length === 0, 'aucun envoi avant l’échéance (ils sont groupés)', otlp.length);
  // À l'arrêt, les spans en attente partent
  await stop(t1);
  check(
    otlp.length >= 1 &&
      otlp.every(
        p =>
          p.method === 'POST' &&
          p.url === '/v1/traces' &&
          p.headers['content-type'] === 'application/json' &&
          p.headers.authorization === 'Bearer otel-secret'
      ),
    'à l’arrêt, les spans en attente partent vers le collecteur, avec ses en-têtes (variable résolue)',
    J(otlp.map(p => [p.method, p.url, p.headers.authorization]))
  );
  const payload = otlp[0] && otlp[0].json;
  const res = payload && payload.resourceSpans[0];
  check(
    res &&
      attr(res.resource, 'service.name') === 'passerelle-test' &&
      attr(res.resource, 'service.version') === VERSION &&
      res.scopeSpans[0].scope.name === 'passerelle',
    'ressource OTLP : nom du service et version',
    J(res && res.resource)
  );
  const spans = spansOf();
  const root1 = spans.find(s => s.traceId === TRACE);
  check(
    root1 &&
      root1.name === 'POST /v1/translate/dsl' &&
      root1.kind === 2 &&
      root1.parentSpanId === PARENT &&
      /^[0-9a-f]{16}$/.test(root1.spanId) &&
      root1.status.code === 0,
    'le contexte de l’appelant est repris : même trace, parent = son span, nom « POST /v1/translate/dsl », type serveur',
    J(root1)
  );
  check(
    root1 &&
      attr(root1, 'http.response.status_code') === '200' &&
      attr(root1, 'http.route') === '/v1/translate/dsl' &&
      attr(root1, 'passerelle.request_id') === rid &&
      attr(root1, 'passerelle.action') === 'translate.dsl' &&
      attr(root1, 'passerelle.token') === 'ci-lecture' &&
      ['ready', 'review'].includes(attr(root1, 'passerelle.verdict')) &&
      attr(root1, 'client.address') === '127.0.0.1',
    'attributs du span : statut, route, identifiant de requête, action, jeton, verdict',
    J(root1 && root1.attributes)
  );
  check(
    BigInt(root1.endTimeUnixNano) >= BigInt(root1.startTimeUnixNano) &&
      Date.now() - Number(BigInt(root1.startTimeUnixNano) / 1000000n) < 60000,
    'horodatages en nanosecondes, fin après début'
  );
  check(
    !spans.some(s => s.traceId === 'c'.repeat(32)),
    'l’appelant a demandé de ne pas échantillonner (drapeau 00) : aucun span'
  );
  const own = spans.find(s => attr(s, 'passerelle.request_id') === r3.headers['x-request-id']);
  check(
    own && /^[0-9a-f]{32}$/.test(own.traceId) && !('parentSpanId' in own),
    'sans traceparent : une nouvelle trace, sans parent',
    J(own)
  );
  const bad = spans.find(s => attr(s, 'passerelle.request_id') === r5.headers['x-request-id']);
  check(
    bad &&
      bad.name === 'GET autre' &&
      attr(bad, 'http.route') === 'autre' &&
      !('parentSpanId' in bad) &&
      bad.status.code === 0,
    'un traceparent illisible est ignoré ; une route inconnue s’appelle « GET autre » (404 n’est pas une erreur du service)',
    J(bad)
  );

  const rootV = spans.find(s => s.traceId === 'd'.repeat(32) && s.name === 'POST /v1/validate/sql');
  const kids = spans.filter(s => s.traceId === 'd'.repeat(32) && s.name === 'clickhouse.query');
  check(
    rootV && attr(rootV, 'url.path') === '/v1/validate/sql',
    'le span serveur porte le chemin, sans la chaîne de requête',
    J(rootV && rootV.attributes)
  );
  check(
    rootV &&
      kids.length === 2 &&
      kids.every(
        k =>
          k.parentSpanId === rootV.spanId &&
          k.kind === 3 &&
          attr(k, 'db.system.name') === 'clickhouse' &&
          attr(k, 'http.response.status_code') === '200' &&
          attr(k, 'server.address') === '127.0.0.1'
      ),
    'validation SQL : un span enfant de type client par appel à ClickHouse (EXPLAIN AST, puis EXPLAIN indexes)',
    J(kids.map(k => [k.name, k.parentSpanId, k.attributes.length]))
  );
  const forwarded = chSeen.filter(x => x.headers.traceparent && x.headers.traceparent.includes('d'.repeat(32)));
  check(
    forwarded.length === 2 &&
      forwarded.every(x => /^00-d{32}-[0-9a-f]{16}-01$/.test(x.headers.traceparent)) &&
      J(forwarded.map(x => x.headers.traceparent.split('-')[2]).sort()) === J(kids.map(k => k.spanId).sort()),
    'ClickHouse reçoit le traceparent de chaque appel (trace de l’appelant, span de l’appel)',
    J(forwarded.map(x => x.headers.traceparent))
  );
  const raw = otlp.map(p => p.raw).join('');
  check(
    !/SELECT|EXPLAIN|champ_secret|valeur_secrete|valeur_confidentielle_77|logs\.events|jeton-|otel-secret/.test(raw),
    'ni SQL, ni requête, ni jeton dans les spans',
    raw.match(/.{30}(SELECT|EXPLAIN|champ_secret|logs\.events|jeton-).{30}/)
  );

  // Sans traces configurées, rien n'est transmis à ClickHouse
  chSeen.length = 0;
  const plain = await start(tokenServer, tokenEnv);
  await request(plain, 'POST', '/v1/validate/sql', {
    body: sqlBody,
    headers: { authorization: `Bearer ${TOK.ops}`, traceparent: `00-${'e'.repeat(32)}-${PARENT}-01` }
  });
  check(
    chSeen.length === 2 && chSeen.every(x => !('traceparent' in x.headers)),
    'sans server.tracing, aucun traceparent n’est transmis à ClickHouse (le comportement d’avant est inchangé)'
  );
  await stop(plain);

  // Échéance : les spans partent seuls, sans attendre l'arrêt
  otlp.length = 0;
  const timed = await start({ tracing }, { OPS_OTEL: 'otel-secret' });
  await request(timed, 'GET', '/healthz');
  const t0 = Date.now();
  const sent = await until(() => otlp.length > 0, 9000);
  check(
    sent && Date.now() - t0 < 8000 && spansOf().some(s => s.name === 'GET /healthz'),
    `l’échéance (5 s) envoie les spans sans arrêt du service (${Date.now() - t0} ms)`
  );
  await stop(timed);

  // Taux d'échantillonnage : 0 → rien, sauf si l'appelant a décidé d'échantillonner
  otlp.length = 0;
  const none = await start({ tracing: Object.assign({}, tracing, { sample_ratio: 0 }) }, { OPS_OTEL: 'otel-secret' });
  for (let i = 0; i < 5; i++) await request(none, 'GET', '/healthz');
  await request(none, 'GET', '/healthz', { headers: { traceparent: `00-${'f'.repeat(32)}-${PARENT}-01` } });
  await stop(none);
  const kept = spansOf();
  check(
    kept.length === 1 && kept[0].traceId === 'f'.repeat(32),
    'sample_ratio: 0 : aucun span, sauf celui que l’appelant a demandé d’échantillonner',
    J(kept.map(s => s.traceId))
  );

  // Collecteur en panne : le service répond toujours, les échecs sont comptés ; il reprend ensuite
  otlp.length = 0;
  otlpStatus = 500;
  const flaky = await start(
    { tracing, tokens: tokenServer.tokens },
    Object.assign({ OPS_OTEL: 'otel-secret' }, tokenEnv)
  );
  for (let i = 0; i < 70; i++) await request(flaky, 'GET', '/healthz');
  let m = metricsOf((await request(flaky, 'GET', '/metrics', { headers: bearer(TOK.prom) })).body);
  check(
    await until(async () => {
      m = metricsOf((await request(flaky, 'GET', '/metrics', { headers: bearer(TOK.prom) })).body);
      return m.get('passerelle_trace_export_errors_total') >= 1;
    }, 4000),
    'collecteur en erreur (500) : l’échec est compté',
    J([...m.entries()].filter(([k]) => k.includes('trace')))
  );
  check(
    m.get('passerelle_trace_spans_dropped_total') >= 64 && (await request(flaky, 'GET', '/healthz')).status === 200,
    'les spans perdus sont comptés, et le service répond toujours'
  );
  check(
    flaky
      .alertes()
      .some(
        l =>
          l.level === 'warn' &&
          /export des traces impossible/.test(l.msg) &&
          l.msg.includes('/v1/traces') &&
          !l.msg.includes('otel-secret')
      ),
    'l’avertissement dit le collecteur en cause, sans en-tête secret'
  );
  otlpStatus = 200;
  otlp.length = 0;
  for (let i = 0; i < 70; i++) await request(flaky, 'GET', '/healthz');
  await until(() => otlp.length > 0, 4000);
  m = metricsOf((await request(flaky, 'GET', '/metrics', { headers: bearer(TOK.prom) })).body);
  check(
    m.get('passerelle_trace_spans_exported_total') >= 64,
    'le collecteur revenu, l’export reprend et les spans exportés sont comptés',
    J([...m.entries()].filter(([k]) => k.includes('trace')))
  );
  await stop(flaky);
}

/* ---------- Fin ---------- */
for (const s of servers) if (s.exited === null) s.proc.kill('SIGKILL');
ch.close();
collector.close();
rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${failures ? `${failures} échec(s)` : 'tout est vert'}\n`);
process.exit(failures ? 1 : 0);
