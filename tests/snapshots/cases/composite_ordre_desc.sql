-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    env AS env,
    level AS lvl,
    status AS st,
    count() AS doc_count
FROM logs.events
GROUP BY svc, env, lvl, st
ORDER BY svc ASC, env ASC, lvl ASC, st ASC
LIMIT 25;
