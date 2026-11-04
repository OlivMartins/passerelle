-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    avgIfOrNull(latency_ms, status >= 500) AS f_m
FROM logs.events
GROUP BY d
ORDER BY f_m ASC;
