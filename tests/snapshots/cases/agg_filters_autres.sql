-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f
SELECT
    f,
    doc_count
FROM (
    SELECT
        [
            countIf(status >= 500),
            countIf(latency_ms > 2000),
            countIf(NOT (status >= 500 OR latency_ms > 2000))
        ] AS doc_count_values
    FROM logs.events
)
ARRAY JOIN
    ['err', 'slow', '_other_'] AS f,
    doc_count_values AS doc_count;
