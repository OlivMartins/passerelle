-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00.000Z', 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort('2026-03-10T23:59:59.999Z', 3, 'UTC')
  AND service = 'api';
