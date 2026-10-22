-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    sum(length(nums)) AS s_count,
    minArray(nums) AS s_min,
    maxArray(nums) AS s_max,
    avgArray(nums) AS s_avg,
    sumArray(nums) AS s_sum,
    quantilesTDigestArray(0.5)(nums) AS p
FROM logs.events
GROUP BY svc
ORDER BY doc_count DESC, svc ASC
LIMIT 10;
