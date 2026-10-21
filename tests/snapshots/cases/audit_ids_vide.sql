-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Champ _id

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE _id IN ();
