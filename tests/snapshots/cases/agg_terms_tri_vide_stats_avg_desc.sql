-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(service != 'api') AS f_doc_count,
    countIf(bytes, service != 'api') AS f_s_count,
    minIfOrNull(bytes, service != 'api') AS f_s_min,
    maxIfOrNull(bytes, service != 'api') AS f_s_max,
    avgIfOrNull(bytes, service != 'api') AS f_s_avg,
    sumIf(bytes, service != 'api') AS f_s_sum
FROM logs.events
GROUP BY svc
ORDER BY f_s_avg DESC NULLS FIRST, svc ASC
LIMIT 10;
