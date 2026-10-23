-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation t
SELECT
    toStartOfInterval(timestamp, INTERVAL 6 HOUR, 'UTC') AS t,
    count() AS doc_count,
    count() / 6 AS docs_heure,
    count(retries) / 360 AS valeurs_minute
FROM logs.events
GROUP BY t
ORDER BY t ASC WITH FILL STEP INTERVAL 6 HOUR;
