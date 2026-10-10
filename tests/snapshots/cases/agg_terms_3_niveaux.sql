-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › lvl › st
SELECT
    service AS svc,
    level AS lvl,
    status AS st,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count,
    sum(count()) OVER (PARTITION BY svc, lvl) AS lvl_doc_count
FROM logs.events
WHERE (service, level) IN (
    SELECT
        service AS svc,
        level AS lvl
    FROM logs.events
    WHERE service IN (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 3
    )
    GROUP BY svc, lvl
    ORDER BY count() DESC, lvl ASC
    LIMIT 2 BY svc
)
GROUP BY svc, lvl, st
ORDER BY svc_doc_count DESC, svc, lvl_doc_count DESC, lvl, doc_count DESC, st ASC
LIMIT 2 BY svc, lvl;
