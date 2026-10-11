-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Total (track_total_hits)
WITH
    lowerUTF8(message) AS m
SELECT
    count() AS total
FROM logs.events
WHERE m = 'échec réseau: délai dépassé';
