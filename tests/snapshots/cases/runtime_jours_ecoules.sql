-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
WITH
    age('day', timestamp, fromUnixTimestamp64Milli(toInt64(1773273600000)), 'UTC') AS reste
SELECT
    reste AS r,
    count() AS doc_count
FROM logs.events
GROUP BY r
ORDER BY r ASC
LIMIT 10;
