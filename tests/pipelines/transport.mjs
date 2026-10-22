/*
 * Transport du banc d’équivalence : ce que le banc ajoute autour des filtres d’un cas.
 *
 * Les deux moteurs reçoivent les mêmes lignes et écrivent leurs événements dans /work/out, monté sur un dossier
 * différent pour chacun. Vector lit son entrée standard : le pipeline que traduit Passerelle a donc une entrée stdin.
 * Logstash lit un fichier, une seule fois : un même Logstash joue tous les cas, et il n’a qu’une entrée standard.
 */
import { readFileSync } from 'node:fs';

// Compatibilité ECS de Logstash : « v8 » est son réglage par défaut depuis la version 8, « disabled » celui d’avant
export const ECS_MODES = ['v8', 'disabled'];

// Lignes d’entrée d’un cas : un objet JSON par ligne (events), ou des lignes brutes (lines)
export const inputOf = c => (c.lines || c.events.map(e => JSON.stringify(e))).map(l => l + '\n').join('');
// Les événements sont décodés par le codec JSON ; les lignes brutes aussi quand le cas le demande
const isJson = c => !c.lines || c.codec === 'json';
// Options d’entrée propres au cas (add_field, type, tags), recopiées des deux côtés
const inputOptions = c => (c.input ? ` ${c.input}` : '');

const filterBlock = c => `filter {\n${c.filter}\n}\n`;

/*
 * Un cas n’a qu’une sortie, sauf s’il décrit les siennes pour éprouver le routage :
 *     output: o => `if [niveau] == "erreur" { ${o('erreurs')} } else { ${o('autres')} }`
 * Chaque sortie nommée est un fichier, comparé séparément.
 */
const fileOutput = name => `file { path => "/work/out/${name}.ndjson" codec => json_lines }`;
export const outputFile = (prefix, name) => `${prefix}${name ? `.${name}` : ''}`;
export function outputsOf(c) {
  const names = [];
  if (c.output) c.output(name => { names.push(name); return ''; });
  return names.length ? [...new Set(names)] : [''];
}
const outputBlock = (c, prefix) => `output {\n${c.output ? c.output(name => fileOutput(outputFile(prefix, name))) : fileOutput(prefix)}\n}\n`;

// Pipeline que traduit Passerelle et que joue Vector ; avec un mode ECS, ses sorties portent ce mode dans leur nom
export function translatedPipeline(c, mode) {
  return `input { stdin {${isJson(c) ? ' codec => json_lines' : ''}${inputOptions(c)} } }\n` + filterBlock(c) + outputBlock(c, mode ? `${c.id}.${mode}` : c.id);
}

/*
 * L’entrée fichier de Logstash pose le nom d’hôte et le chemin du fichier sur chaque événement qui ne les a pas,
 * ce que ne fait pas une entrée Kafka. Ce préambule les retire avant les filtres du cas, et seulement quand ils
 * viennent de l’entrée, qui garde ses valeurs dans @metadata : un événement qui porte son propre « host » le conserve.
 */
const UNDECORATE = {
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

// Pipeline que joue Logstash : mêmes filtres, même codec
export function logstashPipeline(c, mode) {
  const file = `path => "/work/in/${c.id}.ndjson" mode => "read" exit_after_read => true sincedb_path => "/dev/null" file_completed_action => "log" file_completed_log_path => "/work/out/.lus"`;
  return `input { file { ${file} codec => ${isJson(c) ? 'json' : 'plain'}${inputOptions(c)} } }\n`
    + `filter {\n  ruby { code => '${UNDECORATE[mode]}\n  ' }\n}\n`
    + filterBlock(c) + outputBlock(c, `${c.id}.${mode}`);
}

/*
 * Un pipeline d’exemple du dépôt, joué tel quel à son transport près : son entrée et ses sorties Kafka deviennent
 * celles du banc, chaque sortie prenant le nom de son topic. Ses filtres et ses conditions de routage ne sont pas touchés.
 */
// Fin du bloc { … } ouvert à l’indice donné ; les accolades d’une chaîne ne comptent pas
function blockEnd(text, open) {
  let depth = 0; let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('accolade non fermée');
}
function body(text, opening) {
  const m = opening.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return text.slice(open + 1, blockEnd(text, open));
}
export function example(file) {
  const text = readFileSync(new URL(`../../examples/logstash/${file}`, import.meta.url), 'utf8');
  const input = body(text, /(^|\n)input\s*\{/);
  const sinks = body(text, /(^|\n)output\s*\{/);
  const addField = body(input, /add_field\s*=>\s*\{/);
  const output = o => {
    let out = ''; let from = 0; let m;
    const kafka = /kafka\s*\{/g;
    while ((m = kafka.exec(sinks))) {
      const open = m.index + m[0].length - 1; const end = blockEnd(sinks, open);
      const topic = /topic_id\s*=>\s*"([^"]*)"/.exec(sinks.slice(open, end))[1];
      out += sinks.slice(from, m.index) + o(topic.replace(/%\{[^}]*\}/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
      from = kafka.lastIndex = end + 1;
    }
    return out + sinks.slice(from);
  };
  return { filter: body(text, /(^|\n)filter\s*\{/), codec: /codec\s*=>\s*json/.test(input) ? 'json' : 'plain', input: addField === null ? '' : `add_field => {${addField}}`, output };
}
