-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
WITH
    toHour(timestamp) AS heure
SELECT
    heure AS h,
    count() AS doc_count
FROM logs.events
WHERE timestamp < parseDateTime64BestEffort('2026-03-08T03:00:00Z', 3)
  AND isNotNull(heure)
GROUP BY h
ORDER BY h ASC
LIMIT 24;
