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
 *
 * Un cas ne porte qu’un comportement : quand une opération diverge sur un type d’entrée, ce type a son propre cas.
 */
const convert = type => `mutate { convert => { "n" => "${type}" } }`;
// Marque l’événement selon le résultat d’une condition
const si = condition => `if ${condition} { mutate { add_tag => ["oui"] } } else { mutate { add_tag => ["non"] } }`;

export const CASES = [
  // Sans filtre : ce que chaque moteur fait d’un événement qu’il ne transforme pas
  { id: 'transport_ligne', filter: '', lines: ['une ligne', 'une autre, avec des accents : été'] },
  { id: 'transport_objet', filter: '', events: [{ a: 1, b: 'deux', c: [3, 4.5], d: { e: null, f: true } }] },
  { id: 'transport_json_invalide', filter: '', codec: 'json', lines: ['{"a":1}', 'ligne non json', '{"a":2}'], known: 'une ligne JSON invalide est perdue ; Logstash la garde dans message, avec _jsonparsefailure' },
  { id: 'transport_event_original', filter: '', lines: ['une ligne'], exact: ['original'], known: { v8: 'la traduction ne pose pas [event][original], que les codecs de Logstash ajoutent en mode ECS' } },
  { id: 'transport_horodatage_ingestion', filter: '', lines: ['une ligne'], exact: ['horodatage'], known: 'Logstash écrit l’horodatage d’ingestion à la nanoseconde, la traduction à la milliseconde' },

  // mutate : renommer, remplacer
  { id: 'mutate_rename', filter: 'mutate { rename => { "a" => "b" } }', events: [{ a: 1 }, { a: 1, b: 2 }, { c: 3 }, { a: null }] },
  { id: 'mutate_rename_imbrique', filter: 'mutate { rename => { "[x][y]" => "[z][t]" } }', events: [{ x: { y: 1, k: 2 } }, { x: { y: 1 } }, { x: { k: 2 } }, { x: 5 }] },
  { id: 'mutate_update', filter: 'mutate { update => { "a" => "nouveau" } }', events: [{ a: 1 }, { b: 2 }] },
  { id: 'mutate_replace', filter: 'mutate { replace => { "a" => "v-%{b}" } }', events: [{ a: 1, b: 2 }, { b: 'x' }] },
  { id: 'mutate_copy', filter: 'mutate { copy => { "a" => "b" } }', events: [{ a: 1 }, { a: { x: 1 } }, { a: 1, b: 2 }] },
  { id: 'mutate_coerce', filter: 'mutate { coerce => { "a" => "défaut" } }', events: [{ a: null }, { a: 1 }] },
  { id: 'mutate_coerce_champ_absent', filter: 'mutate { coerce => { "a" => "défaut" } }', events: [{ b: 2 }], known: 'coerce crée le champ absent ; Logstash ne remplace qu’un champ présent et nul' },

  // mutate : convertir
  { id: 'mutate_convert_entier', filter: convert('integer'), events: [{ n: '42' }, { n: '-7' }, { n: 4.7 }, { n: true }] },
  { id: 'mutate_convert_entier_formes', filter: convert('integer'), events: [{ n: ' 42 ' }, { n: '42.9' }, { n: '1,000' }, { n: '0x1A' }], known: 'Logstash lit aussi « 42 » entouré d’espaces, « 42.9 », « 1,000 » et « 0x1A » ; la traduction les laisse en chaînes' },
  { id: 'mutate_convert_non_convertible', filter: convert('integer'), events: [{ n: 'x' }, { n: '' }], known: 'la valeur reste telle quelle des deux côtés, mais Logstash pose _mutate_error' },
  { id: 'mutate_convert_champ_absent', filter: convert('integer'), events: [{ m: 1 }], known: 'convert crée le champ absent, à 0 ; Logstash ne fait rien' },
  { id: 'mutate_convert_tableau', filter: convert('integer'), events: [{ n: ['1', '2', 3.9] }], known: 'un tableau n’est pas converti élément par élément' },
  { id: 'mutate_convert_flottant', filter: convert('float'), events: [{ n: '1.5' }, { n: 3 }, { n: '1e3' }, { n: true }] },
  { id: 'mutate_convert_chaine', filter: convert('string'), events: [{ n: 42 }, { n: 1.5 }, { n: true }] },
  { id: 'mutate_convert_chaine_tableau', filter: convert('string'), events: [{ n: [1, 2] }], known: 'un tableau n’est pas converti élément par élément' },
  { id: 'mutate_convert_booleen', filter: convert('boolean'), events: [{ n: 'true' }, { n: 'yes' }, { n: '0' }, { n: 1 }, { n: 'peut-être' }] },
  { id: 'mutate_convert_echec_et_suite', filter: 'mutate { convert => { "n" => "integer" } add_field => { "k" => "v" } add_tag => ["converti"] }', events: [{ n: '42' }, { n: 'x' }], known: 'après un convert en échec, Logstash n’applique ni add_field ni add_tag ; la traduction les applique' },

  // mutate : chaînes
  { id: 'mutate_gsub', filter: 'mutate { gsub => ["a", "[0-9]+", "#"] }', events: [{ a: 'abc123def45' }, { a: 42 }] },
  { id: 'mutate_gsub_groupes', filter: 'mutate { gsub => ["a", "(\\w+)@(\\w+)", "\\2 at \\1"] }', events: [{ a: 'alice@example' }], known: 'les groupes \\1 et \\2 du remplacement ne sont pas repris : le texte « ${2} at ${1} » est écrit tel quel' },
  { id: 'mutate_majuscules', filter: 'mutate { uppercase => ["a"] }', events: [{ a: 'été Abc ß' }, { a: 42 }] },
  { id: 'mutate_minuscules', filter: 'mutate { lowercase => ["a"] }', events: [{ a: 'ÉTÉ Abc' }, { a: 42 }] },
  { id: 'mutate_capitalize', filter: 'mutate { capitalize => ["a"] }', events: [{ a: 'abc DEF' }, { a: 'x' }] },
  { id: 'mutate_capitalize_accent', filter: 'mutate { capitalize => ["a"] }', events: [{ a: 'élan VITAL' }], known: 'une première lettre accentuée est coupée en deux octets : la valeur produite n’est plus de l’UTF-8 valide' },
  { id: 'mutate_strip', filter: 'mutate { strip => ["a"] }', events: [{ a: '  x  ' }, { a: '\tx\n' }, { a: 5 }] },
  { id: 'mutate_chaines_tableau', filter: 'mutate { gsub => ["a", "[0-9]+", "#"] uppercase => ["b"] lowercase => ["c"] strip => ["d"] }', events: [{ a: ['x1', 'y22'], b: ['x', 'y'], c: ['X', 'Y'], d: ['  x ', ' y'] }], known: 'gsub, uppercase, lowercase et strip ne traitent pas un tableau élément par élément' },
  { id: 'mutate_champ_absent', filter: 'mutate { gsub => ["a", "x", "y"] uppercase => ["b"] lowercase => ["c"] capitalize => ["d"] strip => ["e"] split => { "f" => "," } join => { "g" => "," } copy => { "h" => "i" } }', events: [{ n: 1 }], known: 'une opération sur un champ absent crée ce champ, nul ou vide ; Logstash ne fait rien' },

  // mutate : tableaux
  { id: 'mutate_split', filter: 'mutate { split => { "a" => "," } }', events: [{ a: 'x,y,,z' }, { a: 'seul' }, { a: ['déjà', 'tableau'] }, { a: 42 }] },
  { id: 'mutate_split_vides_de_fin', filter: 'mutate { split => { "a" => "," } }', events: [{ a: 'x,y,,' }, { a: '' }], known: 'Logstash écarte les éléments vides de fin (« x,y,, » donne deux éléments, une chaîne vide aucun) ; la traduction les garde' },
  { id: 'mutate_join', filter: 'mutate { join => { "a" => "-" } }', events: [{ a: ['x', 'y'] }, { a: 'chaîne' }, { a: [] }] },
  { id: 'mutate_join_nombres', filter: 'mutate { join => { "a" => "-" } }', events: [{ a: [1, 2] }], known: 'un tableau de nombres n’est pas joint : Logstash donne « 1-2 »' },
  { id: 'mutate_merge', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: ['x'], b: ['y'] }, { a: 'x', b: 'y' }, { a: ['x'], b: 'y' }, { a: 'x' }, { b: 'y' }] },
  { id: 'mutate_merge_objets', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: { k: 1 }, b: { l: 2 } }], known: 'deux objets sont réunis en un tableau ; Logstash fusionne leurs clés' },

  // mutate applique ses opérations dans un ordre fixe, pas dans celui du pipeline : rename avant uppercase, update avant replace
  { id: 'mutate_ordre_rename_uppercase', filter: 'mutate { uppercase => ["b"] rename => { "a" => "b" } }', events: [{ a: 'x' }] },
  { id: 'mutate_ordre_update_replace', filter: 'mutate { replace => { "a" => "R" } update => { "a" => "U" } }', events: [{ a: 'x' }, { b: 1 }] },

  // Options communes à tous les filtres
  { id: 'commun_add_field', filter: 'mutate { add_field => { "k" => "v" "[x][y]" => "z" } }', events: [{ n: 1 }, { x: { t: 1 } }] },
  { id: 'commun_add_field_champ_existant', filter: 'mutate { add_field => { "k" => "v" "[x][y]" => "z" } }', events: [{ k: 'déjà' }, { x: { y: 'déjà' } }], known: 'sur un champ qui existe, Logstash ajoute la valeur et en fait un tableau ; la traduction écrase' },
  { id: 'commun_add_field_sous_champ_de_scalaire', filter: 'mutate { add_field => { "[x][y]" => "z" } }', events: [{ x: 'scalaire' }], known: 'Logstash refuse d’écrire sous un champ scalaire et pose _mutate_error ; la traduction remplace le scalaire' },
  { id: 'commun_remove_field', filter: 'mutate { remove_field => ["a", "[x][y]"] }', events: [{ a: 1, b: 2 }, { x: { y: 1, z: 2 } }, { x: { y: 1 } }, { b: 2 }] },
  { id: 'commun_remove_field_dynamique', filter: 'mutate { remove_field => ["%{nom}"] }', events: [{ nom: 'a', a: 1 }], known: 'un nom de champ écrit avec %{…} n’est pas résolu : le champ désigné reste' },
  { id: 'commun_add_tag', filter: 'mutate { add_tag => ["t1", "t-%{n}"] }', events: [{ n: 1 }, { n: 2, tags: ['t0'] }, { n: 3, tags: ['t1'] }, { n: 4, tags: 'chaine' }] },
  { id: 'commun_remove_tag', filter: 'mutate { remove_tag => ["t1"] }', events: [{ tags: ['t0', 't1'] }, { tags: ['t1'] }, { tags: 't1' }] },
  { id: 'commun_remove_tag_sans_tags', filter: 'mutate { remove_tag => ["t1"] }', events: [{ n: 1 }], known: 'remove_tag crée un champ tags vide quand l’événement n’en a pas' },

  // %{champ} dans une valeur
  { id: 'sprintf_types', filter: 'mutate { add_field => { "k" => "%{n}" } }', events: [{ n: 'a' }, { n: 1 }, { n: 1.5 }, { n: true }] },
  { id: 'sprintf_champ_absent', filter: 'mutate { add_field => { "k" => "v-%{n}" } }', events: [{ m: 1 }, { n: null }], known: 'pour un champ absent ou nul, Logstash laisse « %{n} » dans la valeur ; la traduction écrit une chaîne vide' },
  { id: 'sprintf_tableau_objet', filter: 'mutate { add_field => { "k" => "%{n}" } }', events: [{ n: ['a', 'b'] }, { n: { a: 1 } }], known: 'Logstash écrit un tableau « a,b » et un objet en JSON ; la traduction écrit une chaîne vide' },
  { id: 'sprintf_nombres', filter: 'mutate { add_field => { "k" => "%{n}" } }', codec: 'json', lines: ['{"n":1.0}', '{"n":1e21}'], known: 'un flottant sans décimale s’écrit « 1.0 » et « 1.0E21 » pour Logstash, « 1 » et « 1000000000000000000000 » pour la traduction' },
  { id: 'sprintf_imbrique', filter: 'mutate { add_field => { "k" => "%{[a][b]}/%{[a][c]}" } }', events: [{ a: { b: 'x', c: 2 } }] },
  { id: 'sprintf_date', filter: 'mutate { add_field => { "jour" => "%{+YYYY.MM.dd}" "heure" => "%{+HH:mm:ss}" } }', events: [{ '@timestamp': '2026-03-10T08:15:30.123Z' }, { '@timestamp': '2026-12-31T23:59:59.999Z' }] },
  { id: 'sprintf_metadata', filter: 'mutate { add_field => { "[@metadata][cle]" => "valeur" } }\nmutate { add_field => { "k" => "%{[@metadata][cle]}" } }', events: [{ n: 1 }] },

  // Conditions
  { id: 'condition_egalite', filter: si('[a] == "x"'), events: [{ a: 'x' }, { a: 'y' }, { b: 1 }, { a: ['x'] }, { a: null }] },
  { id: 'condition_egalite_nombre', filter: si('[n] == 1'), events: [{ n: 1 }, { n: '1' }, { n: 2 }, { n: true }, { m: 0 }] },
  { id: 'condition_different', filter: si('[a] != "x"'), events: [{ a: 'x' }, { a: 'y' }, { b: 1 }] },
  { id: 'condition_comparaison', filter: si('[n] > 10'), events: [{ n: 11 }, { n: 10 }, { n: 10.5 }, { n: -3 }, { n: null }] },
  { id: 'condition_comparaison_champ_absent', filter: si('[n] > 10'), events: [{ n: 11 }, { m: 1 }, { n: 12 }], known: 'Logstash jette l’événement quand le champ comparé à un nombre est absent ; la traduction le garde et tient la condition pour fausse' },
  { id: 'condition_comparaison_chaine', filter: si('[n] > 10'), events: [{ n: 11 }, { n: '11' }, { n: 12 }], known: 'Logstash jette l’événement quand le champ comparé à un nombre est une chaîne ; la traduction le garde et lit la chaîne comme un nombre' },
  { id: 'condition_verite', filter: si('[a]'), events: [{ a: 'x' }, { a: '0' }, { a: 0 }, { a: false }, { a: null }, { b: 1 }, { a: [] }, { a: {} }] },
  { id: 'condition_verite_chaine', filter: si('[a]'), events: [{ a: '' }, { a: 'false' }], known: 'une chaîne vide et la chaîne « false » sont fausses pour Logstash, vraies pour la traduction' },
  { id: 'condition_negation', filter: si('![a]'), events: [{ a: 'x' }, { a: false }, { b: 1 }] },
  { id: 'condition_in_liste', filter: si('[a] in ["x", "y"]'), events: [{ a: 'x' }, { a: 'z' }, { b: 1 }, { a: ['x'] }] },
  { id: 'condition_in_champ', filter: si('"x" in [a]'), events: [{ a: ['x', 'y'] }, { a: 'axb' }, { a: 'z' }, { b: 1 }] },
  { id: 'condition_not_in', filter: si('[a] not in ["x", "y"]'), events: [{ a: 'x' }, { a: 'z' }, { b: 1 }] },
  { id: 'condition_regex', filter: si('[a] =~ /^web-[0-9]+$/'), events: [{ a: 'web-12' }, { a: 'db-1' }, { a: 12 }, { b: 1 }] },
  { id: 'condition_regex_negation', filter: si('[a] !~ /^web/'), events: [{ a: 'web-1' }, { a: 'db' }, { b: 1 }] },
  { id: 'condition_logique', filter: si('[a] == "x" and ([n] > 5 or [b] != "y")'), events: [{ a: 'x', n: 6, b: 'y' }, { a: 'x', n: 1, b: 'y' }, { a: 'x', n: 1, b: 'z' }, { a: 'z', n: 9, b: 'z' }] },
  { id: 'condition_xor', filter: si('[a] == "x" xor [b] == "y"'), events: [{ a: 'x', b: 'y' }, { a: 'x', b: 'z' }, { a: 'z', b: 'y' }, { a: 'z', b: 'z' }] },
  { id: 'condition_sinon_si', filter: 'if [n] < 10 { mutate { add_field => { "classe" => "petit" } } } else if [n] < 100 { mutate { add_field => { "classe" => "moyen" } } } else { mutate { add_field => { "classe" => "grand" } } }', events: [{ n: 5 }, { n: 50 }, { n: 500 }] },
  { id: 'condition_champ_contre_champ', filter: si('[a] == [b]'), events: [{ a: 1, b: 1 }, { a: 1, b: '1' }, { a: 'x', b: 'x' }, { a: 'x' }, { c: 1 }] },
  { id: 'condition_imbriquee', filter: si('[x][y] == "v"'), events: [{ x: { y: 'v' } }, { x: { y: 'w' } }, { x: 'v' }, { z: 1 }] },

  // grok
  { id: 'grok_champs_types', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:path} %{NUMBER:status:int} %{NUMBER:bytes:int}" } }', lines: ['GET /a 200 12', 'POST /b 500 7', 'ligne sans rapport'] },
];
