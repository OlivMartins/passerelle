-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    toMonday(timestamp, 'UTC') AS w,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY w, svc
ORDER BY w ASC, svc ASC
LIMIT 4;
