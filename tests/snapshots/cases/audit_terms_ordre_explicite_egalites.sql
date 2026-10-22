-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    retries AS r,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(retries)
GROUP BY r
ORDER BY doc_count DESC, r ASC
LIMIT 2;
