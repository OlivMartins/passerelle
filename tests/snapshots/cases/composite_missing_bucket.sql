-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    env,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY env, svc
ORDER BY env ASC NULLS FIRST, svc ASC
LIMIT 10;
