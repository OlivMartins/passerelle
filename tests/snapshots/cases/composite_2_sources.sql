-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    level AS lvl,
    count() AS doc_count,
    avg(latency_ms) AS lat
FROM logs.events
GROUP BY svc, lvl
ORDER BY svc ASC, lvl ASC
LIMIT 7;
