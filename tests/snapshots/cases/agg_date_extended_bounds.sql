-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfInterval(timestamp, INTERVAL 12 HOUR, 'UTC') AS d,
    count() AS doc_count
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC')
  AND timestamp < parseDateTime64BestEffort('2026-03-10T00:00:00Z', 3, 'UTC')
GROUP BY d
ORDER BY d ASC WITH FILL STEP INTERVAL 12 HOUR;
