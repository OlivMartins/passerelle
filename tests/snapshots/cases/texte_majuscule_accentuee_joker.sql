-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])éch[\\p{L}\\p{N}_]*(?:$|[^\\p{L}\\p{N}_])');
