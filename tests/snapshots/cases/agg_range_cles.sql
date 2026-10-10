-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    r,
    doc_count
FROM (
    SELECT
        [
            countIf(latency_ms < 100),
            countIf(latency_ms >= 100 AND latency_ms < 3000)
        ] AS doc_count_values
    FROM logs.events
)
ARRAY JOIN
    ['*-100.0', '100.0-3000.0'] AS r,
    doc_count_values AS doc_count;
