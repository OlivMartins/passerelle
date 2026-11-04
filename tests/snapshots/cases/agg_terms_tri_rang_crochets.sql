-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation svc
SELECT
    service AS svc,
    count() AS doc_count,
    round(100 * countIf(latency_ms <= 1500.5) / count(latency_ms), 3) AS r_1500_5
FROM logs.events
GROUP BY svc
ORDER BY r_1500_5 ASC, svc ASC
LIMIT 1;
