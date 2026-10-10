-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › r
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE status >= 300
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
    svc,
    r,
    doc_count,
    moy
FROM (
    SELECT
        service AS svc,
        [
            countIf(latency_ms < 500),
            countIf(latency_ms >= 500 AND latency_ms < 2000),
            countIf(latency_ms >= 2000 AND latency_ms < 2500),
            countIf(latency_ms >= 9000)
        ] AS doc_count_values,
        [
            avgIfOrNull(bytes, latency_ms < 500),
            avgIfOrNull(bytes, latency_ms >= 500 AND latency_ms < 2000),
            avgIfOrNull(bytes, latency_ms >= 2000 AND latency_ms < 2500),
            avgIfOrNull(bytes, latency_ms >= 9000)
        ] AS moy_values,
        sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
    FROM base
    WHERE service IN (SELECT svc FROM top_svc)
    GROUP BY svc
)
ARRAY JOIN
    ['*-500.0', '500.0-2000.0', '2000.0-2500.0', '9000.0-*'] AS r,
    doc_count_values AS doc_count,
    moy_values AS moy
ORDER BY svc_doc_count DESC, svc, indexOf(['*-500.0', '500.0-2000.0', '2000.0-2500.0', '9000.0-*'], r) ASC;
