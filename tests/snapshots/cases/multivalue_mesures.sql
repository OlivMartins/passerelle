-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    sum(length(tags)) AS n,
    uniqArray(tags) AS u
FROM logs.events;
