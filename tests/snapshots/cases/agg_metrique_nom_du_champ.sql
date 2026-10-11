-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Agrégation « bytes » renommée bytes_agg

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    sum(bytes) AS bytes_agg,
    avg(bytes) AS moy
FROM logs.events
WHERE bytes >= 50000
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
