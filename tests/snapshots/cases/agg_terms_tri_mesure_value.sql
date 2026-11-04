-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
GROUP BY svc
ORDER BY lat DESC, svc ASC
LIMIT 10;
