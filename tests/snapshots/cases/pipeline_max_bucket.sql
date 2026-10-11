-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    sum(bytes) AS s
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;

-- Pipeline mx
SELECT
    max(s) AS mx,
    argMax(svc, s) AS mx_key
FROM (
    SELECT
        service AS svc,
        count() AS doc_count,
        sum(bytes) AS s
    FROM logs.events
    GROUP BY svc
    ORDER BY doc_count DESC, svc ASC
    LIMIT 10
);
