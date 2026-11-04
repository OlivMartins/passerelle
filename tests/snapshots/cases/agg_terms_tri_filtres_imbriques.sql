-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › f1
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY avgIfOrNull(latency_ms, level = 'ERROR' AND status >= 500) ASC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f2_doc_count,
    avgIfOrNull(latency_ms, status >= 500) AS f2_m
FROM logs.events
WHERE level = 'ERROR'
  AND service IN (SELECT svc FROM top_svc)
GROUP BY svc
ORDER BY svc ASC, doc_count DESC;
