-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › lvl › st
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 3
    ),
    top_lvl AS (
        SELECT
            service AS svc,
            level AS lvl
        FROM logs.events
        WHERE service IN (SELECT svc FROM top_svc)
        GROUP BY svc, lvl
        ORDER BY count() DESC, lvl ASC
        LIMIT 2 BY svc
    )
SELECT
    service AS svc,
    level AS lvl,
    status AS st,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count,
    sum(count()) OVER (PARTITION BY svc, lvl) AS lvl_doc_count
FROM logs.events
WHERE (service, level) IN (SELECT svc, lvl FROM top_lvl)
GROUP BY svc, lvl, st
ORDER BY svc_doc_count DESC, svc, lvl_doc_count DESC, lvl, doc_count DESC, st ASC
LIMIT 2 BY svc, lvl;
