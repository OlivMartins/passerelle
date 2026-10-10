-- Couverture : 7 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r
SELECT
    r,
    doc_count,
    moy,
    mx,
    s,
    err_doc_count,
    err_lat
FROM (
    SELECT
        [
            countIf(latency_ms < 100),
            countIf(latency_ms >= 100 AND latency_ms < 3000),
            countIf(latency_ms >= 5000)
        ] AS doc_count_values,
        [
            avgIfOrNull(bytes, latency_ms < 100),
            avgIfOrNull(bytes, latency_ms >= 100 AND latency_ms < 3000),
            avgIfOrNull(bytes, latency_ms >= 5000)
        ] AS moy_values,
        [
            maxIfOrNull(bytes, latency_ms < 100),
            maxIfOrNull(bytes, latency_ms >= 100 AND latency_ms < 3000),
            maxIfOrNull(bytes, latency_ms >= 5000)
        ] AS mx_values,
        [
            sumIf(bytes, latency_ms < 100),
            sumIf(bytes, latency_ms >= 100 AND latency_ms < 3000),
            sumIf(bytes, latency_ms >= 5000)
        ] AS s_values,
        [
            countIf(status >= 500 AND latency_ms < 100),
            countIf(status >= 500 AND latency_ms >= 100 AND latency_ms < 3000),
            countIf(status >= 500 AND latency_ms >= 5000)
        ] AS err_doc_count_values,
        [
            avgIfOrNull(latency_ms, status >= 500 AND latency_ms < 100),
            avgIfOrNull(latency_ms, status >= 500 AND latency_ms >= 100 AND latency_ms < 3000),
            avgIfOrNull(latency_ms, status >= 500 AND latency_ms >= 5000)
        ] AS err_lat_values
    FROM logs.events
)
ARRAY JOIN
    ['bas', 'milieu', 'haut'] AS r,
    doc_count_values AS doc_count,
    moy_values AS moy,
    mx_values AS mx,
    s_values AS s,
    err_doc_count_values AS err_doc_count,
    err_lat_values AS err_lat;
