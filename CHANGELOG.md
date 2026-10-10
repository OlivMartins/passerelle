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

- Listes nommées : au-delà de `clickhouse.lists.threshold` valeurs, une liste (`terms`, série de `should`, `OR` d’une `query_string`) quitte le SQL pour une table, désignée par l’empreinte de son contenu ou par un nom déclaré dans `clickhouse.lists.names`. Le `CREATE TABLE` et les `INSERT` sont fournis par l’API (champ `lists`) et par la CLI (fichier `.lists.sql`). Une requête de plus de 256 Kio, que ClickHouse refuse par défaut, est signalée.
- Agrégation `composite` : option `clickhouse.composite_mode: stream`, qui produit une seule requête sans pagination, à lire en flux, quand le client parcourt tous les groupes.

### Modifié

- Les égalités sur une même colonne reliées par `OR` (série de `should`, `dis_max`, `query_string`) sont réunies en un seul `IN`. Une série de motifs `*texte*` sur un même champ devient un `multiSearchAny`.
- Agrégation `composite` : le curseur `after` est une condition `WHERE` écrite clé par clé (`k1 > v1 OR (k1 = v1 AND k2 > v2) …`) et non plus une comparaison de tuples en `HAVING`. ClickHouse peut ainsi la confronter à la clé de tri de la table : 112 granules lus sur 3 125 dans l’essai, contre 3 125.
- Les calculs de date précisent désormais le fuseau `'UTC'` dans le SQL (`toStartOfDay(now('UTC') - INTERVAL 7 DAY)`, `toHour(timestamp, 'UTC')`), parce qu’Elasticsearch calcule en UTC alors que ClickHouse suit le fuseau du serveur. La nouvelle option `clickhouse.timezone: UTC` déclare un serveur et des colonnes en UTC : le SQL retrouve alors sa forme courte.

- Plusieurs clauses `must_not` sont niées une à une (`a != x AND b != y`) plutôt qu’en bloc (`NOT (a = x OR b = y)`).

### Corrigé

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
