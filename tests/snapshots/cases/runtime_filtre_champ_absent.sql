-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation z
WITH
    multiIf(isNull(env), 'inconnu', env = 'prod', 'prod', 'hors prod') AS zone
SELECT
    zone AS z,
    count() AS doc_count
FROM logs.events
WHERE NOT ifNull(isNotNull(env) AND env = 'prod', 0)
  AND isNotNull(zone)
GROUP BY z
ORDER BY doc_count DESC, z ASC
LIMIT 10;
