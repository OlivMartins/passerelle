-- Couverture : 5 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Tranches vides non comblées (d)

-- Agrégation d
SELECT
    toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'UTC') AS d,
    count() AS doc_count,
    sum(bytes) AS s,
    sum(s) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cs,
    s - lagInFrame(toNullable(s), 1) OVER (ORDER BY d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS dv
FROM logs.events
WHERE service = 'Search'
GROUP BY d
ORDER BY d ASC;
