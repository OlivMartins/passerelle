-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'UTC') AS d,
    count() AS doc_count,
    avgOrNull(latency_ms) AS lat,
    maxOrNull(bytes) AS mx
FROM logs.events
WHERE service = 'Search'
GROUP BY d
ORDER BY d ASC WITH FILL STEP INTERVAL 1 HOUR;
