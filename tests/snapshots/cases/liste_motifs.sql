-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE multiSearchAny(host, ['eb-1', 'lan', 'b_0']);
