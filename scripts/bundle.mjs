/*
 * Assemblage des modules de src/ par esbuild (la seule dépendance de construction, avec postject pour le binaire).
 *
 *   bundleUI()      le script de l'interface : src/ui/app.js et ce qu'il importe du moteur, en un IIFE sans dépendance.
 *                   scripts/build.mjs l'insère dans src/ui/index.html.
 *   bundleServer()  le serveur et la ligne de commande : src/server.js, src/node/ et le moteur, en un seul fichier
 *                   CommonJS (celui du binaire autonome et de l'image conteneur). Les tests des commandes le construisent
 *                   de la même façon, pour éprouver ce qui est livré.
 *
 * Le moteur (src/engine) n'importe rien d'autre que ses propres modules : il tourne dans l'un comme dans l'autre.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

// Exemples de l'interface : examples/index.json et les fichiers qu'il désigne
function examples() {
  const index = JSON.parse(rd('examples/index.json'));
  const out = {};
  for (const [kind, list] of Object.entries(index)) {
    out[kind] = list.map(e => ({ title: e.title, file: basename(e.file), text: rd(join('examples', e.file)) }));
  }
  return out;
}

async function bundle(options) {
  const result = await build({
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    ...options
  });
  return result.outputFiles[0].text;
}

// « import EXAMPLES from 'passerelle:examples' » : les exemples, lus au moment de la construction
const examplesPlugin = {
  name: 'passerelle-examples',
  setup(b) {
    b.onResolve({ filter: /^passerelle:examples$/ }, () => ({ path: 'examples', namespace: 'passerelle' }));
    b.onLoad({ filter: /.*/, namespace: 'passerelle' }, () => ({
      contents: `export default ${JSON.stringify(examples())};`,
      loader: 'js'
    }));
  }
};

// Les modules ES sont toujours en mode strict ; esbuild n'écrit pas la directive dans un IIFE ou un fichier CommonJS
const STRICT = "'use strict';";

export function bundleUI() {
  return bundle({
    entryPoints: ['src/ui/app.js'],
    format: 'iife',
    platform: 'browser',
    target: 'esnext',
    banner: { js: STRICT },
    plugins: [examplesPlugin]
  });
}

/*
 * version : celle de package.json, qui remplace la version écrite en dur dans src/node/common.js.
 * outfile : si donné, le fichier est aussi écrit là.
 */
export async function bundleServer({ version, outfile } = {}) {
  const versionPlugin = {
    name: 'passerelle-version',
    setup(b) {
      if (!version) return;
      b.onLoad({ filter: /src[\\/]node[\\/]common\.js$/ }, args => {
        const src = readFileSync(args.path, 'utf8');
        const out = src.replace(/^export const VERSION = '[^']*';$/m, `export const VERSION = '${version}';`);
        if (!out.includes(`export const VERSION = '${version}';`)) {
          throw new Error('src/node/common.js : la ligne « export const VERSION = … » est introuvable');
        }
        return { contents: out, loader: 'js' };
      });
    }
  };
  const js = await bundle({
    entryPoints: ['src/server.js'],
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    // Dans un fichier CommonJS, import.meta.dirname est __dirname : le dossier où le binaire ou le paquet est posé
    define: { 'import.meta.dirname': '__dirname' },
    banner: { js: `${STRICT}\n/* Passerelle — binaire autonome : moteur de traduction + serveur + CLI */` },
    plugins: [versionPlugin]
  });
  if (outfile) writeFileSync(outfile, js);
  return js;
}
