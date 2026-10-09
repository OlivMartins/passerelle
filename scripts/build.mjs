#!/usr/bin/env node
/*
 * Construction de Passerelle
 *   node scripts/build.mjs            interface, bundle serveur, binaire Linux x86_64 et archive de release
 *   node scripts/build.mjs --ui-only  interface autonome uniquement (dist/passerelle.html)
 *
 * Le binaire est un « single executable application » Node.js : il doit être construit
 * avec un Node.js 24 officiel pour Linux x86_64. Par défaut, le Node qui exécute ce script ;
 * sinon, celui désigné par NODE_SEA_BASE.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const rd = p => readFileSync(join(ROOT, p), 'utf8');
const { version: VERSION } = JSON.parse(rd('package.json'));
const uiOnly = process.argv.includes('--ui-only');
const step = msg => process.stdout.write(`• ${msg}\n`);

/* ---------- Sources ---------- */
const ENGINE = ['src/engine/base.js', 'src/engine/dsl.js', 'src/engine/logstash.js'].map(rd).join('');

function examples() {
  const index = JSON.parse(rd('examples/index.json'));
  const out = {};
  for (const [kind, list] of Object.entries(index)) {
    out[kind] = list.map(e => ({ title: e.title, file: basename(e.file), text: rd(join('examples', e.file)) }));
  }
  return out;
}

function buildUI() {
  const script = "(function () {\n'use strict';\n" + ENGINE + '\nconst EXAMPLES = ' + JSON.stringify(examples()) + ';\n' + rd('src/ui/app.js') + '\n})();\n';
  const html = rd('src/ui/index.html')
    .replace('/* @@STYLES@@ */', () => rd('src/ui/styles.css').trimEnd())
    .replace('/* @@SCRIPT@@ */', () => script.replace(/<\/script/gi, '<\\/script').trimEnd());
  writeFileSync(join(DIST, 'passerelle.html'), html);
  step(`dist/passerelle.html (${Math.round(html.length / 1024)} Kio)`);
}

function buildServer() {
  const server = rd('src/server.js').replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${VERSION}';`);
  const js = "'use strict';\n/* Passerelle — binaire autonome : moteur de traduction + serveur + CLI */\n" + ENGINE + server;
  writeFileSync(join(DIST, 'passerelle.cjs'), js);
  execFileSync(process.execPath, ['--check', join(DIST, 'passerelle.cjs')]);
  step('dist/passerelle.cjs');
}

/* ---------- Binaire autonome (Node.js SEA) ---------- */
const base = process.env.NODE_SEA_BASE || process.execPath;

// Le binaire embarque Node.js : sa licence (MIT et composants tiers) accompagne l’archive.
// Les distributions officielles la placent à la racine, à côté de bin/.
function nodeLicense() {
  const p = join(dirname(dirname(realpathSync(base))), 'LICENSE');
  if (!existsSync(p)) throw new Error(`licence de Node.js introuvable (${p}) : utilisez une distribution officielle de Node.js 24`);
  return p;
}

function buildBinary() {
  const nodeVersion = execFileSync(base, ['--version'], { encoding: 'utf8' }).trim();
  const arch = execFileSync(base, ['-p', 'process.platform + "-" + process.arch'], { encoding: 'utf8' }).trim();
  if (!nodeVersion.startsWith('v24.') || arch !== 'linux-x64') {
    throw new Error(`Node.js 24 pour Linux x86_64 requis pour le binaire (trouvé ${nodeVersion} ${arch}). Définissez NODE_SEA_BASE ou lancez avec --ui-only.`);
  }
  // Chemins relatifs : le binaire ne doit contenir aucun chemin de la machine de construction
  writeFileSync(join(DIST, 'sea-config.json'), JSON.stringify({
    main: 'passerelle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    assets: { 'index.html': 'passerelle.html' }
  }, null, 2));
  execFileSync(base, ['--experimental-sea-config', 'sea-config.json'], { cwd: DIST, stdio: ['ignore', 'ignore', 'inherit'] });

  const bin = join(DIST, 'passerelle');
  copyFileSync(base, bin);
  chmodSync(bin, 0o755);
  try { execFileSync('strip', ['--strip-debug', bin]); } catch { /* strip absent : binaire un peu plus gros */ }
  const postject = join(ROOT, 'node_modules', '.bin', 'postject');
  if (!existsSync(postject)) throw new Error('postject introuvable : lancez npm ci');
  execFileSync(postject, [bin, 'NODE_SEA_BLOB', join(DIST, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'ignore' });
  const v = execFileSync(bin, ['version'], { encoding: 'utf8' }).trim();
  rmSync(join(DIST, 'sea-prep.blob')); rmSync(join(DIST, 'sea-config.json'));
  step(`dist/passerelle (${Math.round(statSync(bin).size / 1048576)} Mio, ${v})`);
}

/* ---------- Archive de release ---------- */
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');

function buildArchive() {
  const name = `passerelle-${VERSION}-linux-x86_64`;
  const stage = join(DIST, name);
  rmSync(stage, { recursive: true, force: true });
  const layout = [
    ['bin/passerelle', join(DIST, 'passerelle'), 0o755],
    ['systemd/passerelle.service', join(ROOT, 'packaging/passerelle.service'), 0o644],
    ['etc/passerelle.yaml', join(ROOT, 'packaging/passerelle.yaml'), 0o644],
    ['etc/passerelle.env.example', join(ROOT, 'packaging/passerelle.env.example'), 0o644],
    ['install.sh', join(ROOT, 'packaging/install.sh'), 0o755],
    ['README.md', join(ROOT, 'docs/INSTALL.md'), 0o644],
    ['LICENSE', join(ROOT, 'LICENSE'), 0o644],
    ['NOTICE', join(ROOT, 'NOTICE'), 0o644],
    ['THIRD_PARTY_LICENSES/nodejs.txt', nodeLicense(), 0o644]
  ];
  for (const [rel, src, mode] of layout) {
    mkdirSync(dirname(join(stage, rel)), { recursive: true });
    copyFileSync(src, join(stage, rel));
    chmodSync(join(stage, rel), mode);
  }
  writeFileSync(join(stage, 'SHA256SUMS'), layout.map(([rel]) => `${sha256(join(stage, rel))}  ${rel}`).join('\n') + '\n');

  // Archive reproductible : propriétaire, ordre et dates fixés
  const epoch = process.env.SOURCE_DATE_EPOCH || String(Math.floor(Date.now() / 1000));
  const tgz = `${name}.tar.gz`;
  execFileSync('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', tgz, name], { cwd: DIST });
  writeFileSync(join(DIST, `${tgz}.sha256`), `${sha256(join(DIST, tgz))}  ${tgz}\n`);
  rmSync(stage, { recursive: true, force: true });
  step(`dist/${tgz} (${Math.round(statSync(join(DIST, tgz)).size / 1048576)} Mio) et ${tgz}.sha256`);
}

try {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  step(`Passerelle ${VERSION}`);
  buildUI();
  if (!uiOnly) { buildServer(); buildBinary(); buildArchive(); }
} catch (e) {
  process.stderr.write(`échec de la construction : ${e.message}\n`);
  process.exit(1);
}
