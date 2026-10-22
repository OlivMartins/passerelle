-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE (timestamp < fromUnixTimestamp64Milli(toInt64(1773100800000)) OR (timestamp = fromUnixTimestamp64Milli(toInt64(1773100800000)) AND host > 'web-3'))
ORDER BY timestamp DESC, host ASC
LIMIT 10;
