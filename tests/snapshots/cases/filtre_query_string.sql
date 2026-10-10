-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE status BETWEEN 500 AND 599 AND service != 'api' AND hasToken(lowerUTF8(message), 'timeout');
