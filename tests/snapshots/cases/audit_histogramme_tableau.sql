-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    floor(nums / 5) * 5 AS h,
    count() AS doc_count
FROM logs.events
GROUP BY h
ORDER BY h ASC WITH FILL STEP 5;
