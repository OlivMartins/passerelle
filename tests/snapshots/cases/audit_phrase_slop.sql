-- Couverture : 0 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : Proximité (slop 2) sur message

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'connection')
  AND hasToken(lowerUTF8(message), 'peer')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])connection[^\\p{L}\\p{N}]+(?:[\\p{L}\\p{N}_]+[^\\p{L}\\p{N}]+){0,2}peer(?:$|[^\\p{L}\\p{N}_])');
