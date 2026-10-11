-- Couverture : 3 directs, 0 à vérifier, 0 à reprendre

-- Agrégation c
SELECT
    service AS svc,
    host AS h,
    count() AS doc_count
FROM logs.events
WHERE (
         svc > 'cart'
      OR (svc = 'cart' AND h > 'web-3')
  )
GROUP BY svc, h
ORDER BY svc ASC, h ASC
LIMIT 10;
