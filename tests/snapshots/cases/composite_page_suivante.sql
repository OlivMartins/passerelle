-- Couverture : 8 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    env,
    level AS lvl,
    status AS st,
    toStartOfDay(timestamp, 'UTC') AS d,
    http.method AS m,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
WHERE (
         svc > 'cart'
      OR (svc = 'cart' AND env IS NULL AND lvl < 'INFO')
      OR (svc = 'cart' AND env IS NULL AND lvl = 'INFO' AND st > 404)
      OR (svc = 'cart' AND env IS NULL AND lvl = 'INFO' AND st = 404 AND d > fromUnixTimestamp64Milli(toInt64(1773014400000)))
      OR (svc = 'cart' AND env IS NULL AND lvl = 'INFO' AND st = 404 AND d = fromUnixTimestamp64Milli(toInt64(1773014400000)) AND m > 'POST')
  )
GROUP BY svc, env, lvl, st, d, m
ORDER BY svc ASC, env DESC, lvl DESC, st ASC, d ASC, m ASC
LIMIT 20;
