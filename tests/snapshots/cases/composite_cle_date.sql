-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    host AS h,
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count
FROM logs.events
GROUP BY h, d
ORDER BY h ASC, d ASC
LIMIT 6;
