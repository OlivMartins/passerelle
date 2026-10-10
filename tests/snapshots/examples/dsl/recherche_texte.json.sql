-- Couverture : 6 directs, 0 à vérifier, 0 à reprendre
-- À vérifier : Schéma des colonnes non fourni

-- Documents
SELECT
    timestamp,
    service.name,
    message,
    trace.id
FROM logs.events
WHERE (hasTokenCaseInsensitive(message, 'timeout') OR (hasTokenCaseInsensitive(message, 'connection') AND hasTokenCaseInsensitive(message, 'reset') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])connection[^\\p{L}\\p{N}]+reset(?:$|[^\\p{L}\\p{N}_])')))
  AND level != 'DEBUG'
  AND timestamp >= now() - INTERVAL 15 MINUTE
  AND startsWith(host.name, 'web-')
ORDER BY timestamp DESC
LIMIT 1 BY trace.id
LIMIT 50;

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE (hasTokenCaseInsensitive(message, 'timeout') OR (hasTokenCaseInsensitive(message, 'connection') AND hasTokenCaseInsensitive(message, 'reset') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])connection[^\\p{L}\\p{N}]+reset(?:$|[^\\p{L}\\p{N}_])')))
  AND level != 'DEBUG'
  AND timestamp >= now() - INTERVAL 15 MINUTE
  AND startsWith(host.name, 'web-');
