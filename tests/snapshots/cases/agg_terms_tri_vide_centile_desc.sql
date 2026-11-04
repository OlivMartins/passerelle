-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(service != 'api') AS f_doc_count,
    arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigestIf(0.5)(latency_ms, service != 'api')) AS f_p
FROM logs.events
GROUP BY svc
ORDER BY f_p[1] DESC NULLS FIRST, svc ASC
LIMIT 1;
