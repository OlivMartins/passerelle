-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation h
WITH
    multiIf(latency_ms < 100, 'rapide', latency_ms < 1000, 'normal', 'lent') AS classe,
    lower(host) AS hote
SELECT
    hote AS h,
    count() AS doc_count
FROM logs.events
WHERE classe IN ('normal', 'lent')
  AND hote NOT IN ('web-1', 'web-a', 'db_01')
  AND isNotNull(hote)
GROUP BY h
ORDER BY doc_count DESC, h ASC
LIMIT 20;
