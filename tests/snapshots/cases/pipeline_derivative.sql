-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    sum(bytes) AS s,
    s - lagInFrame(s, 1) OVER (ORDER BY d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS dv
FROM logs.events
GROUP BY d
ORDER BY d ASC;
