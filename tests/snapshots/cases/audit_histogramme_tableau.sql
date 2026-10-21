-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    arrayJoin(arrayDistinct(arrayMap(v -> floor(v / 5) * 5, nums))) AS h,
    count() AS doc_count
FROM logs.events
GROUP BY h
ORDER BY h ASC WITH FILL STEP 5;
