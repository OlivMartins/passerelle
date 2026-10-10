-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    tags AS t,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY t, svc
ORDER BY t ASC, svc ASC
LIMIT 10;
