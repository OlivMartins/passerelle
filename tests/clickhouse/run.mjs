#!/usr/bin/env node
/*
 * Banc d’exécution ClickHouse : ce que Passerelle génère pour ses exemples s’exécute, et donne le bon résultat.
 *
 *   - Schéma : chaque CREATE TABLE tiré des modèles d’index (examples/schema) est créé sur ClickHouse.
 *   - Inventaire Kibana : chaque requête SQL de l’inventaire des exemples (examples/kibana) s’exécute sur une table
 *     remplie de documents connus ; quelques résultats sont comparés à leur valeur calculée ici, à la main.
 *   - Tableau de bord Grafana (examples/grafana) : chaque requête du tableau converti est interpolée comme Grafana et le
 *     plugin ClickHouse le font (grafana.mjs), puis exécutée et contrôlée de la même façon.
 *
 *   node tests/clickhouse/run.mjs [--verbose]
 *
 *   CLICKHOUSE_LOCAL   commande ClickHouse locale (défaut clickhouse-local ; « clickhouse local » convient)
 *   PASSERELLE_CH_WORK dossier de travail, sur un système de fichiers Linux
 *
 * Code de sortie : 0 si tout s’exécute et chaque valeur contrôlée est juste, 1 sinon.
 */
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../scripts/engine.mjs';
import { grafanaInterpolate } from './grafana.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERBOSE = process.argv.includes('--verbose');
const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const WORK = process.env.PASSERELLE_CH_WORK || join(tmpdir(), 'passerelle-clickhouse');
const E = loadEngine();
const rd = p => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail && (!ok || VERBOSE) ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
};
// Une base de travail par section : les tables persistent d’une requête à l’autre
function clickhouse(dir, sql, params) {
  const args = CH_PRE.concat(['--path', dir, '--multiquery', '--output-format', 'JSONEachRow', '--output_format_json_quote_64bit_integers', '0']);
  for (const [k, v] of Object.entries(params || {})) args.push(`--param_${k}=${v}`);
  // Requêtes sur l’entrée standard : un INSERT de documents dépasserait la taille permise d’un argument
  const out = execFileSync(CH_BIN, args, { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
  return out.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const errorOf = e => String(e.stderr || e.message).split('\n').find(l => /Code: \d+/.test(l)) || String(e.stderr || e.message).slice(0, 400);
const fresh = name => { const d = join(WORK, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

/* ---------- Schéma : CREATE TABLE des modèles d’index ---------- */
{
  const dir = fresh('schema');
  for (const f of readdirSync(join(ROOT, 'examples/schema')).filter(n => /\.(txt|json)$/.test(n))) {
    const r = E.schemaFromElastic(rd(`examples/schema/${f}`), E.DEFAULT_CONFIG, {});
    if (r.error) { check(false, `schéma ${f}`, r.error); continue; }
    const dbs = [...new Set(r.tables.map(t => String(t.table).split('.')[0]))];
    try {
      clickhouse(dir, dbs.map(d => `CREATE DATABASE IF NOT EXISTS ${d};`).join('\n') + '\n' + r.sql);
      check(true, `schéma ${f} : ${r.tables.length} table(s) créée(s)`);
    } catch (e) { check(false, `schéma ${f}`, errorOf(e)); }
  }
}

/* ---------- Inventaire Kibana, puis tableau de bord Grafana, sur une même table remplie ---------- */
{
  const dir = fresh('kibana');
  const cfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/kibana/passerelle.yaml')));
  const files = readdirSync(join(ROOT, 'examples/kibana')).filter(n => n.endsWith('.ndjson')).sort();
  const inv = E.kibanaInventory(files.map(f => rd(`examples/kibana/${f}`)), cfg, { names: files });
  // Table de l’exemple, d’après son profil, et documents connus : un jour d’activité, puis quelques minutes récentes
  const cols = cfg.clickhouse.tables['logs.web'].columns;
  const ddl = `CREATE DATABASE IF NOT EXISTS logs;\nCREATE TABLE logs.web (${Object.entries(cols).map(([n, t]) => `\`${n}\` ${t}`).join(', ')}) ENGINE = MergeTree ORDER BY timestamp;`;
  const services = ['checkout', 'panier', 'catalogue'];
  const paths = ['/api/panier', '/api/paiement', '/health', '/admin/users', '/export/csv'];
  const rows = [];
  const base = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; i < 600; i++) {
    const status = [200, 200, 200, 201, 404, 500, 503][i % 7];
    rows.push({
      timestamp: new Date(base + i * 137000).toISOString().replace('T', ' ').replace('Z', ''),
      'service.name': services[i % 3], 'service.environment': i % 5 === 0 ? 'recette' : 'production', 'host.name': `web-${i % 4}`,
      'url.path': paths[i % 5], 'http.request.method': ['GET', 'POST', 'PUT'][i % 3], 'http.response.status_code': status,
      'http.response.bytes': 100 + (i * 37) % 5000, 'event.duration': 1000000 * (1 + (i * 13) % 900),
      'event.category': i % 6 === 0 ? 'authentication' : 'web', 'event.outcome': i % 4 === 0 ? 'failure' : 'success',
      'user.name': i % 9 === 0 ? '-' : `u${i % 11}`, 'source.ip': `10.0.${i % 3}.${i % 7}`, message: i % 10 === 0 ? 'upstream timeout after 30s' : 'requête servie'
    });
  }
  const insert = rows.map(r => JSON.stringify(r)).join('\n');
  // Documents récents (fenêtres des règles d’alerte : now-5m, now-15m) : 3 erreurs 5xx, 1 succès
  const recent = `INSERT INTO logs.web (timestamp, \`service.name\`, \`service.environment\`, \`http.response.status_code\`, \`event.duration\`, message) VALUES (now64(3) - INTERVAL 60 SECOND, 'checkout', 'production', 500, 900000000, 'connection refused'), (now64(3) - INTERVAL 90 SECOND, 'checkout', 'production', 503, 800000000, 'x'), (now64(3) - INTERVAL 120 SECOND, 'panier', 'production', 502, 100, 'x'), (now64(3) - INTERVAL 30 SECOND, 'panier', 'production', 200, 100, 'x');`;
  try { clickhouse(dir, `${ddl}\nINSERT INTO logs.web FORMAT JSONEachRow\n${insert}\n`); clickhouse(dir, recent); check(true, `table logs.web : ${rows.length + 4} documents`); }
  catch (e) { check(false, 'table logs.web', errorOf(e)); }
  const params = { time_from: '2026-10-01T00:00:00.000Z', time_to: '2026-10-02T00:00:00.000Z' };
  const results = new Map();
  let ran = 0, failed = 0;
  for (const x of inv.entries) for (const q of x.queries) {
    if (!q.sql) continue;
    try { results.set(`${x.title} / ${q.title}`, clickhouse(dir, q.sql, params)); ran++; }
    catch (e) { failed++; check(false, `${x.title} / ${q.title}`, errorOf(e)); }
  }
  check(!failed && ran > 0, `inventaire Kibana : ${ran} requête(s) exécutée(s) sur ClickHouse`, failed ? `${failed} en échec` : '');

  // Valeurs contrôlées : calculées ici sur les mêmes documents
  const inRange = rows.filter(r => { const t = Date.parse(r.timestamp.replace(' ', 'T') + 'Z'); return t >= Date.parse(params.time_from) && t <= Date.parse(params.time_to); });
  const get = k => results.get(k) || [];
  const errors = inRange.filter(r => r['http.response.status_code'] >= 500).length;
  const ratio = get('Taux d’erreur (formule) / Requête')[0];
  check(ratio && Math.abs(ratio.Taux_d_erreur - errors / inRange.length) < 1e-12, 'Lens, formule count(kql=…) / count() : part des erreurs', ratio ? `${ratio.Taux_d_erreur} pour ${errors}/${inRange.length}` : 'aucune ligne');
  const docs = get('Erreurs 5xx récentes / Documents');
  const expectedDocs = inRange.filter(r => r['http.response.status_code'] >= 500 && r['service.name'] === 'checkout' && r['url.path'] !== '/health');
  check(docs.length === Math.min(500, expectedDocs.length) && docs.every((d, i) => i === 0 || d.timestamp <= docs[i - 1].timestamp), 'recherche Discover : KQL, filtre de pastille et tri', `${docs.length} documents, ${expectedDocs.length} attendus`);
  const lat = get('Latence moyenne et p95 par heure / Requête');
  const hourly = new Map();
  for (const r of inRange.filter(r => ['checkout', 'panier'].includes(r['service.name']))) { const h = r.timestamp.slice(0, 13); if (!hourly.has(h)) hourly.set(h, []); hourly.get(h).push(r['event.duration']); }
  const avgOk = lat.length === hourly.size && lat.every(l => { const v = [...hourly.values()].find(xs => Math.abs(xs.reduce((a, b) => a + b, 0) / xs.length - l.Latence_moyenne) < 1e-6); return !!v; });
  check(avgOk, 'visualisation agrégée : moyenne par heure, filtre KQL service.name: (checkout or panier)', `${lat.length} heures, ${hourly.size} attendues`);
  const pic = get('Pic d’erreurs 5xx / Condition')[0];
  check(pic && pic.count === 3 && pic.declenchee === 0, 'règle .es-query : erreurs des 5 dernières minutes et décision du seuil (> 100)', JSON.stringify(pic));
  const lat2 = get('Latence moyenne par service / Condition');
  const checkout = lat2.find(r => r.groupe === 'checkout');
  check(checkout && checkout.declenchee === 1 && lat2.every(r => r.declenchee === (r.valeur > 500000000 ? 1 : 0)), 'règle .index-threshold : moyenne par service sur 15 minutes, décision par groupe', JSON.stringify(lat2));
  // Règle de détection à seuil : les documents anciens sont hors de la fenêtre now-6m
  const brute = get('Connexions refusées en rafale / Détection');
  check(results.has('Connexions refusées en rafale / Détection') && brute.length === 0, 'règle de détection à seuil : fenêtre now-6m, aucun groupe sur des documents anciens', `${brute.length} groupe(s)`);

  /* ---------- Tableau de bord Grafana, sur la même table ---------- */
  // Chaque requête est interpolée comme Grafana et le plugin ClickHouse l’auraient fait, puis exécutée
  const gcfg = E.mergeConfig(E.DEFAULT_CONFIG, E.parseYAMLConfig(rd('examples/grafana/passerelle.yaml')));
  const g = E.grafanaDashboard(rd('examples/grafana/supervision_es.json'), gcfg, { index: 'logs-web-*' });
  const from = Date.parse(params.time_from), to = Date.parse(params.time_to);
  const run = (sql, vars) => clickhouse(dir, grafanaInterpolate(sql, { from, to, intervalSeconds: 600, vars }));
  const ALL = { service: '$__all', methode: 'GET', champ: 'message', pas: '10m' };
  const gres = new Map(); let gran = 0, gfailed = 0;
  const gtry = (key, sql, vars) => { try { gres.set(key, run(sql, vars)); gran++; } catch (e) { gfailed++; check(false, `Grafana ${key}`, errorOf(e)); } };
  for (const p of g.report.panels) for (const t of p.targets) gtry(`${p.title} / ${t.refId}`, t.sql, ALL);
  for (const v of g.report.variables.filter(v => v.sql)) gtry(`variable ${v.name}`, v.sql, ALL);
  for (const a of g.report.annotations.filter(a => a.sql)) gtry(`annotation ${a.name}`, a.sql, ALL);
  check(!gfailed && gran > 15, `tableau de bord Grafana : ${gran} requête(s) interpolées et exécutées`, gfailed ? `${gfailed} en échec` : '');
  const gget = k => gres.get(k) || [];
  const prod = inRange.filter(r => r['service.environment'] === 'production');
  const series = gget('Requêtes par service / A');
  check(series.reduce((n, x) => n + x.Count, 0) === prod.length && series.every((x, i) => i === 0 || x.time >= series[i - 1].time), 'Grafana, terms puis date_histogram, « All » : tous les documents de production, triés par temps', `${series.reduce((n, x) => n + x.Count, 0)} pour ${prod.length}`);
  const one = run(g.report.panels.find(p => p.title === 'Erreurs 5xx').targets[0].sql, Object.assign({}, ALL, { service: ['checkout', 'panier'] }))[0];
  check(one && one.Count === inRange.filter(r => r['http.response.status_code'] >= 500 && ['checkout', 'panier'].includes(r['service.name'])).length, 'Grafana, variable à deux valeurs : liste IN, valeur unique sans regroupement', JSON.stringify(one));
  const fam = Object.fromEntries(gget('Familles de statuts / A').map(x => [x.filtre, x.Count]));
  const famOk = fam['2xx'] === inRange.filter(r => r['http.response.status_code'] < 300).length && fam['5xx'] === inRange.filter(r => r['http.response.status_code'] >= 500).length;
  check(famOk, 'Grafana, regroupement Filters (Lucene) : un groupe par filtre', JSON.stringify(fam));
  const svc = gget('variable service').map(x => x.valeur);
  check(JSON.stringify(svc) === JSON.stringify([...new Set(prod.map(r => r['service.name']))].sort()), 'Grafana, variable terms : valeurs distinctes, ordre alphabétique', JSON.stringify(svc));
  const lat10 = gget('Latence : moyenne et centiles / A');
  const b10 = new Map(); for (const r of inRange) { const t = Math.floor(Date.parse(r.timestamp.replace(' ', 'T') + 'Z') / 600000) * 600000; if (!b10.has(t)) b10.set(t, []); b10.get(t).push(r['event.duration']); }
  const firstBucket = lat10.find(x => x['Average event.duration'] !== null);
  const t0 = firstBucket && Date.parse(firstBucket.time.replace(' ', 'T') + 'Z');
  check(firstBucket && b10.has(t0) && Math.abs(b10.get(t0).reduce((a, b) => a + b, 0) / b10.get(t0).length - firstBucket['Average event.duration']) < 1e-6 && lat10.length === 145, 'Grafana, date_histogram 10m : tranches alignées, comblées sur la période (WITH FILL), moyenne exacte', `${lat10.length} tranches`);
}

rmSync(WORK, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} échec(s)\n` : '\nTout s’exécute sur ClickHouse, et chaque valeur contrôlée est juste.\n');
process.exit(failures ? 1 : 0);
