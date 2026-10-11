-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › d
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 10
    )
SELECT
    service AS svc,
    toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'UTC') AS d,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM logs.events
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, d
ORDER BY svc_doc_count DESC, svc, d ASC WITH FILL STEP INTERVAL 1 HOUR;
