-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE timestamp >= toStartOfDay(parseDateTime64BestEffort('2026-03-10', 3, 'Etc/GMT-9'))
  AND timestamp < toStartOfDay(parseDateTime64BestEffort('2026-03-10', 3, 'Etc/GMT-9') + INTERVAL 1 DAY)
ORDER BY timestamp ASC
LIMIT 3;
