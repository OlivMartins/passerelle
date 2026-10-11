-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    host AS h,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
GROUP BY h
ORDER BY lat DESC
LIMIT 5;
