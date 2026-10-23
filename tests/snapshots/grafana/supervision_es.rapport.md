# Conversion Grafana vers ClickHouse : supervision_es.json

Verdict : **à reprendre**. 13 panneaux convertis (8 prêts, 4 à vérifier, 1 à reprendre), 13 requêtes.

- Variable service : la valeur « All » personnalisée (*) est retirée ; $__conditionalAll lève la condition quand tout est sélectionné.
- Table interrogée : logs.web.

Le tableau de bord converti s’importe dans Grafana (Tableaux de bord > Nouveau > Importer) : choisissez la source ClickHouse demandée. Les requêtes utilisent les macros du plugin ClickHouse ($__timeFilter, $__interval_s, $__conditionalAll) et les variables du tableau de bord.

## Panneaux

| Panneau | Type | Verdict | Points |
|---|---|---|---|
| Requêtes par service | timeseries | prête |  |
| Latence : moyenne et centiles | timeseries | prête |  |
| Octets moyens par requête (bucket script) | timeseries | à vérifier | Division dans un script ; Tranches vides non comblées (time) |
| Octets cumulés et dérivée | timeseries | à vérifier | Tranches vides non comblées (time) |
| Erreurs 5xx | stat | prête |  |
| Hôtes les plus lents | bargauge | prête |  |
| Méthodes et statuts | table | à vérifier | Unique Count |
| Familles de statuts | piechart | prête |  |
| Durée : écart type | timeseries | prête |  |
| Journaux d’erreurs | logs | à vérifier | colonnes du panneau de journaux |
| Derniers documents | table | prête |  |
| Requêtes × 1000 (expression) | timeseries | prête |  |
| Pic de 5xx (ancienne alerte) | graph | à reprendre | alerte du panneau |

## Variables

| Variable | Verdict | Traduction |
|---|---|---|
| service | prête | liste de valeurs |
| methode | prête | liste de valeurs |
| champ | à vérifier | La liste des champs d’Elasticsearch devient celle des colonnes de la table. |
| filtres | à vérifier | Filtres ad hoc : le plugin ClickHouse les ajoute à chaque requête (ClickHouse 22.7 ou plus récent). |

## Annotations

| Annotation | Verdict | Traduction |
|---|---|---|
| Déploiements | prête | requête d’annotations (time, text, tags) |

## Détail

### Requêtes par service

Prête. Panneau timeseries.

**Requête A** — prête, table logs.web.

```sql
SELECT
    time,
    toString(service_name) AS `service_name`,
    doc_count AS `Count`
FROM
(
    WITH
        base AS (
            SELECT
                *
            FROM logs.web
            WHERE $__timeFilter_ms(timestamp)
              AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
              AND service.environment = 'production'
        ),
        top_service_name AS (
            SELECT
                service.name AS service_name
            FROM base
            GROUP BY service_name
            ORDER BY count() DESC, service_name ASC
            LIMIT 5
        )
    SELECT
        service.name AS service_name,
        toStartOfInterval(timestamp, INTERVAL $__interval_s SECOND, 'UTC') AS time,
        count() AS doc_count,
        sum(count()) OVER (PARTITION BY service_name) AS service_name_doc_count
    FROM base
    WHERE service.name IN (SELECT service_name FROM top_service_name)
    GROUP BY service_name, time
    ORDER BY service_name_doc_count DESC, service_name, time ASC WITH FILL
        FROM toStartOfInterval($__fromTime_ms, INTERVAL $__interval_s SECOND, 'UTC')
        TO toStartOfInterval($__toTime_ms, INTERVAL $__interval_s SECOND, 'UTC') + INTERVAL $__interval_s SECOND
        STEP INTERVAL $__interval_s SECOND
)
ORDER BY time, service_name
```

### Latence : moyenne et centiles

Prête. Panneau timeseries.

**Requête A** — prête, table logs.web.

```sql
SELECT
    time,
    m1 AS `Average event.duration`,
    m4[1] AS `p95.0 event.duration`,
    m4[2] AS `p99.0 event.duration`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL 10 MINUTE, 'UTC') AS time,
        count() AS doc_count,
        avgOrNull(event.duration) AS m1,
        arrayMap(v -> if(isNaN(v), NULL, v), quantilesTDigest(0.95, 0.99)(event.duration)) AS m4
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
    GROUP BY time
    ORDER BY time ASC WITH FILL
        FROM toStartOfInterval($__fromTime_ms, INTERVAL 10 MINUTE, 'UTC')
        TO toStartOfInterval($__toTime_ms, INTERVAL 10 MINUTE, 'UTC') + INTERVAL 10 MINUTE
        STEP INTERVAL 10 MINUTE
)
ORDER BY time
```

### Octets moyens par requête (bucket script)

À vérifier. Panneau timeseries.

**Requête A** — à vérifier, table logs.web.

- À vérifier : **Division dans un script** — Le type des opérandes n’est pas connu. Entre deux entiers, Painless fait une division entière (7 / 2 = 3) alors que ClickHouse renvoie 3.5 : il faudrait intDiv(). Renseignez clickhouse.columns pour que le bon opérateur soit choisi.
- À vérifier : **Tranches vides non comblées (time)** — Avec un pipeline d’agrégation, les tranches sans document ne sont pas ajoutées : le calcul porte sur les tranches présentes, alors qu’Elasticsearch compte aussi les tranches vides.

```sql
SELECT
    time,
    m6 AS `Sum http.response.bytes / Count`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL $__interval_s SECOND, 'UTC') AS time,
        count() AS doc_count,
        sum(http.response.bytes / 1024) AS m5,
        m5 / doc_count AS m6
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
    GROUP BY time
    ORDER BY time ASC
)
ORDER BY time
```

### Octets cumulés et dérivée

À vérifier. Panneau timeseries.

**Requête A** — à vérifier, table logs.web.

- À vérifier : **Tranches vides non comblées (time)** — Avec un pipeline d’agrégation, les tranches sans document ne sont pas ajoutées : le calcul porte sur les tranches présentes, alors qu’Elasticsearch compte aussi les tranches vides.

```sql
SELECT
    time,
    m1 AS `Sum http.response.bytes`,
    m2 AS `Cumulative Sum Sum http.response.bytes`,
    m3 AS `Derivative Sum http.response.bytes`,
    m4 AS `Moving Function Sum http.response.bytes`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'UTC') AS time,
        count() AS doc_count,
        sum(http.response.bytes) AS m1,
        sum(m1) OVER (ORDER BY time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS m2,
        m1 - lagInFrame(toNullable(m1), 1) OVER (ORDER BY time ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS m3,
        avg(toNullable(m1)) OVER (ORDER BY time ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS m4
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
    GROUP BY time
    ORDER BY time ASC
)
ORDER BY time
```

### Erreurs 5xx

Prête. Panneau stat.

**Requête A** — prête, table logs.web.

```sql
SELECT
    doc_count AS `Count`
FROM
(
    SELECT
        tout,
        doc_count
    FROM (
        SELECT
            [
                countIf(1)
            ] AS doc_count_values
        FROM logs.web
        WHERE $__timeFilter_ms(timestamp)
          AND http.response.status_code >= 500
          AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
    )
    ARRAY JOIN
        ['tout'] AS tout,
        doc_count_values AS doc_count
)
```

### Hôtes les plus lents

Prête. Panneau bargauge.

**Requête A** — prête, table logs.web.

```sql
SELECT
    host_name,
    m1 AS `Average event.duration`
FROM
(
    SELECT
        host.name AS host_name,
        count() AS doc_count,
        avg(event.duration) AS ordre_m1,
        avg(event.duration) AS m1
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
    GROUP BY host_name
    ORDER BY ordre_m1 DESC, host_name ASC
    LIMIT 10
)
```

### Méthodes et statuts

À vérifier. Panneau table.

**Requête A** — à vérifier, table logs.web.

- À vérifier : **Unique Count** — Elasticsearch estime le nombre de valeurs distinctes (HyperLogLog++) ; ClickHouse le calcule selon la configuration (uniq approché, uniqExact exact).

```sql
SELECT
    http_request_method,
    http_response_status_code,
    doc_count AS `Count`,
    m2 AS `Max event.duration`,
    m3 AS `Unique Count source.ip`
FROM
(
    WITH
        base AS (
            SELECT
                *
            FROM logs.web
            WHERE $__timeFilter_ms(timestamp)
        ),
        top_http_request_method AS (
            SELECT
                http.request.method AS http_request_method
            FROM base
            GROUP BY http_request_method
            ORDER BY http_request_method ASC
            LIMIT 5
        )
    SELECT
        http.request.method AS http_request_method,
        http.response.status_code AS http_response_status_code,
        count() AS doc_count,
        max(event.duration) AS m2,
        uniq(source.ip) AS m3
    FROM base
    WHERE http.request.method IN (SELECT http_request_method FROM top_http_request_method)
    GROUP BY http_request_method, http_response_status_code
    ORDER BY http_request_method ASC, doc_count DESC, http_response_status_code ASC
    LIMIT 10 BY http_request_method
)
```

### Familles de statuts

Prête. Panneau piechart.

**Requête A** — prête, table logs.web.

```sql
SELECT
    filtre,
    doc_count AS `Count`
FROM
(
    SELECT
        filtre,
        doc_count
    FROM (
        SELECT
            [
                countIf(http.response.status_code BETWEEN 200 AND 299),
                countIf(http.response.status_code BETWEEN 400 AND 499),
                countIf(http.response.status_code BETWEEN 500 AND 599)
            ] AS doc_count_values
        FROM logs.web
        WHERE $__timeFilter_ms(timestamp)
    )
    ARRAY JOIN
        ['2xx', '4xx', '5xx'] AS filtre,
        doc_count_values AS doc_count
)
```

### Durée : écart type

Prête. Panneau timeseries.

**Requête A** — prête, table logs.web.

```sql
SELECT
    time,
    m1_avg AS `Avg event.duration`,
    m1_avg + 3 * m1_std_deviation AS `Std Dev Upper event.duration`,
    m1_avg - 3 * m1_std_deviation AS `Std Dev Lower event.duration`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL 1 HOUR, 'UTC') AS time,
        count() AS doc_count,
        count(event.duration) AS m1_count,
        minOrNull(event.duration) AS m1_min,
        maxOrNull(event.duration) AS m1_max,
        avgOrNull(event.duration) AS m1_avg,
        sum(event.duration) AS m1_sum,
        varPopOrNull(event.duration) AS m1_variance,
        stddevPopOrNull(event.duration) AS m1_std_deviation,
        sumOrNull(event.duration * event.duration) AS m1_sum_of_squares
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
    GROUP BY time
    ORDER BY time ASC WITH FILL
        FROM toStartOfInterval($__fromTime_ms, INTERVAL 1 HOUR, 'UTC')
        TO toStartOfInterval($__toTime_ms, INTERVAL 1 HOUR, 'UTC') + INTERVAL 1 HOUR
        STEP INTERVAL 1 HOUR
)
ORDER BY time
```

### Journaux d’erreurs

À vérifier. Panneau logs.

**Requête A** — à vérifier, table logs.web.

- À vérifier : **colonnes du panneau de journaux** — Le plugin lit timestamp, body et level : body vient de message (premier champ de clickhouse.text_fields) ; ajoutez « … AS level » pour colorer les niveaux.

```sql
SELECT
    timestamp AS timestamp,
    message AS body,
    *
FROM
(
    SELECT
        *
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND http.response.status_code >= 500
      AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
    ORDER BY timestamp DESC
    LIMIT 200
)
```

### Derniers documents

Prête. Panneau table.

**Requête A** — prête, table logs.web.

```sql
SELECT
    *
FROM logs.web
WHERE $__timeFilter_ms(timestamp)
  AND startsWith(url.path, '/admin')
ORDER BY timestamp DESC
LIMIT 50
```

### Requêtes × 1000 (expression)

Prête. Panneau timeseries.

**Requête A** — prête, table logs.web.

```sql
SELECT
    time,
    doc_count AS `Count`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL $__interval_s SECOND, 'UTC') AS time,
        count() AS doc_count
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
    GROUP BY time
    ORDER BY time ASC WITH FILL
        FROM toStartOfInterval($__fromTime_ms, INTERVAL $__interval_s SECOND, 'UTC')
        TO toStartOfInterval($__toTime_ms, INTERVAL $__interval_s SECOND, 'UTC') + INTERVAL $__interval_s SECOND
        STEP INTERVAL $__interval_s SECOND
)
ORDER BY time
```

### Pic de 5xx (ancienne alerte)

À reprendre. Panneau graph.

**Requête A** — prête, table logs.web.

- À reprendre : **alerte du panneau** — Les alertes des anciens panneaux Graph se recréent en règles d’alerte Grafana.

```sql
SELECT
    time,
    doc_count AS `Count`
FROM
(
    SELECT
        toStartOfInterval(timestamp, INTERVAL 1 MINUTE, 'UTC') AS time,
        count() AS doc_count
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND http.response.status_code >= 500
    GROUP BY time
    ORDER BY time ASC WITH FILL
        FROM toStartOfInterval($__fromTime_ms, INTERVAL 1 MINUTE, 'UTC')
        TO toStartOfInterval($__toTime_ms, INTERVAL 1 MINUTE, 'UTC') + INTERVAL 1 MINUTE
        STEP INTERVAL 1 MINUTE
)
ORDER BY time
```

### Variable service

```sql
SELECT valeur
FROM
(
    SELECT
        service.name AS valeur,
        count() AS doc_count
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND service.environment = 'production'
    GROUP BY valeur
    ORDER BY valeur ASC
    LIMIT 500
)
```

### Variable methode

```sql
SELECT valeur
FROM
(
    SELECT
        http.request.method AS valeur,
        count() AS doc_count
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
    GROUP BY valeur
    ORDER BY doc_count DESC, valeur ASC
    LIMIT 10
)
```

### Variable champ

```sql
SELECT name
FROM system.columns
WHERE database = 'logs' AND table = 'web'
  AND type LIKE '%String%'
ORDER BY name
```

### Annotation Déploiements

```sql
SELECT
    timestamp AS time,
    message AS text,
    service.name AS tags
FROM
(
    SELECT
        timestamp,
        message,
        service.name
    FROM logs.web
    WHERE $__timeFilter_ms(timestamp)
      AND event.category = 'deployment'
      AND $__conditionalAll(service.name IN (${service:singlequote}), $service)
    ORDER BY timestamp DESC
    LIMIT 10000
)
```
