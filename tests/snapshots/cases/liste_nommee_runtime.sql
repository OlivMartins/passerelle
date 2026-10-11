-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › h
WITH
    base AS (
        SELECT
            *,
            lowerUTF8(host) AS hote
        FROM logs.events
        WHERE hote NOT IN (SELECT value FROM logs.passerelle_lists WHERE name = 'l_9d8e1e49ee4e')
    ),
    top_svc AS (
        SELECT
            service AS svc
        FROM base
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 3
    )
SELECT
    service AS svc,
    hote AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;
