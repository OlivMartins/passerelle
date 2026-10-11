-- Couverture : 6 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    host AS h,
    level AS lvl,
    status AS st,
    http.method AS m,
    count() AS doc_count
FROM logs.events
GROUP BY svc, h, lvl, st, m
ORDER BY svc ASC, h ASC, lvl ASC, st ASC, m ASC
LIMIT 400;
