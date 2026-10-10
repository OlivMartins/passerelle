-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(latency_ms < 100, '*-100', ''), if(latency_ms >= 100 AND latency_ms < 3000, '100-3000', '')])) AS r,
    count() AS doc_count
FROM logs.events
GROUP BY r
ORDER BY indexOf(['*-100', '100-3000'], r) ASC;
