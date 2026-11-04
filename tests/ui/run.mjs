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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page_ = join(ROOT, 'dist', 'passerelle.html');
if (!existsSync(page_)) {
  console.error('dist/passerelle.html absent : lancez npm run build:ui');
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM || ROOT, '/'))('playwright'));
} catch (e) {
  console.error('Playwright introuvable (npm install --no-save playwright, ou PLAYWRIGHT_FROM) :', e.message);
  process.exit(2);
}

let failed = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(`pageerror ${e.message}`));
p.on('console', m => {
  if (m.type() === 'error') errs.push(`console ${m.text()}`);
});
await p.goto(`file://${page_}`);

const text = async sel => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ');
const VERDICT = /(Prête|À vérifier|À reprendre|Non reconnue)/;

await p.click('[data-view="dsl"]');
await p.waitForTimeout(400);
{
  const v = await text('#view-dsl [data-role="verdict"]');
  check(
    VERDICT.test(v) && /Sur les 24 dernières heures/.test(v),
    'section dsl : verdict et phrase de synthèse',
    v.slice(0, 160)
  );
}
// Ingestion : deux traducteurs de pipelines (Elasticsearch, Logstash) derrière un sélecteur, comme « Autres sources »
await p.click('[data-view="ingest"]');
await p.waitForTimeout(400);
{
  const seg = (await p.locator('#view-ingest [data-role="ingest-seg"] button').allInnerTexts()).map(s => s.trim());
  check(
    seg.join('|') === 'Elasticsearch|Logstash',
    'ingestion : le sélecteur propose Elasticsearch puis Logstash',
    seg.join(' | ')
  );
  const pressed = await p.locator('#view-ingest [data-ingest="ingest"]').getAttribute('aria-pressed');
  const esShown = await p.locator('#bench-ingest').isVisible();
  const lsShown = await p.locator('#bench-ls').isVisible();
  check(
    pressed === 'true' && esShown && !lsShown,
    'ingestion : Elasticsearch ouvert par défaut, le banc Logstash caché',
    `${pressed} ${esShown} ${lsShown}`
  );
  const v = await text('#bench-ingest [data-role="verdict"]');
  check(
    VERDICT.test(v) && /pipeline traduit en VRL/.test(v),
    'ingestion, Elasticsearch : verdict et phrase de synthèse',
    v.slice(0, 160)
  );
}
for (const [tab, must] of [
  ['flow', /Source logstash/],
  ['notes', /uri_parts/],
  ['validate', /vector validate/]
]) {
  await p.click(`#bench-ingest [data-tab="${tab}"]`);
  await p.waitForTimeout(150);
  const t = await text('#bench-ingest [data-role="out"]');
  check(must.test(t), `ingestion, onglet ${tab}`, t.slice(0, 160));
}
// Logstash : l'ancienne section « Pipelines », son banc, ses exemples et sa topologie
await p.click('#view-ingest [data-ingest="ls"]');
await p.waitForTimeout(500);
{
  const pressed = await p.locator('#view-ingest [data-ingest="ls"]').getAttribute('aria-pressed');
  const lsShown = await p.locator('#bench-ls').isVisible();
  const esShown = await p.locator('#bench-ingest').isVisible();
  check(
    pressed === 'true' && lsShown && !esShown,
    'ingestion, Logstash : son banc remplace celui d’Elasticsearch',
    `${pressed} ${lsShown} ${esShown}`
  );
  const v = await text('#bench-ls [data-role="verdict"]');
  check(
    VERDICT.test(v) && /Lit nginx-raw/.test(v),
    'ingestion, Logstash : verdict et phrase de synthèse',
    v.slice(0, 160)
  );
  const ex = (await p.locator('#view-ingest [data-act="example"] option').allInnerTexts()).join(' | ');
  const exEs = await p.locator('#view-ingest [data-act="example"] option').count();
  check(
    exEs >= 2 && !/^Charger un exemple$/.test(ex),
    'ingestion, Logstash : le menu d’exemples propose des pipelines Logstash',
    ex
  );
  await p.click('#bench-ls [data-tab="flow"]');
  await p.waitForTimeout(300);
  const edges = await p.locator('#bench-ls .flow svg.edges path').count();
  const nodes = await p.locator('#bench-ls .flow .node').count();
  check(nodes >= 3 && edges >= 2, 'ingestion, Logstash : la topologie se dessine', `${nodes} nœuds, ${edges} liens`);
  const accept = await p.locator('#view-ingest [data-role="file"]').getAttribute('accept');
  check(/\.conf/.test(accept), 'ingestion, Logstash : le sélecteur de fichiers attend des .conf', accept);
}

// Navigation : Kibana n’a plus de section à part (il ouvre « Autres sources »), ni Logstash (il ouvre « Ingestion ») : 6 sections
{
  const navItems = await p.locator('.nav-item').count();
  const kibanaNav = await p.locator('[data-view="kibana"]').count();
  const lsNav = await p.locator('[data-view="ls"]').count();
  check(
    navItems === 6 && kibanaNav === 0 && lsNav === 0,
    'navigation : 6 sections, plus d’entrée Kibana ni Pipelines à part',
    `${navItems} entrées, ${kibanaNav} Kibana, ${lsNav} Pipelines`
  );
  const subIngest = await text('[data-view="ingest"] small');
  check(
    /Elasticsearch, Logstash/.test(subIngest),
    'navigation : « Ingestion » annonce Elasticsearch et Logstash',
    subIngest
  );
  const sub = await text('[data-view="tools"] small');
  check(/^Kibana, Grafana/.test(sub), 'navigation : « Autres sources » annonce Kibana en premier', sub);
}

// Kibana : l’outil d’« Autres sources » ouvre l’exemple, chaque panneau montre son SQL et sa requête DSL reconstituée
await p.click('[data-view="tools"]');
await p.waitForTimeout(500);
{
  const seg = (await p.locator('#view-tools [data-role="tool-seg"] button').allInnerTexts()).map(s => s.trim());
  check(
    seg[0] === 'Kibana' && !seg.some(s => /Inventaire/.test(s)),
    'autres sources : l’outil s’appelle Kibana, plus « Inventaire Kibana »',
    seg.join(' | ')
  );
  const shown = await p.locator('#kb').isVisible();
  const generic = await p.locator('#tools-bench').isVisible();
  const pressed = await p.locator('#view-tools [data-tool="kibana"]').getAttribute('aria-pressed');
  check(
    shown && !generic && pressed === 'true',
    'autres sources : Kibana ouvert par défaut avec son propre banc',
    `${shown} ${generic} ${pressed}`
  );
  const v = await text('#kb [data-role="verdict"]');
  const o = await text('#kb [data-role="out"]');
  check(
    VERDICT.test(v) &&
      /11 panneaux, 14 requêtes SQL/.test(v) &&
      /Filtre commun/.test(o) &&
      /Requêtes par service/.test(o),
    'kibana : tableau de bord et requêtes de ses panneaux',
    `${v.slice(0, 120)} || ${o.slice(0, 120)}`
  );
  await p.click('#kb .kb-row:has-text("Débit sortant par hôte")');
  await p.waitForTimeout(200);
  const o2 = await text('#kb [data-role="out"]');
  check(
    /Octets par tranche/.test(o2) &&
      /Taux d’erreur/.test(o2) &&
      /FROM logs\.events/.test(o2) &&
      !/Filtre commun/.test(o2),
    'kibana : SQL d’un panneau',
    o2.slice(0, 160)
  );
  for (const [tab, must] of [
    ['dsl', /GET logs-web-\*\/_search/],
    ['notes', /Intervalle automatique/],
    ['anatomy', /Supervision du site web/]
  ]) {
    await p.click(`#kb [data-tab="${tab}"]`);
    await p.waitForTimeout(150);
    const t = await text('#kb [data-role="out"]');
    check(must.test(t), `kibana, onglet ${tab}`, t.slice(0, 160));
  }
  // Le menu d’exemples de l’en-tête sert le banc Kibana ; passer à un autre outil le remplace, et revenir garde la sélection
  const ex = (await p.locator('#view-tools [data-act="example"] option').allInnerTexts()).map(s => s.trim());
  check(
    ex.length > 1 && /supervision/i.test(ex.join(' ')),
    'kibana : le menu d’exemples de l’en-tête propose ceux de Kibana',
    ex.join(' | ')
  );
  await p.click('#view-tools [data-tool="grafana"]');
  await p.waitForTimeout(300);
  const exG = (await p.locator('#view-tools [data-act="example"] option').allInnerTexts()).join(' | ');
  const switched = !(await p.locator('#kb').isVisible()) && (await p.locator('#tools-bench').isVisible());
  check(
    switched && exG !== ex.join(' | '),
    'autres sources : Grafana remplace le banc Kibana et ses exemples',
    `${switched} ${exG}`
  );
  await p.click('#view-tools [data-tool="kibana"]');
  await p.waitForTimeout(300);
  const kept = await p.locator('#kb .kb-row[aria-selected="true"]').first().innerText();
  check(
    /Débit sortant par hôte/.test(kept) && (await p.locator('#kb').isVisible()),
    'autres sources : retour à Kibana, objet choisi conservé',
    kept
  );
  await p.click('#kb .kb-row.overview');
  await p.click('#kb [data-tab="synth"]');
  await p.waitForTimeout(150);
  const t = await text('#kb [data-role="out"]');
  check(/Synthèse/.test(t) && /Prérequis|Principaux points/.test(t), 'kibana : vue d’ensemble', t.slice(0, 160));
  // Un export ouvert par le sélecteur de fichiers de l’en-tête remplace l’exemple ; le filtre réduit l’arbre
  await p.setInputFiles('#view-tools [data-role="file"]', join(ROOT, 'examples', 'kibana', 'regles_detection.ndjson'));
  await p.waitForTimeout(400);
  const all = await text('#kb [data-role="tree"]');
  const fname = await text('#kb [data-role="fname"]');
  await p.fill('#kb [data-role="filter"]', 'rafale');
  await p.waitForTimeout(150);
  const tree = await text('#kb [data-role="tree"]');
  check(
    /regles_detection\.ndjson/.test(fname) &&
      /Accès à l’administration/.test(all) &&
      !/Supervision du site web/.test(all) &&
      /Connexions refusées en rafale/.test(tree) &&
      !/Accès à l’administration/.test(tree),
    'kibana : fichier ouvert et filtre',
    `${fname} || ${all.slice(0, 120)} || ${tree.slice(0, 120)}`
  );
  // Un second export s’ajoute au premier (une puce par fichier, les objets sont réunis)
  await p.fill('#kb [data-role="filter"]', '');
  await p.setInputFiles('#view-tools [data-role="file"]', join(ROOT, 'examples', 'kibana', 'supervision_web.ndjson'));
  await p.waitForTimeout(400);
  const chips = await p.locator('#kb .file-chip').count();
  const both = await text('#kb [data-role="tree"]');
  check(
    chips === 2 && /Accès à l’administration/.test(both) && /Supervision du site web/.test(both),
    'kibana : un second export s’ajoute au premier',
    `${chips} puces || ${both.slice(0, 120)}`
  );
  // Zone de dépôt : c’est celle du banc affiché qui s’illumine
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{}'], 'x.ndjson'));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const lit = await p.locator('#kb .pane-in.dragging').count();
  const litGeneric = await p.locator('#tools-bench .pane-in.dragging').count();
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{}'], 'x.ndjson'));
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  check(
    lit === 1 && litGeneric === 0,
    'kibana : la zone de dépôt du banc affiché s’illumine',
    `${lit} / ${litGeneric}`
  );
}

await p.click('[data-view="tools"]');
await p.waitForTimeout(500);
for (const [tool, verdict, out, tab2] of [
  ['grafana', /panneaux convertis/, /Conversion Grafana vers ClickHouse/, /"__inputs"/],
  ['watcher', /watches à migrer, \d+ conditions traduites/, /Migration des watches Elasticsearch/, /AS declenchee/],
  ['schema', /table ClickHouse à créer/, /CREATE TABLE IF NOT EXISTS logs\.events/, /clickhouse:/],
  ['analyzers', /analyseurs à traduire/, /Analyseurs personnalisés/, /ALTER TABLE logs\.catalogue/]
]) {
  await p.click(`#view-tools [data-tool="${tool}"]`);
  await p.waitForTimeout(500);
  const v = await text('#tools-bench [data-role="verdict"]');
  const o = await text('#tools-bench [data-role="out"]');
  check(
    VERDICT.test(v) && verdict.test(v) && out.test(o),
    `autres sources, ${tool} : verdict et résultat`,
    `${v.slice(0, 100)} || ${o.slice(0, 100)}`
  );
  await p.locator('#tools-bench [data-tab]').nth(1).click();
  await p.waitForTimeout(150);
  const o2 = await text('#tools-bench [data-role="out"]');
  check(tab2.test(o2), `autres sources, ${tool} : deuxième onglet`, o2.slice(0, 120));
}
// Dépôt d’un fichier par glisser-déposer, comme le fait le navigateur
const drop = (name, content) =>
  p.evaluate(
    ([n, c]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([c], n, { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, content]
  );
const ndjson = readFileSync(join(ROOT, 'examples', 'kibana', 'regles_detection.ndjson'), 'utf8');

// Des watches déposées sur la section Requêtes vont à l’outil Watcher, pas à la traduction DSL
await p.click('[data-view="dsl"]');
await p.waitForTimeout(300);
await drop('console.txt', readFileSync(join(ROOT, 'examples', 'watcher', 'console.txt'), 'utf8'));
await p.waitForTimeout(600);
{
  const visible = await p.locator('#view-tools').isVisible();
  const pressed = await p.locator('#view-tools [data-tool="watcher"]').getAttribute('aria-pressed');
  const v = await text('#tools-bench [data-role="verdict"]');
  check(
    visible && pressed === 'true' && /2 watches à migrer/.test(v),
    'watches déposées sur Requêtes : aiguillées vers l’outil Watcher',
    `${visible} ${pressed} ${v.slice(0, 120)}`
  );
}
// Un export Kibana déposé ailleurs ouvre l’outil Kibana d’« Autres sources », où qu’il tombe
{
  await p.click('[data-view="dsl"]');
  await p.waitForTimeout(300);
  const before = await p.locator('#kb .file-chip').count();
  await drop('export.ndjson', ndjson);
  await p.waitForTimeout(600);
  const visible = await p.locator('#view-tools').isVisible();
  const kb = await p.locator('#kb').isVisible();
  const pressed = await p.locator('#view-tools [data-tool="kibana"]').getAttribute('aria-pressed');
  const after = await p.locator('#kb .file-chip').count();
  check(
    visible && kb && pressed === 'true' && after === before + 1,
    'export Kibana déposé sur Requêtes : aiguillé vers l’outil Kibana',
    `${visible} ${kb} ${pressed} ${before}→${after} puces`
  );
  // Déposé pendant qu’un autre outil est affiché : l’outil change, et le menu d’exemples avec lui
  await p.click('#view-tools [data-tool="grafana"]');
  await p.waitForTimeout(300);
  await drop('export.ndjson', ndjson);
  await p.waitForTimeout(600);
  const pressedK = await p.locator('#view-tools [data-tool="kibana"]').getAttribute('aria-pressed');
  const ex = (await p.locator('#view-tools [data-act="example"] option').allInnerTexts()).join(' | ');
  check(
    pressedK === 'true' && (await p.locator('#kb').isVisible()) && /Supervision web/.test(ex),
    'export Kibana déposé sur Grafana : bascule sur Kibana, exemples à jour',
    `${pressedK} ${ex}`
  );
  // Un fichier .json qui n’est pas un export Kibana n’est pas avalé par l’outil Kibana : il va où son contenu l’envoie
  await drop('requete.json', '{ "query": { "match_all": {} } }');
  await p.waitForTimeout(500);
  check(
    await p.locator('#view-dsl').isVisible(),
    'requête .json déposée sur Kibana : traduite dans Requêtes, pas lue comme un export',
    'la vue Requêtes n’est pas affichée'
  );
}
// Une vue « kibana » mémorisée par une version précédente mène à l’outil Kibana
{
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p2.addInitScript(() => {
    localStorage.setItem('passerelle:view', JSON.stringify('kibana'));
    localStorage.setItem('passerelle:tool', JSON.stringify('grafana'));
  });
  p2.on('pageerror', e => errs.push(`pageerror ${e.message}`));
  await p2.goto(`file://${page_}`);
  await p2.waitForTimeout(500);
  const visible = await p2.locator('#view-tools').isVisible();
  const pressed = await p2.locator('#view-tools [data-tool="kibana"]').getAttribute('aria-pressed');
  const current = await p2.locator('.nav-item[aria-current="page"]').getAttribute('data-view');
  check(
    visible && pressed === 'true' && current === 'tools',
    'ancienne vue « kibana » mémorisée : ouvre l’outil Kibana d’Autres sources',
    `${visible} ${pressed} ${current}`
  );
  await p2.close();
}
// Un pipeline Logstash déposé ailleurs ouvre l’outil Logstash d’« Ingestion », où qu’il tombe ; un pipeline d’ingestion, l’outil Elasticsearch
{
  const conf = readFileSync(join(ROOT, 'examples', 'logstash', 'routage.conf'), 'utf8');
  const yml = readFileSync(join(ROOT, 'examples', 'ingest', 'navigateur.yml'), 'utf8');
  await p.click('[data-view="dsl"]');
  await p.waitForTimeout(300);
  await drop('routage.conf', conf);
  await p.waitForTimeout(600);
  {
    const visible = await p.locator('#view-ingest').isVisible();
    const ls = await p.locator('#bench-ls').isVisible();
    const pressed = await p.locator('#view-ingest [data-ingest="ls"]').getAttribute('aria-pressed');
    const current = await p.locator('.nav-item[aria-current="page"]').getAttribute('data-view');
    // Le fichier déposé remplace le pipeline d’exemple : l’éditeur et le nom du fichier le montrent
    const fname = await text('#bench-ls [data-role="fname"]');
    check(
      visible && ls && pressed === 'true' && current === 'ingest' && fname === 'routage.conf',
      'pipeline Logstash déposé sur Requêtes : aiguillé vers l’outil Logstash d’Ingestion',
      `${visible} ${ls} ${pressed} ${current} ${fname}`
    );
  }
  // Déposé pendant que Logstash est affiché : un pipeline d’ingestion bascule sur Elasticsearch, le menu d’exemples avec lui
  await drop('navigateur.yml', yml);
  await p.waitForTimeout(600);
  {
    const pressed = await p.locator('#view-ingest [data-ingest="ingest"]').getAttribute('aria-pressed');
    const es = await p.locator('#bench-ingest').isVisible();
    const ls = await p.locator('#bench-ls').isVisible();
    const ex = (await p.locator('#view-ingest [data-act="example"] option').allInnerTexts()).join(' | ');
    const accept = await p.locator('#view-ingest [data-role="file"]').getAttribute('accept');
    check(
      pressed === 'true' && es && !ls && /yml/.test(accept),
      'pipeline d’ingestion déposé sur Logstash : bascule sur Elasticsearch, exemples et fichiers acceptés à jour',
      `${pressed} ${es} ${ls} ${accept} || ${ex}`
    );
  }
}
// Une vue « ls » (l’ancienne section Pipelines) mémorisée par une version précédente mène à l’outil Logstash d’Ingestion
{
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p2.addInitScript(() => {
    localStorage.setItem('passerelle:view', JSON.stringify('ls'));
    localStorage.setItem('passerelle:ingest-tool', JSON.stringify('ingest'));
  });
  p2.on('pageerror', e => errs.push(`pageerror ${e.message}`));
  await p2.goto(`file://${page_}`);
  await p2.waitForTimeout(500);
  const visible = await p2.locator('#view-ingest').isVisible();
  const lsShown = await p2.locator('#bench-ls').isVisible();
  const pressed = await p2.locator('#view-ingest [data-ingest="ls"]').getAttribute('aria-pressed');
  const current = await p2.locator('.nav-item[aria-current="page"]').getAttribute('data-view');
  check(
    visible && lsShown && pressed === 'true' && current === 'ingest',
    'ancienne vue « ls » mémorisée : ouvre l’outil Logstash d’Ingestion',
    `${visible} ${lsShown} ${pressed} ${current}`
  );
  await p2.close();
}
// Mobile : 6 entrées dans la barre du bas, rien ne déborde, le banc Kibana s’affiche
{
  const p3 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p3.on('pageerror', e => errs.push(`pageerror ${e.message}`));
  await p3.goto(`file://${page_}`);
  await p3.click('[data-view="tools"]');
  await p3.waitForTimeout(500);
  const m = await p3.evaluate(() => ({
    items: document.querySelectorAll('.nav-item').length,
    overflow: document.documentElement.scrollWidth - innerWidth,
    h: Math.round(document.querySelector('#kb .pane-in').getBoundingClientRect().height)
  }));
  check(
    m.items === 6 && m.overflow <= 0 && (await p3.locator('#kb').isVisible()) && m.h >= 380,
    'mobile : 6 entrées, pas de débordement, banc Kibana affiché',
    JSON.stringify(m)
  );
  // Ingestion sur téléphone : le sélecteur Elasticsearch / Logstash tient dans l’écran et chaque banc s’affiche
  await p3.click('[data-view="ingest"]');
  await p3.waitForTimeout(400);
  await p3.click('#view-ingest [data-ingest="ls"]');
  await p3.waitForTimeout(400);
  const mi = await p3.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    h: Math.round(document.querySelector('#bench-ls .pane-in').getBoundingClientRect().height),
    seg: Math.round(document.querySelector('#view-ingest [data-role="ingest-seg"]').getBoundingClientRect().right)
  }));
  check(
    mi.overflow <= 0 && mi.h >= 300 && mi.seg <= 390 && (await p3.locator('#bench-ls').isVisible()),
    'mobile : Ingestion, sélecteur et banc Logstash dans l’écran',
    JSON.stringify(mi)
  );
  await p3.close();
}
check(errs.length === 0, 'aucune erreur de page ni de console', errs.join(' | '));
await browser.close();
if (failed) {
  console.error(`\n${failed} vérification(s) en échec`);
  process.exit(1);
}
console.log('\nL’interface passe.');
