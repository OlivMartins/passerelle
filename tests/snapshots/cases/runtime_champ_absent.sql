-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation m
WITH
    if(isNotNull(env), upperUTF8(env), NULL) AS milieu
SELECT
    milieu AS m,
    count() AS doc_count
FROM logs.events
WHERE (milieu != 'PROD' OR milieu IS NULL)
  AND isNotNull(milieu)
GROUP BY m
ORDER BY doc_count DESC, m ASC
LIMIT 10;
