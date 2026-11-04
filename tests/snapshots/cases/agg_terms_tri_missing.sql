-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › absent
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY avgIfOrNull(latency_ms, isNull(env)) DESC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    count() AS doc_count,
    avg(latency_ms) AS m
FROM logs.events
WHERE isNull(env)
  AND service IN (SELECT svc FROM top_svc)
GROUP BY svc
ORDER BY svc ASC, doc_count DESC;
