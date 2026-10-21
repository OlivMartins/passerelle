-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    count(nums) AS s_count,
    minOrNull(nums) AS s_min,
    maxOrNull(nums) AS s_max,
    avgOrNull(nums) AS s_avg,
    sum(nums) AS s_sum
FROM logs.events;
