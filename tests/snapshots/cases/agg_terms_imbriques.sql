-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › h
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count,
    avg(latency_ms) AS lat,
    sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
FROM logs.events
WHERE service IN (
    SELECT
        service AS svc
    FROM logs.events
    GROUP BY svc
    ORDER BY count() DESC, svc ASC
    LIMIT 3
)
GROUP BY svc, h
ORDER BY svc_doc_count DESC, svc, doc_count DESC, h ASC
LIMIT 2 BY svc;
