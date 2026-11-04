-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation s
SELECT
    floor(status / 100) * 100 AS s,
    count() AS doc_count,
    countIf(level = 'ERROR') AS f_doc_count,
    avgIfOrNull(latency_ms, level = 'ERROR') AS f_m
FROM logs.events
GROUP BY s
ORDER BY f_m DESC;
