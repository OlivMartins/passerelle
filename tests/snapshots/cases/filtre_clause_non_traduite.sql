-- Couverture : 0 directs, 0 à vérifier, 1 à reprendre
-- À reprendre : more_like_this non traduit

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE NOT (throwIf(1, 'Passerelle : more_like_this à traduire'));
