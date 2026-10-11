-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE ifNull(env = 'prod', 0) + (level = 'ERROR') + (latency_ms >= 2000) >= 2;
