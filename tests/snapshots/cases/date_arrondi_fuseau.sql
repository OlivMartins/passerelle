-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE timestamp >= toStartOfDay(parseDateTime64BestEffort('2026-03-10T12:00:00Z', 3, 'UTC'))
  AND timestamp < toStartOfDay(parseDateTime64BestEffort('2026-03-10T12:00:00Z', 3, 'UTC') + INTERVAL 1 DAY)
ORDER BY timestamp ASC
LIMIT 3;
