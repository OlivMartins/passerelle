-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
SELECT
    uniq(latency_ms) AS c,
    quantilesTDigest(0.5, 0.95, 0.99)(latency_ms) AS p,
    round(100 * countIf(latency_ms <= 100) / count(latency_ms), 3) AS rangs_100,
    round(100 * countIf(latency_ms <= 1500) / count(latency_ms), 3) AS rangs_1500
FROM logs.events;
