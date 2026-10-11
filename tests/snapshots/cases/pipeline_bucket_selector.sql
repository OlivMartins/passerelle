-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    host AS h,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
GROUP BY h
HAVING lat > 1500
ORDER BY doc_count DESC, h ASC
LIMIT 20;
