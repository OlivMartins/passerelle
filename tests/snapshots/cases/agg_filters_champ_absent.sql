-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f
SELECT
    f,
    doc_count
FROM (
    SELECT
        [
            countIf(env = 'prod'),
            countIf((env != 'prod' OR env IS NULL))
        ] AS doc_count_values
    FROM logs.events
)
ARRAY JOIN
    ['prod', '_other_'] AS f,
    doc_count_values AS doc_count;
