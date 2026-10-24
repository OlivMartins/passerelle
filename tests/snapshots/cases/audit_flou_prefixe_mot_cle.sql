-- Couverture : 0 directs, 2 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE ((startsWith(service, 'c') AND least(editDistanceUTF8(service, 'cxrt'), damerauLevenshteinDistance(service, 'cxrt')) <= 1) OR (startsWith(service, 'x') AND least(editDistanceUTF8(service, 'xpi'), damerauLevenshteinDistance(service, 'xpi')) <= 1));
