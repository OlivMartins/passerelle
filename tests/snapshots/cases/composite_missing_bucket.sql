-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    env AS env,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY env, svc
ORDER BY env ASC, svc ASC
LIMIT 10;
