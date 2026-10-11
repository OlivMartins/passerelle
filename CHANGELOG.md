# Journal des modifications

Toutes les évolutions notables de Passerelle sont consignées ici. Le format s’inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les versions suivent le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- Banc d’équivalence Logstash / Vector (`npm run test:pipelines`) : chaque cas est joué dans Logstash, sa traduction dans Vector, et les événements produits sont comparés champ par champ, dans les deux modes de compatibilité ECS de Logstash. Les écarts connus sont inventoriés dans `tests/pipelines/cases.mjs`. Il demande Docker ; la CI épingle Logstash 9.5.5 et Vector 0.59.0.
- Instantanés de la traduction de chaque cas de ce banc (`tests/snapshots/pipelines`), comparés par `npm test`.

### Corrigé

- Pipelines dont l’entrée n’est pas Kafka (`stdin`, `file`, `tcp`, `udp`, `http`, `beats`, `generator`) : la source Vector déclare désormais `log_namespace: true`, que suppose le VRL généré. Sans ce réglage, Vector refusait la configuration d’une entrée `stdin` en JSON, et rangeait sinon l’événement entier dans `message`.
- Champ absent ou nul : la traduction ne crée plus le champ et ne signale plus d’échec là où Logstash ne fait rien. Sont concernés `mutate` (`gsub`, `uppercase`, `lowercase`, `capitalize`, `strip`, `split`, `join`, `copy`, `convert`, `coerce`), `remove_tag`, `truncate`, `dissect`, `date`, `json`, `xml`, `fingerprint` et `translate`. Au passage : une date `UNIX` sur un champ absent ne pose plus `@timestamp` au 1er janvier 1970, `capitalize` ne vide plus un champ qui n’est pas une chaîne, `convert` ne change plus un champ nul en 0, et `remove_tag` garde une étiquette écrite en chaîne plutôt qu’en tableau.
- Valeurs qui différaient de celles de Logstash : `capitalize` ne coupe plus en deux une première lettre accentuée ; `split` écarte les éléments vides de fin et découpe sur les blancs quand son séparateur est une espace ; `merge` réunit les clés de deux objets au lieu d’en faire un tableau, et ne fait rien d’un objet et d’une autre valeur ; `truncate` compte des octets, sans couper un caractère ; une condition `if [champ]` est fausse pour une chaîne vide et pour la chaîne « false ».
- Plusieurs filtres dans un même bloc `if` : Vector refusait la configuration (`error[E103]`) quand un filtre s’appuyait sur un champ posé par le précédent dans une branche seulement, par exemple `json` puis `kv`, ou `grok` avec `add_field` puis `mutate`. Dans le même cas, un champ retiré par `remove_field` quand `grok` réussit n’était plus traité par les filtres suivants, même quand `grok` échouait.
- `json` sans `target` : un JSON valide qui n’est pas un objet (tableau, nombre, chaîne, `null`) reçoit l’étiquette d’échec, comme dans Logstash, y compris avec `skip_on_invalid_json` ; les options `add_field`, `add_tag` et `remove_field` ne lui sont plus appliquées.
- `split` : l’option `target` est appliquée (l’élément va dans le champ cible, le champ d’origine reste entier) ; un élément vide ou nul ne donne plus d’événement ; une chaîne qui ne donne qu’un élément n’est pas touchée, et une chaîne vide ne donne aucun événement ; un champ absent, nul ou d’un autre type reçoit `_split_type_failure`.
- `remove_field` avec un nom calculé (`%{nom}`) : le champ désigné est retiré, que la valeur obtenue s’écrive `a` ou `[a][b]`. Le nom n’était pas résolu, et rien n’était retiré.

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

[Non publié]: https://github.com/OlivMartins/passerelle/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/OlivMartins/passerelle/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/OlivMartins/passerelle/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OlivMartins/passerelle/releases/tag/v1.0.0
