-- Couverture : 6 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › h
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE timestamp >= parseDateTime64BestEffort('2026-03-08T12:00:00Z', 3, 'UTC')
          AND (env != 'staging' OR env IS NULL)
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
    avg(latency_ms) AS lat,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;

-- Agrégation svc › h › m
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE timestamp >= parseDateTime64BestEffort('2026-03-08T12:00:00Z', 3, 'UTC')
          AND (env != 'staging' OR env IS NULL)
    ),
    top_svc AS (
        SELECT
            service AS svc
        FROM base
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 3
    ),
    top_h AS (
        SELECT
            service AS svc,
            host AS h
        FROM base
        WHERE service IN (SELECT svc FROM top_svc)
        GROUP BY svc, h
        ORDER BY count() DESC, h ASC
        LIMIT 2 BY svc
    )
SELECT
    service AS svc,
    host AS h,
    http.method AS m,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count,
    sum(count()) OVER (PARTITION BY svc, h) AS h_doc_count
FROM base
WHERE (service, host) IN (SELECT svc, h FROM top_h)
GROUP BY svc, h, m
ORDER BY svc_doc_count DESC, svc, h_doc_count DESC, h, doc_count DESC, m ASC
LIMIT 2 BY svc, h;
