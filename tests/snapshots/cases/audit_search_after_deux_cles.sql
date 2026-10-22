-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE (status, timestamp) > (404, fromUnixTimestamp64Milli(toInt64(1773100800000)))
ORDER BY status ASC, timestamp ASC
LIMIT 10;
