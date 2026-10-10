-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 3;

-- Top hits svc › derniers
SELECT
    service AS svc,
    *
FROM logs.events
WHERE service IN (
    SELECT
        service AS svc
    FROM logs.events
    GROUP BY svc
    ORDER BY count() DESC, svc ASC
    LIMIT 3
)
ORDER BY svc, timestamp DESC
LIMIT 2 BY svc;
