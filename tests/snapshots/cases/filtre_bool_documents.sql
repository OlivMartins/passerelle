-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Documents
SELECT
    *
FROM logs.events
WHERE level = 'ERROR'
  AND status >= 500
ORDER BY timestamp DESC
LIMIT 20;
