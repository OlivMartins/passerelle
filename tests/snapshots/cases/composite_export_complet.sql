-- Couverture : 7 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    host AS h,
    level AS lvl,
    status AS st,
    http.method AS m,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
GROUP BY svc, h, lvl, st, m;
