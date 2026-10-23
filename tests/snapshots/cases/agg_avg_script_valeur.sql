-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    avg(latency_ms * 0.1) AS a
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
