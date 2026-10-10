-- Couverture : 0 directs, 1 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE arrayExists(t -> editDistanceUTF8(t, 'conection') <= 1, tokens(lower(message)));
