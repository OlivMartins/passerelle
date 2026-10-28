-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation m
SELECT
    toStartOfMonth(timestamp, 'UTC') AS m,
    count() AS doc_count,
    sum(bytes) / (dateDiff('second', m, m + INTERVAL 1 MONTH) / 86400) AS octets_jour,
    count() * 12 AS docs_an
FROM logs.events
GROUP BY m
ORDER BY m ASC WITH FILL STEP INTERVAL 1 MONTH;
