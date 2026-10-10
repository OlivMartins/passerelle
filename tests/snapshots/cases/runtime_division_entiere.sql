-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation b
WITH
    latency_ms / 100 AS tranche
SELECT
    tranche AS b,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(tranche)
GROUP BY b
ORDER BY b ASC
LIMIT 40;
