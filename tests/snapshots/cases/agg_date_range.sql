-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    r,
    doc_count
FROM (
    SELECT
        [
            countIf(timestamp < parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC')),
            countIf(timestamp >= parseDateTime64BestEffort('2026-03-09T00:00:00Z', 3, 'UTC') AND timestamp < parseDateTime64BestEffort('2026-03-10', 3, 'UTC')),
            countIf(timestamp >= toStartOfDay(parseDateTime64BestEffort('2026-03-10', 3, 'UTC'))),
            countIf(timestamp >= parseDateTime64BestEffort('2027-01-01', 3, 'UTC'))
        ] AS doc_count_values
    FROM logs.events
)
ARRAY JOIN
    ['avant', 'pendant', 'apres', 'jamais'] AS r,
    doc_count_values AS doc_count;
