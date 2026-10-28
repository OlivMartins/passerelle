-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    argMax(status, timestamp) AS t
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
