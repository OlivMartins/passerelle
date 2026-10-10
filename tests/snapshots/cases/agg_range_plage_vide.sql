-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(latency_ms < 100, 'bas', ''), if(latency_ms >= 100 AND latency_ms < 3000, 'milieu', ''), if(latency_ms >= 5000, 'haut', '')])) AS r,
    count() AS doc_count
FROM logs.events
GROUP BY r
ORDER BY indexOf(['bas', 'milieu', 'haut'], r) ASC;
