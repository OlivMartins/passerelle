-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc › f
WITH
    top_svc AS (
        SELECT
            service AS svc
        FROM logs.events
        GROUP BY svc
        ORDER BY count() DESC, svc ASC
        LIMIT 2
    )
SELECT
    svc,
    f,
    doc_count
FROM (
    SELECT
        service AS svc,
        [
            countIf(status >= 500),
            countIf(isNull(env))
        ] AS doc_count_values,
        sum(count()) OVER (PARTITION BY svc) AS svc_doc_count
    FROM logs.events
    WHERE service IN (SELECT svc FROM top_svc)
    GROUP BY svc
)
ARRAY JOIN
    ['err', 'sans_env'] AS f,
    doc_count_values AS doc_count
ORDER BY svc_doc_count DESC, svc, indexOf(['err', 'sans_env'], f) ASC;
