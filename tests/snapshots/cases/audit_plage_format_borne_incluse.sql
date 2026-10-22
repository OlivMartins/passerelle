-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= parseDateTime64InJodaSyntax('08/03/2026', 'dd/MM/yyyy', 'UTC') + INTERVAL 1 DAY
  AND timestamp < parseDateTime64InJodaSyntax('09/03/2026', 'dd/MM/yyyy', 'UTC') + INTERVAL 1 DAY;
