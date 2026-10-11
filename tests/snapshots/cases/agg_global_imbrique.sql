-- Couverture : 6 directs, 0 à vérifier, 0 à reprendre

-- Agrégation tous › svc › h
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM logs.events
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;

-- Agrégation svc › h
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE level = 'ERROR'
    ),
    top_svc AS (
        SELECT
            service AS svc
        FROM base
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;
