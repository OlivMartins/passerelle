-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE multiSearchAnyCaseInsensitive(host, ['WEB-1', 'ÉLAN']);
