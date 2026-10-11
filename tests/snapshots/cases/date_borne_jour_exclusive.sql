-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-09', 3, 'UTC') + INTERVAL 1 DAY
  AND timestamp < parseDateTime64BestEffort('2026-03-11', 3, 'UTC');
