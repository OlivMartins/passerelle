-- Couverture : 10 directs, 0 à vérifier, 0 à reprendre

-- Agrégation par_heure
WITH
    toHour(toTimeZone(timestamp, 'Europe/Paris')) AS heure_locale,
    multiIf(isNull(latency_ms), NULL, latency_ms < 100, 'rapide', latency_ms < 1000, 'normal', 'lent') AS classe_latence
SELECT
    heure_locale AS par_heure,
    count() AS doc_count,
    countIf(classe_latence = 'lent') AS lentes_doc_count,
    maxIfOrNull(latency_ms, classe_latence = 'lent') AS lentes_lat_max
FROM logs.events
WHERE timestamp >= toStartOfDay(now('UTC') - INTERVAL 7 DAY)
  AND isNotNull(heure_locale)
GROUP BY par_heure
ORDER BY par_heure ASC
LIMIT 24;

-- Agrégation par_heure › par_classe
WITH
    toHour(toTimeZone(timestamp, 'Europe/Paris')) AS heure_locale,
    multiIf(isNull(latency_ms), NULL, latency_ms < 100, 'rapide', latency_ms < 1000, 'normal', 'lent') AS classe_latence
SELECT
    heure_locale AS par_heure,
    classe_latence AS par_classe,
    count() AS doc_count
FROM logs.events
WHERE timestamp >= toStartOfDay(now('UTC') - INTERVAL 7 DAY)
  AND isNotNull(heure_locale)
  AND isNotNull(classe_latence)
  AND heure_locale IN (
    SELECT
        heure_locale AS par_heure
    FROM logs.events
    WHERE timestamp >= toStartOfDay(now('UTC') - INTERVAL 7 DAY)
      AND isNotNull(heure_locale)
    GROUP BY par_heure
    ORDER BY par_heure ASC
    LIMIT 24
)
GROUP BY par_heure, par_classe
ORDER BY par_heure ASC, doc_count DESC, par_classe ASC
LIMIT 3 BY par_heure;
