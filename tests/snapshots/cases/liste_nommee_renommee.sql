-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE level IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_f3cfbbe2acd6');
