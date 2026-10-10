-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasTokenCaseInsensitive(message, 'don')
  AND hasTokenCaseInsensitive(message, 't')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])don\'t(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))');
