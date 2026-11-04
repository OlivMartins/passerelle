-- Couverture : 4 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Tranches vides non comblées (d)

-- Agrégation d
SELECT
    toStartOfDay(timestamp, 'UTC') AS d,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    sum(f_doc_count) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cs
FROM logs.events
GROUP BY d
ORDER BY d ASC;
