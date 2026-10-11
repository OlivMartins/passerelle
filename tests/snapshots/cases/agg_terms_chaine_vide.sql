-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation u
SELECT
    user AS u,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(user)
GROUP BY u
ORDER BY doc_count DESC, u ASC
LIMIT 10;
