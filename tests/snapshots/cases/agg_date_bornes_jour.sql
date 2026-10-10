-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC')
  AND timestamp < parseDateTime64BestEffort('2026-03-10T00:00:00Z', 3, 'UTC')
GROUP BY d
ORDER BY d ASC WITH FILL
    FROM toStartOfDay(parseDateTime64BestEffort('2026-03-07', 3, 'UTC'), 'UTC')
    TO toStartOfDay(parseDateTime64BestEffort('2026-03-12', 3, 'UTC'), 'UTC') + INTERVAL 1 DAY
    STEP INTERVAL 1 DAY;
