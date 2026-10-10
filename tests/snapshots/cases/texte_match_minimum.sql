-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (hasTokenCaseInsensitive(message, 'connection')) + (hasTokenCaseInsensitive(message, 'reset')) + (hasTokenCaseInsensitive(message, 'peer')) + (hasTokenCaseInsensitive(message, 'upstream')) >= 3;
