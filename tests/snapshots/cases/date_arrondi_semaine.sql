-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE timestamp >= toDateTime(toMonday(parseDateTime64BestEffort('2026-03-10T12:00:00Z', 3, 'UTC')), 'UTC')
  AND timestamp < toDateTime(toStartOfMonth(parseDateTime64BestEffort('2026-03-10T12:00:00Z', 3, 'UTC')), 'UTC') + INTERVAL 1 MONTH
ORDER BY timestamp ASC
LIMIT 3;
