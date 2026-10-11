-- Couverture : 4 directs, 0 à vérifier, 1 à reprendre
-- À reprendre : pipeline max_bucket non traduit

-- Agrégation svc › h
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE status >= 400
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
    host AS h,
    count() AS doc_count,
    sum(bytes) AS s,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 3 BY svc;
