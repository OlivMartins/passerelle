-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    env,
    service AS svc,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(env)
GROUP BY env, svc
ORDER BY env ASC, svc ASC
LIMIT 10;
