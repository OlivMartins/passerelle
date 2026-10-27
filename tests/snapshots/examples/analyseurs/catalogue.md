# Analyseurs personnalisés : plan ClickHouse

## logs.catalogue · titre · analyseur « francais » — à vérifier

- ≈ tokenizer standard — découpage UAX#29 approché par une expression : « a1.b » reste un mot ici, deux en Elasticsearch ; les idéogrammes ne sont pas séparés
- ✓ filtre lowercase
- ✓ filtre elision_fr
- ≈ filtre asciifolding — accents et æ œ ß ø đ ł þ ð ı ; la table de Lucene est plus large
- ✓ filtre mots_vides — les positions des mots retirés ne sont pas conservées (match_phrase : voir les notes)
- ℹ Positions — Les mots vides retirés laissent un trou dans les positions d’Elasticsearch ; dans la colonne de mots, un match_phrase par hasSubstr() ne les saute pas : une phrase contenant un mot vide doit être cherchée sans lui.

Aperçu de « Les téléviseurs d’été » (ce qu’Elasticsearch indexerait) :

- tokenizer standard : [Les] [téléviseurs] [d’été]
- filtre lowercase : [les] [téléviseurs] [d’été]
- filtre elision_fr : [les] [téléviseurs] [été]
- filtre asciifolding : [les] [televiseurs] [ete]
- filtre mots_vides : [televiseurs] [ete]
- ℹ asciifolding : la table de Lucene compte plus d’un millier de remplacements ; sont reproduits ici les lettres accentuées (décomposition Unicode) et æ œ ß ø đ ł þ ð ı.

```sql
ALTER TABLE logs.catalogue ADD COLUMN titre_mots Array(String) MATERIALIZED if(isNull(titre), [], arrayFilter(t -> NOT has(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et'], t), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> replaceRegexpOne(t, '^(?:l|d|qu|j|n|s|c|m|t)[\'’]', ''), arrayMap(t -> lowerUTF8(t), extractAll(ifNull(titre, ''), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))));
ALTER TABLE logs.catalogue ADD INDEX idx_titre_mots titre_mots TYPE text(tokenizer = 'array') GRANULARITY 1;
ALTER TABLE logs.catalogue MATERIALIZE COLUMN titre_mots;
ALTER TABLE logs.catalogue MATERIALIZE INDEX idx_titre_mots;
```

Recherche de la même phrase :

```sql
-- match (tous les mots)
hasAll(titre_mots, arrayDistinct(arrayFilter(t -> NOT has(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et'], t), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> replaceRegexpOne(t, '^(?:l|d|qu|j|n|s|c|m|t)[\'’]', ''), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))))
-- match (un des mots)
hasAny(titre_mots, arrayDistinct(arrayFilter(t -> NOT has(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et'], t), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> replaceRegexpOne(t, '^(?:l|d|qu|j|n|s|c|m|t)[\'’]', ''), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))))
-- match_phrase
hasSubstr(titre_mots, arrayFilter(t -> NOT has(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et'], t), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> replaceRegexpOne(t, '^(?:l|d|qu|j|n|s|c|m|t)[\'’]', ''), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))))
```

## logs.catalogue · titre.debut · analyseur « autocompletion » — à vérifier

- ≈ tokenizer standard — découpage UAX#29 approché par une expression : « a1.b » reste un mot ici, deux en Elasticsearch ; les idéogrammes ne sont pas séparés
- ✓ filtre lowercase
- ≈ filtre asciifolding — accents et æ œ ß ø đ ł þ ð ı ; la table de Lucene est plus large
- ✓ filtre debut_de_mot
- ℹ Sous-champ — « titre.debut » est un sous-champ de « titre » dans le mapping : il n’a pas de colonne, ses mots sont calculés depuis « titre ».

Aperçu de « Les téléviseurs d’été » (ce qu’Elasticsearch indexerait) :

- tokenizer standard : [Les] [téléviseurs] [d’été]
- filtre lowercase : [les] [téléviseurs] [d’été]
- filtre asciifolding : [les] [televiseurs] [d’ete]
- filtre debut_de_mot : [le] [les] [te] [tel] [tele] [telev] [televi] [televis] [televise] [d’] [d’e] [d’et] [d’ete]
- ℹ asciifolding : la table de Lucene compte plus d’un millier de remplacements ; sont reproduits ici les lettres accentuées (décomposition Unicode) et æ œ ß ø đ ł þ ð ı.

```sql
ALTER TABLE logs.catalogue ADD COLUMN titre_debut_mots Array(String) MATERIALIZED if(isNull(titre), [], arrayFlatten(arrayMap(t -> arrayMap(n -> substringUTF8(t, 1, n), arrayFilter(n -> n <= lengthUTF8(t), range(2, 9))), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> lowerUTF8(t), extractAll(ifNull(titre, ''), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))));
ALTER TABLE logs.catalogue ADD INDEX idx_titre_debut_mots titre_debut_mots TYPE text(tokenizer = 'array') GRANULARITY 1;
ALTER TABLE logs.catalogue MATERIALIZE COLUMN titre_debut_mots;
ALTER TABLE logs.catalogue MATERIALIZE INDEX idx_titre_debut_mots;
```

Recherche de la même phrase :

```sql
-- match (tous les mots)
hasAll(titre_debut_mots, arrayDistinct(arrayFlatten(arrayMap(t -> arrayMap(n -> substringUTF8(t, 1, n), arrayFilter(n -> n <= lengthUTF8(t), range(2, 9))), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))))
-- match (un des mots)
hasAny(titre_debut_mots, arrayDistinct(arrayFlatten(arrayMap(t -> arrayMap(n -> substringUTF8(t, 1, n), arrayFilter(n -> n <= lengthUTF8(t), range(2, 9))), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))))
-- match_phrase
hasSubstr(titre_debut_mots, arrayFlatten(arrayMap(t -> arrayMap(n -> substringUTF8(t, 1, n), arrayFilter(n -> n <= lengthUTF8(t), range(2, 9))), arrayMap(t -> replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(normalizeUTF8NFD(t), '\\p{M}', ''), 'Æ', 'AE'), 'æ', 'ae'), 'Œ', 'OE'), 'œ', 'oe'), 'ß', 'ss'), 'Ø', 'O'), 'ø', 'o'), 'Đ', 'D'), 'đ', 'd'), 'Ł', 'L'), 'ł', 'l'), 'Þ', 'TH'), 'þ', 'th'), 'Ð', 'D'), 'ð', 'd'), 'ı', 'i'), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))))
```

## logs.catalogue · reference · analyseur « reference » — à vérifier

- ✓ char_filter normalise_sku
- ✓ tokenizer keyword
- ≈ filtre uppercase — upperUTF8 applique les correspondances multi-lettres (ß → SS) que Lucene ignore : seuls les mots avec ß ou ligatures diffèrent

Aperçu de « Les téléviseurs d’été » (ce qu’Elasticsearch indexerait) :

- char_filter normalise_sku : "Lestéléviseursd’été"
- tokenizer keyword : [Lestéléviseursd’été]
- filtre uppercase : [LESTÉLÉVISEURSD’ÉTÉ]

```sql
ALTER TABLE logs.catalogue ADD COLUMN reference_mots Array(String) MATERIALIZED if(isNull(reference), [], arrayMap(t -> upperUTF8(t), [replaceRegexpAll(ifNull(reference, ''), '[-_ ]+', '')]));
ALTER TABLE logs.catalogue ADD INDEX idx_reference_mots reference_mots TYPE text(tokenizer = 'array') GRANULARITY 1;
ALTER TABLE logs.catalogue MATERIALIZE COLUMN reference_mots;
ALTER TABLE logs.catalogue MATERIALIZE INDEX idx_reference_mots;
```

Recherche de la même phrase :

```sql
-- match (tous les mots)
hasAll(reference_mots, arrayDistinct(arrayMap(t -> upperUTF8(t), [replaceRegexpAll('Les téléviseurs d’été', '[-_ ]+', '')])))
-- match (un des mots)
hasAny(reference_mots, arrayDistinct(arrayMap(t -> upperUTF8(t), [replaceRegexpAll('Les téléviseurs d’été', '[-_ ]+', '')])))
-- match_phrase
hasSubstr(reference_mots, arrayMap(t -> upperUTF8(t), [replaceRegexpAll('Les téléviseurs d’été', '[-_ ]+', '')]))
```

## logs.catalogue · tags · analyseur « equivalents » — à vérifier

- ≈ tokenizer standard — découpage UAX#29 approché par une expression : « a1.b » reste un mot ici, deux en Elasticsearch ; les idéogrammes ne sont pas séparés
- ✓ filtre lowercase
- ≈ filtre equivalences — les mots sont ramenés à un terme canonique, à l’indexation comme à la recherche : mêmes résultats, mais les mots indexés ne sont pas ceux d’Elasticsearch

Aperçu de « Les téléviseurs d’été » (ce qu’Elasticsearch indexerait) :

- tokenizer standard : [Les] [téléviseurs] [d’été]
- filtre lowercase : [les] [téléviseurs] [d’été]
- filtre equivalences : [les] [téléviseurs] [d’été]

```sql
ALTER TABLE logs.catalogue ADD COLUMN tags_mots Array(String) MATERIALIZED arrayFlatten(arrayMap(v -> arrayMap(t -> transform(t, ['télé', 'téléviseur', 'pc'], ['tv', 'tv', 'ordinateur'], t), arrayMap(t -> lowerUTF8(t), extractAll(v, '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))), tags));
ALTER TABLE logs.catalogue ADD INDEX idx_tags_mots tags_mots TYPE text(tokenizer = 'array') GRANULARITY 1;
ALTER TABLE logs.catalogue MATERIALIZE COLUMN tags_mots;
ALTER TABLE logs.catalogue MATERIALIZE INDEX idx_tags_mots;
```

Recherche de la même phrase :

```sql
-- match (tous les mots)
hasAll(tags_mots, arrayDistinct(arrayMap(t -> transform(t, ['télé', 'téléviseur', 'pc'], ['tv', 'tv', 'ordinateur'], t), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))
-- match (un des mots)
hasAny(tags_mots, arrayDistinct(arrayMap(t -> transform(t, ['télé', 'téléviseur', 'pc'], ['tv', 'tv', 'ordinateur'], t), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))
-- match_phrase
hasSubstr(tags_mots, arrayMap(t -> transform(t, ['télé', 'téléviseur', 'pc'], ['tv', 'tv', 'ordinateur'], t), arrayMap(t -> lowerUTF8(t), extractAll('Les téléviseurs d’été', '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))
```

## logs.catalogue · description · analyseur « descriptions » — à vérifier

- ≈ char_filter sans_html — html_strip de Lucene gère aussi scripts, commentaires et entités numériques
- ≈ tokenizer standard — découpage UAX#29 approché par une expression : « a1.b » reste un mot ici, deux en Elasticsearch ; les idéogrammes ne sont pas séparés
- ✓ filtre lowercase
- ≈ filtre stemmer — stem(mot, 'en') suit Snowball (Porter2) alors que le stemmer « porter » d’Elasticsearch est le Porter d’origine : certains mots n’ont pas la même racine, comparez sur vos données. Demande allow_experimental_nlp_functions = 1

Aperçu de « Les téléviseurs d’été » : impossible — filtre « stemmer » : pas d’aperçu (Lucene non reproduit ici)

```sql
ALTER TABLE logs.catalogue ADD COLUMN description_mots Array(String) MATERIALIZED if(isNull(description), [], arrayMap(t -> stem(t, 'en'), arrayMap(t -> lowerUTF8(t), extractAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(ifNull(description, ''), '<[^>]*>', ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))));
ALTER TABLE logs.catalogue ADD INDEX idx_description_mots description_mots TYPE text(tokenizer = 'array') GRANULARITY 1;
ALTER TABLE logs.catalogue MATERIALIZE COLUMN description_mots;
ALTER TABLE logs.catalogue MATERIALIZE INDEX idx_description_mots;
```

Recherche de la même phrase :

```sql
-- match (tous les mots)
hasAll(description_mots, arrayDistinct(arrayMap(t -> stem(t, 'en'), arrayMap(t -> lowerUTF8(t), extractAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll('Les téléviseurs d’été', '<[^>]*>', ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))
-- match (un des mots)
hasAny(description_mots, arrayDistinct(arrayMap(t -> stem(t, 'en'), arrayMap(t -> lowerUTF8(t), extractAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll('Les téléviseurs d’été', '<[^>]*>', ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*')))))
-- match_phrase
hasSubstr(description_mots, arrayMap(t -> stem(t, 'en'), arrayMap(t -> lowerUTF8(t), extractAll(replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll('Les téléviseurs d’été', '<[^>]*>', ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'), '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*'))))
```
