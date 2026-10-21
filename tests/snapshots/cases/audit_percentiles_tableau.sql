-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    quantilesTDigest(0.5, 0.9)(nums) AS p
FROM logs.events;
