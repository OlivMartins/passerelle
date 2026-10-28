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
  'src/engine/schema.js',
  'src/engine/analysis.js',
  'src/engine/kql.js',
  'src/engine/kibana.js',
  'src/engine/grafana.js',
  'src/engine/logstash.js',
  'src/engine/sink.js',
  'src/engine/pipelines.js',
  'src/engine/ingest.js',
  'src/engine/equivalence.js',
  'src/engine/replay.js'
];

/*
 * Code propre à Node.js (entrées-sorties du serveur et de la ligne de commande), assemblé après le moteur et avant
 * src/server.js. Il partage sa portée : il emploie les modules que src/server.js charge en tête (fs, path, os, crypto…)
 * dans ses fonctions seulement, jamais à son chargement.
 */
export const NODE_FILES = [
  'src/node/verify.js'
];

export const engineSource = () => ENGINE_FILES.map(f => readFileSync(join(ROOT, f), 'utf8')).join('');
export const nodeSource = () => NODE_FILES.map(f => readFileSync(join(ROOT, f), 'utf8')).join('');
// Ce que le binaire assemble après le moteur : le code Node.js, puis le serveur
export const serverSource = () => nodeSource() + readFileSync(join(ROOT, 'src/server.js'), 'utf8');

// Le moteur chargé hors du binaire, pour les tests et les bancs
export function loadEngine() {
  return new Function(`'use strict';\n${engineSource()}\nreturn { clickhouseOutput, chShapeLines, translateDSL, translateLogstash, translateIngest, ingestRead, yamlLoad, translatePipelines, pipelinesFromYML, parsePipelinesYML, pipelineConfigFiles, schemaFromElastic, profilesFromSystem, anAnalyze, anPlan, anFieldPlan, anReport, kqlParse, kqlToDSL, kqlTranslate, kibanaObjects, kibanaInventory, inventoryMarkdown, inventoryCSV, inventoryHTML, inventorySQLFiles, grafanaDashboard, grafanaReportMarkdown, schemaPullQueries, parseYAMLConfig, tableConfig, toYAML, DEFAULT_CONFIG, mergeConfig, verdictOf, coverage, VERDICTS, eqRunCase, eqRunComposite, eqCompareStatements, eqCompareRows, eqCompareRowsDetailed, eqCompareIds, eqCompareIdsDetailed, eqBucketRows, eqLeafMetrics, eqMetricColumns, eqSame, eqNormKey, eqPinNow, eqBoundWindow, eqTimeField, eqDuration, eqWindow, eqStateOf, eqSummarize, eqSentence, eqReportMarkdown, eqReportCSV, eqReportHTML, eqNormalizeEvent, eqAlign, eqEventDiffs, eqPipelineParts, eqVectorSource, eqLogstashSource, eqComparePipelineOutputs, eqEsError, eqCanon, EQ_ECS_MODES, EQ_STATES };`)();
}
