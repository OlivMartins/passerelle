-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation t
SELECT
    arrayJoin(if(empty(tags), ['aucun'], tags)) AS t,
    count() AS doc_count
FROM logs.events
GROUP BY t
ORDER BY doc_count DESC, t ASC
LIMIT 10;
