-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE ((hasToken(lowerUTF8(message), 'connection') OR match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])upstr')) OR (hasToken(lowerUTF8(title), 'connection') OR match(title, '(?i)(?:^|[^\\p{L}\\p{N}_])upstr')));
