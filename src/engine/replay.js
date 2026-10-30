/* Passerelle — moteur : rejeu d’un échantillon dans Logstash et Vector, comparaison des événements */
import { isObj } from './base.js';

/*
 * Le comparateur du banc d’équivalence des pipelines (tests/pipelines) et celui de « passerelle verify pipelines » :
 * le même code. Ici, aucune entrée-sortie : le pipeline du client est réduit à ses filtres, entouré du transport
 * du banc (une entrée standard ou un fichier, des sorties en fichiers), et les événements produits sont comparés.
 */

// Compatibilité ECS de Logstash : « v8 » est son réglage par défaut depuis la version 8, « disabled » celui d’avant
export const EQ_ECS_MODES = ['v8', 'disabled'];
const EQ_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const eqCanon = v =>
  JSON.stringify(v, (k, x) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(key => [key, x[key]])
        )
      : x
  );

/*
 * Un événement est comparé tel quel, types compris : 42 n’est pas "42". Deux tolérances, pas une de plus :
 *   horodatage   un @timestamp posé à l’ingestion ne peut pas être égal des deux côtés : il est reconnu à ce
 *                qu’il tombe pendant l’exécution (window = [début, fin] en millisecondes), et sa précision n’est
 *                pas comparée non plus ; exact: ['horodatage'] la désactive
 *   UUID         tiré au hasard par chaque moteur, il n’est comparé que par sa forme
 */
export function eqNormalizeEvent(event, window, exact) {
  const e = JSON.parse(JSON.stringify(event), (k, v) => (typeof v === 'string' && EQ_UUID.test(v) ? '<uuid>' : v));
  const ts = e['@timestamp'];
  if (typeof ts === 'string' && Date.parse(ts) >= window[0] && Date.parse(ts) <= window[1]) {
    const digits = (/\.(\d+)Z$/.exec(ts) || ['', ''])[1].length;
    e['@timestamp'] = (exact || []).includes('horodatage') ? `<ingestion, ${digits} décimales>` : '<ingestion>';
  }
  return e;
}

// Table des plus longues sous-suites communes : l’alignement du banc d’origine, tel quel
function eqAlignTable(a, b) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const gaps = [];
  let gap = { a: [], b: [] };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      gaps.push(gap);
      gap = { a: [], b: [] };
      i++;
      j++;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) gap.a.push(i++);
    else gap.b.push(j++);
  }
  gaps.push(gap);
  return gaps.filter(g => g.a.length || g.b.length);
}
// Aligne les deux suites sur leurs événements identiques : un événement perdu ne décale pas les suivants.
// Un échantillon de plusieurs milliers d’événements ne tient pas dans la table : au-delà de 4 millions de cases,
// les débuts et les fins identiques sont écartés d’abord, et ce qui reste est apparié dans l’ordre si c’est encore trop.
export function eqAlign(a, b) {
  if (a.length * b.length <= 4e6) return eqAlignTable(a, b);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  if (!ma.length && !mb.length) return [];
  if (ma.length * mb.length <= 4e6)
    return eqAlignTable(ma, mb).map(g => ({ a: g.a.map(i => i + head), b: g.b.map(j => j + head) }));
  return [{ a: ma.map((x, i) => i + head), b: mb.map((x, j) => j + head) }];
}

function eqLeaves(v, path, out) {
  if (isObj(v) && Object.keys(v).length) for (const k of Object.keys(v)) eqLeaves(v[k], path ? `${path}.${k}` : k, out);
  else out.set(path, eqCanon(v));
  return out;
}
const eqShortText = s => (s.length > 120 ? s.slice(0, 117) + '…' : s);

/*
 * Écarts entre deux suites d’événements déjà normalisées (eqNormalizeEvent). Chaque écart porte un « text »
 * (avec les valeurs) et un « safe » (le champ et le numéro de l’événement, sans valeur).
 * where : préfixe de la sortie (« [sortie erreurs] »), labels : les noms des deux moteurs.
 */
export function eqEventDiffs(ln, vn, where, labels) {
  const L = labels || { ref: 'Logstash', vec: 'Vector' };
  const w = where || '';
  const diffs = [];
  if (ln.length !== vn.length) {
    const t = `${w}${ln.length} événement(s) côté ${L.ref}, ${vn.length} côté ${L.vec}`;
    diffs.push({ kind: 'count', text: t, safe: t });
  }
  for (const gap of eqAlign(ln.map(eqCanon), vn.map(eqCanon))) {
    gap.a.forEach((i, k) => {
      if (k >= gap.b.length) {
        diffs.push({
          kind: 'missing',
          event: i + 1,
          text: `${w}[événement ${i + 1}] sans équivalent côté ${L.vec} : ${eqShortText(eqCanon(ln[i]))}`,
          safe: `${w}[événement ${i + 1}] sans équivalent côté ${L.vec}`
        });
        return;
      }
      const a = eqLeaves(ln[i], '', new Map());
      const b = eqLeaves(vn[gap.b[k]], '', new Map());
      for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        if (a.get(key) !== b.get(key))
          diffs.push({
            kind: 'field',
            event: i + 1,
            field: key,
            text: `${w}[événement ${i + 1}] ${key} : ${L.ref} ${a.has(key) ? eqShortText(a.get(key)) : 'absent'} / ${L.vec} ${b.has(key) ? eqShortText(b.get(key)) : 'absent'}`,
            safe: `${w}[événement ${i + 1}] ${key} : valeurs différentes`
          });
      }
    });
    for (const j of gap.b.slice(gap.a.length))
      diffs.push({
        kind: 'extra',
        text: `${w}[${L.vec} seul] ${eqShortText(eqCanon(vn[j]))}`,
        safe: `${w}[${L.vec} seul]`
      });
  }
  return diffs;
}

/* ---------- Le pipeline du client, réduit à ses filtres ---------- */
// Fin du bloc { … } ouvert à l’indice donné ; les accolades d’une chaîne ne comptent pas
function eqBlockEnd(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('accolade non fermée');
}
function eqBlockBody(text, opening) {
  const m = opening.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return text.slice(open + 1, eqBlockEnd(text, open));
}
// Greffons de sortie reconnus : chacun devient un fichier du banc
const EQ_OUTPUT_PLUGINS =
  'kafka|elasticsearch|opensearch|file|stdout|s3|http|tcp|udp|syslog|redis|rabbitmq|email|exec|gelf|graphite|influxdb|loki|lumberjack|google_pubsub|google_cloud_storage|azure_event_hubs|datadog|webhdfs|sns|sqs|null';
const eqSlug = s =>
  String(s)
    .replace(/%\{[^}]*\}/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/*
 * Pipeline Logstash → { filter, json, options, output(o), outputNames, caveats }, ou { error }.
 * L’entrée devient une entrée standard (ou un fichier), chaque sortie un fichier nommé d’après son topic Kafka,
 * son index ou son greffon. Les filtres et les conditions de routage ne sont pas touchés.
 */
export function eqPipelineParts(text) {
  let input;
  let sinks;
  let filter;
  try {
    // Un bloc commence une ligne ou suit l’accolade qui ferme le précédent (« input { … } filter { … } » sur une ligne)
    input = eqBlockBody(text, /(^|\n|\})[ \t]*input\s*\{/);
    sinks = eqBlockBody(text, /(^|\n|\})[ \t]*output\s*\{/);
    filter = eqBlockBody(text, /(^|\n|\})[ \t]*filter\s*\{/);
  } catch (e) {
    return { error: `pipeline illisible : ${e.message}` };
  }
  if (input === null) return { error: 'aucun bloc input' };
  if (sinks === null) return { error: 'aucun bloc output' };
  if (/\bpipeline\s*\{[^}]*send_to/.test(sinks) || /\bpipeline\s*\{[^}]*address/.test(input))
    return {
      error:
        'pipeline relié à d’autres pipelines (send_to, address) : à rejouer avec l’ensemble, ce que cette commande ne fait pas encore'
    };
  const caveats = [];
  if (/decorate_events\s*=>\s*(true|"(true|basic|extended)")/.test(input) || /\[@metadata\]\[kafka\]/.test(text))
    caveats.push(
      'Les métadonnées Kafka ([@metadata][kafka], decorate_events) ne sont pas rejouées : un filtre qui s’en sert ne voit rien.'
    );
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(filter || ''))
    caveats.push(
      'Le filtre cite des variables d’environnement ${…} : elles doivent avoir la même valeur pour Logstash et pour Vector.'
    );
  const options = [];
  const type = /\btype\s*=>\s*("[^"]*"|'[^']*')/.exec(input);
  if (type) options.push(`type => ${type[1]}`);
  const tags = /\btags\s*=>\s*(\[[^\]]*\])/.exec(input);
  if (tags) options.push(`tags => ${tags[1]}`);
  let addField = null;
  try {
    addField = eqBlockBody(input, /add_field\s*=>\s*\{/);
  } catch {
    addField = null;
  }
  if (addField !== null) options.push(`add_field => {${addField}}`);
  const plug = new RegExp(`\\b(${EQ_OUTPUT_PLUGINS})\\s*\\{`, 'g');
  const nameOf = (plugin, block) => {
    if (plugin === 'kafka') {
      const t = /topic_id\s*=>\s*"([^"]*)"/.exec(block);
      return eqSlug(t ? t[1] : 'kafka');
    }
    if (plugin === 'elasticsearch' || plugin === 'opensearch') {
      const i = /\bindex\s*=>\s*"([^"]*)"/.exec(block);
      return eqSlug(i ? i[1] : plugin) || plugin;
    }
    return plugin;
  };
  const output = o => {
    let out = '';
    let from = 0;
    let m;
    plug.lastIndex = 0;
    while ((m = plug.exec(sinks))) {
      const open = m.index + m[0].length - 1;
      const end = eqBlockEnd(sinks, open);
      out += sinks.slice(from, m.index) + o(nameOf(m[1], sinks.slice(open, end)) || m[1]);
      from = plug.lastIndex = end + 1;
    }
    return out + sinks.slice(from);
  };
  const names = [];
  output(name => {
    names.push(name);
    return '';
  });
  if (!names.length) return { error: 'aucune sortie reconnue dans le bloc output' };
  return {
    filter: filter === null ? '' : filter,
    json: /codec\s*=>\s*"?json/.test(input),
    options: options.length ? ` ${options.join(' ')}` : '',
    output,
    outputNames: [...new Set(names)],
    caveats
  };
}

const eqOutFile = (dir, name) => `file { path => "${dir}/${name}.ndjson" codec => json_lines }`;
export const eqOutName = (prefix, name) => `${prefix}${name ? `.${name}` : ''}`;
const eqOutputBlock = (parts, dir, prefix) =>
  `output {\n${parts.output(name => eqOutFile(dir, eqOutName(prefix, name)))}\n}\n`;
const eqFilterBlock = parts => `filter {\n${parts.filter}\n}\n`;

// Pipeline que traduit Passerelle et que joue Vector : une entrée standard, des sorties en fichiers de dir
export function eqVectorSource(parts, dir, prefix) {
  return (
    `input { stdin {${parts.json ? ' codec => json_lines' : ''}${parts.options} } }\n` +
    eqFilterBlock(parts) +
    eqOutputBlock(parts, dir, prefix)
  );
}

/*
 * L’entrée fichier de Logstash pose le nom d’hôte et le chemin du fichier sur chaque événement qui ne les a pas,
 * ce que ne fait pas une entrée Kafka. Ce préambule les retire avant les filtres, et seulement quand ils
 * viennent de l’entrée, qui garde ses valeurs dans @metadata : un événement qui porte son propre « host » le conserve.
 */
const EQ_UNDECORATE = {
  v8: `
    h = event.get("[@metadata][host]"); p = event.get("[@metadata][path]")
    if h && event.get("[host][name]") == h
      event.remove("[host][name]")
      event.remove("host") if event.get("host").empty?
    end
    if p && event.get("[log][file][path]") == p
      event.remove("[log][file][path]")
      event.remove("[log][file]") if event.get("[log][file]").empty?
      event.remove("log") if event.get("log").empty?
    end`,
  disabled: `
    event.remove("host") if event.get("host") == event.get("[@metadata][host]")
    event.remove("path") if event.get("path") == event.get("[@metadata][path]")`
};

// Pipeline que joue Logstash : le même, avec un fichier lu une fois en entrée (il s’arrête alors seul)
export function eqLogstashSource(parts, mode, input, dir, prefix) {
  const file = `path => "${input}" mode => "read" exit_after_read => true sincedb_path => "/dev/null" file_completed_action => "log" file_completed_log_path => "${dir}/.lus"`;
  return (
    `input { file { ${file} codec => ${parts.json ? 'json' : 'plain'}${parts.options} } }\n` +
    `filter {\n  ruby { code => '${EQ_UNDECORATE[mode]}\n  ' }\n}\n` +
    eqFilterBlock(parts) +
    eqOutputBlock(parts, dir, prefix)
  );
}

/*
 * Compare, sortie par sortie, les événements de la référence et ceux de Vector.
 * ref, vec : { nomDeSortie: [événements] } ; renvoie { diffs, events, identical }.
 */
export function eqComparePipelineOutputs(ref, vec, names, window, opts) {
  const o = opts || {};
  const diffs = [];
  let events = 0;
  let identical = 0;
  for (const name of names) {
    const where = name ? `[sortie ${name}] ` : '';
    const ln = (ref[name] || []).map(e => eqNormalizeEvent(e, window, o.exact));
    const vn = (vec[name] || []).map(e => eqNormalizeEvent(e, window, o.exact));
    const d = eqEventDiffs(ln, vn, where, o.labels);
    events += ln.length;
    const bad = new Set(d.filter(x => x.event !== undefined).map(x => `${name}#${x.event}`));
    identical += ln.length - bad.size;
    diffs.push(...d);
  }
  return { diffs, events, identical: Math.max(0, identical) };
}
