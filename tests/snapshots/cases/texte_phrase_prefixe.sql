-- Couverture : 0 directs, 1 à vérifier, 0 à reprendre
-- À vérifier : match_phrase_prefix approximé

-- Total (track_total_hits)
SELECT
    count() AS total
FROM logs.events
WHERE message ILIKE '%connection res%';
