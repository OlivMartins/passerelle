-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasTokenCaseInsensitive(message, '10')
  AND hasTokenCaseInsensitive(message, '0')
  AND hasTokenCaseInsensitive(message, '1')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.,\']|(?:^|[^\\p{N}])[.,\'])10\\.0\\.0\\.1(?:$|[^\\p{L}\\p{N}_.,\']|[.,\'](?:$|[^\\p{N}]))');
