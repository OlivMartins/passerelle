-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE ((hasToken(lowerUTF8(message), 'user') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])user(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))')) OR (hasToken(lowerUTF8(message), 'id') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])id(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))')))
  AND NOT (hasToken(lowerUTF8(message), 'html') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.\'’]|(?:^|[^\\p{L}_])[.\'’])html(?:$|[^\\p{L}\\p{N}_.\'’]|[.\'’](?:$|[^\\p{L}_]))'));
