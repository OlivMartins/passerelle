-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Agrégation « host » renommée host_agg

-- Agrégation host
SELECT
    service AS host_agg,
    count() AS doc_count
FROM logs.events
WHERE host = 'web-1'
GROUP BY host_agg
ORDER BY doc_count DESC, host_agg ASC
LIMIT 10;
