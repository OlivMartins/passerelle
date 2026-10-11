-- Couverture : 6 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    minOrNull(latency_ms) AS mn,
    maxOrNull(latency_ms) AS mx,
    avgOrNull(latency_ms) AS av,
    sum(latency_ms) AS sm,
    count(latency_ms) AS vc
FROM logs.events
WHERE service = 'aucun';
