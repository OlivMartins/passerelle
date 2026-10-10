-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    r,
    doc_count,
    envs
FROM (
    SELECT
        [
            countIf(bytes < 50000),
            countIf(bytes >= 50000)
        ] AS doc_count_values,
        [
            uniqIf(env, bytes < 50000),
            uniqIf(env, bytes >= 50000)
        ] AS envs_values
    FROM logs.events
)
ARRAY JOIN
    ['*-50000.0', '50000.0-*'] AS r,
    doc_count_values AS doc_count,
    envs_values AS envs;
