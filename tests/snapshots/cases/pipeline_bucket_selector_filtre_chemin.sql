-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    avgIfOrNull(latency_ms, status >= 500) AS f_m
FROM logs.events
GROUP BY svc
HAVING f_m > 1500
ORDER BY svc ASC
LIMIT 10;
