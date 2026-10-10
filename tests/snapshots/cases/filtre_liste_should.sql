-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (host = 'web-1' OR host = 'web-2' OR host = 'db_01' OR host IN ('Web-A', 'web-6'));
