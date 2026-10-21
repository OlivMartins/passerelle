-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= parseDateTime64InJodaSyntax('09/03/2026 06:30', 'dd/MM/yyyy HH:mm', 'UTC')
  AND timestamp < parseDateTime64InJodaSyntax('09/03/2026 18:00', 'dd/MM/yyyy HH:mm', 'UTC');
