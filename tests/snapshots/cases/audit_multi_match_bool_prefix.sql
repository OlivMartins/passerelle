-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE ((hasToken(lowerUTF8(message), 'connection') OR hasToken(lowerUTF8(message), 'upstr')) OR (hasToken(lowerUTF8(title), 'connection') OR hasToken(lowerUTF8(title), 'upstr')));
