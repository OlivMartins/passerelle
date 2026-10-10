-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(status >= 500, 'err', ''), if(latency_ms > 2000, 'slow', ''), if(NOT ((status >= 500 OR latency_ms > 2000)), '_other_', '')])) AS f,
    count() AS doc_count
FROM logs.events
GROUP BY f
ORDER BY indexOf(['err', 'slow', '_other_'], f) ASC;
