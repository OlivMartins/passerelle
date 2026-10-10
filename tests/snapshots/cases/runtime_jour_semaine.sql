-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation j
WITH
    toDayOfWeek(timestamp, 0, 'UTC') AS jour
SELECT
    jour AS j,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(jour)
GROUP BY j
ORDER BY j ASC
LIMIT 7;
