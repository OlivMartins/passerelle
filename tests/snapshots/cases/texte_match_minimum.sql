-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (hasToken(lowerUTF8(message), 'connection')) + (hasToken(lowerUTF8(message), 'reset')) + (hasToken(lowerUTF8(message), 'peer')) + (hasToken(lowerUTF8(message), 'upstream')) >= 3;
