-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    toFloat64(sum(bytes)) AS octets
FROM logs.events
GROUP BY d
ORDER BY d ASC WITH FILL STEP INTERVAL 1 DAY;
