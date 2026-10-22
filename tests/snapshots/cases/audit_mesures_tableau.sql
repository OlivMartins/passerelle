-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    sum(length(nums)) AS s_count,
    minArrayOrNull(nums) AS s_min,
    maxArrayOrNull(nums) AS s_max,
    avgArrayOrNull(nums) AS s_avg,
    sumArray(nums) AS s_sum
FROM logs.events;
