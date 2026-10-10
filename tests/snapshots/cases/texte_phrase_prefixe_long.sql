-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'upstream')
  AND hasToken(lowerUTF8(message), 'timeout')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])upstream[^\\p{L}\\p{N}]+timeout[^\\p{L}\\p{N}]+aft');
