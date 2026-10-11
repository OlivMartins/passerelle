-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Mesures globales
WITH
    latency_ms / 2.0 AS moitie
SELECT
    maxOrNull(moitie) AS m,
    sum(moitie) AS s
FROM logs.events;
