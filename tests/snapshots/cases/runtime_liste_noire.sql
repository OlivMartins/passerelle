-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
WITH
    lowerUTF8(host) AS hote
SELECT
    hote AS h,
    count() AS doc_count
FROM logs.events
WHERE latency_ms >= 100
  AND hote NOT IN ('web-1', 'web-a', 'db_01')
GROUP BY h
ORDER BY doc_count DESC, h ASC
LIMIT 20;
