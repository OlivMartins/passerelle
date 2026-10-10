-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toMonday(timestamp, 'UTC') AS d,
    count() AS doc_count
FROM logs.events
GROUP BY d
ORDER BY d ASC WITH FILL STEP INTERVAL 1 WEEK;
