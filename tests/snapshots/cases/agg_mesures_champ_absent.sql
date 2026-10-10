-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    count(env) AS n,
    uniq(env) AS u
FROM logs.events;
