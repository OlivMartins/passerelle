-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation w
SELECT
    toMonday(timestamp, 'UTC') AS w,
    count() AS doc_count,
    sum(bytes) / 7 AS octets_jour
FROM logs.events
GROUP BY w
ORDER BY w ASC WITH FILL STEP INTERVAL 1 WEEK;
