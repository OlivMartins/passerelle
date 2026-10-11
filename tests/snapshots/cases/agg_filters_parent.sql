-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f › svc
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(status >= 500, 'err', ''), if(latency_ms > 2000, 'lent', '')])) AS f,
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY f, svc
ORDER BY indexOf(['err', 'lent'], f), doc_count DESC, svc ASC
LIMIT 2 BY f;
