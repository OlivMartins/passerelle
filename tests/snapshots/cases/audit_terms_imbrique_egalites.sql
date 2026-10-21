-- Couverture : 2 directs, 0 à vérifier, 0 à reprendre

-- Agrégation r › lvl
WITH
    top_r AS (
        SELECT
            retries AS r
        FROM logs.events
        WHERE isNotNull(retries)
        GROUP BY r
        ORDER BY count() DESC, r ASC
        LIMIT 2
    )
SELECT
    retries AS r,
    level AS lvl,
    count() AS doc_count,
    sum(count()) OVER (PARTITION BY r) AS r_doc_count
FROM logs.events
WHERE isNotNull(retries)
  AND retries IN (SELECT r FROM top_r)
GROUP BY r, lvl
ORDER BY r_doc_count DESC, r, doc_count DESC, lvl ASC
LIMIT 2 BY r;
