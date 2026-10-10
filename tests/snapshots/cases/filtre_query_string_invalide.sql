-- Couverture : 0 directs, 0 à vérifier, 1 à reprendre
-- À reprendre : query_string non traduit

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE throwIf(1, 'Passerelle : query_string à traduire');
