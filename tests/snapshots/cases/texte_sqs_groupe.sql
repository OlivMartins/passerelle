-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (hasToken(lowerUTF8(message), 'timeout') OR hasToken(lowerUTF8(message), 'reset'))
  AND hasToken(lowerUTF8(message), 'upstream');
