-- Couverture : 0 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : geo_distance

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE 2 * 6371008.7714 * asin(sqrt(pow(sin((radians(location.2) - radians(48.8566)) / 2), 2) + cos(radians(48.8566)) * cos(radians(location.2)) * pow(sin((radians(location.1) - radians(2.3522)) / 2), 2))) <= 3000;
