-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (host IN ('web-1', 'web-2', 'db_01') OR status IN (500, 503));
