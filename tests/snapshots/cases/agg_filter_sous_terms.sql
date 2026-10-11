-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation err › svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
WHERE status >= 500
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
