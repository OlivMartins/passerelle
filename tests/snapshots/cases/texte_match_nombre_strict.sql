-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE hasToken(lowerUTF8(message), '3')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_.,\']|(?:^|[^\\p{N}])[.,\'])3(?:$|[^\\p{L}\\p{N}_.,\']|[.,\'](?:$|[^\\p{N}]))');
