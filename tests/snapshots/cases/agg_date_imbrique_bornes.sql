-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › d
WITH
    base AS (
        SELECT
            *
        FROM logs.events
        WHERE timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC')
          AND timestamp < parseDateTime64BestEffort('2026-03-10T00:00:00Z', 3, 'UTC')
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
    toStartOfInterval(timestamp, INTERVAL 12 HOUR, 'UTC') AS d,
    count() AS doc_count,
    avgOrNull(latency_ms) AS lat,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM base
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, d
ORDER BY svc_doc_count DESC, svc, d ASC WITH FILL
    FROM toStartOfInterval(parseDateTime64BestEffort('2026-03-08T00:00:00Z', 3, 'UTC'), INTERVAL 12 HOUR, 'UTC')
    TO toStartOfInterval(parseDateTime64BestEffort('2026-03-10T23:59:59Z', 3, 'UTC'), INTERVAL 12 HOUR, 'UTC') + INTERVAL 12 HOUR
    STEP INTERVAL 12 HOUR;
