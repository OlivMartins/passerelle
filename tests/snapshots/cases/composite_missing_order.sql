-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    env,
    level AS lvl,
    count() AS doc_count
FROM logs.events
GROUP BY svc, env, lvl
ORDER BY svc ASC, env ASC, lvl DESC
LIMIT 4;
