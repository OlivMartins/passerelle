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
 *   input    options de l’entrée, recopiées des deux côtés (add_field, tags…)
 *   output   sorties du cas quand il en a plusieurs, pour éprouver le routage :
 *              o => `if [niveau] == "erreur" { ${o('erreurs')} } else { ${o('autres')} }`
 *   known    écart connu, avec sa raison. Le cas doit alors diverger : s’il devient identique,
 *            le banc échoue pour rappeler de retirer la mention. Formes acceptées :
 *              'raison'            dans les deux modes de compatibilité ECS de Logstash
 *              { v8: 'raison' }    dans un seul mode (v8 ou disabled)
 *   exact    tolérances du banc à désactiver pour ce cas : 'original', 'horodatage' (voir run.mjs)
 *
 * Un cas ne porte qu’un comportement : quand une opération diverge sur un type d’entrée, ce type a son propre cas.
 */
import { example } from './transport.mjs';

const convert = type => `mutate { convert => { "n" => "${type}" } }`;
// Marque l’événement selon le résultat d’une condition
const si = condition => `if ${condition} { mutate { add_tag => ["oui"] } } else { mutate { add_tag => ["non"] } }`;
const DICTIONNAIRE = 'dictionary => { "200" => "OK" "404" => "Introuvable" }';
// Une opération de mutate par champ, de a à h
const SUR_CHAQUE_CHAMP = 'mutate { gsub => ["a", "x", "y"] uppercase => ["b"] lowercase => ["c"] capitalize => ["d"] strip => ["e"] split => { "f" => "," } join => { "g" => "," } copy => { "h" => "i" } }';

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
  { id: 'mutate_coerce_champ_absent', filter: 'mutate { coerce => { "a" => "défaut" } }', events: [{ b: 2 }] },

  // mutate : convertir
  { id: 'mutate_convert_entier', filter: convert('integer'), events: [{ n: '42' }, { n: '-7' }, { n: 4.7 }, { n: true }] },
  { id: 'mutate_convert_entier_formes', filter: convert('integer'), events: [{ n: ' 42 ' }, { n: '42.9' }, { n: '1,000' }, { n: '0x1A' }], known: 'Logstash lit aussi « 42 » entouré d’espaces, « 42.9 », « 1,000 » et « 0x1A » ; la traduction les laisse en chaînes' },
  { id: 'mutate_convert_non_convertible', filter: convert('integer'), events: [{ n: 'x' }, { n: '' }], known: 'la valeur reste telle quelle des deux côtés, mais Logstash pose _mutate_error' },
  { id: 'mutate_convert_champ_absent', filter: convert('integer'), events: [{ m: 1 }] },
  { id: 'mutate_convert_champ_nul', filter: convert('integer'), events: [{ n: null }] },
  { id: 'mutate_convert_tableau', filter: convert('integer'), events: [{ n: ['1', '2', 3.9] }], known: 'un tableau n’est pas converti élément par élément' },
  { id: 'mutate_convert_flottant', filter: convert('float'), events: [{ n: '1.5' }, { n: 3 }, { n: '1e3' }, { n: true }] },
  { id: 'mutate_convert_chaine', filter: convert('string'), events: [{ n: 42 }, { n: 1.5 }, { n: true }] },
  { id: 'mutate_convert_chaine_tableau', filter: convert('string'), events: [{ n: [1, 2] }], known: 'un tableau n’est pas converti élément par élément' },
  { id: 'mutate_convert_booleen', filter: convert('boolean'), events: [{ n: 'true' }, { n: 'yes' }, { n: '0' }, { n: 1 }, { n: 'peut-être' }] },
  { id: 'mutate_convert_echec_et_suite', filter: 'mutate { convert => { "n" => "integer" } add_field => { "k" => "v" } add_tag => ["converti"] }', events: [{ n: '42' }, { n: 'x' }], known: 'après un convert en échec, Logstash n’applique ni add_field ni add_tag ; la traduction les applique' },

  // mutate : chaînes
  { id: 'mutate_gsub', filter: 'mutate { gsub => ["a", "[0-9]+", "#"] }', events: [{ a: 'abc123def45' }, { a: 42 }] },
  { id: 'mutate_gsub_groupes', filter: 'mutate { gsub => ["a", "(\\w+)@(\\w+)", "\\2 at \\1"] }', events: [{ a: 'alice@example' }], known: 'les groupes \\1 et \\2 sont bien traduits en ${1} et ${2}, mais le moteur double chaque « $ » du VRL pour l’interpolation des variables d’environnement, que Vector ne fait plus par défaut depuis la 0.58 au moins : le texte « ${2} at ${1} » est écrit tel quel' },
  { id: 'mutate_majuscules', filter: 'mutate { uppercase => ["a"] }', events: [{ a: 'été Abc ß' }, { a: 42 }] },
  { id: 'mutate_minuscules', filter: 'mutate { lowercase => ["a"] }', events: [{ a: 'ÉTÉ Abc' }, { a: 42 }] },
  { id: 'mutate_capitalize', filter: 'mutate { capitalize => ["a"] }', events: [{ a: 'abc DEF' }, { a: 'x' }, { a: 42 }] },
  { id: 'mutate_capitalize_accent', filter: 'mutate { capitalize => ["a"] }', events: [{ a: 'élan VITAL' }, { a: '' }] },
  { id: 'mutate_strip', filter: 'mutate { strip => ["a"] }', events: [{ a: '  x  ' }, { a: '\tx\n' }, { a: 5 }] },
  { id: 'mutate_chaines_tableau', filter: 'mutate { gsub => ["a", "[0-9]+", "#"] uppercase => ["b"] lowercase => ["c"] strip => ["d"] }', events: [{ a: ['x1', 'y22'], b: ['x', 'y'], c: ['X', 'Y'], d: ['  x ', ' y'] }], known: 'gsub, uppercase, lowercase et strip ne traitent pas un tableau élément par élément' },
  { id: 'mutate_champ_absent', filter: SUR_CHAQUE_CHAMP, events: [{ n: 1 }] },
  { id: 'mutate_champ_nul', filter: SUR_CHAQUE_CHAMP, events: [{ a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null }] },

  // mutate : tableaux
  { id: 'mutate_split', filter: 'mutate { split => { "a" => "," } }', events: [{ a: 'x,y,,z' }, { a: 'seul' }, { a: ['déjà', 'tableau'] }, { a: 42 }] },
  // Logstash découpe comme Ruby : les éléments vides de fin sont écartés, ceux du début et du milieu gardés
  { id: 'mutate_split_vides_de_fin', filter: 'mutate { split => { "a" => "," } }', events: [{ a: 'x,y,,' }, { a: '' }, { a: ',,' }, { a: ',x' }] },
  { id: 'mutate_split_separateur_special', filter: 'mutate { split => { "a" => "|" } }', events: [{ a: 'x|y||' }, { a: '|x' }, { a: '||' }] },
  { id: 'mutate_split_separateur_long', filter: 'mutate { split => { "a" => "::" } }', events: [{ a: 'x::y::::' }, { a: 'x:y' }] },
  // Un séparateur réduit à une espace découpe sur les blancs, sans élément vide
  { id: 'mutate_split_espace', filter: 'mutate { split => { "a" => " " } }', events: [{ a: ' x  y ' }, { a: 'x\ty' }, { a: '' }, { a: '  ' }] },
  { id: 'mutate_join', filter: 'mutate { join => { "a" => "-" } }', events: [{ a: ['x', 'y'] }, { a: 'chaîne' }, { a: [] }] },
  { id: 'mutate_join_nombres', filter: 'mutate { join => { "a" => "-" } }', events: [{ a: [1, 2] }], known: 'un tableau de nombres n’est pas joint : Logstash donne « 1-2 »' },
  { id: 'mutate_merge', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: ['x'], b: ['y'] }, { a: 'x', b: 'y' }, { a: ['x'], b: 'y' }, { a: 'x' }, { b: 'y' }] },
  { id: 'mutate_merge_objets', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: { k: 1 }, b: { l: 2 } }, { a: { k: 1, m: { p: 1 } }, b: { k: 2, m: { q: 2 } } }] },
  { id: 'mutate_merge_objet_et_scalaire', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: { k: 1 }, b: 'x' }, { a: 'x', b: { l: 2 } }, { b: { l: 2 } }] },
  { id: 'mutate_merge_elements_vides', filter: 'mutate { merge => { "a" => "b" } }', events: [{ a: ['x', ''], b: [['y'], null] }], known: 'Logstash met les deux tableaux bout à bout ; la traduction en retire les chaînes vides et les nuls, et aplatit les tableaux imbriqués' },

  // mutate applique ses opérations dans un ordre fixe, pas dans celui du pipeline : rename avant uppercase, update avant replace
  { id: 'mutate_ordre_rename_uppercase', filter: 'mutate { uppercase => ["b"] rename => { "a" => "b" } }', events: [{ a: 'x' }] },
  { id: 'mutate_split_puis_join', filter: 'mutate { replace => { "a" => "x,y" } split => { "a" => "," } join => { "a" => "-" } }', events: [{ n: 1 }], known: 'configuration refusée par Vector (E651) : après replace et split, VRL sait que le champ est un tableau de chaînes, et refuse le repli que le moteur écrit autour de join' },
  { id: 'mutate_ordre_update_replace', filter: 'mutate { replace => { "a" => "R" } update => { "a" => "U" } }', events: [{ a: 'x' }, { b: 1 }] },

  // Options communes à tous les filtres
  { id: 'commun_add_field', filter: 'mutate { add_field => { "k" => "v" "[x][y]" => "z" } }', events: [{ n: 1 }, { x: { t: 1 } }] },
  { id: 'commun_add_field_champ_existant', filter: 'mutate { add_field => { "k" => "v" "[x][y]" => "z" } }', events: [{ k: 'déjà' }, { x: { y: 'déjà' } }], known: 'sur un champ qui existe, Logstash ajoute la valeur et en fait un tableau ; la traduction écrase' },
  { id: 'commun_add_field_sous_champ_de_scalaire', filter: 'mutate { add_field => { "[x][y]" => "z" } }', events: [{ x: 'scalaire' }], known: 'Logstash refuse d’écrire sous un champ scalaire et pose _mutate_error ; la traduction remplace le scalaire' },
  { id: 'commun_remove_field', filter: 'mutate { remove_field => ["a", "[x][y]"] }', events: [{ a: 1, b: 2 }, { x: { y: 1, z: 2 } }, { x: { y: 1 } }, { b: 2 }] },
  { id: 'commun_remove_field_dynamique', filter: 'mutate { remove_field => ["%{nom}"] }', events: [{ nom: 'a', a: 1 }, { nom: '[x][y]', x: { y: 1, z: 2 } }, { a: 1 }] },
  { id: 'commun_add_tag', filter: 'mutate { add_tag => ["t1", "t-%{n}"] }', events: [{ n: 1 }, { n: 2, tags: ['t0'] }, { n: 3, tags: ['t1'] }, { n: 4, tags: 'chaine' }] },
  { id: 'commun_remove_tag', filter: 'mutate { remove_tag => ["t1"] }', events: [{ tags: ['t0', 't1'] }, { tags: ['t1'] }, { tags: 't1' }, { tags: 't0' }] },
  { id: 'commun_remove_tag_sans_tags', filter: 'mutate { remove_tag => ["t1"] }', events: [{ n: 1 }] },

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
  { id: 'condition_verite_chaine', filter: si('[a]'), events: [{ a: '' }, { a: 'false' }] },
  { id: 'condition_negation', filter: si('![a]'), events: [{ a: 'x' }, { a: false }, { b: 1 }, { a: '' }, { a: 'false' }] },
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

  // Plusieurs filtres dans un même bloc if : ils partagent un programme VRL, que Vector doit accepter
  { id: 'bloc_json_puis_kv', filter: 'if [t] == "x" { json { source => "message" } kv { source => "extra" } }', events: [{ t: 'x', message: '{"a":1}', extra: 'k=v' }, { t: 'y', message: '{"a":1}', extra: 'k=v' }] },
  { id: 'bloc_add_field_puis_mutate', filter: 'if [t] == "x" { grok { match => { "message" => "%{WORD:w}" } add_field => { "k" => "v" } } mutate { uppercase => ["k"] } }', events: [{ t: 'x', message: 'a' }, { t: 'x', message: '!' }] },
  { id: 'bloc_remove_field_puis_mutate', filter: 'if [t] == "x" { grok { match => { "message" => "%{IP:ip}" } remove_field => ["message"] } mutate { uppercase => ["message"] } }', events: [{ t: 'x', message: '10.0.0.1' }, { t: 'x', message: 'pas une adresse' }] },

  // grok
  { id: 'grok_champs_types', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:path} %{NUMBER:status:int} %{NUMBER:bytes:int}" } }', lines: ['GET /a 200 12', 'POST /b 500 7', 'ligne sans rapport'] },
  { id: 'grok_types', filter: 'grok { match => { "message" => "%{NUMBER:entier:int} %{NUMBER:flottant:float} %{NUMBER:texte}" } }', lines: ['12 3.5 42', '-7 10 0.5'] },
  { id: 'grok_plusieurs_motifs', filter: 'grok { match => { "message" => ["%{IP:ip} %{WORD:action}", "%{WORD:action} depuis %{IP:ip}"] } }', lines: ['10.0.0.1 connexion', 'connexion depuis 10.0.0.2', 'rien à voir'] },
  { id: 'grok_plusieurs_champs', filter: 'grok { match => { "message" => "%{WORD:w}" "autre" => "%{WORD:z}" } }', events: [{ message: 'a', autre: 'b' }], known: 'avec plusieurs champs dans match, Logstash s’arrête au premier qui correspond (break_on_match) ; la traduction les applique tous' },
  { id: 'grok_motif_defini', filter: 'grok { pattern_definitions => { "CODE" => "[A-Z]{3}-[0-9]+" } match => { "message" => "%{CODE:code} %{GREEDYDATA:reste}" } }', lines: ['ABC-123 le reste du message', 'abc-1 pas de code'] },
  { id: 'grok_champ_imbrique', filter: 'grok { match => { "message" => "%{IP:[client][ip]} %{NUMBER:[http][status]:int}" } }', lines: ['10.0.0.1 200'] },
  { id: 'grok_capture_anonyme', filter: 'grok { match => { "message" => "%{IP} %{WORD:action} (?<code>[A-Z]+)" } }', lines: ['10.0.0.1 connexion OK'] },
  { id: 'grok_champ_existant', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:chemin}" } }', events: [{ message: 'GET /a', verb: 'déjà' }], known: 'quand le champ capturé existe déjà, Logstash ajoute la capture et en fait un tableau ; la traduction écrase' },
  { id: 'grok_overwrite', filter: 'grok { match => { "message" => "%{TIMESTAMP_ISO8601:quand} %{GREEDYDATA:message}" } overwrite => ["message"] }', lines: ['2026-03-10T08:15:30Z le texte utile'] },
  { id: 'grok_source_absente', filter: 'grok { match => { "message" => "%{WORD:verb}" } }', events: [{ n: 1 }, { message: null }] },
  { id: 'grok_source_nombre', filter: 'grok { match => { "message" => "%{WORD:verb}" } }', events: [{ message: 42 }], known: 'Logstash lit un nombre comme du texte ; la traduction pose _grokparsefailure' },
  { id: 'grok_etiquette_echec', filter: 'grok { match => { "message" => "%{IP:ip}" } tag_on_failure => ["echec_ip"] }', lines: ['10.0.0.1', 'pas une adresse'] },
  { id: 'grok_succes_seulement', filter: 'grok { match => { "message" => "%{IP:ip}" } add_tag => ["analyse"] add_field => { "source" => "grok" } }', lines: ['10.0.0.1', 'pas une adresse'] },
  { id: 'grok_target', filter: 'grok { match => { "message" => "%{WORD:verb} %{URIPATH:chemin}" } target => "http" }', lines: ['GET /a'], known: 'target n’est pas appliqué : les captures sont posées à la racine' },
  { id: 'grok_journal_apache', filter: 'grok { match => { "message" => "%{COMBINEDAPACHELOG}" } }', lines: ['192.168.1.10 - alice [10/Mar/2026:08:15:30 +0000] "GET /index.html?x=1 HTTP/1.1" 200 5123 "https://exemple.fr/" "Mozilla/5.0 (X11; Linux x86_64)"'], known: { v8: 'en mode ECS, COMBINEDAPACHELOG capture sous les noms ECS ([source][address], [http][request][method]…) et type les nombres ; la traduction garde les noms historiques (clientip, verb…)' } },
  { id: 'grok_ligne_syslog', filter: 'grok { match => { "message" => "%{SYSLOGLINE}" } }', lines: ['Mar 10 08:15:30 web-1 sshd[1234]: Accepted publickey for alice'], known: { v8: 'en mode ECS, SYSLOGLINE capture sous les noms ECS ; la traduction garde les noms historiques', disabled: 'le motif capture message, qui existe déjà : Logstash en fait un tableau, la traduction écrase' } },

  // dissect
  { id: 'dissect_simple', filter: 'dissect { mapping => { "message" => "%{date} %{niveau} [%{service}] %{texte}" } }', lines: ['2026-03-10 INFO [api] démarrage terminé', 'ligne sans crochets'] },
  { id: 'dissect_ajout', filter: 'dissect { mapping => { "message" => "%{quand} %{+quand} %{texte}" } }', lines: ['2026-03-10 08:15:30 le reste'], known: '%{+champ} n’ajoute rien : « 2026-03-10 » au lieu de « 2026-03-10 08:15:30 »' },
  { id: 'dissect_champ_ignore', filter: 'dissect { mapping => { "message" => "%{} %{niveau->} %{texte}" } }', lines: ['x INFO    le reste', 'x WARN le reste'] },
  { id: 'dissect_types', filter: 'dissect { mapping => { "message" => "%{n} %{f} %{s}" } convert_datatype => { "n" => "int" "f" => "float" } }', lines: ['12 3.5 texte'] },
  { id: 'dissect_types_non_convertibles', filter: 'dissect { mapping => { "message" => "%{n} %{f} %{s}" } convert_datatype => { "n" => "int" "f" => "float" } }', lines: ['x y texte'], known: 'Logstash pose _dataconversionuncoercible_<champ>_<type> ; la traduction ne pose rien' },
  // Seule l’absence du champ est passée sous silence : un champ nul est un échec
  { id: 'dissect_source_absente', filter: 'dissect { mapping => { "message" => "%{a} %{b}" } }', events: [{ n: 1 }, { message: null }] },
  { id: 'dissect_etiquette_echec', filter: 'dissect { mapping => { "message" => "%{a}|%{b}" } tag_on_failure => ["echec_decoupe"] }', lines: ['x|y', 'sans séparateur'] },

  // date
  { id: 'date_iso8601', filter: 'date { match => ["ts", "ISO8601"] }', events: [{ ts: '2026-03-10T08:15:30.123Z' }, { ts: '2026-03-10T09:15:30+01:00' }, { ts: '2026-03-10T08:15:30Z' }] },
  { id: 'date_iso8601_formes', filter: 'date { match => ["ts", "ISO8601"] }', events: [{ ts: '2026-03-10 08:15:30' }, { ts: '2026-03-10T08:15:30' }, { ts: '2026-03-10T08:15:30.123456Z' }] },
  { id: 'date_iso8601_jour_seul', filter: 'date { match => ["ts", "ISO8601"] }', events: [{ ts: '2026-03-10' }], known: 'une date sans heure est lue par Logstash, à minuit ; la traduction la refuse' },
  { id: 'date_echec', filter: 'date { match => ["ts", "ISO8601"] }', events: [{ ts: 'pas une date' }, { ts: '' }] },
  { id: 'date_champ_absent', filter: 'date { match => ["ts", "ISO8601"] }', events: [{ n: 1 }, { ts: null }] },
  { id: 'date_unix_champ_absent', filter: 'date { match => ["ts", "UNIX"] }', events: [{ n: 1 }, { ts: null }] },
  { id: 'date_unix', filter: 'date { match => ["ts", "UNIX"] }', events: [{ ts: 1773130530 }, { ts: '1773130530' }] },
  { id: 'date_unix_decimales', filter: 'date { match => ["ts", "UNIX"] }', events: [{ ts: 1773130530.123 }, { ts: '1773130530.123' }], known: 'les décimales d’un horodatage UNIX sont perdues, et la chaîne « 1773130530.123 » est refusée' },
  { id: 'date_unix_ms', filter: 'date { match => ["ts", "UNIX_MS"] }', events: [{ ts: 1773130530123 }, { ts: '1773130530123' }] },
  { id: 'date_format_apache', filter: 'date { match => ["ts", "dd/MMM/yyyy:HH:mm:ss Z"] }', events: [{ ts: '10/Mar/2026:08:15:30 +0000' }, { ts: '10/Mar/2026:09:15:30 +0100' }] },
  { id: 'date_plusieurs_formats', filter: 'date { match => ["ts", "yyyy-MM-dd HH:mm:ss", "dd/MM/yyyy HH:mm"] }', events: [{ ts: '2026-03-10 08:15:30' }, { ts: '10/03/2026 08:15' }, { ts: '10 mars 2026' }] },
  { id: 'date_fuseau', filter: 'date { match => ["ts", "yyyy-MM-dd HH:mm:ss"] timezone => "Europe/Paris" }', events: [{ ts: '2026-01-15 12:00:00' }, { ts: '2026-07-15 12:00:00' }, { ts: '2026-03-29 02:30:00' }] },
  { id: 'date_fuseau_heure_double', filter: 'date { match => ["ts", "yyyy-MM-dd HH:mm:ss"] timezone => "Europe/Paris" }', events: [{ ts: '2026-10-25 02:30:00' }], known: 'à la fin de l’heure d’été, 02:30 existe deux fois : Logstash prend la première, la traduction refuse la date' },
  { id: 'date_sans_fuseau', filter: 'date { match => ["ts", "yyyy-MM-dd HH:mm:ss"] }', events: [{ ts: '2026-01-15 12:00:00' }] },
  { id: 'date_sans_annee', filter: 'date { match => ["ts", "MMM dd HH:mm:ss"] }', events: [{ ts: 'Mar 10 08:15:30' }], known: 'sans année dans le format, Logstash prend l’année courante ; la traduction refuse la date' },
  { id: 'date_target', filter: 'date { match => ["ts", "ISO8601"] target => "quand" }', events: [{ ts: '2026-03-10T08:15:30.123Z' }] },
  { id: 'date_target_seconde_ronde', filter: 'date { match => ["ts", "ISO8601"] target => "quand" }', events: [{ ts: '2026-03-10T08:15:30Z' }], known: 'un champ cible autre que @timestamp perd ses millisecondes quand elles sont nulles ; Logstash écrit toujours « .000 »' },
  { id: 'date_millisecondes', filter: 'date { match => ["ts", "yyyy-MM-dd HH:mm:ss.SSS"] }', events: [{ ts: '2026-03-10 08:15:30.123' }, { ts: '2026-03-10 08:15:30.100' }] },
  { id: 'date_mois_francais', filter: 'date { match => ["ts", "dd MMMM yyyy"] locale => "fr" }', events: [{ ts: '10 mars 2026' }, { ts: '15 août 2026' }], known: 'locale n’est pas traduit : les noms de mois français ne sont pas lus' },
  { id: 'date_etiquette_echec', filter: 'date { match => ["ts", "ISO8601"] tag_on_failure => ["date_illisible"] }', events: [{ ts: 'pas une date' }] },

  // json
  { id: 'json_simple', filter: 'json { source => "message" }', lines: ['{"a":1,"b":{"c":"deux"},"d":[1,2]}', '{"message":"remplacé"}'] },
  { id: 'json_invalide', filter: 'json { source => "message" }', lines: ['pas du json', '{"a":'] },
  // Un JSON qui n’est pas un objet ne peut pas être posé à la racine : c’est un échec, même avec skip_on_invalid_json
  { id: 'json_racine_non_objet', filter: 'json { source => "message" }', lines: ['[1,2,3]', '42', '"texte"', 'null'] },
  { id: 'json_racine_non_objet_ignore', filter: 'json { source => "message" skip_on_invalid_json => true }', lines: ['[1,2]', '42'] },
  { id: 'json_target', filter: 'json { source => "message" target => "doc" }', lines: ['{"a":1}', '[1,2]', '42'] },
  { id: 'json_champ_existant', filter: 'json { source => "charge" }', events: [{ charge: '{"a":1,"b":{"c":2}}', a: 'ancien', b: { d: 3 } }] },
  { id: 'json_retire_la_source', filter: 'json { source => "message" remove_field => ["message"] }', lines: ['{"a":1}', 'pas du json', '[1,2]'] },
  { id: 'json_invalide_ignore', filter: 'json { source => "message" skip_on_invalid_json => true }', lines: ['{"a":1}', 'pas du json'] },
  { id: 'json_source_non_chaine', filter: 'json { source => "charge" }', events: [{ charge: 42 }, { charge: { deja: 'objet' } }] },
  { id: 'json_source_absente', filter: 'json { source => "charge" }', events: [{ n: 1 }, { charge: null }] },
  { id: 'json_horodatage', filter: 'json { source => "message" }', lines: ['{"@timestamp":"2026-03-10T08:15:30.123Z","a":1}'] },
  { id: 'json_horodatage_invalide', filter: 'json { source => "message" }', lines: ['{"@timestamp":"pas une date","a":2}'], known: 'Logstash garde l’horodatage d’ingestion, range la valeur dans _@timestamp et pose _timestampparsefailure ; la traduction écrit la chaîne dans @timestamp' },
  { id: 'json_etiquette_echec', filter: 'json { source => "message" tag_on_failure => ["json_illisible"] }', lines: ['pas du json', '[1,2]'] },

  // kv
  { id: 'kv_simple', filter: 'kv { }', lines: ['a=1 b=deux c="trois quatre"', 'a=1 a=2'] },
  { id: 'kv_mot_sans_valeur', filter: 'kv { }', lines: ['sans paire', 'espace=a b'], known: 'un mot sans « = » devient un champ à true ; Logstash l’ignore' },
  { id: 'kv_separateurs', filter: 'kv { field_split => "&" value_split => ":" }', lines: ['a:1&b:deux&c:3'] },
  { id: 'kv_separateurs_multiples', filter: 'kv { field_split => "&?" }', lines: ['a=1&b=2?c=3'], known: 'field_split est réduit à son premier caractère' },
  { id: 'kv_prefixe_cible', filter: 'kv { prefix => "p_" target => "paires" }', lines: ['a=1 b=2'] },
  { id: 'kv_cles_choisies', filter: 'kv { include_keys => ["a", "b"] }', lines: ['a=1 b=2 c=3'] },
  { id: 'kv_cles_exclues', filter: 'kv { exclude_keys => ["b"] }', lines: ['a=1 b=2 c=3'] },
  { id: 'kv_source', filter: 'kv { source => "requete" }', events: [{ requete: 'a=1 b=2' }, { n: 1 }, { requete: 42 }] },
  { id: 'kv_valeurs', filter: 'kv { }', lines: ['vide= url=http://x/?q=1 n=42'] },

  // csv
  { id: 'csv_colonnes', filter: 'csv { columns => ["a", "b", "c"] }', lines: ['x,y,z', 'x,"y, avec virgule",z'] },
  { id: 'csv_champ_vide', filter: 'csv { columns => ["a", "b", "c"] }', lines: ['x,,z'], known: 'un champ vide vaut null pour Logstash, une chaîne vide pour la traduction' },
  { id: 'csv_colonnes_manquantes', filter: 'csv { columns => ["a", "b", "c"] }', lines: ['x,y'], known: 'une colonne sans valeur est créée à null ; Logstash ne la crée pas' },
  { id: 'csv_colonnes_en_trop', filter: 'csv { columns => ["a", "b", "c"] }', lines: ['x,y,z,t'], known: 'une valeur au-delà des colonnes nommées est perdue ; Logstash la range dans column4' },
  { id: 'csv_separateur', filter: 'csv { separator => ";" columns => ["a", "b"] }', lines: ['x;y'] },
  { id: 'csv_sans_colonnes', filter: 'csv { }', lines: ['x,y,z'], known: 'sans columns, Logstash nomme column1, column2… ; la traduction range les valeurs dans un tableau csv' },
  { id: 'csv_types', filter: 'csv { columns => ["a", "n"] convert => { "n" => "integer" } }', lines: ['x,42', 'x,y'] },
  { id: 'csv_invalide', filter: 'csv { columns => ["a", "b"] }', lines: ['x,"guillemet non fermé'], known: 'pour un guillemet non fermé, Logstash pose _csvparsefailure ; la traduction découpe quand même' },
  { id: 'csv_cible', filter: 'csv { columns => ["a", "b"] target => "ligne" }', lines: ['x,y'], known: 'target n’est pas appliqué : les colonnes sont posées à la racine' },

  // xml
  { id: 'xml_simple', filter: 'xml { source => "message" target => "doc" }', lines: ['<a><b>1</b><c x="2">3</c><c>4</c></a>'], known: 'l’objet n’a pas la même forme : Logstash retire la racine, range tout en tableaux de chaînes et nomme le texte « content » ; la traduction garde la racine, préfixe les attributs de « @ », nomme le texte « text » et lit les nombres' },
  { id: 'xml_sans_tableaux', filter: 'xml { source => "message" target => "doc" force_array => false }', lines: ['<a><b>1</b><c x="2">3</c></a>'], known: 'même sans tableaux forcés, la racine, les attributs, le texte et les nombres ne sont pas rendus comme par Logstash' },
  { id: 'xml_invalide', filter: 'xml { source => "message" target => "doc" }', lines: ['<a><b>1</a>', 'pas du xml'] },
  { id: 'xml_xpath', filter: 'xml { source => "message" store_xml => false xpath => { "/a/b/text()" => "b" } }', lines: ['<a><b>1</b><b>2</b></a>'], known: 'xpath n’est pas appliqué : le document entier est rangé sous xml' },
  { id: 'xml_source_absente', filter: 'xml { source => "message" target => "doc" }', events: [{ n: 1 }, { message: null }, { message: '' }, { message: '  ' }] },

  // split
  { id: 'split_tableau', filter: 'split { field => "articles" }', events: [{ commande: 1, articles: ['a', 'b', 'c'] }, { commande: 2, articles: ['seul'] }] },
  { id: 'split_objets', filter: 'split { field => "articles" }', events: [{ commande: 1, articles: [{ ref: 'a', q: 1 }, { ref: 'b', q: 2 }] }] },
  { id: 'split_imbrique', filter: 'split { field => "[corps][articles]" }', events: [{ corps: { articles: ['a', 'b'], client: 'x' } }] },
  { id: 'split_chaine', filter: 'split { field => "liste" terminator => "," }', events: [{ liste: 'a,b,c' }] },
  { id: 'split_lignes', filter: 'split { }', events: [{ message: 'ligne 1\nligne 2' }] },
  { id: 'split_cible', filter: 'split { field => "articles" target => "article" }', events: [{ articles: ['a', 'b'] }, { articles: 'x\ny' }, { articles: 'seul' }] },
  // Un élément vide ou nul ne donne pas d’événement
  { id: 'split_elements_vides', filter: 'split { field => "articles" }', events: [{ n: 1, articles: ['a', '', null, 'b'] }, { n: 2, articles: ['', null] }] },
  // Une chaîne qui ne donne qu’un élément n’est pas touchée, et add_tag ne lui est pas appliqué ; une chaîne vide ne donne aucun événement
  { id: 'split_chaine_seule', filter: 'split { field => "liste" terminator => "," add_tag => ["decoupe"] }', events: [{ liste: 'seul' }, { liste: 'a,b' }, { liste: 'a,,b,' }, { liste: '' }] },
  { id: 'split_tableau_vide', filter: 'split { field => "articles" }', events: [{ n: 1, articles: [] }] },
  { id: 'split_non_decoupable', filter: 'split { field => "articles" }', events: [{ n: 1 }, { n: 2, articles: 42 }, { n: 3, articles: null }] },
  { id: 'split_sous_condition', filter: 'if [type] == "lot" { split { field => "articles" } }', events: [{ type: 'lot', articles: ['a', 'b'] }, { type: 'unitaire', articles: ['c', 'd'] }] },

  // drop
  { id: 'drop_conditionnel', filter: 'if [niveau] == "debug" { drop { } }', events: [{ niveau: 'info', n: 1 }, { niveau: 'debug', n: 2 }, { niveau: 'erreur', n: 3 }] },
  { id: 'drop_tout', filter: 'drop { }', events: [{ n: 1 }, { n: 2 }] },
  { id: 'drop_puis_suite', filter: 'if [n] == 2 { drop { } }\nmutate { add_tag => ["garde"] }', events: [{ n: 1 }, { n: 2 }, { n: 3 }] },

  // translate
  { id: 'translate_dictionnaire', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} }`, events: [{ code: '200' }, { code: '404' }, { code: '500' }, { n: 1 }] },
  { id: 'translate_valeur_de_repli', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} fallback => "inconnu" }`, events: [{ code: '200' }, { code: '500' }] },
  // Seule l’absence du champ arrête la traduction : un champ nul reçoit la valeur de repli
  { id: 'translate_repli_source_absente', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} fallback => "inconnu" add_tag => ["traduit"] }`, events: [{ n: 1 }, { code: null }] },
  { id: 'translate_nombre', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} }`, events: [{ code: 200 }] },
  { id: 'translate_cible_existante', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} }`, events: [{ code: '200', libelle: 'déjà' }], known: 'la cible qui existe déjà est écrasée ; Logstash la garde, sauf avec override' },
  { id: 'translate_override', filter: `translate { source => "code" target => "libelle" ${DICTIONNAIRE} override => true }`, events: [{ code: '200', libelle: 'déjà' }] },
  { id: 'translate_sans_cible', filter: `translate { source => "code" ${DICTIONNAIRE} }`, events: [{ code: '200' }], known: { v8: 'sans target, Logstash en mode ECS écrit sur place, dans le champ source ; la traduction écrit dans translation, comme le mode historique' } },

  // fingerprint
  { id: 'fingerprint_sha256', filter: 'fingerprint { source => "message" target => "empreinte" method => "SHA256" }', lines: ['abc', 'été'] },
  { id: 'fingerprint_sha1', filter: 'fingerprint { source => "message" target => "empreinte" method => "SHA1" }', lines: ['abc'] },
  { id: 'fingerprint_md5', filter: 'fingerprint { source => "message" target => "empreinte" method => "MD5" }', lines: ['abc'] },
  { id: 'fingerprint_murmur3', filter: 'fingerprint { source => "message" target => "empreinte" method => "MURMUR3" }', lines: ['abc'], known: 'MURMUR3 : Logstash donne un entier sur 32 bits, la traduction une chaîne tirée d’un autre hachage' },
  { id: 'fingerprint_sans_cible', filter: 'fingerprint { source => "message" method => "SHA256" }', lines: ['abc'], known: { v8: 'sans target, Logstash en mode ECS écrit dans [event][hash] ; la traduction écrit dans fingerprint, comme le mode historique' } },
  { id: 'fingerprint_nombre', filter: 'fingerprint { source => "n" target => "empreinte" method => "SHA256" }', events: [{ n: 42 }, { n: 1.5 }] },
  // Seule l’absence du champ retient l’empreinte : un champ nul donne celle d’une chaîne vide
  { id: 'fingerprint_source_absente', filter: 'fingerprint { source => "s" target => "empreinte" method => "SHA256" }', events: [{ n: 1 }, { s: null }] },
  { id: 'fingerprint_champs_concatenes', filter: 'fingerprint { source => ["a", "b"] target => "empreinte" method => "SHA256" concatenate_sources => true }', events: [{ a: 'x', b: 'y' }], known: 'avec concatenate_sources, la chaîne hachée n’est pas celle que compose Logstash' },
  { id: 'fingerprint_champs_separes', filter: 'fingerprint { source => ["a", "b"] target => "empreinte" method => "SHA256" }', events: [{ a: 'x', b: 'y' }], known: 'sans concatenate_sources, Logstash garde l’empreinte du dernier champ ; la traduction hache les champs réunis' },

  // uuid
  { id: 'uuid_cible', filter: 'uuid { target => "id" }', events: [{ n: 1 }] },
  { id: 'uuid_cible_existante', filter: 'uuid { target => "id" }', events: [{ id: 'déjà' }] },
  { id: 'uuid_overwrite', filter: 'uuid { target => "id" overwrite => true }', events: [{ id: 'déjà' }] },

  // urldecode
  { id: 'urldecode_champ', filter: 'urldecode { field => "url" }', events: [{ url: 'a%20b%2Fc%C3%A9' }, { url: 'a+b' }, { url: '100%' }, { n: 1 }] },
  { id: 'urldecode_octet_invalide', filter: 'urldecode { field => "url" }', events: [{ url: '%E9' }], known: 'un octet qui n’est pas de l’UTF-8 est écrit « \\xE9 » par Logstash, « � » par la traduction' },
  { id: 'urldecode_tous_les_champs', filter: 'urldecode { all_fields => true }', events: [{ a: 'x%20y', b: 'z%21' }], known: 'all_fields n’est pas appliqué : aucun champ n’est décodé, et message est créé à null' },

  // truncate
  { id: 'truncate_octets', filter: 'truncate { fields => ["a"] length_bytes => 5 }', events: [{ a: 'abcdefgh' }, { a: 'abc' }, { a: 12345678 }] },
  { id: 'truncate_champ_absent', filter: 'truncate { fields => ["a"] length_bytes => 5 }', events: [{ n: 1 }, { a: null }] },
  // length_bytes compte des octets, et la coupe ne tombe jamais au milieu d’un caractère
  { id: 'truncate_accents', filter: 'truncate { fields => ["a"] length_bytes => 5 }', events: [{ a: 'éééé' }, { a: 'aéééé' }, { a: 'abcdé' }, { a: '😀😀' }, { a: '😀' }] },
  { id: 'truncate_tableau', filter: 'truncate { fields => ["a"] length_bytes => 5 }', events: [{ a: ['abcdefgh', 'x'] }], known: 'un tableau n’est pas tronqué élément par élément' },

  // cidr
  { id: 'cidr_reseau', filter: `cidr { address => ["%{ip}"] network => ["10.0.0.0/8", "192.168.0.0/16"] add_tag => ["interne"] }`, events: [{ ip: '10.1.2.3' }, { ip: '192.168.5.5' }, { ip: '8.8.8.8' }] },
  { id: 'cidr_adresse_invalide', filter: `cidr { address => ["%{ip}"] network => ["10.0.0.0/8"] add_tag => ["interne"] }`, events: [{ ip: 'pas une adresse' }, { n: 1 }] },
  { id: 'cidr_ipv6', filter: `cidr { address => ["%{ip}"] network => ["fd00::/8"] add_tag => ["interne"] }`, events: [{ ip: 'fd12::1' }, { ip: '2001:db8::1' }] },

  // useragent
  { id: 'useragent_navigateur', filter: 'useragent { source => "ua" target => "navigateur" }', events: [{ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, { ua: 'curl/8.4.0' }], known: 'les champs produits n’ont ni les mêmes noms ni les mêmes valeurs : name, os, major… pour Logstash (ou leurs équivalents ECS), browser.family, os.family, device.category pour la traduction' },
  { id: 'useragent_source_absente', filter: 'useragent { source => "ua" target => "navigateur" }', events: [{ n: 1 }] },

  // Sorties : le routage par conditions
  { id: 'sortie_selon_condition', filter: '', output: o => `if [niveau] == "erreur" { ${o('erreurs')} } else { ${o('autres')} }`, events: [{ niveau: 'erreur', n: 1 }, { niveau: 'info', n: 2 }, { n: 3 }] },
  { id: 'sortie_sans_sinon', filter: '', output: o => `if [niveau] == "erreur" { ${o('erreurs')} }`, events: [{ niveau: 'erreur', n: 1 }, { niveau: 'info', n: 2 }] },
  { id: 'sortie_double', filter: '', output: o => `${o('une')}\n${o('deux')}`, events: [{ n: 1 }, { n: 2 }] },
  { id: 'sortie_en_cascade', filter: '', output: o => `if "alerte" in [tags] { ${o('alertes')} } else if [region] == "EMEA" { ${o('emea')} } else { ${o('autres')} }`, events: [{ tags: ['alerte'], region: 'EMEA' }, { region: 'EMEA' }, { region: 'APAC' }, { n: 1 }] },
  { id: 'sortie_commune_et_conditionnelle', filter: '', output: o => `${o('tout')}\nif [niveau] == "erreur" { ${o('erreurs')} }`, events: [{ niveau: 'erreur', n: 1 }, { niveau: 'info', n: 2 }] },

  // Les pipelines d’exemple du dépôt, à leur transport près (voir example dans transport.mjs).
  // nginx.conf n’est pas joué : son filtre geoip demande la même base de données des deux côtés.
  { id: 'exemple_batch', ...example('batch.conf'), lines: ['2026-03-10 09:15:30,123 [INFO] billing: {"order":"A1","items":[{"sku":"x","qty":"2"},{"sku":"y","qty":"1"}]}', '2026-07-15 14:00:00,000 [WARN] Api Gateway: {"order":"A2","items":[{"sku":"z","qty":"5"}]}'], known: 'le filtre ruby n’est pas traduit : le champ computed manque' },
  { id: 'exemple_routage', ...example('routage.conf'), events: [{ level: 'ERROR', env: 'prod', payload: '{"country":"FR","user_id":"u1","extra":"a=1&b=2"}' }, { level: 'INFO', env: 'prod', payload: '{"country":"DE","user_id":"u2","extra":"c=3"}' }, { level: 'INFO', env: 'dev', payload: '{"country":"JP","user_id":"u3","extra":"d=4"}' }, { level: 'DEBUG', env: 'dev', payload: '{"country":"US","user_id":"u4","extra":"e=5"}' }] },
];
