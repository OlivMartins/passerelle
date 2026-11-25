#!/usr/bin/env node
/*
 * GIF de démonstration du README (docs/assets/demo-light.gif et demo-dark.gif), rejouable à chaque version.
 *
 * La page assemblée (dist/passerelle.html) est pilotée dans Chromium par Playwright ; un curseur dessiné dans la page
 * porte les fichiers déposés. Chaque étape donne une image et sa durée ; ffmpeg assemble les images (palette commune
 * par thème) en un GIF de 1280 × 800 qui boucle.
 *
 *   npm run build:ui && node scripts/demo.mjs [--theme light|dark] [--out docs/assets]
 *
 * Il faut ffmpeg, et Playwright (pas une dépendance du projet : PLAYWRIGHT_FROM, comme tests/ui/run.mjs).
 * CHROME_BIN désigne un Chromium ou un Chrome déjà installé, à la place de celui de Playwright.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = resolve(ROOT, opt('out', 'docs/assets'));
const THEMES = opt('theme') ? [opt('theme')] : ['light', 'dark'];
const PAGE = join(ROOT, 'dist', 'passerelle.html');
if (!existsSync(PAGE)) {
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
const rd = p => readFileSync(join(ROOT, p), 'utf8');

// Requête déposée dans la première scène : latence par heure et par service
const LATENCE = JSON.stringify(
  {
    size: 0,
    query: {
      bool: {
        filter: [{ range: { '@timestamp': { gte: 'now-7d/d' } } }, { term: { 'service.environment': 'production' } }],
        must_not: [{ match: { message: 'healthcheck' } }]
      }
    },
    aggs: {
      par_heure: {
        date_histogram: { field: '@timestamp', fixed_interval: '1h' },
        aggs: {
          services: {
            terms: { field: 'service.name', size: 5 },
            aggs: { latence: { percentiles: { field: 'latency_ms', percents: [50, 95, 99] } } }
          }
        }
      }
    }
  },
  null,
  2
);

// Curseur et fichier transporté, dessinés dans la page (une capture d’écran ne montre pas le vrai pointeur)
const CURSOR = `(() => {
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;transition:none';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 9-6.2 1.3L7.6 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg><span id="demo-file" style="display:none;margin:2px 0 0 14px;padding:4px 10px;border-radius:7px;background:#fff;color:#1b2a33;font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.18);border:1px solid #e3e3de;white-space:nowrap"></span>';
  document.body.appendChild(c);
})()`;

async function record(theme) {
  const browser = await chromium.launch(
    process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] } : {}
  );
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.addInitScript(t => {
    localStorage.clear();
    localStorage.setItem('passerelle:theme', JSON.stringify(t));
  }, theme);
  await page.goto(`file://${PAGE}`);
  await page.evaluate(CURSOR);
  const frames = [];
  let at = { x: 900, y: 120 };
  const shot = async ms => frames.push({ png: await page.screenshot({ type: 'png' }), ms });
  const pointer = async (x, y, file) =>
    page.evaluate(
      ([x, y, file]) => {
        const c = document.getElementById('demo-cursor');
        c.style.transform = `translate(${x}px, ${y}px)`;
        const f = document.getElementById('demo-file');
        f.style.display = file ? 'inline-block' : 'none';
        f.textContent = file || '';
      },
      [x, y, file || '']
    );
  // Déplacement du curseur en quelques images, avec ou sans fichier
  const move = async (x, y, file, steps = 5) => {
    const from = at;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await pointer(from.x + (x - from.x) * e, from.y + (y - from.y) * e, file);
      await shot(40);
    }
    at = { x, y };
  };
  const center = async sel => {
    const b = await page.locator(sel).first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const click = async (sel, hold = 900) => {
    const c = await center(sel);
    await move(c.x, c.y);
    await page.locator(sel).first().click();
    await page.waitForTimeout(250);
    await shot(hold);
  };
  // Dépôt d’un fichier : le voile de la zone de dépôt, puis la traduction
  const drop = async (sel, name, text, hold = 1600) => {
    await move(at.x, at.y, name, 1);
    const c = await center(sel);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x'));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    });
    await move(c.x, c.y, name, 7);
    await shot(400);
    await page.evaluate(
      ([name, text]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'text/plain' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [name, text]
    );
    await pointer(c.x, c.y);
    await page.waitForTimeout(500);
    await shot(hold);
  };
  const clear = async view => {
    await page.locator(`#view-${view} [data-act="clear"]`).first().click();
    await page.waitForTimeout(150);
  };

  // 1. Requêtes : une requête déposée, traduite, ses remarques et sa lecture
  await page.click('[data-view="dsl"]');
  await clear('dsl');
  await pointer(at.x, at.y);
  await shot(1000);
  await drop('#view-dsl .pane-in', 'latence_par_heure.json', LATENCE, 1800);
  await click('#view-dsl [data-tab="notes"]', 1600);
  await click('#view-dsl [data-tab="anatomy"]', 1800);

  // 2. Log vers Vector : un journal Java déposé, son fuseau, ses champs, l’événement produit et le VRL
  await click('[data-view="logs"]', 700);
  await clear('logs');
  await shot(600);
  await drop('#view-logs .pane-in', 'boutique.log', rd('examples/logs/java_logback.log'), 1600);
  {
    const c = await center('#view-logs [data-role="tz"]');
    await move(c.x, c.y);
    await page.fill('#view-logs [data-role="tz"]', '');
    for (const part of ['Europe/', 'Europe/Paris']) {
      await page.fill('#view-logs [data-role="tz"]', part);
      await page.dispatchEvent('#view-logs [data-role="tz"]', 'input');
      await page.waitForTimeout(300);
      await shot(part === 'Europe/Paris' ? 1400 : 200);
    }
  }
  await click('#view-logs [data-tab="fields"]', 1800);
  await click('#view-logs [data-tab="preview"]', 600);
  // L’événement en erreur : l’exception lue dans la trace de pile
  await page.evaluate(() => {
    const out = document.querySelector('#view-logs [data-role="out"]');
    const key = [...out.querySelectorAll('.t-key')].find(k => k.textContent === '"exception.type"');
    if (key) out.scrollTop += key.getBoundingClientRect().top - out.getBoundingClientRect().top - 90;
  });
  await page.waitForTimeout(150);
  await shot(2200);
  await click('#view-logs [data-tab="vrl"]', 1800);

  // 3. Ingestion : le sélecteur passe à Logstash, un pipeline de routage déposé et sa topologie
  await click('[data-view="ingest"]', 700);
  await click('#view-ingest [data-ingest="ls"]', 600);
  await page.locator('#bench-ls [data-act="clear"]').click();
  await page.waitForTimeout(150);
  await shot(500);
  await drop('#bench-ls .pane-in', 'routage.conf', rd('examples/logstash/routage.conf'), 1400);
  await click('#bench-ls [data-tab="flow"]', 2200);

  // 4. Autres sources : un export Kibana, un tableau de bord et les requêtes SQL d’un panneau
  await click('[data-view="tools"]', 700);
  await page.locator('#kb [data-act="clear"]').click();
  await page.waitForTimeout(150);
  await shot(500);
  await drop('#kb .pane-in', 'supervision_web.ndjson', rd('examples/kibana/supervision_web.ndjson'), 1400);
  // « Effacer » a ouvert le texte de l’export : retour à l’arbre des objets
  await click('#kb [data-mode="tree"]', 1400);
  await click('#kb .kb-row.child >> nth=1', 2000);
  await click('#kb [data-tab="notes"]', 2000);
  await browser.close();
  return frames;
}

function gif(frames, file) {
  const dir = mkdtempSync(join(tmpdir(), 'passerelle-demo-'));
  try {
    const list = [];
    frames.forEach((f, i) => {
      const p = join(dir, `${String(i).padStart(4, '0')}.png`);
      writeFileSync(p, f.png);
      list.push(`file '${p}'`, `duration ${(f.ms / 1000).toFixed(3)}`);
    });
    // La dernière image est répétée : le démultiplexeur concat ignore sinon sa durée
    list.push(`file '${join(dir, `${String(frames.length - 1).padStart(4, '0')}.png`)}'`);
    writeFileSync(join(dir, 'images.txt'), list.join('\n') + '\n');
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        join(dir, 'images.txt'),
        '-filter_complex',
        '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
        '-vsync',
        'vfr',
        '-loop',
        '0',
        file
      ],
      { stdio: 'inherit' }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
for (const theme of THEMES) {
  const frames = await record(theme);
  const file = join(OUT, `demo-${theme}.gif`);
  gif(frames, file);
  const total = frames.reduce((n, f) => n + f.ms, 0);
  console.log(`${file} : ${frames.length} images, ${(total / 1000).toFixed(1)} s`);
}
