-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    floor(latency_ms / 500) * 500 AS h,
    count() AS doc_count,
    avgOrNull(bytes) AS lat
FROM logs.events
GROUP BY h
ORDER BY h ASC WITH FILL
    FROM floor(0 / 500) * 500
    TO floor(4999 / 500) * 500 + 500
    STEP 500;
