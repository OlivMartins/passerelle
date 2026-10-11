-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfHour(timestamp, 'Asia/Kolkata') AS d,
    count() AS doc_count
FROM logs.events
WHERE timestamp < parseDateTime64BestEffort('2026-03-08T06:00:00Z', 3, 'UTC')
GROUP BY d
ORDER BY d ASC WITH FILL STEP INTERVAL 1 HOUR;
