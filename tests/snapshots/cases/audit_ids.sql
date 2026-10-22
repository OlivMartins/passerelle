-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Champ _id

-- Documents
SELECT
    *
FROM logs.events
WHERE _id IN ('3', '10', '2999', 'abc')
ORDER BY timestamp ASC
LIMIT 5;
