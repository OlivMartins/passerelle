#!/usr/bin/env node
/*
 * Tests du serveur HTTP et de la ligne de commande : le serveur est assemblé comme le fait
 * scripts/build.mjs, puis interrogé à travers une fausse instance ClickHouse et un faux binaire Vector.
 * Linux seulement (le faux Vector est un script shell).
 *   node tests/server/run.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { engineSource } from '../../scripts/engine.mjs';

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
writeFileSync(BIN, "'use strict';\n" + engineSource() + rd('src/server.js'));
const UI = join(TMP, 'passerelle.html');
writeFileSync(UI, '<!doctype html><html><body><script>void 0;</script></body></html>');
// Faux Vector : recopie son environnement dans sa sortie, que l'API renvoie au client
const VECTOR = join(TMP, 'vector');
writeFileSync(VECTOR, '#!/bin/sh\nenv\n'); chmodSync(VECTOR, 0o755);

const SECRET = 'secret-clickhouse-4f9a';
const TOKEN = 'jeton-de-test-81c2';

// Fausse instance ClickHouse : note l'adresse et le corps reçus, répond après un délai réglable.
// À EXPLAIN AST, elle répond un arbre réduit : une TableExpression par « FROM nom » ou « FROM fonction(… ».
const chSeen = [];
const chBodies = [];
let chDelay = 0;
function fakeAST(sql) {
  const lines = ['SelectWithUnionQuery (children 1)'];
  for (const m of sql.matchAll(/\bFROM\s+([A-Za-z_][\w.]*)(\()?/g)) {
    lines.push('   TableExpression (children 1)', m[2] ? `    Function ${m[1]} (children 1)` : `    TableIdentifier ${m[1]}`);
  }
  for (const m of sql.matchAll(/\b(dictGet\w*)\(/g)) lines.push(`   Function ${m[1]} (children 1)`);
  return lines.join('\n') + '\n';
}
const ch = http.createServer((req, res) => {
  chSeen.push(new URL(req.url, 'http://x'));
  let body = ''; req.setEncoding('utf8'); req.on('data', d => { body += d; });
  req.on('end', () => setTimeout(() => {
    chBodies.push(body);
    res.writeHead(200); res.end(/^EXPLAIN AST /.test(body) ? fakeAST(body) : 'Expression\n');
  }, chDelay));
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
  // EXPLAIN indexes = 1 évalue les sous-requêtes scalaires : une table hors configuration est refusée avant
  r = await request(prod, 'POST', '/v1/validate/sql', { body: "SELECT count() FROM logs.events WHERE service = (SELECT any(k) FROM logs.secrets)", headers: auth });
  check(r.status === 400 && /logs\.secrets/.test(r.json.error) && !chBodies.at(-1).startsWith('EXPLAIN indexes'), 'validation SQL : table hors configuration refusée avant EXPLAIN', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/validate/sql', { body: "SELECT * FROM url('http://exemple.invalid/x', CSV, 'a String')", headers: auth });
  check(r.status === 400 && /url\(\)/.test(r.json.error), 'validation SQL : fonction de table refusée', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/validate/sql', { body: "SELECT dictGet('secrets', 'v', 1) FROM logs.events", headers: auth });
  check(r.status === 400 && /dictGet/.test(r.json.error), 'validation SQL : lecture de dictionnaire refusée', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/validate/sql?param_when=2026-10-22&param_x%3By=1', { body: 'WITH base AS (SELECT * FROM logs.events) SELECT count() FROM base WHERE timestamp >= {when:String}', headers: auth });
  const sent = chSeen.at(-1);
  check(r.status === 200 && r.json.valid && sent.searchParams.get('param_when') === '2026-10-22' && !sent.searchParams.has('param_x;y'), 'validation SQL : CTE acceptée, paramètres param_* transmis', `statut ${r.status}`);

  /* ---------- Verdict ---------- */
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: JSON.stringify({ size: 0, query: { range: { '@timestamp': { gte: '{{ctx.trigger.scheduled_time}}||-5m' } } } }), headers: auth });
  check(r.status === 200 && r.json.verdict && r.json.parameters.length === 1 && r.json.parameters[0].name === 'scheduled_time', 'traduction DSL : verdict et paramètres renvoyés', r.body.slice(0, 200));
  r = await request(prod, 'POST', '/v1/translate/dsl', { body: JSON.stringify({ query: { bool: { filtre: [] } } }), headers: auth });
  check(r.status === 422 && r.json.verdict === 'unrecognized', 'traduction DSL : clé inconnue refusée, verdict non reconnue', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/logstash', { body: 'input { stdin {} } filter { ruby { code => "x" } } output { stdout {} }', headers: auth });
  check(r.status === 200 && r.json.verdict === 'todo', 'traduction Logstash : verdict renvoyé', r.json && r.json.verdict);

  /* ---------- Ensemble de pipelines (pipelines.yml) ---------- */
  const yml = rd('examples/logstash/pipelines/pipelines.yml');
  const confs = Object.fromEntries(['conf.d/entree.conf', 'conf.d/systeme.conf', 'conf.d/web/10-entree.conf', 'conf.d/web/20-filtres.conf', 'conf.d/web/30-sorties.conf'].map(f => [f, rd(`examples/logstash/pipelines/${f}`)]));
  r = await request(prod, 'POST', '/v1/translate/logstash/pipelines', { body: JSON.stringify({ pipelines: yml, files: confs }), headers: auth });
  check(r.status === 200 && r.json.pipelines.length === 4 && r.json.pipelines.every(p => p.verdict !== 'todo') && /entree_routage/.test(r.json.config), 'pipelines.yml : quatre pipelines reliés en une configuration', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/logstash/pipelines?format=toml', { body: '- pipeline.id: seul\n  config.string: "input { stdin {} } output { stdout {} }"\n', headers: auth });
  check(r.status === 200 && r.json.format === 'toml' && /\[sources\.seul_stdin_in\]/.test(r.json.config), 'pipelines.yml seul (config.string) : TOML', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/logstash/pipelines', { body: JSON.stringify({ pipelines: yml }), headers: auth });
  check(r.status === 200 && r.json.verdict === 'todo' && r.json.pipelines.filter(p => p.error).length === 3, 'pipelines.yml sans ses fichiers : pipelines à reprendre, nommés', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/logstash/pipelines', { body: 'pipeline.id: x', headers: auth });
  check(r.status === 422 && /liste/.test(r.json.error), 'pipelines.yml qui n’est pas une liste : refusé', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/logstash/pipelines', { body: JSON.stringify({ pipelines: yml, files: ['x'] }), headers: auth });
  check(r.status === 400, 'pipelines.yml : « files » mal formé refusé', `statut ${r.status}`);

  /* ---------- Inventaire Kibana ---------- */
  const ndjson = rd('examples/kibana/supervision_web.ndjson');
  r = await request(prod, 'POST', '/v1/inventory/kibana', { body: ndjson, headers: auth });
  check(r.status === 200 && r.json.summary.objects > 10 && r.json.entries.some(x => x.type === 'dashboard') && r.json.summary.effort.hours > 0, 'inventaire Kibana : objets, verdicts et effort', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/inventory/kibana?format=md&timezone=Europe/Paris', { body: ndjson, headers: auth });
  check(r.status === 200 && /^# Inventaire de migration Kibana/.test(r.body), 'inventaire Kibana : rapport Markdown', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/inventory/kibana?timezone=Mars/Olympe', { body: ndjson, headers: auth });
  check(r.status === 400 && /fuseau/.test(r.json.error), 'inventaire Kibana : fuseau inconnu refusé', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/inventory/kibana', { body: 'pas un export', headers: auth });
  check(r.status === 422, 'inventaire Kibana : fichier sans objet refusé', `statut ${r.status}`);
  // Un export de plusieurs Mio passe sur cette route, pas sur les autres
  const big = Array.from({ length: 220 }, () => ndjson).join('');
  r = await request(prod, 'POST', '/v1/inventory/kibana?format=csv', { body: big, headers: auth });
  check(r.status === 200 && big.length > 2 * 1024 * 1024 && /^\ufeffType;/.test(r.body), 'inventaire Kibana : export de plus de 2 Mio accepté, CSV', `statut ${r.status}, ${Math.round(big.length / 1048576)} Mio`);

  /* ---------- Tableau de bord Grafana ---------- */
  r = await request(prod, 'POST', '/v1/translate/grafana?index=logs-*', { body: rd('examples/grafana/supervision_es.json'), headers: auth });
  check(r.status === 200 && r.json.dashboard.__inputs.some(i => i.pluginId === 'grafana-clickhouse-datasource') && r.json.report.panels.length > 5, 'tableau de bord Grafana : converti, avec son rapport', `statut ${r.status}`);
  r = await request(prod, 'POST', '/v1/translate/grafana', { body: JSON.stringify({ panels: [{ type: 'text', title: 't' }] }), headers: auth });
  check(r.status === 422 && /aucune requête Elasticsearch/.test(r.json.error), 'tableau de bord sans Elasticsearch : refusé', `statut ${r.status}`);

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
c = cli('dsl2sql', 'examples/dsl/erreurs_5xx.json', '--fail-on', 'todo');
check(c.status === 0 && /Verdict : /.test(c.stdout), '--fail-on todo : code 0 sans élément à reprendre, verdict dans le SQL', `code ${c.status}`);
c = cli('dsl2sql', 'examples/dsl/erreurs_5xx.json', '--fail-on', 'review');
check(c.status === 2 && /à vérifier/.test(c.stderr), '--fail-on review : code 2 sur un fichier à vérifier', `code ${c.status} ${c.stderr}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--fail-on', 'todos');
check(c.status === 1, '--fail-on avec une valeur inconnue : erreur', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--fial-on', 'todo');
check(c.status === 1 && /--fial-on/.test(c.stderr), 'option inconnue : erreur qui la nomme', `code ${c.status}`);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--format', 'tom');
check(c.status === 1, '--format avec une valeur inconnue : erreur', `code ${c.status}`);
const lsOut = join(TMP, 'sortie-vector');
c = cli('ls2vector', 'examples/logstash/pipelines/pipelines.yml', '--out', lsOut);
check(c.status === 0 && existsSync(join(lsOut, 'pipelines.yaml')) && /entree \(conf\.d\/entree\.conf, 1 fichier\)/.test(c.stderr) && /web \(conf\.d\/web\/\*\.conf, 3 fichiers\)/.test(c.stderr), 'ls2vector pipelines.yml --out : une configuration, chaque pipeline et ses fichiers listés', `code ${c.status} ${c.stderr}`);
c = cli('ls2vector', 'examples/logstash/pipelines/', '--out', join(TMP, 'sortie-vector-2'));
check(/pipelines\.yml : « passerelle ls2vector/.test(c.stderr), 'ls2vector sur un dossier qui porte pipelines.yml : la commande d’ensemble est indiquée', c.stderr.split('\n')[0]);
c = cli('ls2vector', 'examples/logstash/batch.conf', '--out', 'examples/logstash/batch.conf');
check(c.status === 1 && /--out : impossible de créer le dossier/.test(c.stderr) && !/at /.test(c.stderr), '--out sur un fichier : erreur lisible, sans pile', c.stderr.trim());
c = cli('ls2vector', join(TMP, 'absent.yml'));
check(c.status === 1 && /absent\.yml/.test(c.stderr), 'ls2vector pipelines.yml introuvable : erreur', `code ${c.status}`);
c = cli('--help');
check(/--verbose/.test(c.stdout), 'l’aide mentionne --verbose');

const kibanaOut = join(TMP, 'inventaire');
c = cli('kibana', 'examples/kibana/', '--config', 'examples/kibana/passerelle.yaml', '--out', kibanaOut);
check(c.status === 0 && ['md', 'html', 'csv', 'json'].every(f => existsSync(join(kibanaOut, `inventaire.${f}`))) && readdirSync(join(kibanaOut, 'sql')).length > 10 && /Effort estimé/.test(c.stderr), 'kibana --out : rapports et fichiers SQL', `code ${c.status} ${c.stderr}`);
c = cli('kibana', 'examples/kibana/supervision_web.ndjson', '--fail-on', 'todo');
check(c.status === 2, 'kibana --fail-on todo : code 2 quand un objet est à reprendre', `code ${c.status}`);
c = cli('kibana', 'examples/kibana/supervision_web.ndjson', '--format', 'toml');
check(c.status === 1 && /--format/.test(c.stderr), 'kibana --format : formats de l’inventaire seulement', `code ${c.status}`);
c = cli('kibana', 'examples/kibana/supervision_web.ndjson', '--timezone', 'Mars/Olympe');
check(c.status === 1 && /--timezone/.test(c.stderr), 'kibana --timezone : fuseau inconnu refusé', `code ${c.status}`);

const grafanaOut = join(TMP, 'grafana');
c = cli('grafana', 'examples/grafana/supervision_es.json', '--config', 'examples/grafana/passerelle.yaml', '--index', 'logs-web-*', '--out', grafanaOut);
check(c.status === 0 && existsSync(join(grafanaOut, 'supervision_es.clickhouse.json')) && existsSync(join(grafanaOut, 'supervision_es.rapport.md')), 'grafana --out : tableau de bord converti et rapport', `code ${c.status} ${c.stderr}`);
c = cli('grafana', 'examples/grafana/supervision_es.json', '--fail-on', 'todo');
check(c.status === 2 && /"grafana-clickhouse-datasource"/.test(c.stdout), 'grafana --fail-on todo : JSON sur la sortie standard, code 2', `code ${c.status}`);

const typo = join(TMP, 'faute.yaml');
writeFileSync(typo, 'version: 1\nclickhous:\n  endpoint: http://localhost:8123\nkafka:\n  bootstrap_server: k:9092\n');
c = cli('check-config', '--config', typo);
check(c.status === 1 && /clickhous/.test(c.stderr) && /kafka\.bootstrap_server/.test(c.stderr), 'check-config : clés inconnues refusées et nommées', `code ${c.status}`);
c = cli('check-config', '--quiet', '--config', 'packaging/passerelle.yaml');
check(c.status === 0, 'check-config : la configuration livrée reste valide', c.stderr.trim());

rmSync(TMP, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTous les tests du serveur passent.\n');
process.exit(failures ? 1 : 0);
