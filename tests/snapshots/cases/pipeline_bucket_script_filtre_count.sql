-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS err_doc_count,
    err_doc_count / doc_count AS part
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
