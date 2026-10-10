-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'connection')
  AND hasToken(lowerUTF8(message), 'reset')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])connection(?:[^\\p{L}\\p{N}_.,\'’]|[.,\'’](?:$|[^\\p{L}\\p{N}_]))[^\\p{L}\\p{N}_]*reset(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))');
