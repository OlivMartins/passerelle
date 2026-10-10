-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation service
SELECT
    service AS service,
    count() AS doc_count
FROM logs.events
GROUP BY service
ORDER BY doc_count DESC, service ASC
LIMIT 10;
