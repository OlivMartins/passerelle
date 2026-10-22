# Tests

Deux niveaux, du plus rapide au plus probant.

## Instantanés : `npm test`

Sans dépendance ni réseau. Chaque exemple de `examples/` et chaque cas des deux bancs (`tests/differential/cases.mjs`, `tests/pipelines/cases.mjs`) est traduit, puis comparé au fichier attendu dans `tests/snapshots/`. L’en-tête d’un instantané reprend la couverture annoncée et les remarques « à vérifier » et « à reprendre ».

Un changement du SQL ou du YAML généré fait échouer le test et apparaît en clair dans la revue. S’il est voulu :

```bash
npm run test:update
```

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

Côté Elasticsearch, le banc donne le même bilan sur trois versions majeures : `ES_VERSION=7.17.29`, `8.19.22` (celle de la CI) et `9.5.4`.

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

La configuration jouée par Vector est celle que produit Passerelle, sans retouche. Seul le transport est celui du banc : Vector lit son entrée standard, Logstash un fichier, et tous deux écrivent dans un fichier. L’entrée fichier de Logstash pose le nom d’hôte et le chemin du fichier sur l’événement ; un préambule les retire avant les filtres du cas, pour que Logstash livre ce qu’une entrée Kafka livrerait.

Trois tolérances, pas une de plus :

- `[event][original]`, que les codecs de Logstash ajoutent en mode `v8` ;
- l’horodatage posé à l’ingestion, qui ne peut pas être égal des deux côtés ;
- un UUID, tiré au hasard par chaque moteur et comparé par sa forme.

Les deux premières sont portées par un cas qui les désactive (champ `exact`) et en fait l’inventaire.

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
