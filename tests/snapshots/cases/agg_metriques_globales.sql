-- Couverture : 4 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    count(latency_ms) AS st_count,
    min(latency_ms) AS st_min,
    max(latency_ms) AS st_max,
    avg(latency_ms) AS st_avg,
    sum(latency_ms) AS st_sum,
    count(bytes) AS es_count,
    min(bytes) AS es_min,
    max(bytes) AS es_max,
    avg(bytes) AS es_avg,
    sum(bytes) AS es_sum,
    varPop(bytes) AS es_variance,
    stddevPop(bytes) AS es_std_deviation,
    sum(bytes * bytes) AS es_sum_of_squares,
    count(user) AS vc,
    avgWeighted(latency_ms, bytes) AS wa
FROM logs.events;
