# Journal des modifications

Toutes les évolutions notables de Passerelle sont consignées ici. Le format s’inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les versions suivent le [versionnage sémantique](https://semver.org/lang/fr/).

## [1.5.0] - 2026-10-28

### Ajouté

- **Interface, section « Kibana »** : on y dépose un export d’objets sauvegardés (`.ndjson`, plusieurs exports réunis). À gauche, les tableaux de bord et leurs panneaux, puis les objets qu’aucun tableau de bord n’affiche, chacun avec son verdict et un filtre par titre ; à droite, les requêtes SQL ClickHouse de l’objet choisi (tout le tableau de bord, panneau après panneau, ou un seul panneau), avec le verdict, l’effort et les remarques de l’inventaire. Les onglets montrent aussi la requête DSL que Kibana envoie, reconstituée (« Ouvrir dans Requêtes » la reprend dans la section Requêtes), et la lecture de l’objet : vue de données, table, paramètres, champs cités, détail de l’effort. La vue d’ensemble reprend la synthèse de l’inventaire ; l’archive téléchargée contient un fichier SQL par objet et l’inventaire en Markdown, CSV et HTML.
- Un fichier `.ndjson`, ou un `.json` dont la première ligne est un objet sauvegardé ou une règle de détection, déposé n’importe où dans l’interface ouvre la section Kibana (depuis « Autres sources », il reste dans l’inventaire). Le test d’interface (`npm run test:ui`) couvre la nouvelle section.

### Modifié

- Interface : les tableaux des rapports (inventaire, Grafana, analyseurs) sont mis en forme, colonnes de nombres alignées à droite ; sur mobile, la barre de navigation prend des libellés courts pour tenir ses huit sections.
- README : le GIF de démonstration et les captures (lecture, remarques, pipelines) sont refaits avec l’interface de la 1.5.0, section Kibana comprise ; le nombre de filtres Logstash repris passe de 18 à 25.

## [1.4.0] - 2026-10-28

### Ajouté

- **TLS des sources qui écoutent** : une entrée Logstash `beats`, `tcp` ou `http` reprend `ssl_enabled`, `ssl_certificate`, `ssl_key`, `ssl_certificate_authorities`, `ssl_client_authentication` (ou `ssl_verify_mode`) et `ssl_key_passphrase` (lue dans une variable d’environnement) dans le `tls` de la source Vector ; un magasin Java (JKS, PKCS12) est signalé, avec des chemins PEM à remplir. Sans TLS, la source est signalée « à vérifier » : tout hôte qui atteint le port peut y envoyer des événements. La source Elastic Agent des pipelines d’ingestion se règle par `vector.ingest_source` (`address`, `tls.crt_file`, `tls.key_file`, `tls.ca_file`, `tls.verify_client`), et elle est signalée de la même façon quand TLS est absent. Un banc (`tests/ingest/tls.mjs`) vérifie avec Vector que la configuration est acceptée, que le handshake répond avec le certificat donné et qu’une connexion en clair est refusée.

Horizon 2 : au-delà des requêtes et des pipelines Logstash, Passerelle lit désormais ce qui entoure Elasticsearch. Chaque sortie garde les verdicts prête, à vérifier, à reprendre ou non reconnue.

- **Inventaire Kibana** (`passerelle kibana`, `POST /v1/inventory/kibana`) : lit un export d’objets sauvegardés (NDJSON) et dresse le catalogue de ce qui se traduit (index patterns, recherches, visualisations, Lens, cartes, tableaux de bord, alertes, règles de sécurité, connecteurs, canvas, graphes), objet par objet, en `md`, `html`, `csv` ou `json`. Les requêtes DSL, KQL et Lucene qu’ils portent sont traduites en SQL.
- **Tableaux de bord Grafana** (`passerelle grafana`, `POST /v1/translate/grafana`) : les panneaux à source Elasticsearch deviennent des requêtes SQL ClickHouse, avec un rapport par panneau et le tableau de bord réécrit.
- **Schéma** (`passerelle schema ddl`, `schema pull`) : `CREATE TABLE` ClickHouse déduit d’un mapping Elasticsearch, avec les préréglages OpenTelemetry `otel` (Map) et `otel-json` (colonnes JSON typées) ; `schema pull` lit les tables déjà présentes pour que les traductions s’y adaptent.
- **Pipelines d’ingestion Elasticsearch** (`passerelle ingest`, `POST /v1/translate/ingest`) : les pipelines d’ingestion deviennent des étapes VRL. Processeurs pris en charge : `append`, `bytes`, `community_id`, `convert`, `csv`, `date`, `dissect`, `dot_expander`, `drop`, `fail`, `fingerprint`, `foreach`, `geoip`, `grok`, `gsub`, `html_strip`, `join`, `json`, `kv`, `lowercase`, `pipeline`, `registered_domain`, `remove`, `rename`, `reroute`, `script` (Painless), `set`, `sort`, `split`, `terminate`, `trim`, `uppercase`, `uri_parts`, `urldecode`, `user_agent`. Un pipeline appelé par un autre est résolu parmi les fichiers donnés.
- **Sortie ClickHouse** : avec `vector.elasticsearch_output: clickhouse`, la sortie `elasticsearch` d’un pipeline Logstash devient un puits ClickHouse (table, colonnes inconnues ignorées signalées).
- **Plusieurs pipelines** : `pipelines.yml` est lu (`passerelle ls2vector pipelines.yml`, `POST /v1/translate/logstash/pipelines`), les pipelines qui s’appellent entre eux sont reliés.
- **Analyseurs personnalisés** (`passerelle schema analyzers`) : un analyseur Elasticsearch (char_filters, tokenizers, filtres) devient une colonne `MATERIALIZED` et un index plein texte ClickHouse, avec l’aperçu des termes produits et la requête de recherche correspondante. Voir [docs/ANALYSEURS.md](docs/ANALYSEURS.md).
- Sortie ClickHouse : `clickhouse.sink_user` et `clickhouse.sink_password` donnent à Vector un compte d’écriture distinct du compte de validation (lecture seule) ; sans eux, le puits reprend `clickhouse.user` et la traduction le signale « à vérifier ».
- API : `POST /v1/schema/ddl` et `POST /v1/schema/analyzers`, comme `passerelle schema ddl` et `schema analyzers`.
- Filtres Logstash : `prune`, `de_dot`, `syslog_pri`, `clone`, `throttle`, `environment`, `bytes`.
- **Interface** : deux nouvelles sections, « Ingestion » et « Autres sources » (Kibana, Grafana, schéma, analyseurs), avec dépôt de fichiers par type ; l’API et la ligne de commande y sont listées.
- **CI** : le job `ingest` compile avec `vector validate` (0.59.0) le VRL de la traduction des exemples, des cas de `tests/ingest/cas/` et d’une sélection de data streams des intégrations Elastic, pour les sorties console et ClickHouse (`npm run test:ingest`). Le banc ClickHouse exécute aussi la chaîne complète des analyseurs, et le job `interface` ouvre la page assemblée dans Chromium (`npm run test:ui`) : chaque section traduit son exemple, sans erreur de page.

- **Scripts Painless d’ingestion** : le traducteur reprend la plupart des constructions des intégrations Elastic. Sur les 1 154 data streams, les « à reprendre » passent de 481 à 128 (voir `tests/README.md`) :
  - **références** : une variable qui désigne un objet de `ctx` (`def x = ctx.a`, `x.get('b')`, l’élément d’une boucle, une entrée de `entrySet()`, un argument de fonction) le modifie comme en Java ; un rattachement qui dépend de la branche suivie est suivi par un indicateur, un rattachement qui change au fil d’une boucle est à reprendre avec la raison ;
  - expressions régulières : littéraux `/…/` partout, `Pattern.compile`, `matcher(…).replaceAll`, `replaceFirst`, `matches`, `find` ; Matcher gardé dans une variable (`while (m.find())`, `group(n|nom)`, `start()`/`end()` de la première correspondance) ; `Pattern.split` ;
  - lambdas de `forEach` (liste ou table) et de `removeIf` (liste, `values()`, `entrySet()`), à une expression ou à plusieurs instructions ; `stream()` avec `filter`, `map`, `anyMatch`/`allMatch`/`noneMatch`, `collect(toList | toSet | joining)`, `distinct`, `count`, `limit`, `skip`, `findFirst().orElse()`, `sorted` ;
  - collections : `HashSet` (sans doublons), `StringBuilder`, `subList`, `toArray`, `new T[n]`, `new T[] { … }`, `Arrays.asList`, `List.of`, `Collections.emptyList`/`singletonList`, `list.set(i, v)`, `entry.setValue(v)`, `m.remove(k)` et `l.remove(i)` en expression, `put`/`remove` à clé calculée, `ctx.a[clé] = v` ;
  - tri : `Collections.sort`, `list.sort(null)`, comparateur `(a, b) -> clé(a).compareTo(clé(b))` et ordre inverse (tri par insertion stable ; valeurs non comparables : le processeur échoue) ;
  - boucles : `for` à trois clauses (nombre de tours calculé à l’entrée quand c’est possible), `while`, `x++`/`--x` ; une boucle qui tournerait plus de 1 024 fois fait échouer le processeur ;
  - fonctions : récursion, y compris croisée (`handleMap` ↔ `handleList`), recopiée sur un nombre borné de niveaux (5, ou 4 quand la fonction s’appelle plusieurs fois, moins si la copie devient trop lourde à compiler pour Vector, jamais moins de 3) ; au-delà, le processeur échoue au lieu de traiter de travers un document plus profond ; signalé « à vérifier ». Une fonction qui ne tient pas sur 3 niveaux reste à reprendre ;
  - texte et nombres : `String.format` (`%s`, `%d`, `%x`, `%X`, largeur, zéros), `String.split` selon Java (éléments vides de fin retirés, limite), `String.join`, `Json.dump`, `Long.decode`, `Integer.toOctalString`/`toHexString`, `Integer.parseUnsignedInt`, `Boolean.parseBoolean`, `sha1()`, `decodeBase64()`, `Character.isUpperCase`/`isLowerCase`/`isDigit`/`toLowerCase`… ; conversions vers une classe Java (`(Number) x`) ;
  - bits : `&` avec un masque constant, `>>`, `>>>`, `<<` avec un décalage constant, littéraux hexadécimaux ;
  - dates : `ZonedDateTime.parse`, `Instant.parse`, `ofEpochMilli`, `ofEpochSecond`, `toInstant`, `toEpochSecond`/`toEpochMilli`, `plusDays`…, `isAfter`/`isBefore`, `ChronoUnit.X.between`, `Instant.toString` au format ISO ;
  - `throw` : le processeur échoue avec le message de l’exception.
- Processeur `sort` (`order`, `target_field`) ; `kv` et `split` acceptent un séparateur `X(?=Y)` (quand aucun `X` ne peut commencer dans `Y`) ou `(?<!\\)c` ; `gsub` de `(..)(?!$)` (adresses MAC).
- `passerelle ingest` et les bancs lisent les fichiers `.yml.link` d’elastic-package (pipelines partagés).
- Un banc (`tests/ingest/painless.mjs`, job `ingest`) rejoue ces cas dans Vector et compare chaque champ à ce que Java donnerait.

### Sécurité

- Release : les fichiers joints portent une attestation de provenance (`gh attestation verify <fichier> -R OlivMartins/passerelle`) ; un fichier déjà joint n’est plus remplacé en silence (`--clobber` retiré) ; le jeton en écriture n’est plus laissé dans le dépôt cloné pendant la construction.
- CI : actions épinglées par empreinte de commit, mises à jour proposées par Dependabot.

### Corrigé

- Pipelines d’ingestion :
  - Painless : une variable qui désignait un objet de `ctx` en était une copie : `def x = ctx.a; x.put('b', 1)` ne modifiait pas le document, sans aucun signalement. Les modifications sont maintenant recopiées vers l’origine.
  - `rename` ou `remove` de `_ingest._value` dans un `foreach` échouaient (« cannot remove ») ; `_ingest._key` dans un `foreach` sur une liste rendait le processeur intraduisible (Elasticsearch le rend vide).
  - grok : un nom de groupe `(?'nom'…)` et un `%{` sans accolade fermante faisaient refuser la configuration par Vector.
  - Painless : `String.split` gardait les éléments vides de fin, que Java retire.
  - `dissect` dont une clé apparaît deux fois produisait deux groupes du même nom, que Vector refuse ; la dernière valeur l’emporte, comme dans Elasticsearch.
  - Painless : le reste de la division (`%`) produisait un VRL invalide (VRL n’a pas cet opérateur) ; il utilise `mod()`.
  - Painless : `for (int i = 0; i < texte.length(); i++)` parcourait un texte comme une liste vide ; il parcourt maintenant ses caractères.
  - `dot_expander` concaténait des tableaux avec `+`, que VRL refuse (E110) ; il utilise `append()`.
  - Un motif `gsub` qui contient des caractères de contrôle (`\u0000-\u001F`) s’écrit `\xNN` dans le VRL : bruts, ils faisaient refuser le YAML par Vector.
  - `keySet`, `values` et les boucles sur `params` ne portent plus de fusion d’erreur inutile (E651).
  - Une addition, soustraction ou multiplication Painless sur des valeurs de type inconnu n’utilise plus `?? null` (E651 quand VRL connaît déjà les types) : entiers entre eux, sinon flottants, sinon `null`.
  - Une variable Painless réaffectée avec une valeur d’un autre type perd son type (`String s = …; s = s.substring(1)` laissait croire à une chaîne, d'où E103 sur `split`).
  - Les comparaisons Painless entre valeurs de type inconnu suivent la même forme (entiers, flottants, sinon faux).
  - Une conversion Painless `(int)` ou `(double)` d’une valeur de type inconnu se fait par `int!` / `to_float!` après contrôle du type, sans fusion d’erreur.
  - Une conversion Painless d’un nombre de type connu (`(int) 2.5`, `(long) 1e18`) n’utilise plus `?? null`.
  - Un littéral flottant à exposant (`1e18`, `1.5e-3`) s’écrit en décimal : VRL ne lit pas cette notation et refusait la configuration (« undefined variable »).
  - `kv` : `trim_key` et `trim_value` qui contiennent une apostrophe donnent une expression régulière valide.
  - Les conversions en chaîne des scripts Painless ne produisent plus d’erreur E651 (« fusion d’erreur inutile ») sur un type déjà connu.
- Analyseurs :
  - `elision` : `articles_case` n’était pas appliqué dans le bon sens (faux : sensible à la casse, vrai : insensible), et le filtre prédéfini cherchait toujours sans tenir compte de la casse ; un filtre défini sans `articles` ni `articles_path` est refusé, comme par Elasticsearch.
  - `stemmer` : `name` est lu comme synonyme de `language` ; sans l’un ni l’autre, le défaut d’Elasticsearch (Porter) est appliqué, et `light_*`, `minimal_*`, sans équivalent dans ClickHouse, sont signalés « à reprendre ».
  - `synonym` : la requête générée cherche le terme canonique, comme l’index, au lieu des mots développés qui ne trouvaient rien.
- `ids` : la requête lit la colonne de `field_mapping._id`, comme `term` sur `_id`, au lieu d’une colonne `_id` écrite en dur.
- `_source.excludes` : les exclusions sont gardées quand `includes` est présent ; un champ exclut aussi ses sous-champs (`http` retire `http.method`) et un motif (`http.*`) s’applique. Elles s’écrivent `EXCEPT ('expression régulière')` : une liste de noms n’excluait rien en silence pour un motif ou un nom absent.
- `fuzzy` : `prefix_length` est appliqué (les premiers caractères doivent être identiques) au lieu d’être signalé « à vérifier » ; `fuzziness: AUTO:bas,haut` respecte ses bornes ; la longueur du mot se compte en caractères.
- `query_string` : `mot~1` garde sa distance (elle était remplacée par `AUTO`), `mot~` prend l’option `fuzziness` de la requête ; `fuzzy_prefix_length` et `fuzzy_transpositions` sont appliqués, dans `simple_query_string` aussi.
- `geo_distance` sur un champ rangé dans une Map ou une colonne JSON d’attributs (`otel`, `otel-json`) : la requête est « à reprendre » avec la raison, au lieu d’un SQL qui échouait à l’exécution (une position n’y est pas un Point).
- `geo_distance` :
  - toutes les unités d’Elasticsearch sont lues (`nmi`, `NM`, `cm`, `mm`, `in`, noms longs comme `miles`, notation `2.5e3m`) ; une unité inconnue faisait chercher à 0 m, elle fait maintenant refuser la requête, comme Elasticsearch ;
  - la distance n’est plus arrondie au mètre (`1.5ft` donnait 0) ;
  - la distance est calculée par la formule d’Elasticsearch (haversine, rayon de 6 371 008,77 m) : `geoDistance()`, sur l’ellipsoïde, comptait 418 m de plus entre Paris et Londres, de quoi classer autrement un point en bord de cercle.
- `geoip` : la base MaxMind à monter est signalée « à vérifier » et rappelée en tête de la configuration générée. Sans elle, Vector refuse la configuration avec une erreur peu parlante (`error[E401] invalid enum variant`), comme pour l’exemple `nginx.conf`.
- Interface :
  - commandes de validation et de lancement pour Vector 0.59, avec la variable `VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION` quand la configuration l’exige, et la base geoip montée dans le conteneur ;
  - modèle GitLab CI sur Vector 0.59 et ClickHouse 26.9 (au lieu de 0.49 et `latest`).
- `SECURITY.md` : versions maintenues à jour (1.3.x).

## [1.3.0] - 2026-10-22

### À savoir avant de mettre à jour

- **Compatibilité ECS, `v8` par défaut.** Comme Logstash 8 et suivants, la traduction Logstash → Vector suit désormais les conventions ECS :
  - `[event][original]` sur chaque événement ;
  - noms ECS des captures des motifs grok composites ;
  - cible `[event][hash]` de `fingerprint` et traduction sur place de `translate`.

  Pour des pipelines d’avant ECS, réglez `vector.ecs_compatibility: disabled`. Un réglage `ecs_compatibility` écrit dans le pipeline l’emporte.

### Ajouté

- Option `vector.ecs_compatibility` (`v8` ou `disabled`), dans la configuration et dans l’interface.

### Corrigé

- Dans un motif grok à alternative (`HTTPD_ERRORLOG`), la capture de la seconde branche garde son nom.

## [1.2.0] - 2026-10-22

### À savoir avant de mettre à jour

- **Requêtes DSL lues comme Elasticsearch les lit.** Une clé inconnue (corps de recherche, `bool`, définition d’agrégation, deux clauses ou deux champs dans un même objet) fait refuser la requête (HTTP 422, code 1 de la CLI). Un paramètre inconnu, ou une option connue qui change le résultat sans être traduite (`knn`, `min_score`, `terminate_after`…), la rend « à reprendre » : son SQL s’arrête sur `throwIf`. Des requêtes jusqu’ici traduites en silence peuvent donc changer de statut.
- **Verdict.** Les réponses de traduction portent un champ `verdict` (`ready`, `review`, `todo`, `unrecognized`) et, pour le DSL, `parameters`. Le pourcentage de couverture est arrondi vers le bas : une clause à reprendre ne laisse plus afficher 100 %.
- **Ligne de commande.** `--fail-on` accepte aussi `review` (code 2 dès qu’un fichier n’est pas prêt). Le résumé de chaque fichier commence par son verdict, et le SQL écrit par `dsl2sql` le rappelle en en-tête.
- **Validation SQL.** Une requête qui lit une table absente de la configuration (`index_mapping`, `default_table`, `lists.table`), une fonction de table ou un dictionnaire est refusée (HTTP 400). Restreignez aussi le compte ClickHouse du service : voir « Compte ClickHouse de validation » dans le guide d’installation.
- **Vector 0.57 et suivants.** Une configuration générée qui utilise des variables `${VAR}`, ou des `$` doublés dans son VRL, doit être lancée avec `--dangerously-allow-env-var-interpolation`, ce que rappelle son en-tête.

### Ajouté

- Verdict par traduction, du pire au meilleur : non reconnue, à reprendre, à vérifier, prête. Affiché avant le pourcentage dans l’interface, renvoyé par l’API, imprimé par la CLI.
- Modèles de requête traduits en paramètres ClickHouse `{nom:String}` : `{{…}}` (Watcher, alertes Kibana, modèles de recherche), `$__macro`, `${var}`, `[[var]]` et `$var` (Grafana). Une borne de date en modèle est lue par `parseDateTime64BestEffort`, ou en epoch selon son `format`. Un modèle placé là où une valeur fixe est nécessaire (recherche plein texte, intervalle) rend la requête « à reprendre ».
- `/v1/validate/sql` transmet à ClickHouse les paramètres `param_*` de l’adresse.
- Sortie `elasticsearch` : utilisateur et mot de passe (`user`, `password`, `cloud_auth`), clé d’API, TLS (`ssl_enabled`, autorité de certification, certificat client, vérification), `data_stream` et ses options, `action`, `document_id`, `pipeline`, `http_compression`, `timeout`, `custom_headers`, `proxy`. Les secrets écrits en clair sont remplacés par des variables d’environnement.
- Sorties `http` et `file` : méthode, en-têtes et compression repris ; toute option de sortie sans équivalent est signalée « à vérifier ».
- Image conteneur (`Dockerfile`) et `npm run build:server`, qui construit l’interface et le serveur sans binaire autonome.
- CI : banc différentiel joué sur Elasticsearch 7.17, 8.19 et 9.5 ; image construite et démarrée. La release rejoue toute la CI sur son étiquette avant de joindre ses fichiers.
- Banc d’équivalence Logstash / Vector (`npm run test:pipelines`) : chaque cas est joué dans Logstash, sa traduction dans Vector, et les événements produits sont comparés champ par champ, dans les deux modes de compatibilité ECS de Logstash. Les écarts connus sont inventoriés dans `tests/pipelines/cases.mjs`. Il demande Docker ; la CI épingle Logstash 9.5.5 et Vector 0.59.0.
- Instantanés de la traduction de chaque cas de ce banc (`tests/snapshots/pipelines`), comparés par `npm test`.

### Corrigé

- `fields` et `docvalue_fields` à motif : `*`, envoyé par Discover avec `_source: false`, donnait une colonne nommée « * » que ClickHouse refuse ; il donne `SELECT *`, et `http.*` donne `COLUMNS('^http\..*$')`.
- Options du corps de recherche ignorées en silence (`knn`, `retriever`, `min_score`, `terminate_after`, `suggest`, `slice`…) : déclarées à reprendre. Les options sans effet sur le résultat (`highlight`, `profile`, `version`…) sont signalées une fois.
- Objet sauvegardé Kibana, ou requête KQL de Kibana, soumis à la place d’une requête DSL : refusés avec un message qui dit quoi copier, au lieu d’un `SELECT *` sans remarque.
- `query_string` : une liste de quelques milliers de `OR` épuisait la pile (« Maximum call stack size exceeded »). Les suites d’opérateurs sont analysées sans récursion ; parenthèses, négations et requêtes imbriquées à l’excès sont refusées avec un message clair, côté DSL comme côté Logstash.
- Sortie `elasticsearch` : un index tiré d’une métadonnée (`%{[@metadata][index]}-%{+YYYY.MM.dd}`) donnait une configuration refusée par Vector 0.57 et suivants ; les identifiants, le TLS et `data_stream` étaient perdus sans remarque.
- La remarque « Métadonnée dans un modèle » est retirée : Vector lit une métadonnée dans un modèle (`{{ %index }}`), vérifié avec Vector 0.59.
- `passerelle.env.example` annonçait des droits 0640 root:passerelle ; `install.sh` pose 0600 root:root.
- Pipelines dont l’entrée n’est pas Kafka (`stdin`, `file`, `tcp`, `udp`, `http`, `beats`, `generator`) : la source Vector déclare désormais `log_namespace: true`, que suppose le VRL généré. Sans ce réglage, Vector refusait la configuration d’une entrée `stdin` en JSON, et rangeait sinon l’événement entier dans `message`.
- Champ absent ou nul : la traduction ne crée plus le champ et ne signale plus d’échec là où Logstash ne fait rien. Sont concernés `mutate` (`gsub`, `uppercase`, `lowercase`, `capitalize`, `strip`, `split`, `join`, `copy`, `convert`, `coerce`), `remove_tag`, `truncate`, `dissect`, `date`, `json`, `xml`, `fingerprint` et `translate`. Au passage : une date `UNIX` sur un champ absent ne pose plus `@timestamp` au 1er janvier 1970, `capitalize` ne vide plus un champ qui n’est pas une chaîne, `convert` ne change plus un champ nul en 0, et `remove_tag` garde une étiquette écrite en chaîne plutôt qu’en tableau.
- Valeurs qui différaient de celles de Logstash : `capitalize` ne coupe plus en deux une première lettre accentuée ; `split` écarte les éléments vides de fin et découpe sur les blancs quand son séparateur est une espace ; `merge` réunit les clés de deux objets au lieu d’en faire un tableau, et ne fait rien d’un objet et d’une autre valeur ; `truncate` compte des octets, sans couper un caractère ; une condition `if [champ]` est fausse pour une chaîne vide et pour la chaîne « false ».
- Plusieurs filtres dans un même bloc `if` : Vector refusait la configuration (`error[E103]`) quand un filtre s’appuyait sur un champ posé par le précédent dans une branche seulement, par exemple `json` puis `kv`, ou `grok` avec `add_field` puis `mutate`. Dans le même cas, un champ retiré par `remove_field` quand `grok` réussit n’était plus traité par les filtres suivants, même quand `grok` échouait.
- `json` sans `target` : un JSON valide qui n’est pas un objet (tableau, nombre, chaîne, `null`) reçoit l’étiquette d’échec, comme dans Logstash, y compris avec `skip_on_invalid_json` ; les options `add_field`, `add_tag` et `remove_field` ne lui sont plus appliquées.
- `split` : l’option `target` est appliquée (l’élément va dans le champ cible, le champ d’origine reste entier) ; un élément vide ou nul ne donne plus d’événement ; une chaîne qui ne donne qu’un élément n’est pas touchée, et une chaîne vide ne donne aucun événement ; un champ absent, nul ou d’un autre type reçoit `_split_type_failure`.
- Options qui n’étaient pas appliquées : `target` de `grok` (les captures vont sous le champ cible), `all_fields` de `urldecode` (chaque chaîne de l’événement est décodée, à toute profondeur) et un `field_split` de `kv` à plusieurs caractères (chacun sépare les champs).
- `kv` : un mot sans séparateur de valeur n’est plus rendu comme un champ à `true`. `translate` : une cible qui existe déjà est gardée, sauf avec `override` ; sans valeur de repli, `add_field` et `add_tag` ne sont appliqués que si la clé est trouvée.
- `date` : le format `UNIX` garde les décimales, en nombre comme en chaîne, et refuse ce que Logstash refuse (notation scientifique, booléen) ; un champ cible autre que `@timestamp` s’écrit à la milliseconde, en UTC, comme `@timestamp`. Une option `locale` autre que l’anglais avec des noms de mois ou de jours est maintenant signalée « à vérifier ».
- `date`, format sans année (`MMM dd HH:mm:ss`, celui de syslog) : la date n’est plus refusée. Comme Logstash, la traduction prend l’année en cours, celle d’avant pour un événement de décembre lu en janvier, celle d’après pour un événement de janvier lu en décembre.
- `remove_field` avec un nom calculé (`%{nom}`) : le champ désigné est retiré, que la valeur obtenue s’écrive `a` ou `[a][b]`. Le nom n’était pas résolu, et rien n’était retiré.
- Codec `json` :
  - une ligne invalide est gardée dans `message` avec `_jsonparsefailure`, au lieu d’être perdue ;
  - la source `file` avec ce codec n’est plus refusée par Vector.
- `@timestamp` venu du document (codec ou filtre `json`) : converti en UTC à la milliseconde ; une valeur illisible est rangée dans `_@timestamp` avec `_timestampparsefailure`.
- `add_field` et les captures `grok` sur un champ qui existe déjà : la valeur est ajoutée et le champ devient un tableau, sauf `overwrite`.
- `%{champ}` sur un tableau ou un objet : « a,b » ou le JSON de l’objet, au lieu d’une chaîne vide.
- `csv` :
  - colonnes `column<n>` au-delà de `columns`, ou sans `columns` ;
  - valeur vide à null, colonne sans valeur absente ;
  - `target` appliqué.
- `date` en `ISO8601` : jour seul, heure sans secondes et virgule décimale sont lus.
- `mutate convert` lit les nombres comme Logstash (espaces, séparateurs « , » et « _ », décimales tronquées, `1e3`, `0x1A`).
- `fingerprint` :
  - avec plusieurs sources, la chaîne hachée est celle de Logstash ;
  - `MURMUR3`, qui n’existe pas en VRL, est déclaré « à reprendre » au lieu d’être remplacé par un autre hachage.
- Comparaison à un nombre sur un champ absent ou qui n’est pas un nombre : la condition est fausse, et la traduction signale que Logstash, lui, jette l’événement.
- `topic_id => "%{type}"` : le sink Kafka reçoit `dangerously_allow_unconfined_template_resolution`, sans lequel Vector 0.57 refuse la configuration.
- Remarques ajoutées pour les écarts gardés volontairement :
  - un tableau n’est pas traité élément par élément dans `mutate` et `truncate` ;
  - une conversion ratée ne pose pas `_mutate_error` ;
  - `%{champ}` absent donne une chaîne vide ;
  - la forme de l’objet `xml` est à vérifier.

### Sécurité

- Validation SQL : `EXPLAIN indexes = 1` évalue les sous-requêtes scalaires et imprime leur valeur dans le plan. Une requête soumise pouvait donc lire toute table accessible au compte du service. La requête est désormais analysée par `EXPLAIN AST`, qui ne lit aucune donnée, et refusée si elle lit une table hors de la configuration, une fonction de table ou un dictionnaire.

## [1.1.1] - 2026-10-22

Correctifs de sécurité du service et de la ligne de commande, et écarts de traduction DSL → SQL résolus : 578 cas du banc différentiel donnent le même résultat qu’Elasticsearch, contre 494 en 1.1.0. Mise à jour recommandée pour tout service exposé.

### À savoir avant de mettre à jour

- **Configuration stricte.** Une clé inconnue dans `passerelle.yaml` est refusée : `check-config` sort en 1 et le service ne démarre pas. Lancez `passerelle check-config` avant de redémarrer.
- **Ligne de commande stricte.** Une option inconnue ou sans valeur est une erreur, et `--fail-on` n’accepte que `todo`. Les scripts d’intégration continue qui passaient une option erronée sans effet échoueront désormais.
- **Secrets.** `install.sh` passe `passerelle.env` en 0600 root:root, installation existante comprise. Si un secret a pu apparaître dans une réponse de validation Vector, changez-le.
- **SQL généré.** Il change pour les cas listés ci-dessous (tri des égalités, champs texte, dates, multivalués). Les scripts qui exploitent la sortie de l’API ou de la CLI sont à vérifier.

### Sécurité

- Serveur : une requête sur l’adresse `//` arrêtait le processus. Elle reçoit désormais une réponse 400.
- Validation Vector : `vector validate` recevait tout l’environnement du service, et sa sortie revient au client. Une configuration soumise pouvait donc faire afficher les secrets (`CLICKHOUSE_PASSWORD`, `PASSERELLE_TOKEN`). Le processus ne reçoit plus que `PATH`, `HOME`, `TZ` et les variables `VECTOR_*`. `install.sh` passe `passerelle.env` en 0600 root:root, installation existante comprise.
- Validation SQL : `readonly=1` au lieu de `readonly=2`. La requête soumise ne peut plus lever la limite de 15 s ni faire appeler d’autres hôtes par `url()`. La limite de deux validations simultanées couvre aussi la validation SQL.
- API : les requêtes intersites d’un navigateur sont refusées sur `/v1/*`. Sans `PASSERELLE_TOKEN`, l’API ne répond qu’aux requêtes adressées à `localhost`, `127.0.0.1` ou `[::1]` (DNS rebinding).
- Traduction DSL : le sens de tri des documents était recopié tel quel dans le SQL. Seuls `asc` et `desc` sont acceptés, comme pour les agrégations.

### Corrigé

Écarts trouvés par un audit de la traduction DSL → SQL, rejoués dans le banc différentiel : 578 cas identiques au lieu de 494, sur Elasticsearch 7.17, 8.19 et 9.5.

- `terms` et `multi_terms` : les égalités sont départagées par clé croissante, même avec un `order` explicite (celui qu’envoie Kibana). En limite du top N, les valeurs retenues pouvaient différer.
- `date_histogram` :
  - un intervalle fixe en heures qui ne divise pas 24 (`5h`) est aligné sur l’epoch ;
  - `offset` est appliqué ;
  - un fuseau écrit en décalage (`+01:00`) est accepté, partout où un fuseau l’est ;
  - un intervalle refusé par Elasticsearch est refusé aussi.
- Champs multivalués :
  - `stats`, `extended_stats`, `percentiles` et `histogram` portent sur toutes les valeurs (SQL refusé auparavant) ;
  - le tri porte sur le minimum en croissant et le maximum en décroissant.
- Champs texte :
  - `term`, `prefix` et `regexp` portent sur les mots, et non sur la valeur entière ;
  - `multi_match` avec `operator: and` exige tous les mots dans un même champ (`best_fields`, `most_fields`) ;
  - `bool_prefix` traite le dernier mot comme un début de mot ;
  - un `match` sans mot exploitable ne trouve plus tous les documents ;
  - `slop` et `"a b"~N` sont appliqués (mots dans l’ordre ; une inversion est signalée « à vérifier ») ;
  - `fuzzy` compte une transposition pour une modification.
- Dates :
  - un epoch en millisecondes est converti dans `term` et `terms` ;
  - `range` lit un format personnalisé (`dd/MM/yyyy`) par `parseDateTime64InJodaSyntax`.
- `search_after` :
  - les valeurs de `_shard_doc` (pagination par point-in-time) sont écartées avec leur clé ;
  - des sens de tri mélangés sont pris en charge ;
  - une date est reconnue par le schéma et non par le nom de la colonne.
- `multi_terms` : un document sans l’un des champs ne forme pas de groupe.
- `top_metrics` : `size` est appliqué (`groupArraySorted`).
- `percentiles` : null, et non nan, sur un groupe vide.

Ligne de commande et configuration :

- Une option inconnue, ou sans sa valeur, est une erreur. `--fail-on` n’accepte que `todo` et `--format` que `yaml` ou `toml`. Avant, `--fail-on todos` sortait en 0, et `dsl2sql --verbose A.json B.json` ne traduisait que B.
- `--format` l’emporte sur `vector.format` de la configuration.
- Une clé de configuration inconnue est refusée au lieu d’être ignorée. `check-config` sort en 1 et le service ne démarre pas.

### Ajouté

- Tests du serveur et de la ligne de commande, lancés par `npm test`.
- Banc différentiel :
  - un tableau numérique, un entier facultatif et un second champ texte dans le jeu de données ;
  - des requêtes jouées sous un point-in-time (option `pit` d’un cas) ;
  - la comparaison de `multi_terms` et de `top_metrics`.

## [1.1.0] - 2026-10-11

Banc différentiel Elasticsearch / ClickHouse et correctifs de fiabilité, contribués par @gnocent ([#1](https://github.com/OlivMartins/passerelle/pull/1)) : 494 cas sur 504 donnent désormais le même résultat qu’Elasticsearch.

### À savoir avant de mettre à jour

- **Index plein texte.** La recherche utilise `hasToken(lowerUTF8(colonne), …)`. Un index `tokenbf_v1` créé sur `lower(colonne)` d’après la remarque de la 1.0 ne sert plus : remplacez-le par l’index `text` que propose Passerelle. Cet index demande ClickHouse 26.x ; les requêtes, elles, fonctionnent aussi sur 25.8 LTS.
- **SQL généré.** Sa forme change : fuseau `'UTC'` explicite dans les calculs de date, CTE `base` et `top_<nom>`, suffixe `_agg` sur un alias qui masquerait une colonne. Les scripts qui exploitent la sortie de l’API ou de la CLI sont à vérifier.
- **Clauses non traduites.** Le SQL s’arrête sur un message explicite (`throwIf`) au lieu de s’exécuter en ignorant la clause.
- **Schéma des colonnes.** Déclarez `clickhouse.columns` pour une traduction fidèle des champs facultatifs, multivalués et entiers.

### Ajouté

- Présentation du projet : README, bannière, démonstration animée et captures en thème clair et sombre.
- Fichiers `LICENSE`, `NOTICE` et licence de Node.js inclus dans l’archive de release.
- Politique de sécurité (`SECURITY.md`).
- Intégration continue : tests à chaque push ; archive, somme de contrôle et page autonome construites et jointes automatiquement aux releases.
- Instantanés du SQL et du YAML générés (`tests/snapshots`), comparés par `npm test`.
- Banc différentiel (`npm run test:diff`) : chaque requête est exécutée sur Elasticsearch, sa traduction sur ClickHouse, et les résultats sont comparés. Les écarts connus sont inventoriés dans `tests/differential/cases.mjs`. Il demande ClickHouse 26.9 ou une version suivante, celle que vise le SQL généré ; la CI épingle la 26.9.
- Schéma des colonnes : la clé facultative `clickhouse.columns` donne le type ClickHouse de chaque colonne. La traduction s’en sert pour les champs facultatifs (`Nullable`), multivalués (`Array`), les entiers et les dates. `clickhouse.empty_as_missing` déclare qu’une chaîne vide représente un champ absent.
- Recherche plein texte : option `clickhouse.text_match: strict`, qui vérifie chaque mot par une expression régulière suivant le découpage de l’analyseur standard d’Elasticsearch. Le mode par défaut, `tokens`, garde `hasToken` seul pour un mot simple.
- Listes nommées : au-delà de `clickhouse.lists.threshold` valeurs, une liste (`terms`, série de `should`, `OR` d’une `query_string`) quitte le SQL pour une table, désignée par l’empreinte de son contenu ou par un nom déclaré dans `clickhouse.lists.names`. Le `CREATE TABLE` et les `INSERT` sont fournis par l’API (champ `lists`) et par la CLI (fichier `.lists.sql`). Une requête de plus de 256 Kio, que ClickHouse refuse par défaut, est signalée.
- Agrégation `composite` : option `clickhouse.composite_mode: stream`, qui produit une seule requête sans pagination, à lire en flux, quand le client parcourt tous les groupes.

### Modifié

- Recherche plein texte : chaque mot est cherché par `hasToken(lowerUTF8(colonne), 'mot')` et non plus par `hasTokenCaseInsensitive(colonne, 'mot')`. L’index recommandé devient un index `text` construit sur `lowerUTF8(colonne)`, à la place de `tokenbf_v1` : un index posé sur `lower(colonne)` ne sert pas cette forme et doit être recréé.
- Configuration Vector générée : l’API de Vector écoute sur `127.0.0.1:8686` et non plus sur toutes les interfaces. Elle n’a pas d’authentification.
- Agrégations `range`, `date_range`, `ip_range` et `filters` : calculées par agrégation conditionnelle (un `countIf` par plage, puis `ARRAY JOIN`) au lieu d’un `arrayJoin` qui construisait un tableau pour chaque ligne. Quand elles servent de parent à un autre regroupement, des plages numériques disjointes deviennent un `multiIf`.
- Agrégations imbriquées : le filtre commun et chaque top N sont nommés par des CTE (`base`, `top_<nom>`) au lieu d’être recopiés dans des sous-requêtes emboîtées. Le SQL se lit de haut en bas ; le plan d’exécution ne change pas.
- Filtre sur un champ runtime de classification (un script qui émet une constante par branche) : il est réécrit sur les colonnes sources. `classe = 'lent'` devient `latency_ms >= 1000`, ce qui rend la clé de tri et les index utilisables. Quand le script ne s’y prête pas, la remarque de matérialisation propose aussi un index de saut.
- Un champ runtime qui émet toujours une valeur n’ajoute plus de `isNotNull()` au regroupement, et son DDL de matérialisation n’est plus `Nullable`.
- Les égalités sur une même colonne reliées par `OR` (série de `should`, `dis_max`, `query_string`) sont réunies en un seul `IN`. Une série de motifs `*texte*` sur un même champ devient un `multiSearchAny`.
- Agrégation `composite` : le curseur `after` est une condition `WHERE` écrite clé par clé (`k1 > v1 OR (k1 = v1 AND k2 > v2) …`) et non plus une comparaison de tuples en `HAVING`. ClickHouse peut ainsi la confronter à la clé de tri de la table : 112 granules lus sur 3 125 dans l’essai, contre 3 125.
- Les calculs de date précisent désormais le fuseau `'UTC'` dans le SQL (`toStartOfDay(now('UTC') - INTERVAL 7 DAY)`, `toHour(timestamp, 'UTC')`), parce qu’Elasticsearch calcule en UTC alors que ClickHouse suit le fuseau du serveur. La nouvelle option `clickhouse.timezone: UTC` déclare un serveur et des colonnes en UTC : le SQL retrouve alors sa forme courte.
- Plusieurs clauses `must_not` sont niées une à une (`a != x AND b != y`) plutôt qu’en bloc (`NOT (a = x OR b = y)`).

### Corrigé

- Scripts Painless : `toLowerCase()`, `toUpperCase()` et `equalsIgnoreCase()` replient la casse de toutes les lettres, comme Java (`lowerUTF8`, `upperUTF8`). `lower()` et `upper()` ne traitaient que l’ASCII : `Échec` restait `Échec`.
- `case_insensitive` sur `term`, `prefix` et `wildcard` : seules les lettres ASCII sont repliées, comme dans Elasticsearch. `ÉLAN-1` trouvait `élan-1`, qu’Elasticsearch ne renvoie pas.
- `regexp` avec `case_insensitive` : l’option était ignorée. La casse des caractères cités un à un est repliée, pas celle des intervalles (`[a-z]`), comme dans Elasticsearch.
- Recherche plein texte et lettres accentuées : `échec` ne trouvait pas `Échec`, parce que `hasTokenCaseInsensitive()` ne replie que les lettres ASCII. Même correction pour `fuzzy` sur un champ texte.
- Agrégations `range` et `filters` : une plage ou un filtre sans document n’était pas renvoyé. Elasticsearch renvoie tous les groupes, avec un compte nul et des mesures `null`.
- Clé par défaut d’une plage numérique : `*-100.0` comme dans Elasticsearch, et non `*-100`. Une `date_range` sans clé explicite est signalée « à vérifier ».
- Un regroupement placé sous un `range` ou un `filters` sortait ses groupes parents par ordre alphabétique de clé, et non dans l’ordre de leur déclaration.
- Recherche plein texte : le texte cherché est découpé comme le fait l’analyseur standard. `match` sur `10.0.0.1` cherchait 10 OU 0 OU 1 (337 documents au lieu de 42) ; `user_id`, `index.html` ou `3.14` étaient de même éclatés. Les fragments d’un mot composé doivent maintenant être tous présents et se suivre.
- `match_phrase` et `match_phrase_prefix` cherchaient la phrase comme sous-chaîne exacte : `connection reset` manquait `connection-reset` et les espaces multiples (300 documents au lieu de 900). Les mots sont cherchés à la suite, quels que soient les séparateurs. `match_bool_prefix` et les jokers sur un champ texte s’appliquent mot par mot.
- Agrégation `global` imbriquée dans une autre : déclarée « à reprendre », comme Elasticsearch la refuse.
- Agrégation `composite` : `order: desc` sur une source était ignoré, tout comme `missing_bucket` et `missing_order`. Chaque source garde son sens de tri, et une clé `null` se place et se pagine comme dans Elasticsearch.
- Colonnes `Nullable` (avec `clickhouse.columns`) : `must_not`, `NOT`, `exclude` et `minimum_should_match` écartaient les lignes `NULL`, qu’Elasticsearch garde. Les négations deviennent `(col != x OR col IS NULL)`, les conditions comptées `ifNull(…, 0)`.
- Regroupement sur un champ facultatif : les documents sans le champ formaient un groupe en trop. Ils sont écartés, sauf paramètre `missing`.
- Champs multivalués (colonnes `Array`) : `term`, `terms`, `prefix`, `range`, `exists`, les regroupements et les mesures échouaient ou regroupaient par tableau entier.
- `exists` et l’agrégation `missing` sur une colonne non `Nullable` : toujours vrai ou toujours faux. Signalés « à vérifier », ou traduits par `col != ''` avec `empty_as_missing`.
- Division de deux entiers dans un script Painless : `intDiv()`, entière comme en Java. Sans schéma, la division est signalée « à vérifier ».
- Sans `clickhouse.columns`, les exclusions et `exists` portent une remarque « à vérifier » au lieu de passer pour sûrs.
- Dates et fuseau : sur un serveur ClickHouse hors UTC, les arrondis (`now/d`), les dates écrites sans fuseau, les tranches de `date_histogram` et les accesseurs Painless (`getHour()`, `getDayOfWeekEnum()`…) étaient décalés. Les arrondis à la semaine, au mois et à l’année sont reconvertis en instant avant comparaison.
- Borne de date en epoch millis (nombre ou chaîne de chiffres) : elle était comparée telle quelle à la colonne, et ne trouvait rien. Même correction pour le curseur `after` d’un `composite` sur `date_histogram`, y compris à la semaine et au mois.
- Borne de date écrite sans heure : `lte: "2026-03-10"` s’arrête à la fin du jour, comme dans Elasticsearch, et non à minuit.
- Date math avec un arrondi suivi d’un décalage (`now/d+1h`, `…||/M+1M`) ; une expression de date illisible fait échouer la traduction au lieu d’être comparée comme une chaîne.
- `ChronoUnit.X.between()` : unités entières écoulées (`age`), et non changements de jour ou de mois (`dateDiff`).
- Mesures sans document : `min`, `max`, `avg`, la variance et `weighted_avg` valent `null` comme dans Elasticsearch, et non 0 ou `nan` (combinateur `-OrNull`). Concerne les mesures globales, les sous-filtres et les tranches vides d’un histogramme.
- `extended_bounds` était ignoré : les tranches vides aux bornes sont ajoutées (`WITH FILL FROM … TO …`), pour `date_histogram` et `histogram`.
- Histogramme imbriqué : les tranches vides sont comblées dans chaque groupe parent, et plus seulement quand l’histogramme est seul.
- `derivative`, `serial_diff`, `moving_fn` : les premiers points, sans prédécesseur, valent `null` et non 0 ou la valeur elle-même. Un histogramme avec pipeline, dont les tranches vides ne sont pas comblées, est désormais signalé « à vérifier ».
- `query_string` mal formée (parenthèse ou guillemet non fermé, opérateur doublé) : déclarée « à reprendre », comme Elasticsearch la refuse, au lieu d’être traduite en partie sans avertissement.
- `simple_query_string` : analyseur dédié. Les opérateurs `+`, `|` et `-` s’appliquent de gauche à droite et une négation se combine par l’opérateur par défaut, comme dans Elasticsearch. `a | b` n’était pas filtré du tout.
- Clause non traduite : le SQL s’arrête sur un message explicite (`throwIf`) au lieu de s’exécuter en ignorant la clause. Dans un `must_not`, l’ancien `1` écartait toutes les lignes.
- Nombres recopiés dans le SQL (`size`, `from`, intervalles, fenêtres, coordonnées) : seuls des nombres sont acceptés, toute autre valeur est refusée.
- Script Painless à conditions successives : déclaré « à reprendre » au-delà de 500 chemins, au lieu de doubler le SQL à chaque `if`.
- Agrégation portant le nom d’une colonne citée par la requête : son alias masquait la colonne dans tout le `SELECT` (filtre appliqué à la mauvaise colonne, ou erreur SQL). L’alias reçoit le suffixe `_agg`, avec une remarque.
- Agrégation portant le nom de son champ runtime : l’alias était déclaré deux fois, ce que ClickHouse refuse.
- `bucket_sort` : le tri écrit `{ champ: { order } }` produisait un SQL invalide.

## [1.0.0] - 2026-10-08

### Ajouté

- Traduction des requêtes DSL Elasticsearch en SQL ClickHouse : 28 types de requêtes, 51 agrégations, champs runtime Painless, syntaxe Lucene, format console Kibana.
- Traduction des pipelines Logstash en configurations Vector : 18 filtres, conditions, aiguillage des sorties, Kafka en entrée et en sortie, mode shadow.
- Interface web autonome, API REST et ligne de commande pour l’intégration continue.
- Configuration `passerelle.yaml` versionnable, secrets par variables d’environnement.
- Paquet Linux x86_64 : binaire unique, unité systemd durcie, script d’installation.

[1.5.0]: https://github.com/OlivMartins/passerelle/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/OlivMartins/passerelle/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/OlivMartins/passerelle/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/OlivMartins/passerelle/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/OlivMartins/passerelle/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/OlivMartins/passerelle/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OlivMartins/passerelle/releases/tag/v1.0.0
