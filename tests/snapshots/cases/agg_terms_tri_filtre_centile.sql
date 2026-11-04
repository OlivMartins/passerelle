-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigestIf(0.99, 0.5)(latency_ms, status >= 500)) AS f_p
FROM logs.events
GROUP BY svc
ORDER BY f_p[2] ASC, svc ASC
LIMIT 1;
