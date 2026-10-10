-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › d › h
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
    toStartOfDay(timestamp, 'UTC') AS d,
    host AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, d, h
ORDER BY svc_doc_count DESC, svc, d ASC, doc_count DESC, h ASC
LIMIT 2 BY svc, d;
