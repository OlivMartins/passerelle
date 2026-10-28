-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation d › svc
SELECT
    toStartOfInterval(timestamp, INTERVAL 6 HOUR, 'UTC') AS d,
    service AS svc,
    count() AS doc_count,
    count() / 360 AS par_minute
FROM logs.events
GROUP BY d, svc
ORDER BY d ASC, doc_count DESC, svc ASC
LIMIT 3 BY d;
