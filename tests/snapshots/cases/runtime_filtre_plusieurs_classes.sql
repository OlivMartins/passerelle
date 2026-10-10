-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
WHERE latency_ms >= 100
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
