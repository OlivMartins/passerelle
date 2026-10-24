-- Couverture : 0 directs, 1 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE least(editDistanceUTF8(service, 'apu'), damerauLevenshteinDistance(service, 'apu')) <= 0;
