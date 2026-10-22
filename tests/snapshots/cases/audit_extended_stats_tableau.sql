-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    sum(length(nums)) AS s_count,
    minArrayOrNull(nums) AS s_min,
    maxArrayOrNull(nums) AS s_max,
    avgArrayOrNull(nums) AS s_avg,
    sumArray(nums) AS s_sum,
    varPopArrayOrNull(nums) AS s_variance,
    stddevPopArrayOrNull(nums) AS s_std_deviation,
    sumArrayOrNull(arrayMap(v -> v * v, nums)) AS s_sum_of_squares
FROM logs.events
WHERE status >= 500;
