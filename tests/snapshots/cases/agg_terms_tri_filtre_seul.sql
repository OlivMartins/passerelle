-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count
FROM logs.events
GROUP BY svc
ORDER BY f_doc_count DESC, svc ASC
LIMIT 10;
