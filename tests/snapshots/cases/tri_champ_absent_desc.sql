-- Couverture : 0 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
ORDER BY user DESC, timestamp ASC
LIMIT 30;
