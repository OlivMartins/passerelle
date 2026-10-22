/*
 * Fichiers du moteur de traduction, dans l'ordre d'assemblage.
 * Ils partagent une même portée : la construction (scripts/build.mjs) et les tests les concatènent.
 * Seul endroit où la liste est écrite.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ENGINE_FILES = [
  'src/engine/base.js',
  'src/engine/dsl-strict.js',
  'src/engine/dsl-params.js',
  'src/engine/dsl.js',
  'src/engine/logstash.js'
];

export const engineSource = () => ENGINE_FILES.map(f => readFileSync(join(ROOT, f), 'utf8')).join('');

// Le moteur chargé hors du binaire, pour les tests et les bancs
export function loadEngine() {
  return new Function(`'use strict';\n${engineSource()}\nreturn { translateDSL, translateLogstash, toYAML, DEFAULT_CONFIG, mergeConfig, verdictOf, coverage, VERDICTS };`)();
}
