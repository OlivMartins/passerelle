-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation e
SELECT
    env AS e,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(env)
GROUP BY e
ORDER BY doc_count DESC, e ASC
LIMIT 10;
