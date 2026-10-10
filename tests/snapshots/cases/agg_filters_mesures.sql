-- Couverture : 5 directs, 0 à vérifier, 0 à reprendre

-- Agrégation f
SELECT
    f,
    doc_count,
    moy,
    n
FROM (
    SELECT
        [
            countIf(status >= 500),
            countIf(latency_ms > 2000),
            countIf(level = 'AUCUN'),
            countIf(NOT (status >= 500 OR latency_ms > 2000 OR level = 'AUCUN'))
        ] AS doc_count_values,
        [
            avgIfOrNull(bytes, status >= 500),
            avgIfOrNull(bytes, latency_ms > 2000),
            avgIfOrNull(bytes, level = 'AUCUN'),
            avgIfOrNull(bytes, NOT (status >= 500 OR latency_ms > 2000 OR level = 'AUCUN'))
        ] AS moy_values,
        [
            countIf(env, status >= 500),
            countIf(env, latency_ms > 2000),
            countIf(env, level = 'AUCUN'),
            countIf(env, NOT (status >= 500 OR latency_ms > 2000 OR level = 'AUCUN'))
        ] AS n_values
    FROM logs.events
)
ARRAY JOIN
    ['err', 'lent', 'aucun', 'reste'] AS f,
    doc_count_values AS doc_count,
    moy_values AS moy,
    n_values AS n;
