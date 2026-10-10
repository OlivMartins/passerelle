-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation e
SELECT
    ifNull(env, 'N/A') AS e,
    count() AS doc_count
FROM logs.events
GROUP BY e
ORDER BY doc_count DESC, e ASC
LIMIT 10;
