/*
 * Transport du banc d’équivalence : ce que le banc ajoute autour des filtres d’un cas.
 *
 * Les deux moteurs reçoivent les mêmes lignes et écrivent leurs événements dans /work/out, monté sur un dossier
 * différent pour chacun. Vector lit son entrée standard : le pipeline que traduit Passerelle a donc une entrée stdin.
 * Logstash lit un fichier, une seule fois : un même Logstash joue tous les cas, et il n’a qu’une entrée standard.
 */

// Compatibilité ECS de Logstash : « v8 » est son réglage par défaut depuis la version 8, « disabled » celui d’avant
export const ECS_MODES = ['v8', 'disabled'];

// Lignes d’entrée d’un cas : un objet JSON par ligne (events), ou des lignes brutes (lines)
export const inputOf = c => (c.lines || c.events.map(e => JSON.stringify(e))).map(l => l + '\n').join('');
// Les événements sont décodés par le codec JSON ; les lignes brutes aussi quand le cas le demande
const isJson = c => !c.lines || c.codec === 'json';

const filterBlock = c => `filter {\n${c.filter}\n}\n`;
const output = name => `output { file { path => "/work/out/${name}.ndjson" codec => json_lines } }\n`;

// Pipeline que traduit Passerelle et que joue Vector
export function translatedPipeline(c) {
  return `input { stdin {${isJson(c) ? ' codec => json_lines' : ''} } }\n` + filterBlock(c) + output(c.id);
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
  return `input { file { ${file} codec => ${isJson(c) ? 'json' : 'plain'} } }\n`
    + `filter {\n  ruby { code => '${UNDECORATE[mode]}\n  ' }\n}\n`
    + filterBlock(c) + output(`${c.id}.${mode}`);
}
