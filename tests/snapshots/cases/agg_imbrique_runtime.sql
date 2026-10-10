-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › h
WITH
    base AS (
        SELECT
            *,
            lower(host) AS hote
        FROM logs.events
        WHERE NOT startsWith(hote, 'db')
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
    hote AS h,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 3 BY svc;

-- Top hits svc › h › derniers
WITH
    base AS (
        SELECT
            *,
            lower(host) AS hote
        FROM logs.events
        WHERE NOT startsWith(hote, 'db')
    ),
    top_svc AS (
        SELECT
            service AS svc
        FROM base
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 2
    ),
    top_h AS (
        SELECT
            service AS svc,
            hote AS h
        FROM base
        WHERE service IN (SELECT svc FROM top_svc)
        GROUP BY svc, h
        ORDER BY count() DESC, h ASC
        LIMIT 3 BY svc
    )
SELECT
    service AS svc,
    hote AS h,
    *
FROM base
WHERE (service, hote) IN (SELECT svc, h FROM top_h)
ORDER BY svc, h, timestamp DESC
LIMIT 1 BY svc, h;
