/*
 * Cas du banc d’équivalence Logstash / Vector.
 *
 * Chaque cas est un bloc de filtres Logstash et les événements qui le traversent. Logstash joue le pipeline,
 * Vector sa traduction, et les événements produits doivent être identiques.
 *
 *   filter   contenu du bloc filter { … } du pipeline
 *   events   événements d’entrée, un objet JSON par ligne (codec json)
 *   lines    ou lignes brutes, que les deux moteurs rangent dans le champ message (codec plain)
 *   codec    'json' avec lines : les lignes brutes passent par le codec JSON (pour y glisser une ligne invalide)
 *   known    écart connu, avec sa raison. Le cas doit alors diverger : s’il devient identique,
 *            le banc échoue pour rappeler de retirer la mention. Formes acceptées :
 *              'raison'            dans les deux modes de compatibilité ECS de Logstash
 *              { v8: 'raison' }    dans un seul mode (v8 ou disabled)
 *   exact    tolérances du banc à désactiver pour ce cas : 'original', 'horodatage' (voir run.mjs)
 */
const CONVERT = 'mutate { convert => { "n" => "integer" } }';

export const CASES = [
  // Sans filtre : ce que chaque moteur fait d’un événement qu’il ne transforme pas
  { id: 'transport_ligne', filter: '', lines: ['une ligne', 'une autre, avec des accents : été'] },
  { id: 'transport_objet', filter: '', events: [{ a: 1, b: 'deux', c: [3, 4.5], d: { e: null, f: true } }] },
  { id: 'transport_json_invalide', filter: '', codec: 'json', lines: ['{"a":1}', 'ligne non json', '{"a":2}'], known: 'une ligne JSON invalide est perdue ; Logstash la garde dans message, avec _jsonparsefailure' },
  { id: 'transport_event_original', filter: '', lines: ['une ligne'], exact: ['original'], known: { v8: 'la traduction ne pose pas [event][original], que les codecs de Logstash ajoutent en mode ECS' } },
  { id: 'transport_horodatage_ingestion', filter: '', lines: ['une ligne'], exact: ['horodatage'], known: 'Logstash écrit l’horodatage d’ingestion à la nanoseconde, la traduction à la milliseconde' },

  // mutate
  { id: 'mutate_convert_entier', filter: CONVERT, events: [{ n: '42' }, { n: 4.7 }, { n: true }] },
  { id: 'mutate_convert_non_convertible', filter: CONVERT, events: [{ n: 'x' }], known: 'la valeur reste telle quelle des deux côtés, mais Logstash pose _mutate_error' },
  { id: 'mutate_convert_champ_absent', filter: CONVERT, events: [{ m: 1 }], known: 'convert crée le champ absent, à 0 ; Logstash ne fait rien' },

  // grok
  { id: 'grok_champs_types', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:path} %{NUMBER:status:int} %{NUMBER:bytes:int}" } }', lines: ['GET /a 200 12', 'POST /b 500 7', 'ligne sans rapport'] },
];
