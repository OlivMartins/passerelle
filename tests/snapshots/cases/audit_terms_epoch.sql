-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE timestamp IN (fromUnixTimestamp64Milli(toInt64(1772928576192)), fromUnixTimestamp64Milli(toInt64(1772928691910)));
