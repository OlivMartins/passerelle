#!/usr/bin/env node
/*
 * Traduit un pipeline d’ingestion et y joue des documents dans Vector : affiche les documents produits.
 *
 *   node tests/ingest/jouer.mjs pipeline.yml documents.json [--yaml] [--notes]
 *
 * documents.json : un tableau de documents (le _source qu’Elastic Agent enverrait).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { E, play } from './commun.mjs';

const [defFile, docsFile, ...flags] = process.argv.slice(2);
if (!defFile || !docsFile) {
  console.error('usage : node tests/ingest/jouer.mjs pipeline.yml documents.json [--yaml] [--notes]');
  process.exit(2);
}
const r = E.translateIngest(
  [{ text: readFileSync(defFile, 'utf8'), name: basename(defFile).replace(/\.\w+$/, '') }],
  E.DEFAULT_CONFIG
);
if (r.error) {
  console.error(`Erreur : ${r.error}`);
  process.exit(1);
}
if (flags.includes('--yaml')) console.log(r.yaml);
if (flags.includes('--notes')) console.log(r.notes.map(n => `[${n.level}] ${n.title} — ${n.detail}`).join('\n'));
for (const d of play(r, JSON.parse(readFileSync(docsFile, 'utf8')))) console.log(JSON.stringify(d));
