-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
SELECT
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE NOT match(host, '^(?:web-.*)$')
GROUP BY h
ORDER BY doc_count DESC, h ASC
LIMIT 10;
