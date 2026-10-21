-- Couverture : 0 directs, 0 à vérifier, 1 à reprendre
-- À reprendre : search_after à sens mixtes non traduit

-- Documents
SELECT
    *
FROM logs.events
ORDER BY timestamp DESC, host ASC
LIMIT 10;
