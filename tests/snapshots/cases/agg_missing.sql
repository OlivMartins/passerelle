-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation sans_env
SELECT
    count() AS doc_count
FROM logs.events
WHERE isNull(env)
ORDER BY doc_count DESC;
