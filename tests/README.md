# Tests

Deux niveaux, du plus rapide au plus probant.

## Instantanés : `npm test`

Sans dépendance ni réseau. Chaque exemple de `examples/` et chaque cas des deux bancs (`tests/differential/cases.mjs`, `tests/pipelines/cases.mjs`) est traduit, puis comparé au fichier attendu dans `tests/snapshots/`. L’en-tête d’un instantané reprend la couverture annoncée et les remarques « à vérifier » et « à reprendre ».

Un changement du SQL ou du YAML généré fait échouer le test et apparaît en clair dans la revue. S’il est voulu :

```bash
npm run test:update
```

S’y ajoutent des garde-fous ciblés : refus des clés inconnues, verdicts, paramètres de requête, sorties Elasticsearch, profondeur d’imbrication, et aucun nom déclaré deux fois dans le binaire assemblé.

`npm test` lance aussi `tests/server/run.mjs` : le serveur et la ligne de commande, interrogés à travers une fausse instance ClickHouse et un faux binaire Vector (Linux seulement). Il couvre les codes HTTP, les refus de sécurité, les options et les codes de sortie.

## Banc différentiel : `npm run test:diff`

Un instantané prouve que la sortie n’a pas changé, pas qu’elle est juste. Le banc exécute donc chaque requête DSL sur Elasticsearch, sa traduction sur ClickHouse, et compare les deux résultats ligne à ligne : clés, comptes, mesures et ordre.

Il faut :

- Node.js 24 ;
- Docker, pour Elasticsearch ;
- le binaire ClickHouse, en version 26.9 ou plus récente. Il tourne en local, sans serveur.

```bash
tests/differential/clickhouse.sh 26.9 ./clickhouse    # extrait le binaire de l’image Docker officielle
tests/differential/es.sh up                           # Elasticsearch 8.19, nœud unique, sur 127.0.0.1:9200
CLICKHOUSE_LOCAL="$PWD/clickhouse local" npm run test:diff
tests/differential/es.sh down
```

| Variable | Rôle | Défaut |
|---|---|---|
| `ES_VERSION`, `ES_PORT` | Version et port de l’Elasticsearch lancé par `es.sh` | `8.19.22`, `9200` |
| `ES_URL` | Adresse d’un Elasticsearch déjà disponible | `http://127.0.0.1:9200` |
| `CLICKHOUSE_LOCAL` | Commande ClickHouse locale | `clickhouse-local` |
| `PASSERELLE_DIFF_WORK` | Dossier de travail, sur un système de fichiers Linux | dossier temporaire |

### Versions

Le SQL généré vise ClickHouse 26.9 et les versions suivantes. Le banc refuse de tourner sur une version plus ancienne : ses résultats ne diraient rien de la cible. La CI épingle la 26.9 ; `clickhouse.sh` prend la version voulue en premier argument pour en essayer une autre.

Côté Elasticsearch, le banc donne le même bilan sur trois versions majeures : `ES_VERSION=7.17.29`, `8.19.22` et `9.5.4`. La CI les joue toutes les trois, à chaque changement et avant chaque release.

Options : `--only=<regex>` pour ne lancer que certains cas, `--variant=N` ou `D` pour un seul schéma, `--verbose` pour le détail de chaque cas, `--sql` pour afficher le SQL traduit.

### Ce que le banc couvre

Le jeu de données (`dataset.mjs`) est déterministe et contient exprès ce qui fait diverger les deux moteurs : champs absents, chaînes vides, champs multivalués, documents autour de minuit en UTC et en Europe/Paris, textes avec ponctuation, accents et casse mixte.

Chaque cas est joué sur deux schémas ClickHouse, parce que les deux conventions sont courantes et ne se trompent pas aux mêmes endroits :

- **N** : les champs facultatifs sont `Nullable` ;
- **D** : les champs facultatifs ont une valeur par défaut.

Les cas sensibles au fuseau sont aussi joués avec un serveur ClickHouse en `Europe/Paris`. Les agrégations `composite` sont paginées jusqu’au bout des deux côtés.

La table ClickHouse porte l’index `text` que la traduction recommande pour `message` : la recherche plein texte est vérifiée index compris.

### Écarts connus

Un cas dont la traduction ne donne pas encore le résultat d’Elasticsearch porte un champ `known` avec la raison. Le banc réussit tant que chaque cas se comporte comme annoncé. Il échoue dans deux situations :

- un cas attendu identique diverge : c’est une régression ;
- un écart connu disparaît : la correction est là, il reste à retirer `known` du cas.

La liste des `known` est donc l’inventaire exact de ce qui reste à corriger.

### Ajouter un cas

Ajoutez une entrée dans `cases.mjs`, lancez `npm run test:diff -- --only=<id> --verbose`, puis `npm run test:update` pour créer son instantané.

## Banc d’équivalence Logstash / Vector : `npm run test:pipelines`

Le pendant du banc différentiel pour les pipelines. Chaque cas est un bloc de filtres Logstash et quelques événements : Logstash joue le pipeline, Vector sa traduction, et le banc compare les événements produits, champ par champ et types compris.

Il faut Node.js 24 et Docker. Les deux moteurs tournent dans leur image officielle :

```bash
npm run test:pipelines
```

| Variable | Rôle | Défaut |
|---|---|---|
| `LOGSTASH_VERSION` | Version de l’image de Logstash | `9.5.5` |
| `VECTOR_VERSION` | Version de l’image de Vector | `0.59.0` |
| `PASSERELLE_PIPELINES_WORK` | Dossier de travail, sur un système de fichiers Linux | dossier temporaire |

Options : `--only=<regex>` pour ne lancer que certains cas, `--ecs=v8` ou `disabled` pour un seul mode, `--verbose` pour le détail de chaque écart, `--yaml` pour afficher la configuration traduite.

Un seul Logstash joue tous les cas, chacun dans son propre pipeline, puis s’arrête ; un seul conteneur Vector enchaîne les configurations. Le banc entier dure moins de deux minutes, dont une vingtaine de secondes pour le démarrage de Logstash.

### Ce que le banc couvre

Les filtres traduits, un comportement par cas : la forme attendue, puis ce qui fait diverger les deux moteurs, comme un champ absent, un tableau là où l’on attend une chaîne, une valeur qui ne se convertit pas ou une lettre accentuée. S’y ajoutent les conditions, `%{champ}`, le routage des sorties, et deux des pipelines d’exemple, joués tels quels.

Chaque cas est joué dans les deux modes de compatibilité ECS de Logstash, parce que les deux sont en service et ne donnent pas les mêmes champs :

- **v8**, le réglage par défaut depuis Logstash 8 ;
- **disabled**, celui des pipelines plus anciens.

La traduction est faite dans le même mode (`vector.ecs_compatibility`) : chaque cas donne deux configurations Vector. La configuration jouée par Vector est celle que produit Passerelle, sans retouche. Seul le transport est celui du banc : Vector lit son entrée standard, Logstash un fichier, et tous deux écrivent dans un fichier. L’entrée fichier de Logstash pose le nom d’hôte et le chemin du fichier sur l’événement ; un préambule les retire avant les filtres du cas, pour que Logstash livre ce qu’une entrée Kafka livrerait.

Deux tolérances, pas une de plus :

- l’horodatage posé à l’ingestion, qui ne peut pas être égal des deux côtés ;
- un UUID, tiré au hasard par chaque moteur et comparé par sa forme.

La première est portée par un cas qui la désactive (champ `exact`) et en fait l’inventaire. `[event][original]`, que les codecs de Logstash ajoutent en mode `v8`, est comparé comme les autres champs.

### Ce qu’il ne couvre pas

- Kafka : les métadonnées `[@metadata][kafka]` et l’option `decorate_events` ne sont pas jouées.
- `geoip`, et avec lui l’exemple `nginx.conf` : il faudrait la même base de données des deux côtés.
- `fingerprint` avec une clé et `drop` avec `percentage`.
- Les entrées et les sorties autres que celles du transport.
- Les identifiants `${KAFKA_USERNAME}` et `${KAFKA_PASSWORD}` d’une configuration générée. Depuis sa version 0.57, Vector ne remplace `${VAR}` qu’avec l’option `--dangerously-allow-env-var-interpolation`, que demande l’en-tête de chaque configuration générée : le banc la donne (`VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true`), et un `$` doublé par le moteur redevient simple.

### Écarts connus

Même règle que pour le banc différentiel : un cas qui diverge porte un champ `known` avec la raison, pour les deux modes ou pour un seul (`{ v8: '…' }`). Le banc échoue si un cas attendu identique diverge, ou si un écart connu disparaît sans que `known` soit retiré. Une configuration que Vector refuse est un écart ; un pipeline que Logstash refuse est un cas mal écrit, donc toujours un échec.

La raison d’un écart est suivie de « non signalé par la traduction » quand Passerelle n’a émis ni remarque ni élément « à vérifier » pour ce pipeline : l’utilisateur n’a alors aucun moyen de s’en douter.

### Ajouter un cas

Ajoutez une entrée dans `tests/pipelines/cases.mjs`, lancez `npm run test:pipelines -- --only=<id> --verbose`, puis `npm run test:update` pour créer son instantané. Un instantané ne garde que les transforms propres au cas : le transport du banc est le même partout.

## Bancs d’ingestion Elasticsearch

La traduction des ingest pipelines vers VRL se vérifie contre le comportement d’Elasticsearch, sans cluster : les attendus viennent du code d’`IngestDocument` ou des fichiers `*-expected.json` des intégrations Elastic, produits par Elasticsearch lui-même.

```sh
VECTOR_BIN=vector node tests/ingest/chemins.mjs                     # accès aux champs : messages d’erreur, index de liste
node tests/ingest/jouer.mjs pipeline.yml documents.json --yaml      # traduire un pipeline et y jouer des documents

export ELASTIC_INTEGRATIONS=~/src/integrations                      # clone de github.com/elastic/integrations
export MAXMIND_TEST_DATA=~/src/MaxMind-DB/test-data                 # bases GeoLite2-*-Test.mmdb
node tests/ingest/integration.mjs packages/nginx/data_stream/access # tests de pipeline d’un data stream, champ par champ
node tests/ingest/corpus.mjs                                        # tous les data streams : verdicts et causes
VECTOR_BIN=vector node tests/ingest/painless.mjs                    # scripts Painless : documents rejoués, résultat attendu écrit à la main
```

`painless.mjs` rejoue dans Vector les cas de `tests/ingest/cas/` (expressions régulières, lambdas, ensembles, dates, bits, `throw`, fonction récursive) et compare chaque champ à ce que Java donnerait. La CI le joue dans le job `ingest`.

Couverture sur les 1 154 data streams des intégrations Elastic (clone épinglé de la CI, pipelines partagés `.yml.link` compris), mesurée par `corpus.mjs` : **225 prêts, 811 à vérifier, 118 à reprendre**. Avant l’extension du traducteur Painless : 224 prêts, 447 à vérifier, 481 à reprendre (sans les pipelines partagés). Un flux « à vérifier » est traduit avec des écarts signalés (`corpus.mjs` en donne les causes) ; seul « prêt » promet des documents identiques. Sur les flux qui ont des tests de pipeline, `integration.mjs` mesure la part de documents identiques à ceux d’Elasticsearch.

`PASSERELLE_INGEST_WORK` choisit le dossier de travail (par défaut, un dossier temporaire).

Pour lancer à la suite tous les data streams qui ont des tests de pipeline : `node tests/ingest/tout.mjs [--only=regex] [--jobs=2]` (résumé dans `tout.tsv`, une ligne par data stream).

### Compilation du VRL : `npm run test:ingest`

Vector refuse la configuration entière si un seul VRL ne compile pas, quel que soit le verdict de Passerelle. `tests/ingest/valider.mjs` traduit puis passe `vector validate` sur :

- les exemples de `examples/ingest/` et les cas de `tests/ingest/cas/` (une construction par fichier, ajoutés chaque fois qu’une compilation a échoué : `dot_expander`, conversions Painless) ;
- avec `ELASTIC_INTEGRATIONS`, les data streams de `tests/ingest/integrations.txt` (ou ceux que sélectionne `--only=regex`, sur « paquet/flux »).

`--clickhouse` rejoue le tout avec la sortie ClickHouse. Le banc a besoin de `VECTOR_BIN` et, pour les bases geoip, de `MAXMIND_TEST_DATA`. Il ne dit rien de l’exactitude des documents produits : c’est le rôle de `integration.mjs`.

La CI joue ce banc dans le job `ingest`, avec Vector 0.59.0 et des clones épinglés des intégrations Elastic et de MaxMind-DB.

## Interface : `npm run test:ui`

Ouvre `dist/passerelle.html` dans Chromium avec Playwright : les sections requête, Logstash, ingestion et « Autres sources » (Kibana, Grafana, schéma, analyseurs) traduisent leur exemple et affichent un verdict, leurs onglets s’ouvrent, et la page ne produit aucune erreur. Playwright n’est pas une dépendance du projet : `npm run build:ui`, puis `npm install --no-save playwright` et `npx playwright install chromium` (ou `PLAYWRIGHT_FROM=<dossier où playwright se résout>`). La CI joue ce test dans le job `interface`.

## Bancs ClickHouse : `npm run test:attributes` et `npm run test:clickhouse`

Sans Elasticsearch, avec le binaire `clickhouse local` (`CLICKHOUSE_LOCAL`, extrait par `tests/differential/clickhouse.sh`).

- `test:attributes` : les attributs OpenTelemetry (`Map`, `JSON`) donnent le résultat de la table plate.
- `test:clickhouse` : ce que Passerelle génère pour ses exemples (schéma, inventaire Kibana) s’exécute avec les valeurs attendues ; `tests/clickhouse/analyseurs.mjs` rejoue la chaîne des analyseurs (table créée depuis un mapping, lignes insérées, plan appliqué, recherches vérifiées), et `tests/clickhouse/grafana.mjs` les requêtes des tableaux Grafana.
