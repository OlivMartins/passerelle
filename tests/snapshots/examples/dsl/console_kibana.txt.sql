-- Couverture : 10 directs, 0 à vérifier, 0 à reprendre

-- Agrégation par_heure
WITH
    toHour(toTimeZone(timestamp, 'Europe/Paris')) AS heure_locale
SELECT
    heure_locale AS par_heure,
    count() AS doc_count,
    countIf(isNotNull(latency_ms) AND latency_ms >= 1000) AS lentes_doc_count,
    maxIfOrNull(latency_ms, isNotNull(latency_ms) AND latency_ms >= 1000) AS lentes_lat_max
FROM logs.events
WHERE timestamp >= toStartOfDay(now('UTC') - INTERVAL 7 DAY)
GROUP BY par_heure
ORDER BY par_heure ASC
LIMIT 24;

-- Agrégation par_heure › par_classe
WITH
    base AS (
        SELECT
            *,
            toHour(toTimeZone(timestamp, 'Europe/Paris')) AS heure_locale,
            multiIf(isNull(latency_ms), NULL, latency_ms < 100, 'rapide', latency_ms < 1000, 'normal', 'lent') AS classe_latence
        FROM logs.events
        WHERE timestamp >= toStartOfDay(now('UTC') - INTERVAL 7 DAY)
    ),
    top_par_heure AS (
        SELECT
            heure_locale AS par_heure
        FROM base
        GROUP BY par_heure
        ORDER BY par_heure ASC
        LIMIT 24
    )
SELECT
    heure_locale AS par_heure,
    classe_latence AS par_classe,
    count() AS doc_count
FROM base
WHERE isNotNull(classe_latence)
  AND heure_locale IN (SELECT par_heure FROM top_par_heure)
GROUP BY par_heure, par_classe
ORDER BY par_heure ASC, doc_count DESC, par_classe ASC
LIMIT 3 BY par_heure;
