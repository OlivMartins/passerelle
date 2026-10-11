/*
 * Cas du banc d’équivalence Logstash / Vector.
 *
 * Chaque cas est un bloc de filtres Logstash et les événements qui le traversent. Logstash joue le pipeline,
 * Vector sa traduction, et les événements produits doivent être identiques.
 *
 *   filter   contenu du bloc filter { … } du pipeline
 *   events   événements d’entrée, un objet JSON par ligne (codec json)
 *   lines    ou lignes brutes, que les deux moteurs rangent dans le champ message (codec plain)
 */
export const CASES = [
  { id: 'mutate_convert_entier', filter: 'mutate { convert => { "n" => "integer" } }', events: [{ n: '42' }, { n: 4.7 }, { n: true }, { n: 'x' }, {}] },
  { id: 'grok_champs_types', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:path} %{NUMBER:status:int} %{NUMBER:bytes:int}" } }', lines: ['GET /a 200 12', 'POST /b 500 7', 'ligne sans rapport'] },
];
