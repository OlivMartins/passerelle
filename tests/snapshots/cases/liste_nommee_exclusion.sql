-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE status IN (SELECT toInt64(value) FROM logs.passerelle_lists WHERE name = 'l_bf2f9ecd5e8b')
  AND host NOT IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_c70cbd66b3c3');
