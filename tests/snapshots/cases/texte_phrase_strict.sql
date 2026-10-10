-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasTokenCaseInsensitive(message, 'connection')
  AND hasTokenCaseInsensitive(message, 'reset')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])connection(?:[^\\p{L}\\p{N}_.,\'’]|[.,\'’](?:$|[^\\p{L}\\p{N}_]))[^\\p{L}\\p{N}_]*reset(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))');
