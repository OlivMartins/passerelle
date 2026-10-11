-- Couverture : 3 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Tranches vides non comblées (d)

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    sum(bytes) AS s,
    max(toNullable(s)) OVER (ORDER BY d ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) AS mv
FROM logs.events
GROUP BY d
ORDER BY d ASC;
