-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation l
WITH
    multiIf(latency_ms >= 2000, 'tres lent', latency_ms >= 1000, 'lent', NULL) AS lent
SELECT
    lent AS l,
    count() AS doc_count
FROM logs.events
WHERE NOT (latency_ms >= 1000 AND latency_ms < 2000)
  AND isNotNull(lent)
GROUP BY l
ORDER BY doc_count DESC, l ASC
LIMIT 10;
