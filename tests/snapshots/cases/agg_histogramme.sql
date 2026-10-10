-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    floor(latency_ms / 500) * 500 AS h,
    count() AS doc_count
FROM logs.events
GROUP BY h
ORDER BY h ASC WITH FILL STEP 500;
