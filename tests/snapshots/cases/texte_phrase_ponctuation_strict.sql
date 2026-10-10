-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), 'payload')
  AND hasToken(lowerUTF8(message), 'don')
  AND hasToken(lowerUTF8(message), 't')
  AND hasToken(lowerUTF8(message), 'retry')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])payload(?:[^\\p{L}\\p{N}_.,\'’]|[.,\'’](?:$|[^\\p{L}\\p{N}_]))[^\\p{L}\\p{N}_]*don\'t(?:[^\\p{L}\\p{N}_.,\'’]|[.,\'’](?:$|[^\\p{L}\\p{N}_]))[^\\p{L}\\p{N}_]*retry(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))');
