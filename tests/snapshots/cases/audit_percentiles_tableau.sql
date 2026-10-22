-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigestArray(0.5, 0.9)(nums)) AS p
FROM logs.events;
