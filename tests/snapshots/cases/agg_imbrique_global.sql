-- Couverture : 2 directs, 0 à vérifier, 1 à reprendre
-- À reprendre : agrégation tous non traduit

-- Comptage
SELECT
    count() AS count
FROM logs.events
WHERE level = 'ERROR';
