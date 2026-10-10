-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    env,
    level AS lvl,
    status AS st,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(env)
GROUP BY svc, env, lvl, st
ORDER BY svc ASC, env ASC, lvl DESC, st ASC
LIMIT 25;
