-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= toStartOfDay(parseDateTime64BestEffort('2026-03-09T10:00:00Z', 3, 'UTC')) + INTERVAL 1 DAY
  AND timestamp < toStartOfDay(parseDateTime64BestEffort('2026-03-10T10:00:00Z', 3, 'UTC')) + INTERVAL 1 DAY;
