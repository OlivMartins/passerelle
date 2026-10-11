-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
WITH
    upperUTF8(host) AS hote
SELECT
    hote AS h,
    count() AS doc_count
FROM logs.events
GROUP BY h
ORDER BY h ASC
LIMIT 20;
