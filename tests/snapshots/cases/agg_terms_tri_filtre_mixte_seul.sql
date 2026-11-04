-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › f › h
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY countIf(status >= 500) DESC, svc ASC
        LIMIT 2
    )
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE status >= 500
  AND service IN (SELECT svc FROM top_svc)
GROUP BY svc, h
ORDER BY svc ASC, doc_count DESC, h ASC
LIMIT 2 BY svc;
