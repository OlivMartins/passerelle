-- Couverture : 10 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    env,
    level AS lvl,
    status AS st,
    toStartOfDay(timestamp, 'UTC') AS d,
    http.method AS m,
    count() AS doc_count,
    avg(latency_ms) AS lat,
    sum(bytes) AS octets
FROM logs.events
WHERE timestamp >= parseDateTime64BestEffort('2026-03-08T12:00:00Z', 3, 'UTC')
GROUP BY svc, env, lvl, st, d, m
ORDER BY svc ASC, env DESC, lvl DESC, st ASC, d ASC, m ASC
LIMIT 150;
