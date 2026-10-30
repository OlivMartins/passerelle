/*
 * Passerelle — façade du moteur de traduction : tout ce que les modules de src/engine exportent.
 * Le moteur ne dépend d’aucune API de Node.js ni du navigateur : il tourne aussi bien dans l’interface que dans le serveur.
 */
export * from './base.js';
export * from './dsl-strict.js';
export * from './dsl-params.js';
export * from './dsl.js';
export * from './schema.js';
export * from './analysis.js';
export * from './kql.js';
export * from './kibana.js';
export * from './grafana.js';
export * from './watcher.js';
export * from './logstash.js';
export * from './assist.js';
export * from './sink.js';
export * from './pipelines.js';
export * from './ingest.js';
export * from './equivalence.js';
export * from './replay.js';
