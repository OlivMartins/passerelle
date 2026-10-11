-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'can')
  AND hasToken(lowerUTF8(message), 't')
  AND positionCaseInsensitiveUTF8(message, 'can\'t') > 0;
