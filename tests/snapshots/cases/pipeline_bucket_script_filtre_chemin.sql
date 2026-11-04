-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    avgIfOrNull(latency_ms, status >= 500) AS f_m,
    (f_doc_count * f_m) / doc_count AS part
FROM logs.events
GROUP BY svc
ORDER BY svc ASC
LIMIT 10;
