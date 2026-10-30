/*
 * Watches du banc Watcher (tests/differential/watcher.mjs), écrites sur le jeu de données du banc différentiel.
 * Chacune est jouée par Elasticsearch (_execute, sans être enregistrée) et par ClickHouse (sa traduction), à
 * plusieurs heures prévues ; la condition d’Elasticsearch (condition.met) doit valoir la décision de ClickHouse
 * (colonne declenchee).
 *
 *   es : valeur attendue d’Elasticsearch quand elle diffère exprès de la traduction (écart connu et documenté).
 */
import { INDEX } from './dataset.mjs';

// Heures prévues : des fenêtres pleines, une fenêtre autour de minuit, et une fenêtre sans aucun document
export const TIMES = [
  '2026-03-08T06:00:00Z',
  '2026-03-09T12:00:00Z',
  '2026-03-10T18:30:00Z',
  '2026-03-11T23:59:00Z',
  '2026-01-01T00:00:00Z'
];

const window = d => ({
  range: { '@timestamp': { gte: `{{ctx.trigger.scheduled_time}}||-${d}`, lte: '{{ctx.trigger.scheduled_time}}' } }
});
const search = (body, extra) => ({ search: { request: Object.assign({ indices: [INDEX], body }, extra || {}) } });
const watch = (input, condition, metadata) =>
  Object.assign(
    {
      trigger: { schedule: { interval: '5m' } },
      input,
      condition,
      actions: { journal: { logging: { text: 'banc' } } }
    },
    metadata ? { metadata } : {}
  );
const errors5xx = { size: 0, query: { bool: { filter: [window('1h'), { range: { status: { gte: 500 } } }] } } };
const perService = {
  size: 0,
  query: window('2h'),
  aggs: { svc: { terms: { field: 'service', size: 10 }, aggs: { lat: { avg: { field: 'latency_ms' } } } } }
};

export const WATCHES = [
  { name: 'compare hits.total', watch: watch(search(errors5xx), { compare: { 'ctx.payload.hits.total': { gt: 4 } } }) },
  {
    name: 'compare hits.total, seuil lu dans metadata',
    watch: watch(
      search(errors5xx),
      { compare: { 'ctx.payload.hits.total': { gte: '{{ctx.metadata.seuil}}' } } },
      { seuil: 6 }
    )
  },
  // Watcher rend hits.total en entier : hits.total.value est vide et la condition d’origine ne se déclenche jamais
  {
    name: 'compare hits.total.value (écart connu)',
    watch: watch(search(errors5xx), { compare: { 'ctx.payload.hits.total.value': { gt: 0 } } }),
    es: false
  },
  // Seuil écrit entre guillemets : Watcher compare en texte (« 11 » < « 5 »)
  {
    name: 'compare à un seuil entre guillemets',
    watch: watch(search(errors5xx), { compare: { 'ctx.payload.hits.total': { gt: '5' } } })
  },
  {
    name: 'compare hits.total.value avec rest_total_hits_as_int: false',
    watch: watch(search(errors5xx, { rest_total_hits_as_int: false }), {
      compare: { 'ctx.payload.hits.total.value': { gt: 4 } }
    })
  },
  {
    name: 'compare sur une moyenne',
    watch: watch(search({ size: 0, query: window('1h'), aggs: { lat: { avg: { field: 'latency_ms' } } } }), {
      compare: { 'ctx.payload.aggregations.lat.value': { gte: 1500 } }
    })
  },
  {
    name: 'compare eq null sur un maximum vide',
    watch: watch(
      search({
        size: 0,
        query: { bool: { filter: [window('1h'), { term: { env: 'aucun' } }] } },
        aggs: { m: { max: { field: 'latency_ms' } } }
      }),
      { compare: { 'ctx.payload.aggregations.m.value': { eq: null } } }
    )
  },
  {
    name: 'compare not_eq sur un maximum vide',
    watch: watch(
      search({
        size: 0,
        query: { bool: { filter: [window('1h'), { term: { env: 'aucun' } }] } },
        aggs: { m: { max: { field: 'latency_ms' } } }
      }),
      { compare: { 'ctx.payload.aggregations.m.value': { not_eq: 5 } } }
    )
  },
  {
    name: 'compare doc_count d’une agrégation filter',
    watch: watch(
      search({ size: 0, query: window('2h'), aggs: { err: { filter: { range: { status: { gte: 500 } } } } } }),
      { compare: { 'ctx.payload.aggregations.err.doc_count': { gte: 8 } } }
    )
  },
  {
    name: 'array_compare some',
    watch: watch(search(perService), {
      array_compare: {
        'ctx.payload.aggregations.svc.buckets': { path: 'lat.value', gte: { value: 1700, quantifier: 'some' } }
      }
    })
  },
  {
    name: 'array_compare all (vrai sur une liste vide)',
    watch: watch(search(perService), {
      array_compare: {
        'ctx.payload.aggregations.svc.buckets': { path: 'doc_count', gte: { value: 3, quantifier: 'all' } }
      }
    })
  },
  {
    name: 'array_compare sur hits.hits',
    watch: watch(search({ size: 20, query: window('3h'), sort: [{ '@timestamp': 'desc' }] }), {
      array_compare: { 'ctx.payload.hits.hits': { path: '_source.latency_ms', gte: { value: 2950 } } }
    })
  },
  {
    name: 'script hits.total > params',
    watch: watch(search(errors5xx), {
      script: { source: 'return ctx.payload.hits.total > params.n;', params: { n: 5 } }
    })
  },
  {
    name: 'script boucle sur les groupes',
    watch: watch(search({ size: 0, query: window('2h'), aggs: { hotes: { terms: { field: 'host', size: 20 } } } }), {
      script: {
        source:
          'for (def b : ctx.payload.aggregations.hotes.buckets) { if (b.doc_count > 9) { return true; } } return false;'
      }
    })
  },
  {
    name: 'script taille de la liste des groupes',
    watch: watch(
      search({
        size: 0,
        query: window('1h'),
        aggs: { niveaux: { terms: { field: 'level', size: 10, min_doc_count: 6 } } }
      }),
      { script: 'return ctx.payload.aggregations.niveaux.buckets.size() >= 2' }
    )
  },
  {
    // Seuil créé par l’interface Watcher de Kibana : Elasticsearch joue son script, la traduction lit metadata.watcherui
    name: 'seuil de l’interface Watcher',
    watch: watch(
      search({
        size: 0,
        query: {
          bool: {
            filter: {
              range: {
                '@timestamp': {
                  gte: '{{ctx.trigger.scheduled_time}}||-30m',
                  lte: '{{ctx.trigger.scheduled_time}}',
                  format: 'strict_date_optional_time||epoch_millis'
                }
              }
            }
          }
        },
        aggs: {
          bucketAgg: {
            terms: { field: 'host', size: 5, order: { metricAgg: 'desc' } },
            aggs: { metricAgg: { max: { field: 'latency_ms' } } }
          }
        }
      }),
      {
        script: {
          source:
            "ArrayList arr = ctx.payload.aggregations.bucketAgg.buckets; for (int i = 0; i < arr.length; i++) { if (arr[i]['metricAgg'].value > params.threshold) { return true; } } return false;",
          params: { threshold: 2900 }
        }
      },
      {
        name: 'Latence maximale par hôte',
        watcherui: {
          index: [INDEX],
          time_field: '@timestamp',
          trigger_interval_size: 5,
          trigger_interval_unit: 'm',
          agg_type: 'max',
          agg_field: 'latency_ms',
          term_size: 5,
          term_field: 'host',
          threshold_comparator: '>',
          time_window_size: 30,
          time_window_unit: 'm',
          threshold: [2900]
        },
        xpack: { type: 'threshold' }
      }
    )
  }
];
