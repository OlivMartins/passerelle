-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r › svc
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(latency_ms >= 0, 'tout', ''), if(latency_ms >= 1000, 'lent', '')])) AS r,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY r, svc
ORDER BY indexOf(['tout', 'lent'], r), doc_count DESC, svc ASC
LIMIT 2 BY r;
