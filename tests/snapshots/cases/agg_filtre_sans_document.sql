-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(level = 'AUCUN') AS vide_doc_count,
    maxIf(latency_ms, level = 'AUCUN') AS vide_mx,
    avgIf(latency_ms, level = 'AUCUN') AS vide_av
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 2;
