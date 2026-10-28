#!/usr/bin/env node
/*
 * Test de l’interface dans un vrai navigateur (Chromium, Playwright) : la page assemblée s’ouvre sans erreur, chaque
 * section traduit son exemple et affiche un verdict, les onglets s’ouvrent.
 *
 *   npm run build:ui && npm run test:ui
 *
 * Playwright n’est pas une dépendance du projet : en CI, il est installé à part (voir .github/workflows/ci.yml).
 * Ailleurs, PLAYWRIGHT_FROM désigne un dossier où « playwright » se résout.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page_ = join(ROOT, 'dist', 'passerelle.html');
if (!existsSync(page_)) { console.error('dist/passerelle.html absent : lancez npm run build:ui'); process.exit(2); }
let chromium;
try { ({ chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM || ROOT, '/'))('playwright')); }
catch (e) { console.error('Playwright introuvable (npm install --no-save playwright, ou PLAYWRIGHT_FROM) :', e.message); process.exit(2); }

let failed = 0;
const check = (ok, name, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failed++; };

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(`pageerror ${e.message}`));
p.on('console', m => { if (m.type() === 'error') errs.push(`console ${m.text()}`); });
await p.goto(`file://${page_}`);

const text = async sel => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ');
const VERDICT = /(Prête|À vérifier|À reprendre|Non reconnue)/;

for (const [view, must] of [['dsl', /Sur les 24 dernières heures/], ['ls', /Lit nginx-raw/], ['ingest', /pipeline traduit en VRL/]]) {
  await p.click(`[data-view="${view}"]`); await p.waitForTimeout(400);
  const v = await text(`#view-${view} [data-role="verdict"]`);
  check(VERDICT.test(v) && must.test(v), `section ${view} : verdict et phrase de synthèse`, v.slice(0, 160));
}
for (const [tab, must] of [['flow', /Source logstash/], ['notes', /uri_parts/], ['validate', /vector validate/]]) {
  await p.click(`#view-ingest [data-tab="${tab}"]`); await p.waitForTimeout(150);
  const t = await text('#view-ingest [data-role="out"]');
  check(must.test(t), `ingestion, onglet ${tab}`, t.slice(0, 160));
}

// Kibana : l’exemple ouvre son tableau de bord, chaque panneau montre son SQL et sa requête DSL reconstituée
await p.click('[data-view="kibana"]'); await p.waitForTimeout(500);
{
  const v = await text('#view-kibana [data-role="verdict"]'); const o = await text('#view-kibana [data-role="out"]');
  check(VERDICT.test(v) && /11 panneaux, 14 requêtes SQL/.test(v) && /Filtre commun/.test(o) && /Requêtes par service/.test(o), 'kibana : tableau de bord et requêtes de ses panneaux', `${v.slice(0, 120)} || ${o.slice(0, 120)}`);
  await p.click('#view-kibana .kb-row:has-text("Débit sortant par hôte")'); await p.waitForTimeout(200);
  const o2 = await text('#view-kibana [data-role="out"]');
  check(/Octets par tranche/.test(o2) && /Taux d’erreur/.test(o2) && /FROM logs\.events/.test(o2) && !/Filtre commun/.test(o2), 'kibana : SQL d’un panneau', o2.slice(0, 160));
  for (const [tab, must] of [['dsl', /GET logs-web-\*\/_search/], ['notes', /Intervalle automatique/], ['anatomy', /Supervision du site web/]]) {
    await p.click(`#view-kibana [data-tab="${tab}"]`); await p.waitForTimeout(150);
    const t = await text('#view-kibana [data-role="out"]');
    check(must.test(t), `kibana, onglet ${tab}`, t.slice(0, 160));
  }
  await p.click('#view-kibana .kb-row.overview'); await p.click('#view-kibana [data-tab="synth"]'); await p.waitForTimeout(150);
  const t = await text('#view-kibana [data-role="out"]');
  check(/Synthèse/.test(t) && /Prérequis|Principaux points/.test(t), 'kibana : vue d’ensemble', t.slice(0, 160));
  // Un export ouvert par le sélecteur de fichiers remplace l’exemple ; le filtre réduit l’arbre
  await p.setInputFiles('#view-kibana input[type="file"]', join(ROOT, 'examples', 'kibana', 'regles_detection.ndjson'));
  await p.waitForTimeout(400);
  const all = await text('#view-kibana [data-role="tree"]'); const fname = await text('#view-kibana [data-role="fname"]');
  await p.fill('#view-kibana [data-role="filter"]', 'rafale'); await p.waitForTimeout(150);
  const tree = await text('#view-kibana [data-role="tree"]');
  check(/regles_detection\.ndjson/.test(fname) && /Accès à l’administration/.test(all) && !/Supervision du site web/.test(all) && /Connexions refusées en rafale/.test(tree) && !/Accès à l’administration/.test(tree), 'kibana : fichier ouvert et filtre', `${fname} || ${all.slice(0, 120)} || ${tree.slice(0, 120)}`);
}

await p.click('[data-view="tools"]'); await p.waitForTimeout(500);
for (const [tool, verdict, out, tab2] of [
  ['kibana', /objets à migrer/, /Inventaire de migration Kibana/, /^ ?Type;Identifiant/],
  ['grafana', /panneaux convertis/, /Conversion Grafana vers ClickHouse/, /"__inputs"/],
  ['schema', /table ClickHouse à créer/, /CREATE TABLE IF NOT EXISTS logs\.events/, /clickhouse:/],
  ['analyzers', /analyseurs à traduire/, /Analyseurs personnalisés/, /ALTER TABLE logs\.catalogue/]
]) {
  await p.click(`#view-tools [data-tool="${tool}"]`); await p.waitForTimeout(500);
  const v = await text('#view-tools [data-role="verdict"]'); const o = await text('#view-tools [data-role="out"]');
  check(VERDICT.test(v) && verdict.test(v) && out.test(o), `autres sources, ${tool} : verdict et résultat`, `${v.slice(0, 100)} || ${o.slice(0, 100)}`);
  await p.locator('#view-tools [data-tab]').nth(1).click(); await p.waitForTimeout(150);
  const o2 = await text('#view-tools [data-role="out"]');
  check(tab2.test(o2), `autres sources, ${tool} : deuxième onglet`, o2.slice(0, 120));
}
check(errs.length === 0, 'aucune erreur de page ni de console', errs.join(' | '));
await browser.close();
if (failed) { console.error(`\n${failed} vérification(s) en échec`); process.exit(1); }
console.log('\nL’interface passe.');
