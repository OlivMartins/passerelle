-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    count(latency_ms) AS st_count,
    minOrNull(latency_ms) AS st_min,
    maxOrNull(latency_ms) AS st_max,
    avgOrNull(latency_ms) AS st_avg,
    sum(latency_ms) AS st_sum,
    count(bytes) AS es_count,
    minOrNull(bytes) AS es_min,
    maxOrNull(bytes) AS es_max,
    avgOrNull(bytes) AS es_avg,
    sum(bytes) AS es_sum,
    varPopOrNull(bytes) AS es_variance,
    stddevPopOrNull(bytes) AS es_std_deviation,
    sumOrNull(bytes * bytes) AS es_sum_of_squares,
    count(user) AS vc,
    avgWeightedOrNull(latency_ms, bytes) AS wa
FROM logs.events;
