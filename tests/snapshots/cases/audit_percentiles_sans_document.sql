-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigest(0.5)(latency_ms)) AS p
FROM logs.events
WHERE service = 'inconnu';
