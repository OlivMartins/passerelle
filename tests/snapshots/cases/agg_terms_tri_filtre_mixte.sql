-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › f
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY avgIfOrNull(latency_ms, level = 'ERROR') DESC NULLS FIRST, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    count() AS doc_count,
    avg(latency_ms) AS m
FROM logs.events
WHERE level = 'ERROR'
  AND service IN (SELECT svc FROM top_svc)
GROUP BY svc
ORDER BY svc ASC, doc_count DESC;

-- Agrégation svc › f › h
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY avgIfOrNull(latency_ms, level = 'ERROR') DESC NULLS FIRST, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE level = 'ERROR'
  AND service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc ASC, doc_count DESC, h ASC
LIMIT 2 BY svc;
