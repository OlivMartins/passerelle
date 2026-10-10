# Tests

Deux niveaux, du plus rapide au plus probant.

## Instantanés : `npm test`

Sans dépendance ni réseau. Chaque exemple de `examples/` et chaque cas de `tests/differential/cases.mjs` est traduit, puis comparé au fichier attendu dans `tests/snapshots/`. L’en-tête d’un instantané reprend la couverture annoncée et les remarques « à vérifier » et « à reprendre ».

Un changement du SQL ou du YAML généré fait échouer le test et apparaît en clair dans la revue. S’il est voulu :

```bash
npm run test:update
```

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
