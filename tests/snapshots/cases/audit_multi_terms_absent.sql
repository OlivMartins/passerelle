-- Couverture : 1 directs, 0 à vérifier, 0 à reprendre

-- Agrégation m
SELECT
    service AS m_service,
    env AS m_env,
    count() AS doc_count
FROM logs.events
WHERE isNotNull(env)
GROUP BY m_service, m_env
ORDER BY doc_count DESC, m_service ASC, m_env ASC
LIMIT 30;
