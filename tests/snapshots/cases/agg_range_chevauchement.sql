-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    r,
    doc_count
FROM (
    SELECT
        [
            countIf(latency_ms >= 0),
            countIf(latency_ms >= 1000),
            countIf(latency_ms >= 2500)
        ] AS doc_count_values
    FROM logs.events
)
ARRAY JOIN
    ['tout', 'lent', 'tres_lent'] AS r,
    doc_count_values AS doc_count;
