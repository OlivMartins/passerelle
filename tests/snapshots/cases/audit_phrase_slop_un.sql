-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'reset')
  AND hasToken(lowerUTF8(message), 'peer')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])reset[^\\p{L}\\p{N}]+(?:[\\p{L}\\p{N}_]+[^\\p{L}\\p{N}]+){0,1}peer(?:$|[^\\p{L}\\p{N}_])');
