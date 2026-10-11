-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE host IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_7035e06f791d');
