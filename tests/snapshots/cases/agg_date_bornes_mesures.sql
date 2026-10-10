-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfInterval(timestamp, INTERVAL 12 HOUR, 'UTC') AS d,
    count() AS doc_count,
    avgOrNull(latency_ms) AS lat,
    minOrNull(latency_ms) AS mn,
    sum(bytes) AS s
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC')
  AND timestamp < parseDateTime64BestEffort('2026-03-10T00:00:00Z', 3, 'UTC')
GROUP BY d
ORDER BY d ASC WITH FILL
    FROM toStartOfInterval(fromUnixTimestamp64Milli(toInt64(1772928000000)), INTERVAL 12 HOUR, 'UTC')
    TO toStartOfInterval(parseDateTime64BestEffort('2026-03-10T23:59:59Z', 3, 'UTC'), INTERVAL 12 HOUR, 'UTC') + INTERVAL 12 HOUR
    STEP INTERVAL 12 HOUR;
