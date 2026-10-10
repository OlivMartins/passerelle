-- Couverture : 9 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Schéma des colonnes non fourni

-- Agrégation par_service
SELECT
    service.name AS par_service,
    count() AS doc_count,
    uniq(client.ip) AS clients_uniques
FROM logs.events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND timestamp <= now()
  AND http.response.status_code >= 500
  AND service.name IN ('checkout', 'payment', 'cart')
  AND env != 'staging'
GROUP BY par_service
ORDER BY doc_count DESC, par_service ASC
LIMIT 10;

-- Agrégation par_service › par_heure
SELECT
    service.name AS par_service,
    toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'Europe/Paris') AS par_heure,
    count() AS doc_count,
    quantilesTDigest(0.95)(latency_ms) AS latence_p95,
    avgOrNull(latency_ms) AS latence_moy,
    sum(count()) OVER (PARTITION BY par_service) AS par_service_doc_count
FROM logs.events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND timestamp <= now()
  AND http.response.status_code >= 500
  AND service.name IN ('checkout', 'payment', 'cart')
  AND env != 'staging'
  AND service.name IN (
    SELECT
        service.name AS par_service
    FROM logs.events
    WHERE timestamp >= now() - INTERVAL 24 HOUR
      AND timestamp <= now()
      AND http.response.status_code >= 500
      AND service.name IN ('checkout', 'payment', 'cart')
      AND env != 'staging'
    GROUP BY par_service
    ORDER BY count() DESC, par_service ASC
    LIMIT 10
)
GROUP BY par_service, par_heure
ORDER BY par_service_doc_count DESC, par_service, par_heure ASC WITH FILL STEP INTERVAL 1 HOUR;
