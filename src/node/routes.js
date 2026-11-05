/*
 * Passerelle — calcul des routes lourdes du service, sans entrée-sortie.
 *
 * Un export Kibana de 30 Mo occupe un processus pendant des secondes et plus d'un gigaoctet : tant que ce calcul
 * tournait dans le fil principal, /healthz, /metrics et les autres requêtes attendaient. Ces routes (celles qui
 * acceptent un corps jusqu'à 32 Mio) sont donc calculées par src/node/worker.js, dans un worker_thread, que pilote
 * src/node/pool.js. Le même code sert de repli en ligne si aucun worker ne démarre.
 *
 * Chaque fonction reçoit des données (chemin, requête, corps, configuration) et rend une réponse décrite :
 *   { status, json }              un objet, écrit en JSON indenté ;
 *   { status, text, headers }     un texte et ses en-têtes.
 * renderReply() la met en octets, transférables au fil principal sans copie.
 */
import {
  anReport,
  coverage,
  grafanaDashboard,
  grafanaReportMarkdown,
  inventoryCSV,
  inventoryHTML,
  inventoryMarkdown,
  isObj,
  kibanaInventory,
  pipelinesFromYML,
  schemaFromElastic,
  translateIngest,
  translatePipelines,
  VERDICTS,
  verdictOf,
  watcherReportCSV,
  watcherReportHTML,
  watcherReportMarkdown,
  watcherTranslate
} from '../engine/index.js';
import { VERSION } from './common.js';

/* ---------- Assistants (partagés avec la ligne de commande) ---------- */
export function schemaBlocks(body) {
  let j = null;
  if (/^\s*\{/.test(body)) {
    try {
      j = JSON.parse(body);
    } catch {
      j = null;
    }
  }
  if (j && Object.prototype.hasOwnProperty.call(j, 'files')) {
    if (
      typeof j.files !== 'object' ||
      j.files === null ||
      Array.isArray(j.files) ||
      Object.values(j.files).some(x => typeof x !== 'string')
    )
      return null;
    return Object.values(j.files).map(x => x.trim());
  }
  return [body.trim()];
}
// Plusieurs fichiers JSON (réponses d’API) : chacun est lu pour lui-même, puis tous sont traduits ensemble
export function schemaFromDocuments(blocks, cfg, opts) {
  const wrapped = blocks.map(b => (/^(GET|PUT|POST)\s/i.test(b) ? b : `POST _passerelle\n${b}`)).join('\n\n');
  return schemaFromElastic(wrapped, cfg, opts);
}
// Fuseau IANA (Europe/Paris) ou décalage en heures entières (+02:00), comme le paramètre time_zone d’Elasticsearch
export function validTimeZone(tz) {
  if (/^[+-]\d{2}:?00$/.test(tz)) return true;
  try {
    new Intl.DateTimeFormat('fr', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const json = (status, obj) => ({ status, json: obj });
const text = (status, body, headers) => ({ status, text: body, headers });
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/* ---------- Routes ---------- */
const ROUTES = {
  '/v1/translate/logstash/pipelines': (body, sp, cfg) => {
    // Corps : pipelines.yml seul (config.string), ou JSON { "pipelines": "<pipelines.yml>", "files": { "chemin": "contenu" } }
    const fmt = sp.get('format') === 'toml' ? 'toml' : 'yaml';
    let yml = body;
    let files = {};
    if (/^\s*\{/.test(body)) {
      let j;
      try {
        j = JSON.parse(body);
      } catch (e) {
        return json(400, { error: `JSON invalide : ${e.message}` });
      }
      if (typeof j.pipelines !== 'string')
        return json(400, { error: 'champ « pipelines » attendu : le texte de pipelines.yml' });
      if (
        j.files !== undefined &&
        (typeof j.files !== 'object' ||
          Array.isArray(j.files) ||
          Object.values(j.files).some(x => typeof x !== 'string'))
      )
        return json(400, { error: '« files » attend un objet { chemin: contenu }' });
      yml = j.pipelines;
      files = j.files || {};
    }
    let list;
    try {
      list = pipelinesFromYML(yml, Object.keys(files), f => files[f]);
    } catch (e) {
      return json(422, { error: e.message, verdict: 'unrecognized' });
    }
    const r = translatePipelines(list, cfg);
    if (r.error) return json(422, { error: r.error, verdict: 'unrecognized', notes: r.notes, pipelines: r.pipelines });
    r.pipelines.forEach((p, k) => Object.assign(p, { from: list[k].from, matched: list[k].matched }));
    return json(200, {
      verdict: verdictOf(r),
      format: fmt,
      config: r[fmt],
      notes: r.notes,
      coverage: coverage(r.stats),
      topology: r.graph,
      env: r.env,
      summary: r.sentence,
      pipelines: r.pipelines
    });
  },

  '/v1/translate/ingest': (body, sp, cfg) => {
    // Corps : un pipeline (YAML, JSON, ou requête PUT _ingest/pipeline de la console Kibana), ou JSON { "files": { "nom": "contenu" } }
    const fmt = sp.get('format') === 'toml' ? 'toml' : 'yaml';
    let inputs;
    try {
      const j = JSON.parse(body);
      inputs =
        isObj(j) && isObj(j.files)
          ? Object.entries(j.files).map(([name, content]) => ({
              name: name.replace(/^.*\//, '').replace(/\.(ya?ml|json)$/i, ''),
              text: String(content)
            }))
          : null;
    } catch {
      inputs = null;
    }
    if (!inputs) inputs = [{ name: sp.get('name') || 'pipeline', text: body }];
    if (!inputs.length) return json(400, { error: 'aucun pipeline', verdict: 'unrecognized' });
    const r = translateIngest(inputs, cfg);
    if (r.error) return json(422, { error: r.error, verdict: 'unrecognized', notes: r.notes });
    return json(200, {
      verdict: verdictOf(r),
      format: fmt,
      config: r[fmt],
      notes: r.notes,
      coverage: coverage(r.stats),
      topology: r.graph,
      summary: r.sentence,
      pipelines: r.pipelines.map(({ vrl, ...p }) => p)
    });
  },

  '/v1/inventory/kibana': (body, sp, cfg) => {
    const fmt = sp.get('format') || 'json';
    if (!['json', 'md', 'html', 'csv'].includes(fmt))
      return json(400, { error: `format inconnu « ${fmt} » (json, md, html ou csv)` });
    const tz = sp.get('timezone') || null;
    if (tz && !validTimeZone(tz)) return json(400, { error: `fuseau inconnu « ${tz} »` });
    const inv = kibanaInventory(body, cfg, { timeZone: tz });
    if (!inv.summary.objects && !Object.keys(inv.source.ignored).length)
      return json(422, {
        error: `aucun objet sauvegardé lisible${inv.source.errors.length ? ` (${inv.source.errors[0]})` : ''}`
      });
    if (fmt === 'md') return text(200, inventoryMarkdown(inv), { 'content-type': 'text/markdown; charset=utf-8' });
    if (fmt === 'html')
      return text(200, inventoryHTML(inv, 'Inventaire Kibana'), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': HTML_CSP
      });
    if (fmt === 'csv')
      return text(200, inventoryCSV(inv), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="inventaire.csv"'
      });
    return json(200, inv);
  },

  '/v1/translate/watcher': (body, sp, cfg) => {
    const fmt = sp.get('format') || 'json';
    if (!['json', 'md', 'html', 'csv'].includes(fmt))
      return json(400, { error: `format inconnu « ${fmt} » (json, md, html ou csv)` });
    const rep = watcherTranslate(body, cfg, {});
    if (!rep.entries.length)
      return json(422, {
        error: `aucune watch lisible${rep.source.errors.length ? ` (${rep.source.errors[0]})` : ''}`
      });
    if (fmt === 'md') return text(200, watcherReportMarkdown(rep), { 'content-type': 'text/markdown; charset=utf-8' });
    if (fmt === 'html')
      return text(200, watcherReportHTML(rep, 'Watches Elasticsearch'), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': HTML_CSP
      });
    if (fmt === 'csv')
      return text(200, watcherReportCSV(rep), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="watches.csv"'
      });
    return json(200, rep);
  },

  '/v1/translate/grafana': (body, sp, cfg) => {
    const r = grafanaDashboard(body, cfg, { index: sp.get('index') || '' });
    if (r.error) return json(422, { error: r.error, verdict: 'unrecognized' });
    if (r.empty)
      return json(422, { error: 'aucune requête Elasticsearch dans ce tableau de bord', verdict: 'unrecognized' });
    if (sp.get('format') === 'md')
      return text(200, grafanaReportMarkdown(r), { 'content-type': 'text/markdown; charset=utf-8' });
    return json(200, { verdict: r.verdict, summary: r.summary, report: r.report, dashboard: r.dashboard });
  },

  '/v1/schema/ddl': (body, sp, cfg) => {
    // Corps : un mapping, un modèle d'index ou une réponse d'API (texte ou JSON), ou JSON { "files": { "nom": "contenu" } }
    const fmt = sp.get('format') === 'sql' ? 'sql' : 'json';
    const blocks = schemaBlocks(body);
    if (!blocks) return json(400, { error: '« files » attend un objet { nom: contenu }' });
    const r = schemaFromDocuments(blocks, cfg, {
      preset: sp.get('preset') || undefined,
      compact: sp.get('compact') === 'true',
      json: sp.get('json') === 'true',
      table: sp.get('table') || undefined
    });
    if (r.empty) return json(400, { error: 'aucun mapping lisible', verdict: 'unrecognized' });
    if (r.error) return json(422, { error: r.error, verdict: 'unrecognized' });
    if (fmt === 'sql')
      return text(200, `-- Généré par Passerelle ${VERSION} — verdict : ${VERDICTS[verdictOf(r)]}\n\n${r.sql}`, {
        'content-type': 'text/plain; charset=utf-8'
      });
    return json(200, {
      verdict: verdictOf(r),
      sql: r.sql,
      profiles: r.yaml,
      tables: r.tables.map(t => ({ table: t.table, error: t.error || null })),
      notes: r.notes,
      coverage: coverage(r.stats),
      summary: r.sentence
    });
  },

  '/v1/schema/analyzers': (body, sp, cfg) => {
    const blocks = schemaBlocks(body);
    if (!blocks) return json(400, { error: '« files » attend un objet { nom: contenu }' });
    const r = schemaFromDocuments(blocks, cfg, {});
    if (r.empty) return json(400, { error: 'aucun mapping lisible', verdict: 'unrecognized' });
    if (r.error) return json(422, { error: r.error, verdict: 'unrecognized' });
    const rep = anReport(r.tables, sp.get('text') || undefined, sp.get('field') || undefined);
    if (sp.get('format') === 'md') return text(200, rep.markdown, { 'content-type': 'text/markdown; charset=utf-8' });
    return json(200, { verdict: rep.verdict, plans: rep.plans });
  }
};

// Routes que le service confie à un worker (corps jusqu'à 32 Mio)
export const HEAVY_ROUTES = new Set(Object.keys(ROUTES));

/*
 * Calcule une route lourde et rend la réponse en octets : { status, headers, bytes, verdict?, valid? }.
 * verdict et valid sont ce que le journal et les métriques du fil principal retiennent de la réponse (opsNote).
 */
export function handleHeavy(pathname, search, body, cfg) {
  const route = ROUTES[pathname];
  if (!route) throw new Error(`route lourde inconnue : ${pathname}`);
  // Le fil principal ne décode pas un gros corps : il arrive en octets (Buffer, ou Uint8Array après un transfert)
  const input =
    typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  const r = route(input, new URLSearchParams(search), cfg);
  const isJson = r.json !== undefined;
  const headers = isJson ? { 'content-type': 'application/json; charset=utf-8' } : r.headers || {};
  const bytes = new TextEncoder().encode(isJson ? `${JSON.stringify(r.json, null, 2)}\n` : r.text);
  const o = r.json && typeof r.json === 'object' ? r.json : {};
  return {
    status: r.status,
    headers,
    bytes,
    verdict: typeof o.verdict === 'string' ? o.verdict : undefined,
    valid: typeof o.valid === 'boolean' ? o.valid : undefined
  };
}
