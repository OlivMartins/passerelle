-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    floor(latency_ms / 500) * 500 AS tranche,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY tranche, svc
ORDER BY tranche ASC, svc DESC
LIMIT 9;
