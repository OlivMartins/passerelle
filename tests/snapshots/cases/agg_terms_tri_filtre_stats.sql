-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    countIf(latency_ms, status >= 500) AS f_s_count,
    minIfOrNull(latency_ms, status >= 500) AS f_s_min,
    maxIfOrNull(latency_ms, status >= 500) AS f_s_max,
    avgIfOrNull(latency_ms, status >= 500) AS f_s_avg,
    sumIf(latency_ms, status >= 500) AS f_s_sum
FROM logs.events
GROUP BY svc
ORDER BY f_s_avg ASC, svc ASC
LIMIT 10;
