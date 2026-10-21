-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    quantilesTDigest(0.5)(latency_ms) AS p
FROM logs.events
WHERE service = 'inconnu';
