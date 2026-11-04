-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    quantilesTDigest(0.05, 0.375)(latency_ms) AS p
FROM logs.events
GROUP BY svc
ORDER BY p[2] DESC, svc ASC
LIMIT 1;
