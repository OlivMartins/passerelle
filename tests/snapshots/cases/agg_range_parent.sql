-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r › svc
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(latency_ms < 1000, 'bas', ''), if(latency_ms >= 1000, 'haut', ''), if(latency_ms >= 9000, 'vide', '')])) AS r,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY r, svc
ORDER BY indexOf(['bas', 'haut', 'vide'], r), doc_count DESC, svc ASC
LIMIT 2 BY r;
