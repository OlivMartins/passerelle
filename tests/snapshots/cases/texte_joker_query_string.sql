-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])conn[\\p{L}\\p{N}_]*(?:$|[^\\p{L}\\p{N}_])')
  AND NOT (hasTokenCaseInsensitive(message, 'by') AND hasTokenCaseInsensitive(message, 'peer') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])by[^\\p{L}\\p{N}]+peer(?:$|[^\\p{L}\\p{N}_])'));
