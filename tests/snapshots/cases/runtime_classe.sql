-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
WHERE latency_ms >= 1000
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;

-- Agrégation c
WITH
    multiIf(latency_ms < 100, 'rapide', latency_ms < 1000, 'normal', 'lent') AS classe
SELECT
    classe AS c,
    count() AS doc_count
FROM logs.events
WHERE latency_ms >= 1000
GROUP BY c
ORDER BY doc_count DESC, c ASC
LIMIT 10;
