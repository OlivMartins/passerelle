-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE host IN ('web-1', 'web-2', 'web-3', 'Web-A', 'élan-1', 'inconnu')
  AND status NOT IN (404, 503);
