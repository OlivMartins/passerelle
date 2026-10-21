-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE (timestamp) < (fromUnixTimestamp64Milli(toInt64(1773100800000)))
ORDER BY timestamp DESC
LIMIT 10;
