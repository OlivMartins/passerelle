-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(service != 'api') AS f_doc_count,
    avgIfOrNull(latency_ms, service != 'api') AS f_m
FROM logs.events
GROUP BY svc
ORDER BY f_m DESC NULLS FIRST, svc ASC
LIMIT 10;
