/*
 * Outils communs des bancs d’ingestion : traduction d’un pipeline Elasticsearch et exécution dans Vector.
 *
 *   VECTOR_BIN                 binaire Vector (par défaut : vector dans le PATH)
 *   ELASTIC_INTEGRATIONS       clone de github.com/elastic/integrations (bancs integration et corpus)
 *   MAXMIND_TEST_DATA          dossier test-data de github.com/maxmind/MaxMind-DB (bases GeoLite2-*-Test.mmdb)
 *   PASSERELLE_INGEST_WORK     dossier de travail (par défaut : un dossier temporaire)
 */
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngine } from '../../scripts/engine.mjs';

export const E = loadEngine();
export const VECTOR = process.env.VECTOR_BIN || 'vector';
export const WORK = process.env.PASSERELLE_INGEST_WORK || join(tmpdir(), 'passerelle-ingest');
export const INTEGRATIONS = process.env.ELASTIC_INTEGRATIONS || '';
const GEO = process.env.MAXMIND_TEST_DATA || '';

export function needs(name, value) {
  if (!value) { console.error(`${name} n’est pas défini : voir l’en-tête de tests/ingest/commun.mjs`); process.exit(2); }
}

// Une base GeoIP de la traduction remplacée par la base de test du même type
export function geoPath(path) {
  const kind = /asn/i.test(path) ? 'ASN' : /country/i.test(path) ? 'Country' : 'City';
  return GEO ? join(GEO, `GeoLite2-${kind}-Test.mmdb`) : path;
}

/*
 * Joue des documents dans la traduction : stdin à la place de la source Elastic Agent, un fichier à la place des
 * sorties. Rend les documents produits, dans l’ordre ; un document refusé porte sa cause dans __echec.
 */
export function play(r, docs, dir = join(WORK, 'jeu')) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const cfg = JSON.parse(JSON.stringify(r.config));
  cfg.data_dir = dir; cfg.api = { enabled: false };
  for (const t of Object.values(cfg.enrichment_tables || {})) t.path = geoPath(t.path);
  cfg.sources = { agent_in_raw: { type: 'stdin', decoding: { codec: 'json' }, log_namespace: true } };
  cfg.transforms = Object.assign({ agent_in: { type: 'remap', inputs: ['agent_in_raw'], source: '. = object!(.)' } }, cfg.transforms);
  cfg.transforms.marque = { type: 'remap', inputs: ['bilan.echecs'], source: '.__echec = %ingest_failure' };
  cfg.sinks = { sortie: { type: 'file', inputs: ['bilan._unmatched', 'marque'], path: join(dir, 'sortie.ndjson'), encoding: { codec: 'json' } } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  try {
    execFileSync(VECTOR, ['--quiet', '--config', join(dir, 'config.json')], {
      input: docs.map(d => JSON.stringify(d)).join('\n') + '\n',
      env: Object.assign({}, process.env, { VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION: 'true' }),
      timeout: 120000, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) { throw new Error(`Vector a échoué :\n${String(e.stderr || e.message).slice(0, 4000)}`); }
  const out = join(dir, 'sortie.ndjson');
  return existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

// Table aplatie « a.b.c » → valeur JSON, pour comparer deux documents champ par champ
export function flat(o, p = '', out = {}) {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const k of Object.keys(o)) flat(o[k], p ? `${p}.${k}` : k, out); }
  else out[p] = JSON.stringify(o);
  return out;
}
