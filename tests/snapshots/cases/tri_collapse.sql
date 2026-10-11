-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
ORDER BY timestamp DESC
LIMIT 1 BY host
LIMIT 5;
