-- Couverture : 0 directs, 2 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (arrayExists(t -> startsWith(t, 'tie') AND least(editDistanceUTF8(t, 'tiemout'), damerauLevenshteinDistance(t, 'tiemout')) <= 1, tokens(lowerUTF8(message))) OR arrayExists(t -> startsWith(t, 'con') AND least(editDistanceUTF8(t, 'conection'), damerauLevenshteinDistance(t, 'conection')) <= 1, tokens(lowerUTF8(message))));
