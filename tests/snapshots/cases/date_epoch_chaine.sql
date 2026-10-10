-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp >= fromUnixTimestamp64Milli(toInt64(1773100800000))
  AND timestamp < fromUnixTimestamp64Milli(toInt64(1773187200000));
