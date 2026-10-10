-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › h
WITH
    lower(host) AS hote
SELECT
    service AS svc,
    hote AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM logs.events
WHERE hote NOT IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_9d8e1e49ee4e')
  AND isNotNull(hote)
  AND service IN (
    SELECT
        service AS svc
    FROM logs.events
    WHERE hote NOT IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_9d8e1e49ee4e')
    GROUP BY svc
    ORDER BY count() DESC, svc ASC
    LIMIT 3
)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;
