-- Couverture : 2 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Tranches vides non comblées (d)

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    count() - lagInFrame(toNullable(count()), 1) OVER (ORDER BY d ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS dv
FROM logs.events
GROUP BY d
ORDER BY d ASC;
