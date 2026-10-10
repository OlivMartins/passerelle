-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation e
WITH
    if(lowerUTF8(host) = lowerUTF8('ÉLAN-1'), 'oui', 'non') AS elan
SELECT
    elan AS e,
    count() AS doc_count
FROM logs.events
GROUP BY e
ORDER BY doc_count DESC, e ASC
LIMIT 10;
