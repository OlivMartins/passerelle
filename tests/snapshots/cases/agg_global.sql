-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
WHERE level = 'ERROR'
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;

-- Agrégation tous › svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
