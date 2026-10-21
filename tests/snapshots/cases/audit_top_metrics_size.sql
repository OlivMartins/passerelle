-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    argMax(latency_ms, timestamp) AS t
FROM logs.events
WHERE service = 'Search';
