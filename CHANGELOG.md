# Journal des modifications

Toutes les évolutions notables de Passerelle sont consignées ici. Le format s’inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les versions suivent le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

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

[Non publié]: https://github.com/OlivMartins/passerelle/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OlivMartins/passerelle/releases/tag/v1.0.0
