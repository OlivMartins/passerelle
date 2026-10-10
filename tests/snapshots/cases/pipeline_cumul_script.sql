-- Couverture : 4 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Tranches vides non comblées (d)

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    sum(bytes) AS s,
    sum(s) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cs,
    s / doc_count AS bs
FROM logs.events
GROUP BY d
ORDER BY d ASC;
