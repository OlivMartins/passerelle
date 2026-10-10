-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d
SELECT
    toStartOfDay(timestamp) AS d,
    count() AS doc_count,
    sum(bytes) AS s,
    max(s) OVER (ORDER BY d ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) AS mv
FROM logs.events
GROUP BY d
ORDER BY d ASC;
