-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasTokenCaseInsensitive(message, 'payment')
  AND hasTokenCaseInsensitive(message, 'service')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])payment[^\\p{L}\\p{N}]+service(?:$|[^\\p{L}\\p{N}_])');
