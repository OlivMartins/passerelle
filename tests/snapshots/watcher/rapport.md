# Migration des watches Elasticsearch vers ClickHouse

Source : watches.json, console.txt.

10 watches à migrer (dont 2 désactivées), 9 requêtes traduites, 7 conditions traduites en décision SQL. Effort estimé : **16,75 h**, soit **2,4 jours** à 7 h.

1 watch de Stack Monitoring, sans objet après la migration : non comptée.

## Synthèse

| Watches | Prêtes | À vérifier | À reprendre | Non reconnues | Effort |
|---:|---:|---:|---:|---:|---:|
| 10 | 4 | 3 | 3 | 0 | 16,75 h |

*Prête* : requête et condition traduites directement. *À vérifier* : traduites, avec un écart de comportement à confirmer. *À reprendre* : une partie ne se traduit pas et s’écrit à la main. Dans tous les cas, la planification et les notifications se recréent dans l’outil d’alerte cible.

Actions à recréer : 1 index, 3 journal, 3 e-mail, 2 webhook, 1 Slack, 1 PagerDuty.

## Principaux points à reprendre

| Point | Watches | Effort |
|---|---:|---:|
| référence à une entrée précédente | 1 | 1 h |
| modèle de recherche stocké | 1 | 1 h |
| entrée http | 1 | 1 h |

## Watches

| Watch | État | Planification | Condition | Actions | Verdict | Effort |
|---|---|---|---|---|---|---:|
| Ancien export des réponses volumineuses | désactivée | toutes les heures | au moins un des éléments de hits.hits : _source.http.response.bytes ≥ 4000 | index | à vérifier | 1,5 h |
| Connexions refusées | active | tous les jours à 08:00, 18:30 (UTC) | hits.total.value > 0 (script) | journal | à vérifier | 1,5 h |
| Durée maximale par hôte | active | toutes les minutes | au moins un des éléments de aggregations.bucketAgg.buckets : metricAgg.value > 800000000 (seuil de l’interface Watcher) | journal | prête | 1,25 h |
| Échecs de connexion répétés | active | toutes les heures, à la minute 0, 30 (UTC) | taille de echecs.aggregations.utilisateurs.buckets > 0 (script) | e-mail | à reprendre | 2,25 h |
| Erreurs lentes sur le paiement | active | cron Quartz « 0 0/5 8-19 ? * MON-FRI » (UTC) | aggregations.duree_max.value ≥ 900000000 (script) | webhook | à vérifier | 1,5 h |
| fin-de-mois | désactivée | cron Quartz « 0 0 6 L * ? » | always (toujours vraie) | journal | à reprendre | 2,5 h |
| Latence moyenne par service | active | cron Quartz « 0 0/10 * * * ? » (UTC) | au moins un des éléments de aggregations.services.buckets : latence.value ≥ 500000000 | webhook | prête | 1,25 h |
| Pic d’erreurs 5xx | active | toutes les 5 minutes | hits.total > 20 | e-mail, Slack | prête | 1,5 h |
| Rapport hebdomadaire des pages | active | chaque lundi à 07:00 (UTC) | always (toujours vraie) | e-mail | prête | 1,25 h |
| Santé du cluster Elasticsearch | active | toutes les minutes | status ≠ « green » | PagerDuty | à reprendre | 2,25 h |
| X-Pack Monitoring: Cluster Status | sans objet | toutes les minutes | — | — | sans objet | 0 h |

## Exécuter les requêtes

Les requêtes attendent {scheduled_time:String}, l’heure prévue de l’exécution, connue à l’exécution seulement. Le planificateur la fournit à chaque passage : `--param_scheduled_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"` avec clickhouse-client, `param_scheduled_time=…` dans l’URL de l’interface HTTP. {key:String} : valeur lue dans le résultat d’une entrée précédente, à fournir par l’outil qui enchaîne les requêtes.

## Détail par watch

### Ancien export des réponses volumineuses

À vérifier, 1,5 h. Watch JSON, désactivée. Identifiant : `ancien-export`. Index : logs-web-*. Table : logs.web.

- **Planification** : toutes les heures — cron `0 * * * *`.
- **Entrée** : search.
- **Condition** : au moins un des éléments de hits.hits : _source.http.response.bytes ≥ 4000.

À vérifier :
- **action index** : L’action archive écrit dans l’index Elasticsearch export-panier : à remplacer (table ClickHouse, ou rien) selon l’usage de cet index.

À noter :
- **intervalle** : Un intervalle Watcher part de l’activation de la watch ; le cron proposé (0 * * * *) est aligné sur l’horloge.
- **modèle de recherche** : L’entrée : les paramètres du modèle (service, taille) sont remplacés par leur valeur avant la traduction.
- **1 action à recréer** : archive : index (index export-panier). Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.
- **watch désactivée** : La watch est désactivée : migrez-la seulement si elle sert encore.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-1h, garde les documents où service.name = panier, et renvoie 100 documents triés par timestamp (décroissant).

```sql
-- Documents
SELECT
    *
FROM logs.web
WHERE service.name = 'panier'
  AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 1 HOUR
ORDER BY timestamp DESC
LIMIT 100;
```

**Condition** — décision. Décision : au moins un des éléments de hits.hits : _source.http.response.bytes ≥ 4000.

```sql
-- Condition : au moins un des éléments de hits.hits : _source.http.response.bytes ≥ 4000
SELECT
    countIf(ifNull(http.response.bytes >= 4000, 0)) > 0 AS declenchee,
    countIf(ifNull(http.response.bytes >= 4000, 0)) AS documents_au_seuil,
    count() AS documents
FROM
(
    SELECT
        *
    FROM logs.web
    WHERE service.name = 'panier'
      AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 1 HOUR
    ORDER BY timestamp DESC
    LIMIT 100
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- 1 action à recréer : 0,25 h
- action index : 0,25 h

</details>

### Connexions refusées

À vérifier, 1,5 h. Watch JSON, active. Identifiant : `connexions-refusees`. Index : logs-web-*. Table : logs.web.

- **Planification** : tous les jours à 08:00, 18:30 (UTC) — cron `0 8 * * *` ; `30 18 * * *`.
- **Entrée** : search.
- **Condition** : hits.total.value > 0 (script).

À vérifier :
- **hits.total.value dans une watch** : Dans une watch, hits.total est un entier (rest_total_hits_as_int vaut true par défaut) : ctx.payload.hits.total.value est vide, et la condition d’origine ne se déclenche jamais (sauf not_eq). La traduction suit l’intention, le nombre de documents : vérifiez l’historique de la watch (status.last_met_condition).

À noter :
- **1 action à recréer** : journal : journal (niveau warn), avec hits.total. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-1d, garde les documents où message contient « connection refused ».

```sql
-- Comptage
SELECT
    count() AS count
FROM logs.web
WHERE hasToken(lowerUTF8(message), 'connection')
  AND hasToken(lowerUTF8(message), 'refused')
  AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])connection[^\\p{L}\\p{N}]+refused(?:$|[^\\p{L}\\p{N}_])')
  AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 1 DAY;
```

**Condition** — décision. Décision : hits.total.value > 0 (script).

```sql
-- Condition : hits.total.value > 0 (script)
SELECT
    *,
    count > 0 AS declenchee
FROM
(
    SELECT
        count() AS count
    FROM logs.web
    WHERE hasToken(lowerUTF8(message), 'connection')
      AND hasToken(lowerUTF8(message), 'refused')
      AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])connection[^\\p{L}\\p{N}]+refused(?:$|[^\\p{L}\\p{N}_])')
      AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 1 DAY
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- hits.total.value dans une watch : 0,25 h
- 1 action à recréer : 0,25 h

</details>

### Durée maximale par hôte

Prête, 1,25 h. Seuil (interface Watcher de Kibana), active. Identifiant : `6f1d0c2e-5b7a-4c1e-9e0d-3a2b1c4d5e6f`. Index : logs-web-*. Table : logs.web.

- **Planification** : toutes les minutes — cron `* * * * *`.
- **Entrée** : search.
- **Condition** : au moins un des éléments de aggregations.bucketAgg.buckets : metricAgg.value > 800000000 (seuil de l’interface Watcher).

À noter :
- **intervalle** : Un intervalle Watcher part de l’activation de la watch ; le cron proposé (* * * * *) est aligné sur l’horloge.
- **1 action à recréer** : logging_1 : journal (niveau info). Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-5m et ≤ {{ctx.trigger.scheduled_time}}, regroupe par host.name (5 premiers), avec maximum de event.duration.

```sql
-- Agrégation bucketAgg
SELECT
    host.name AS bucketAgg,
    count() AS doc_count,
    max(event.duration) AS metricAgg
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE
  AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
GROUP BY bucketAgg
ORDER BY metricAgg DESC, bucketAgg ASC
LIMIT 5;
```

**Condition** — décision. Décision : au moins un des éléments de aggregations.bucketAgg.buckets : metricAgg.value > 800000000 (seuil de l’interface Watcher).

```sql
-- Condition : au moins un des éléments de aggregations.bucketAgg.buckets : metricAgg.value > 800000000 (seuil de l’interface Watcher)
SELECT
    countIf(ifNull(metricAgg > 800000000, 0)) > 0 AS declenchee,
    countIf(ifNull(metricAgg > 800000000, 0)) AS groupes_au_seuil,
    count() AS groupes
FROM
(
    SELECT
        host.name AS bucketAgg,
        count() AS doc_count,
        max(event.duration) AS metricAgg
    FROM logs.web
    WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE
      AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
    GROUP BY bucketAgg
    ORDER BY metricAgg DESC, bucketAgg ASC
    LIMIT 5
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- 1 action à recréer : 0,25 h

</details>

### Échecs de connexion répétés

À reprendre, 2,25 h. Watch JSON, active. Identifiant : `echecs-de-connexion`. Index : logs-web-*. Table : logs.web.

- **Planification** : toutes les heures, à la minute 0, 30 (UTC) — cron `0,30 * * * *`.
- **Entrée** : echecs (search), detail (search).
- **Condition** : taille de echecs.aggregations.utilisateurs.buckets > 0 (script).

À reprendre :
- **référence à une entrée précédente** : L’entrée « detail » se sert du résultat d’une entrée précédente ({{ctx.payload.…}}) : la valeur devient un paramètre, à fournir par l’outil qui enchaîne les requêtes.

À noter :
- **1 action à recréer** : securite : e-mail (1 destinataire, objet « Échecs de connexion répétés : {{ctx.payload.echecs.aggregations.utilisateurs.buc »), avec echecs.aggregations.utilisateurs.buckets.0.key. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Entrée « echecs »** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-30m, garde les documents où event.category = authentication, event.outcome = failure, puis regroupe par user.name (20 premiers).

```sql
-- Agrégation utilisateurs
SELECT
    user.name AS utilisateurs,
    count() AS doc_count
FROM logs.web
WHERE event.category = 'authentication'
  AND event.outcome = 'failure'
  AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 30 MINUTE
GROUP BY utilisateurs
HAVING doc_count >= 5
ORDER BY doc_count DESC, utilisateurs ASC
LIMIT 20;
```

**Entrée « detail »** — prête, couverture 100 %. Garde les documents où user.name = {{ctx.payload.echecs.aggregations.utilisateurs.buckets.0.key}}, et renvoie 20 documents triés par timestamp (décroissant).

```sql
-- Documents
SELECT
    *
FROM logs.web
WHERE user.name = {key:String}
ORDER BY timestamp DESC
LIMIT 20;
```

**Condition** — décision. Décision : taille de echecs.aggregations.utilisateurs.buckets > 0 (script).

```sql
-- Condition : taille de echecs.aggregations.utilisateurs.buckets > 0 (script)
SELECT
    count() > 0 AS declenchee,
    count() AS groupes
FROM
(
    SELECT
        user.name AS utilisateurs,
        count() AS doc_count
    FROM logs.web
    WHERE event.category = 'authentication'
      AND event.outcome = 'failure'
      AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 30 MINUTE
    GROUP BY utilisateurs
    HAVING doc_count >= 5
    ORDER BY doc_count DESC, utilisateurs ASC
    LIMIT 20
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- référence à une entrée précédente : 1 h
- 1 action à recréer : 0,25 h

</details>

### Erreurs lentes sur le paiement

À vérifier, 1,5 h. Watch JSON, active. Identifiant : `erreurs-paiement`. Index : logs-web-*. Table : logs.web.

- **Planification** : cron Quartz « 0 0/5 8-19 ? * MON-FRI » (UTC) — cron `*/5 8-19 * * MON-FRI`.
- **Entrée** : search.
- **Condition** : aggregations.duree_max.value ≥ 900000000 (script).

À vérifier :
- **index en date math** : <logs-web-{now/d}> désigne l’index du jour de l’exécution ; la traduction lit logs-web-*, c’est-à-dire toute la table : la fenêtre de temps de la requête doit suffire à limiter la lecture.

À noter :
- **1 action à recréer** : equipe_paiement : webhook (POST https://hooks.exemple.fr/paiement), avec aggregations.duree_max.value. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-5m, garde les documents où url.path = /api/paiement, http.response.status_code ≥ 500, puis calcule maximum de event.duration.

```sql
-- Mesures globales
SELECT
    maxOrNull(event.duration) AS duree_max
FROM logs.web
WHERE url.path = '/api/paiement'
  AND http.response.status_code >= 500
  AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE;
```

**Condition** — décision. Décision : aggregations.duree_max.value ≥ 900000000 (script).

```sql
-- Condition : aggregations.duree_max.value ≥ 900000000 (script)
SELECT
    *,
    ifNull(duree_max >= 900000000, 0) AS declenchee
FROM
(
    SELECT
        maxOrNull(event.duration) AS duree_max
    FROM logs.web
    WHERE url.path = '/api/paiement'
      AND http.response.status_code >= 500
      AND timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- index en date math : 0,25 h
- 1 action à recréer : 0,25 h

</details>

### fin-de-mois

À reprendre, 2,5 h. Watch JSON, désactivée. Identifiant : `fin-de-mois`.

- **Planification** : cron Quartz « 0 0 6 L * ? ».
- **Entrée** : search.
- **Condition** : always (toujours vraie).

À reprendre :
- **modèle de recherche stocké** : L’entrée lit le modèle de recherche « volumes-mensuels », qui n’est pas dans la watch : exportez-le (GET _scripts/volumes-mensuels) et placez sa source dans la watch.

À vérifier :
- **cron Quartz** : « 0 0 6 L * ? » emploie L, W ou # (dernier jour, jour ouvré le plus proche, n-ième jour du mois) : à reproduire à la main

À noter :
- **condition toujours vraie** : Les actions partent à chaque exécution : la requête traduite fournit les données de la notification.
- **1 action à recréer** : journal : journal (niveau info). Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.
- **watch désactivée** : La watch est désactivée : migrez-la seulement si elle sert encore.

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- cron Quartz : 0,25 h
- modèle de recherche stocké : 1 h
- 1 action à recréer : 0,25 h

</details>

### Latence moyenne par service

Prête, 1,25 h. Watch JSON, active. Identifiant : `latence-par-service`. Index : logs-web-*. Table : logs.web.

- **Planification** : cron Quartz « 0 0/10 * * * ? » (UTC) — cron `*/10 * * * *`.
- **Entrée** : search.
- **Condition** : au moins un des éléments de aggregations.services.buckets : latence.value ≥ 500000000.

À noter :
- **1 action à recréer** : astreinte : webhook (POST https://alertes.exemple.fr:443/hooks/latence), avec aggregations.services.buckets. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-15m et ≤ {{ctx.trigger.scheduled_time}}, regroupe par service.name (10 premiers), avec moyenne de event.duration.

```sql
-- Agrégation services
SELECT
    service.name AS services,
    count() AS doc_count,
    avg(event.duration) AS latence
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 15 MINUTE
  AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
GROUP BY services
ORDER BY doc_count DESC, services ASC
LIMIT 10;
```

**Condition** — décision. Décision : au moins un des éléments de aggregations.services.buckets : latence.value ≥ 500000000.

```sql
-- Condition : au moins un des éléments de aggregations.services.buckets : latence.value ≥ 500000000
SELECT
    countIf(ifNull(latence >= 500000000, 0)) > 0 AS declenchee,
    countIf(ifNull(latence >= 500000000, 0)) AS groupes_au_seuil,
    count() AS groupes
FROM
(
    SELECT
        service.name AS services,
        count() AS doc_count,
        avg(event.duration) AS latence
    FROM logs.web
    WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 15 MINUTE
      AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
    GROUP BY services
    ORDER BY doc_count DESC, services ASC
    LIMIT 10
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- 1 action à recréer : 0,25 h

</details>

### Pic d’erreurs 5xx

Prête, 1,5 h. Watch JSON, active. Identifiant : `erreurs-5xx`. Index : logs-web-*. Table : logs.web.

- **Planification** : toutes les 5 minutes — cron `*/5 * * * *`.
- **Entrée** : search.
- **Condition** : hits.total > 20.
- **Condition remplie pour la dernière fois** : 2026-10-27T08:10:00.000Z.

À noter :
- **intervalle** : Un intervalle Watcher part de l’activation de la watch ; le cron proposé (*/5 * * * *) est aligné sur l’horloge.
- **2 actions à recréer** : equipe_ops : e-mail (1 destinataire, objet « {{ctx.payload.hits.total}} erreurs 5xx en 5 minutes »), relance au plus toutes les 15m, avec hits.total ; canal_slack : Slack (compte par défaut, vers #exploitation), avec hits.total. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-5m et ≤ {{ctx.trigger.scheduled_time}}, garde les documents où http.response.status_code ≥ 500, service.environment = production.

```sql
-- Comptage
SELECT
    count() AS count
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE
  AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
  AND http.response.status_code >= 500
  AND service.environment = 'production';
```

**Condition** — décision. Décision : hits.total > 20.

```sql
-- Condition : hits.total > 20
SELECT
    *,
    count > 20 AS declenchee
FROM
(
    SELECT
        count() AS count
    FROM logs.web
    WHERE timestamp >= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 5 MINUTE
      AND timestamp <= parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC')
      AND http.response.status_code >= 500
      AND service.environment = 'production'
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- 2 actions à recréer : 0,5 h

</details>

### Rapport hebdomadaire des pages

Prête, 1,25 h. Watch JSON, active. Identifiant : `rapport-hebdo`. Index : logs-web-*. Table : logs.web.

- **Planification** : chaque lundi à 07:00 (UTC) — cron `0 7 * * 1`.
- **Entrée** : search.
- **Condition** : always (toujours vraie).

À noter :
- **condition toujours vraie** : Les actions partent à chaque exécution : la requête traduite fournit les données de la notification.
- **1 action à recréer** : direction : e-mail (2 destinataires, objet « Pages les plus vues de la semaine »), avec aggregations.pages.buckets. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.

**Recherche** — prête, couverture 100 %. Sur @timestamp ≥ {{ctx.trigger.scheduled_time}}||-7d/d et < {{ctx.trigger.scheduled_time}}||/d, regroupe par url.path (5 premiers).

```sql
-- Agrégation pages
SELECT
    url.path AS pages,
    count() AS doc_count
FROM logs.web
WHERE timestamp >= toStartOfDay(parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC') - INTERVAL 7 DAY)
  AND timestamp < toStartOfDay(parseDateTime64BestEffort({scheduled_time:String}, 3, 'UTC'))
GROUP BY pages
ORDER BY doc_count DESC, pages ASC
LIMIT 5;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- 1 action à recréer : 0,25 h

</details>

### Santé du cluster Elasticsearch

À reprendre, 2,25 h. Watch JSON, active. Identifiant : `sante-cluster`.

- **Planification** : toutes les minutes — cron `* * * * *`.
- **Entrée** : http.
- **Condition** : status ≠ « green ».

À reprendre :
- **entrée http** : L’entrée appelle localhost:9200/_cluster/health (état du cluster Elasticsearch : sans équivalent après la migration ; la santé de ClickHouse se lit dans ses tables system.*) : la donnée surveillée se récupère autrement dans l’outil cible.

À noter :
- **intervalle** : Un intervalle Watcher part de l’activation de la watch ; le cron proposé (* * * * *) est aligné sur l’horloge.
- **condition sur une entrée non traduite** : La condition (status ≠ « green ») lit une valeur de l’entrée http, qui n’a pas de traduction SQL : elle se recrée avec cette entrée.
- **1 action à recréer** : astreinte : PagerDuty (compte astreinte), avec cluster_name, status. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.
- **throttle_period** : Une notification au plus toutes les 30m : à reproduire (Grafana : intervalle de répétition de la politique de notification).

<details><summary>Calcul de l’effort</summary>

- Recréer l’alerte (planification, condition, notifications) : 1 h
- entrée http : 1 h
- 1 action à recréer : 0,25 h

</details>

### X-Pack Monitoring: Cluster Status

Sans objet. Stack Monitoring, sans objet. Identifiant : `kQ7fW3aZTGa0b1c2d3e4fA_elasticsearch_cluster_status`.

- **Planification** : toutes les minutes — cron `* * * * *`.

À noter :
- **alerte de Stack Monitoring** : Watch créée par la supervision d’Elasticsearch (alertes de cluster) : elle surveille le cluster Elasticsearch lui-même et disparaît avec lui. Sans objet pour la migration.

## Barème de l’effort

Recréer une alerte (planification, condition, notifications) : 1 h, plus 0,25 h par action. Vérifier une requête : 0,25 h si elle est à vérifier, 0,5 h si elle est à reprendre, plus 0,25 h par point à vérifier. Point à reprendre : visualisation Vega 6 h ; classeur Canvas 6 h ; carte 4 h ; TSVB ou Timelion 3 h ; requête ES|QL ou EQL 3 h ; logique de détection 4 h ; script Painless 2 h ; agrégation, mesure ou formule 1,5 h ; 1 h pour une clause ou un paramètre. Total arrondi au quart d’heure supérieur par watch ; un jour vaut 7 h.
