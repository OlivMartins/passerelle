#!/usr/bin/env node
/*
 * Tests du serveur HTTP et de la ligne de commande : le serveur est assemblé comme le fait
 * scripts/build.mjs, puis interrogé à travers une fausse instance ClickHouse et un faux binaire Vector.
 * Linux seulement (le faux Vector est un script shell).
 *   node tests/server/run.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');
const TMP = mkdtempSync(join(tmpdir(), 'passerelle-serveur-'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failures++;
};

/* ---------- Montage ---------- */
const BIN = join(TMP, 'passerelle.cjs');
writeFileSync(BIN, "'use strict';\n" + ['src/engine/base.js', 'src/engine/dsl.js', 'src/engine/logstash.js', 'src/server.js'].map(rd).join(''));
const UI = join(TMP, 'passerelle.html');
writeFileSync(UI, '<!doctype html><html><body><script>void 0;</script></body></html>');
// Faux Vector : recopie son environnement dans sa sortie, que l'API renvoie au client
const VECTOR = join(TMP, 'vector');
writeFileSync(VECTOR, '#!/bin/sh\nenv\n'); chmodSync(VECTOR, 0o755);

const SECRET = 'secret-clickhouse-4f9a';
const TOKEN = 'jeton-de-test-81c2';

// Fausse instance ClickHouse : note l'adresse reçue, répond après un délai réglable
const chSeen = [];
let chDelay = 0;
const ch = http.createServer((req, res) => {
  chSeen.push(new URL(req.url, 'http://x'));
  req.resume();
  req.on('end', () => setTimeout(() => { res.writeHead(200); res.end('Expression\n'); }, chDelay));
});
await new Promise(r => ch.listen(0, '127.0.0.1', r));
const CONFIG = join(TMP, 'passerelle.json');
writeFileSync(CONFIG, JSON.stringify({ clickhouse: { endpoint: `http://127.0.0.1:${ch.address().port}` } }));

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const servers = [];
async function start(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [BIN, 'serve', '--listen', `127.0.0.1:${port}`], {
    env: Object.assign({ PATH: process.env.PATH, PASSERELLE_UI: UI, PASSERELLE_CONFIG: CONFIG, PASSERELLE_VECTOR_BIN: VECTOR, CLICKHOUSE_PASSWORD: SECRET }, env),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; p.stderr.on('data', d => { stderr += d; });
  const srv = { port, proc: p, exited: null, stderr: () => stderr };
  p.on('exit', code => { srv.exited = code; });
  servers.push(srv);
  for (let i = 0; i < 100; i++) {
    if (srv.exited !== null) throw new Error(`le serveur s'est arrêté au démarrage : ${stderr}`);
    try { await request(srv, 'GET', '/healthz'); return srv; } catch (e) { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('le serveur ne répond pas');
}
function request(srv, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers: Object.assign({}, headers) }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', d => { data += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (e) { /* page HTML */ } resolve({ status: res.statusCode, body: data, json: j }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
// Requête écrite à la main : http.request refuse certaines adresses
function raw(srv, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(srv.port, '127.0.0.1', () => s.write(text));
    let data = ''; s.on('data', d => { data += d; }); s.on('end', () => resolve(data.split('\r\n')[0])); s.on('error', reject);
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };
const DSL = JSON.stringify({ query: { match_all: {} } });

try {
  const open = await start({});                          // sans jeton, usage local
  const prod = await start({ PASSERELLE_TOKEN: TOKEN }); // comme le service systemd

  /* ---------- Adresse de requête invalide ---------- */
  const line = await raw(open, 'GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await new Promise(r => setTimeout(r, 200));
  check(open.exited === null, 'GET // : le serveur reste en service', `arrêté avec le code ${open.exited}`);
  check(/ 400 /.test(line), 'GET // : réponse 400', line || 'pas de réponse');

  /* ---------- Requêtes intersites ---------- */
  let r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' } });
  check(r.status === 403, 'requête intersite refusée sur /v1', `statut ${r.status}`);
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { 'sec-fetch-site': 'same-site' } });
  check(r.status === 403, 'requête d’un sous-domaine voisin refusée sur /v1', `statut ${r.status}`);
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { 'sec-fetch-site': 'same-origin' } });
  check(r.status === 200, 'requête de l’interface servie acceptée', `statut ${r.status}`);
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL });
  check(r.status === 200, 'requête sans en-tête Sec-Fetch (curl) acceptée', `statut ${r.status}`);
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { host: 'attaquant.example' } });
  check(r.status === 403, 'sans jeton : Host étranger refusé (DNS rebinding)', `statut ${r.status}`);
  r = await request(open, 'POST', '/v1/translate/dsl', { body: DSL, headers: { host: '[::1]:8080' } });
  check(r.status === 200, 'sans jeton : Host de boucle locale accepté', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: DSL, headers: Object.assign({ host: 'passerelle.example.com' }, auth) });
  check(r.status === 200, 'avec jeton : Host public accepté (proxy nginx)', `statut ${r.status}`);
  r = await request(open, 'GET', '/healthz', { headers: { host: 'attaquant.example' } });
  check(r.status === 200, '/healthz reste accessible quel que soit le Host', `statut ${r.status}`);

  /* ---------- Validation Vector : aucun secret du service ---------- */
  r = await request(prod, 'POST', '/v1/validate/vector', { body: 'sinks:\n  ch:\n    auth: { password: "${CLICKHOUSE_PASSWORD}" }\n', headers: auth });
  const out = r.json ? r.json.output : '';
  check(r.status === 200 && /CLICKHOUSE_PASSWORD=validation/.test(out), 'validation Vector : variable référencée remplacée par une valeur factice', `statut ${r.status}`);
  check(!out.includes(SECRET), 'validation Vector : le mot de passe ClickHouse n’est pas transmis');
  check(!out.includes(TOKEN), 'validation Vector : le jeton d’API n’est pas transmis');

  /* ---------- Validation SQL ---------- */
  r = await request(prod, 'POST', '/v1/validate/sql', { body: 'SELECT 1', headers: auth });
  const seen = chSeen.at(-1);
  check(r.status === 200 && seen && seen.searchParams.get('readonly') === '1', 'validation SQL en readonly=1', seen ? `readonly=${seen.searchParams.get('readonly')}` : `statut ${r.status}`);
  chDelay = 500;
  const all = await Promise.all([1, 2, 3].map(() => request(prod, 'POST', '/v1/validate/sql', { body: 'SELECT 1', headers: auth })));
  chDelay = 0;
  check(all.some(x => x.status === 429), 'validation SQL : au plus deux en parallèle', all.map(x => x.status).join(', '));

  /* ---------- Sens de tri des documents ---------- */
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: JSON.stringify({ sort: [{ service: { order: 'desc; DROP TABLE logs.events --' } }] }), headers: auth });
  check(r.status === 422 && !/DROP/i.test(r.json && r.json.sql || ''), 'sens de tri inconnu refusé', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: JSON.stringify({ sort: [{ service: 'asc, (SELECT 1)' }] }), headers: auth });
  check(r.status === 422, 'sens de tri écrit en chaîne vérifié aussi', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: JSON.stringify({ sort: [{ service: { order: 'DESC' } }, 'host'] }), headers: auth });
  check(r.status === 200 && /ORDER BY service DESC, host ASC/.test(r.json.sql), 'sens de tri valides inchangés', r.json && r.json.sql);
} catch (e) {
  check(false, 'serveur', e.message);
} finally {
  for (const s of servers) s.proc.kill();
  ch.close();
}

/* ---------- Ligne de commande ---------- */
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
let c = cli('dsl2sql', '--verbose', 'examples/dsl/erreurs_5xx.json', 'examples/dsl/recherche_texte.json');
check(c.status === 0 && /erreurs_5xx/.test(c.stdout) && /recherche_texte/.test(c.stdout), 'dsl2sql --verbose A B : les deux fichiers traduits', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--fail-on', 'todo');
check(c.status === 2, '--fail-on todo : code 2 sur un élément à reprendre', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--fail-on', 'todos');
check(c.status === 1, '--fail-on avec une valeur inconnue : erreur', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--fial-on', 'todo');
check(c.status === 1 && /--fial-on/.test(c.stderr), 'option inconnue : erreur qui la nomme', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--format', 'tom');
check(c.status === 1, '--format avec une valeur inconnue : erreur', `code ${c.status}`);
c = cli('--help');
check(/--verbose/.test(c.stdout), 'l’aide mentionne --verbose');

const typo = join(TMP, 'faute.yaml');
writeFileSync(typo, 'version: 1\nclickhous:\n  endpoint: http://localhost:8123\nkafka:\n  bootstrap_server: k:9092\n');
c = cli('check-config', '--config', typo);
check(c.status === 1 && /clickhous/.test(c.stderr) && /kafka\.bootstrap_server/.test(c.stderr), 'check-config : clés inconnues refusées et nommées', `code ${c.status}`);
c = cli('check-config', '--quiet', '--config', 'packaging/passerelle.yaml');
check(c.status === 0, 'check-config : la configuration livrée reste valide', c.stderr.trim());

rmSync(TMP, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests du serveur passent.\n');
process.exit(failures ? 1 : 0);
