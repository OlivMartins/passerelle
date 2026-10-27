# Analyseurs personnalisés

Un champ `text` d’Elasticsearch est découpé en mots par son analyseur, à l’indexation comme à la recherche. ClickHouse n’a pas d’analyseur nommé : Passerelle traduit celui d’un index en une colonne `Array(String)` calculée (`MATERIALIZED`), un index plein texte posé dessus, et les requêtes qui cherchent dans cette colonne.

```bash
passerelle schema analyzers mapping.json --text "L’éléphant d’Été"
passerelle schema analyzers index/ --field titre --format sql --out build/analyseurs --fail-on todo
```

L’entrée est un mapping avec ses réglages (`settings.analysis`), tel que renvoyé par `GET mon-index` ou écrit dans une requête `PUT mon-index` de la console Kibana. L’exemple [`examples/analyseurs/catalogue.txt`](../examples/analyseurs/catalogue.txt) en montre un.

| Option | Rôle |
|---|---|
| `--text TEXTE` | Texte d’essai pour l’aperçu (par défaut, un exemple) |
| `--field CHAMP` | Ne traite que ce champ |
| `--format md\|json\|sql` | Rapport lisible (défaut), JSON, ou les seules instructions SQL |
| `--fail-on todo\|review` | Code de sortie 2 si un analyseur est « à reprendre » (ou « à vérifier ») |

## Ce que produit Passerelle, pour chaque champ

1. **L’aperçu** : les mots qu’Elasticsearch indexerait pour le texte d’essai, étape par étape, comme l’API `_analyze`.
2. **Le plan** : les instructions `ALTER TABLE` qui ajoutent la colonne de mots, son index `text(tokenizer = 'array')`, et leur matérialisation.
3. **Les requêtes** : la recherche du même texte passe par la même expression, pour que les deux côtés produisent les mêmes mots : `hasAll` pour `match`, `hasAny` pour l’opérateur `or`, `hasSubstr` pour `match_phrase`.
4. **Le verdict de chaque étape** : exacte (✓), approchée (≈, avec la différence), ou impossible (le champ est « à reprendre » et la raison est donnée). Une étape que Passerelle ne sait pas reproduire n’est jamais approchée en silence.

Un sous-champ du mapping (`titre.debut`) n’a pas de colonne propre : ses mots sont calculés depuis le champ parent.

## Pris en charge

| Étape | Composants |
|---|---|
| Analyseurs prédéfinis | `standard`, `simple`, `whitespace`, `keyword`, `stop`, et l’analyseur `custom` |
| `char_filter` | `mapping`, `pattern_replace`, `html_strip` |
| `tokenizer` | `standard`, `whitespace`, `letter`, `lowercase`, `keyword`, `pattern`, `char_group`, `ngram`, `edge_ngram`, `path_hierarchy` |
| `filter` | `lowercase`, `uppercase`, `asciifolding`, `trim`, `unique`, `reverse`, `truncate`, `length`, `stop`, `ngram`, `edge_ngram`, `pattern_replace`, `elision`, `synonym`, `synonym_graph`, `stemmer`, `snowball`, `porter_stem` |

Un composant d’un autre type (par exemple `icu_*`, `phonetic`, `kuromoji`, des plugins) rend le champ « à reprendre ».

## Les écarts à connaître

- **`standard`** : le découpage UAX#29 de Lucene est approché par une expression régulière. `a1.b` reste un mot ici et en fait deux dans Elasticsearch ; les idéogrammes ne sont pas séparés.
- **`asciifolding`** : sont repliés les lettres accentuées (décomposition Unicode) et `æ œ ß ø đ ł þ ð ı`. La table de Lucene compte plus d’un millier de remplacements.
- **`html_strip`** : balises retirées et entités courantes décodées, sans le traitement exact de Lucene (scripts, commentaires).
- **Mots vides** : les mots retirés laissent un trou dans les positions d’Elasticsearch ; `match_phrase` par `hasSubstr()` ne saute pas ce trou.
- **`elision`** :
  - `articles_case: false` (le défaut) compare sans tenir compte de la casse, `true` en tenant compte, comme Elasticsearch ;
  - le filtre prédéfini `elision`, appelé par son nom, utilise les articles français par défaut, sans tenir compte de la casse ;
  - un filtre défini sans `articles` ni `articles_path` est refusé, comme Elasticsearch le refuse ; `articles_path` (fichier) est refusé : le fichier n’est pas lu.
- **`stemmer`** :
  - la langue se lit dans `language`, ou dans `name` (ancien alias) ; sans l’un ni l’autre, c’est `porter`, comme Elasticsearch ;
  - le plan passe par `stem()` de ClickHouse (Snowball). Le stemmer `english` d’Elasticsearch est le Porter d’origine, ClickHouse applique Porter2 : certains mots n’ont pas la même racine, d’où le verdict « à vérifier » ; comparez sur vos données ;
  - `light_*` et `minimal_*` (`light_french`, `minimal_french`…) n’ont pas d’équivalent dans `stem()` : « à reprendre » ;
  - `stem()` demande `allow_experimental_nlp_functions = 1` quand l’instruction est exécutée sur un serveur ; l’aperçu n’en calcule pas la racine (pas de copie de Lucene dans Passerelle).
- **`synonym`** et **`synonym_graph`** : à l’indexation comme à la recherche, chaque synonyme est remplacé par un terme canonique (le côté droit d’une règle `a => b`, le premier terme d’une liste). Les deux côtés produisent les mêmes mots, donc la requête retrouve les documents. Sont refusés (« à reprendre ») : un synonyme de plusieurs mots, une règle `a => b, c` (un mot qui devient plusieurs), et les fichiers ou ensembles de synonymes (`synonyms_path`, `synonyms_set`).

## Version de ClickHouse

Le plan vise ClickHouse 26.9 et suivants : l’index `text(tokenizer = 'array')` sur une colonne `Array(String)` y est disponible. Le banc `npm run test:clickhouse` crée une table à partir d’un mapping, insère des lignes, applique le plan et vérifie les résultats de recherche.
