-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (env NOT IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_6ca45b679f06') OR env IS NULL);
