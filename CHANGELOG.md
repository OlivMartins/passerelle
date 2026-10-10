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

### Corrigé

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
