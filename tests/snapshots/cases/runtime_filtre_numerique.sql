-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation p
WITH
    multiIf(bytes < 1000, 1, bytes < 50000, 2, 3) AS palier
SELECT
    palier AS p,
    count() AS doc_count
FROM logs.events
WHERE bytes >= 1000
  AND bytes < 50000
GROUP BY p
ORDER BY doc_count DESC, p ASC
LIMIT 10;
