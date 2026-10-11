-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation t › svc
WITH
    top_t AS (
        SELECT
            arrayJoin(tags) AS t
        FROM logs.events
        GROUP BY t
        ORDER BY count() DESC, t ASC
        LIMIT 10
    )
SELECT
    arrayJoin(tags) AS t,
    service AS svc,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY t) AS t_doc_count
FROM logs.events
WHERE arrayJoin(tags) IN (SELECT t FROM top_t)
GROUP BY t, svc
ORDER BY t_doc_count DESC, t, doc_count DESC, svc ASC
LIMIT 2 BY t;
