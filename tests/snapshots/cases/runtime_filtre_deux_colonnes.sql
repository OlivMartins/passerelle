-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation g
WITH
    multiIf(status >= 500 AND level = 'ERROR', 'critique', status >= 400, 'erreur', 'ok') AS gravite
SELECT
    gravite AS g,
    count() AS doc_count
FROM logs.events
WHERE ((status >= 500 AND level = 'ERROR') OR status >= 400)
GROUP BY g
ORDER BY doc_count DESC, g ASC
LIMIT 10;
