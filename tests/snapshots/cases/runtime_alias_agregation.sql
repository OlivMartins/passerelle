-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation b
WITH
    status AS b
SELECT
    b AS b,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(b)
GROUP BY b
ORDER BY b ASC
LIMIT 40;
