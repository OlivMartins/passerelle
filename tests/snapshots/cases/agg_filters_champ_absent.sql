-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(env = 'prod', 'prod', ''), if((env != 'prod' OR env IS NULL), '_other_', '')])) AS f,
    count() AS doc_count
FROM logs.events
GROUP BY f
ORDER BY indexOf(['prod', '_other_'], f) ASC;
