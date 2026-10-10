-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation q
WITH
    intDiv(toHour(timestamp, 'UTC'), 6) AS quart
SELECT
    quart AS q,
    count() AS doc_count
FROM logs.events
GROUP BY q
ORDER BY q ASC
LIMIT 10;
