-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-10', 3, 'UTC')
  AND timestamp < parseDateTime64BestEffort('2026-03-11', 3, 'UTC')
ORDER BY timestamp ASC
LIMIT 3;
