-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    quantilesTDigest(0.99)(latency_ms) AS p
FROM logs.events
GROUP BY svc
ORDER BY arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigest(0.7)(latency_ms))[1] DESC, svc ASC
LIMIT 1;
