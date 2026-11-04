-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    countIf(status >= 500) AS f_doc_count,
    avgIfOrNull(latency_ms, status >= 500) AS f_m
FROM logs.events
GROUP BY svc
ORDER BY f_m DESC, svc ASC
LIMIT 2;

-- Agrégation svc › h
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY avgIfOrNull(latency_ms, status >= 500) DESC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc ASC, doc_count DESC, h ASC
LIMIT 2 BY svc;
