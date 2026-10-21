-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    arrayMap(t -> t.2, groupArraySorted(3)((-toUnixTimestamp64Milli(toDateTime64(timestamp, 3)), latency_ms))) AS t
FROM logs.events
WHERE service = 'Search';
