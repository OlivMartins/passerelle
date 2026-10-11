-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation vide
SELECT
    count() AS doc_count,
    maxOrNull(latency_ms) AS mx
FROM logs.events
WHERE level = 'AUCUN'
ORDER BY doc_count DESC;

-- Agrégation vide › h
SELECT
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE level = 'AUCUN'
GROUP BY h
ORDER BY doc_count DESC, h ASC
LIMIT 10;
