# Inventaire de migration Kibana vers ClickHouse

25 objets à migrer, 21 requêtes traduites. Effort estimé : **37,25 h**, soit **5,3 jours** à 7 h.

Non comptés (sans requête à migrer) : 1 tag, 1 config.

## Synthèse

| Type | Objets | Prêts | À vérifier | À reprendre | Non reconnus | Effort |
|---|---:|---:|---:|---:|---:|---:|
| Vue de données | 1 | 1 | 0 | 0 | 0 | 0,25 h |
| Recherche | 2 | 1 | 0 | 1 | 0 | 3,5 h |
| Visualisation | 7 | 4 | 2 | 1 | 0 | 11 h |
| Lens | 5 | 2 | 2 | 1 | 0 | 4,5 h |
| Carte | 1 | 0 | 0 | 1 | 0 | 4,5 h |
| Tableau de bord | 1 | 0 | 0 | 1 | 0 | 2 h |
| Règle d’alerte | 3 | 3 | 0 | 0 | 0 | 3,5 h |
| Règle de détection | 3 | 0 | 2 | 1 | 0 | 7,5 h |
| Connecteur | 2 | 2 | 0 | 0 | 0 | 0,5 h |
| **Total** | **25** | **13** | **6** | **6** | **0** | **37,25 h** |

*Prête* : traduction directe. *À vérifier* : traduite, avec un écart de comportement à confirmer. *À reprendre* : une partie ne se traduit pas et s’écrit à la main. *Non reconnue* : objet que Passerelle ne lit pas.

## Principaux points à reprendre

| Point | Objets | Effort |
|---|---:|---:|
| visualisation Vega | 1 | 6 h |
| carte (Maps) | 1 | 4 h |
| règle de détection eql | 1 | 4 h |
| recherche ES\|QL | 1 | 3 h |
| décalage temporel (time shift) | 1 | 1 h |

## Tableaux de bord

| Tableau de bord | Panneaux | Verdict | Effort, panneaux compris |
|---|---:|---|---:|
| Supervision du site web | 11 | à reprendre | 10,75 h |

L’effort d’un tableau de bord compte ses panneaux ; un objet partagé par plusieurs tableaux de bord est compté dans chacun ici, une seule fois dans le total.

## Objets

| Type | Objet | Nature | Verdict | Effort |
|---|---|---|---|---:|
| Vue de données | logs-web-* | champ de temps @timestamp | prête | 0,25 h |
| Recherche | Enquête délais d’attente | Discover, 2 onglets | à reprendre | 3,25 h |
| Recherche | Erreurs 5xx récentes | Discover | prête | 0,25 h |
| Visualisation | Carte des sessions (Vega) | Vega | à reprendre | 6,5 h |
| Visualisation | Chemins en erreur | secteurs, depuis une recherche | prête | 0,5 h |
| Visualisation | Débit sortant par hôte (TSVB) | TSVB timeseries | à vérifier | 1,5 h |
| Visualisation | Latence moyenne et p95 par heure | courbes | prête | 0,5 h |
| Visualisation | Mode d’emploi | Markdown | prête | 0,5 h |
| Visualisation | Requêtes par service | barres verticales | à vérifier | 1 h |
| Visualisation | Supervision du site web › Panneau 11 | Markdown | prête | 0,5 h |
| Lens | Erreurs : aujourd’hui contre hier | métrique | à reprendre | 1,5 h |
| Lens | Requêtes par seconde et par méthode | graphique XY | à vérifier | 1,25 h |
| Lens | Taux d’erreur (formule) | métrique | prête | 0,5 h |
| Lens | Utilisateurs les plus actifs | tableau | à vérifier | 0,75 h |
| Lens | Supervision du site web › Codes d’erreur | secteurs | prête | 0,5 h |
| Carte | Origine des visiteurs | Maps | à reprendre | 4,5 h |
| Tableau de bord | Supervision du site web | 11 panneaux, période now-24h → now | à reprendre | 2 h |
| Règle d’alerte | Latence moyenne par service | .index-threshold | prête | 1 h |
| Règle d’alerte | Pic d’erreurs 5xx | .es-query | prête | 1,5 h |
| Règle d’alerte | Requête Elasticsearch : connexions refusées | .es-query, désactivée | prête | 1 h |
| Règle de détection | Accès à l’administration | query | à vérifier | 1,25 h |
| Règle de détection | Connexion puis export massif | eql | à reprendre | 5 h |
| Règle de détection | Connexions refusées en rafale | threshold | à vérifier | 1,25 h |
| Connecteur | Canal #web-ops | .slack | prête | 0,25 h |
| Connecteur | Courriel de l’astreinte | .email | prête | 0,25 h |

## Champs cités, par vue de données

- **logs-web-*** → logs.web : 17 objets. @timestamp (17), http.response.status_code (7), service.name (7), url.path (6), service.environment (4), event.duration (3), message (3), source.ip (2), user.name (2), event.category (1), event.outcome (1), host.name (1), http.request.method (1), http.response.bytes (1), statut_classe (1).

## Détail par objet

### Vue de données : logs-web-*

Prête, 0,25 h. champ de temps @timestamp. Identifiant : `9c1f0a2e-0000-4000-8000-00000000d001`. Vue de données : logs-web-*. Table : logs.web.

**Champs calculés (1)** — prête, couverture 100 %. Renvoie 10 documents triés par timestamp (décroissant).

```sql
-- Documents
WITH
    multiIf(isNull(http.response.status_code), 'inconnu', http.response.status_code >= 500, 'erreur', 'ok') AS statut_classe
SELECT
    statut_classe
FROM logs.web
ORDER BY timestamp DESC
LIMIT 10;
```

### Recherche : Enquête délais d’attente

À reprendre, 3,25 h. Discover, 2 onglets. Identifiant : `9c1f0a2e-0000-4000-8000-00000000s002`. Vue de données : logs-web-*. Table : logs.web.

À reprendre :
- **recherche ES|QL** : Une recherche ES|QL se réécrit en SQL ClickHouse. Requête : FROM logs-web-* | WHERE http.response.status_code >= 500 | STATS n = COUNT(*) BY service.name

**Onglet « Délais »** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où message contient « timeout » ou message contient « délai dépassé », et renvoie 100 documents triés par timestamp (décroissant).

```sql
-- Documents
SELECT
    timestamp,
    service.name,
    message
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND (hasToken(lowerUTF8(message), 'timeout') OR (hasToken(lowerUTF8(message), 'délai') AND hasToken(lowerUTF8(message), 'dépassé') AND match(message, '(?i)(?:^|[^\\p{L}\\p{N}_])délai[^\\p{L}\\p{N}]+dépassé(?:$|[^\\p{L}\\p{N}_])')))
ORDER BY timestamp DESC
LIMIT 100;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (recherche) : 0,25 h
- recherche ES|QL : 3 h

</details>

### Recherche : Erreurs 5xx récentes

Prête, 0,25 h. Discover. Identifiant : `9c1f0a2e-0000-4000-8000-00000000s001`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

**Documents** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où http.response.status_code ≥ 500, service.name = checkout, sauf url.path = /health, et renvoie 500 documents triés par timestamp (décroissant).

```sql
-- Documents
SELECT
    timestamp,
    service.name,
    url.path,
    http.response.status_code,
    message
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND http.response.status_code >= 500
  AND url.path != '/health'
  AND service.name = 'checkout'
ORDER BY timestamp DESC
LIMIT 500;
```

### Visualisation : Carte des sessions (Vega)

À reprendre, 6,5 h. Vega. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v005`.

À reprendre :
- **visualisation Vega** : Une spécification Vega embarque ses propres requêtes Elasticsearch : le graphique se recrée dans l’outil cible et ses requêtes se réécrivent en SQL.

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (visualisation) : 0,5 h
- visualisation Vega : 6 h

</details>

### Visualisation : Chemins en erreur

Prête, 0,5 h. secteurs, depuis une recherche. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v003`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où http.response.status_code ≥ 500, service.name = checkout, sauf url.path = /health, puis regroupe par url.path (10 premiers).

```sql
-- Agrégation url_path
SELECT
    url.path AS url_path,
    count() AS doc_count
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND http.response.status_code >= 500
  AND url.path != '/health'
  AND service.name = 'checkout'
GROUP BY url_path
ORDER BY doc_count DESC, url_path ASC
LIMIT 10;
```

### Visualisation : Débit sortant par hôte (TSVB)

À vérifier, 1,5 h. TSVB timeseries. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v004`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

À vérifier :
- **intervalle automatique** : Kibana calcule l’intervalle d’après la période affichée. La traduction retient 30m, l’intervalle de la période par défaut du tableau de bord (1 j) ; dans Grafana, $__interval le recalcule à chaque affichage.
- **dernière tranche écartée (TSVB)** : TSVB masque par défaut la dernière tranche, incomplète ; le SQL la renvoie.

**Octets par tranche** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où service.environment = production, puis regroupe par host.name (5 premiers), puis par tranche de 30 min, avec somme de http.response.bytes, somme de http.response.bytes.

```sql
-- Agrégation host_name
SELECT
    host.name AS host_name,
    count() AS doc_count,
    sum(http.response.bytes) AS ordre_sum
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND service.environment = 'production'
GROUP BY host_name
ORDER BY ordre_sum DESC, host_name ASC
LIMIT 5;

-- Agrégation host_name › periode
WITH
    base AS (
        SELECT
            *
        FROM logs.web
        WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
          AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
          AND service.environment = 'production'
    ),
    top_host_name AS (
        SELECT
            host.name AS host_name
        FROM base
        GROUP BY host_name
        ORDER BY sum(http.response.bytes) DESC, host_name ASC
        LIMIT 5
    )
SELECT
    host.name AS host_name,
    toStartOfInterval(timestamp, INTERVAL 30 MINUTE, 'Europe/Paris') AS periode,
    count() AS doc_count,
    sum(http.response.bytes) AS sum
FROM base
WHERE host.name IN (SELECT host_name FROM top_host_name)
GROUP BY host_name, periode
ORDER BY host_name ASC, periode ASC WITH FILL
    FROM toStartOfInterval(parseDateTime64BestEffort({time_from:String}, 3, 'Europe/Paris'), INTERVAL 30 MINUTE, 'Europe/Paris')
    TO toStartOfInterval(parseDateTime64BestEffort({time_to:String}, 3, 'Europe/Paris'), INTERVAL 30 MINUTE, 'Europe/Paris') + INTERVAL 30 MINUTE
    STEP INTERVAL 30 MINUTE;
```

**Taux d’erreur** — à vérifier, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où service.environment = production, puis regroupe par tranche de 30 min.

- À vérifier : **Tranches vides non comblées (periode)** — Avec un pipeline d’agrégation, les tranches sans document ne sont pas ajoutées : le calcul porte sur les tranches présentes, alors qu’Elasticsearch compte aussi les tranches vides.

```sql
-- Agrégation periode
SELECT
    toStartOfInterval(timestamp, INTERVAL 30 MINUTE, 'Europe/Paris') AS periode,
    count() AS doc_count,
    countIf(http.response.status_code >= 500) AS numerateur_doc_count,
    countIf(1) AS denominateur_doc_count,
    if(denominateur_doc_count > 0, numerateur_doc_count / denominateur_doc_count, 0) AS filter_ratio
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND service.environment = 'production'
GROUP BY periode
ORDER BY periode ASC;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (visualisation) : 0,5 h
- Vérifier « Taux d’erreur » (à vérifier) : 0,25 h
- Points à vérifier de « Taux d’erreur » : 0,25 h
- intervalle automatique : 0,25 h
- dernière tranche écartée (TSVB) : 0,25 h

</details>

### Visualisation : Latence moyenne et p95 par heure

Prête, 0,5 h. courbes. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v002`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où service.name = checkout ou service.name = panier, puis regroupe par heure, avec moyenne de event.duration, percentiles de event.duration.

```sql
-- Agrégation periode
SELECT
    toStartOfHour(timestamp, 'Europe/Paris') AS periode,
    count() AS doc_count,
    avg(event.duration) AS Latence_moyenne,
    quantilesTDigest(0.95)(event.duration) AS percentiles_event_duration
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND service.name IN ('checkout', 'panier')
GROUP BY periode
ORDER BY periode ASC;
```

### Visualisation : Mode d’emploi

Prête, 0,5 h. Markdown. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v006`.

### Visualisation : Requêtes par service

À vérifier, 1 h. barres verticales. Identifiant : `9c1f0a2e-0000-4000-8000-00000000v001`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

À vérifier :
- **intervalle automatique** : Kibana calcule l’intervalle d’après la période affichée. La traduction retient 30m, l’intervalle de la période par défaut du tableau de bord (1 j) ; dans Grafana, $__interval le recalcule à chaque affichage.
- **groupe « Autres »** : Kibana ajoute le groupe des valeurs hors du top par une seconde requête (filters) ; la traduction renvoie le top seul.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, regroupe par tranche de 30 min, puis par service.name (5 premiers).

```sql
-- Agrégation periode › service_name
SELECT
    toStartOfInterval(timestamp, INTERVAL 30 MINUTE, 'Europe/Paris') AS periode,
    service.name AS service_name,
    count() AS doc_count
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
GROUP BY periode, service_name
ORDER BY periode ASC, doc_count DESC, service_name ASC
LIMIT 5 BY periode;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (visualisation) : 0,5 h
- intervalle automatique : 0,25 h
- groupe « Autres » : 0,25 h

</details>

### Visualisation : Supervision du site web › Panneau 11

Prête, 0,5 h. Markdown. Identifiant : `9c1f0a2e-0000-4000-8000-00000000d101/pv2`.

### Lens : Erreurs : aujourd’hui contre hier

À reprendre, 1,5 h. métrique. Identifiant : `9c1f0a2e-0000-4000-8000-00000000l004`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

À reprendre :
- **décalage temporel (time shift)** : « Erreurs hier » compare à la période décalée de 1d : une seconde requête sur cette période est nécessaire.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où http.response.status_code ≥ 500.

```sql
-- Comptage
SELECT
    count() AS count
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND http.response.status_code >= 500;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (lens) : 0,5 h
- décalage temporel (time shift) : 1 h

</details>

### Lens : Requêtes par seconde et par méthode

À vérifier, 1,25 h. graphique XY. Identifiant : `9c1f0a2e-0000-4000-8000-00000000l001`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

À vérifier :
- **taux par unité de temps aux bords** : Lens ramène les deux tranches des bords de la période à leur partie affichée ; rate divise par la tranche entière : seules ces deux tranches diffèrent.
- **groupe « Autres »** : Lens ajoute le groupe des valeurs hors du top par une seconde requête ; la traduction renvoie le top seul.
- **intervalle automatique** : Kibana calcule l’intervalle d’après la période affichée. La traduction retient 30m, l’intervalle de la période par défaut du tableau de bord (1 j) ; dans Grafana, $__interval le recalcule à chaque affichage.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, regroupe par tranche de 30 min, puis par http.request.method (4 premiers), avec taux de documents par seconde.

```sql
-- Agrégation periode › http_request_method
SELECT
    toStartOfInterval(timestamp, INTERVAL 30 MINUTE, 'Europe/Paris') AS periode,
    http.request.method AS http_request_method,
    count() AS doc_count,
    count() / 1800 AS Requetes_par_seconde
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
GROUP BY periode, http_request_method
ORDER BY periode ASC, Requetes_par_seconde DESC, http_request_method ASC
LIMIT 4 BY periode;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (lens) : 0,5 h
- taux par unité de temps aux bords : 0,25 h
- groupe « Autres » : 0,25 h
- intervalle automatique : 0,25 h

</details>

### Lens : Taux d’erreur (formule)

Prête, 0,5 h. métrique. Identifiant : `9c1f0a2e-0000-4000-8000-00000000l002`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, regroupe par filtres (tout).

```sql
-- Agrégation tout
SELECT
    arrayJoin(arrayFilter(x -> x != '', [if(1, 'tout', '')])) AS tout,
    count() AS doc_count,
    countIf(http.response.status_code >= 500) AS filtre_Part_de_Taux_d_erreur_doc_count,
    filtre_Part_de_Taux_d_erreur_doc_count / doc_count AS Taux_d_erreur
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
GROUP BY tout
ORDER BY indexOf(['tout'], tout) ASC;
```

### Lens : Utilisateurs les plus actifs

À vérifier, 0,75 h. tableau. Identifiant : `9c1f0a2e-0000-4000-8000-00000000l003`. Vue de données : logs-web-*. Table : logs.web. Utilisé par 1 tableau de bord.

À vérifier :
- **nombre de valeurs distinctes** : Elasticsearch l’estime (HyperLogLog++, exact jusqu’à 3 000 valeurs) ; ClickHouse le calcule selon la configuration (uniqExact exact, uniq approché).

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, écarte user.name = -, puis regroupe par user.name (10 premiers), avec nombre distinct de source.ip, dernière valeur de ?.

```sql
-- Agrégation user_name
SELECT
    user.name AS user_name,
    count() AS doc_count,
    uniq(source.ip) AS Adresses_IP_distinctes,
    argMax(url.path, timestamp) AS Dernier_chemin
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
  AND user.name != '-'
GROUP BY user_name
ORDER BY Adresses_IP_distinctes DESC, user_name ASC
LIMIT 10;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (lens) : 0,5 h
- nombre de valeurs distinctes : 0,25 h

</details>

### Lens : Supervision du site web › Codes d’erreur

Prête, 0,5 h. secteurs. Identifiant : `9c1f0a2e-0000-4000-8000-00000000d101/pv1`. Vue de données : logs-web-*. Table : logs.web.

**Requête** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, garde les documents où service.environment = production, sauf url.path = /health, puis regroupe par plages de http.response.status_code.

```sql
-- Agrégation http_response_status_code
SELECT
    http_response_status_code,
    doc_count
FROM (
    SELECT
        [
            countIf(http.response.status_code >= 400 AND http.response.status_code < 500),
            countIf(http.response.status_code >= 500 AND http.response.status_code < 600)
        ] AS doc_count_values
    FROM logs.web
    WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
      AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
      AND service.environment = 'production'
      AND url.path != '/health'
)
ARRAY JOIN
    ['4xx', '5xx'] AS http_response_status_code,
    doc_count_values AS doc_count;
```

### Carte : Origine des visiteurs

À reprendre, 4,5 h. Maps. Identifiant : `9c1f0a2e-0000-4000-8000-00000000m001`.

À reprendre :
- **carte (Maps)** : Une carte de l’application Maps (couches, documents, grilles, jointures) se recrée dans l’outil cible (Geomap de Grafana) ; ses requêtes se réécrivent en SQL.

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (carte) : 0,5 h
- carte (Maps) : 4 h

</details>

### Tableau de bord : Supervision du site web

À reprendre, 2 h. 11 panneaux, période now-24h → now. Identifiant : `9c1f0a2e-0000-4000-8000-00000000d101`. Vue de données : logs-web-*. Table : logs.web.

À vérifier :
- **filtre commun du tableau de bord** : Le tableau de bord ajoute sa requête et ses filtres à chaque panneau. Ils sont inclus dans le SQL des panneaux par valeur ; pour les panneaux par référence, ajoutez la condition ci-dessous à leur requête (ou recréez-la en variable).

**Filtre commun** — prête, couverture 100 %. Garde les documents où service.environment = production, sauf url.path = /health.

```sql
-- Comptage
SELECT
    count() AS count
FROM logs.web
WHERE service.environment = 'production'
  AND url.path != '/health';
```

**Contrôle « Service »** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, regroupe par service.name (100 premiers).

```sql
-- Agrégation valeurs
SELECT
    service.name AS valeurs,
    count() AS doc_count
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC')
GROUP BY valeurs
ORDER BY doc_count DESC, valeurs ASC
LIMIT 100;
```

**Contrôle « Durée »** — prête, couverture 100 %. Sur @timestamp ≥ {{time_from}} et ≤ {{time_to}}, calcule minimum de event.duration, maximum de event.duration.

```sql
-- Mesures globales
SELECT
    minOrNull(event.duration) AS minimum,
    maxOrNull(event.duration) AS maximum
FROM logs.web
WHERE timestamp >= parseDateTime64BestEffort({time_from:String}, 3, 'UTC')
  AND timestamp <= parseDateTime64BestEffort({time_to:String}, 3, 'UTC');
```

<details><summary>Calcul de l’effort</summary>

- Recréer le tableau de bord : 0,5 h
- Disposer 11 panneaux : 1,1 h
- filtre commun du tableau de bord : 0,25 h

</details>

### Règle d’alerte : Latence moyenne par service

Prête, 1 h. .index-threshold. Identifiant : `9c1f0a2e-0000-4000-8000-00000000r002`. Vue de données : logs-web-*. Table : logs.web.

À noter :
- **planification** : La règle s’évalue toutes les 5m : à reproduire dans l’outil cible.

**Condition** — prête, couverture 100 %. Sur les 15 dernières minutes, garde les documents où service.environment = production, puis regroupe par service.name (5 premiers), avec moyenne de event.duration.

```sql
-- Agrégation groupe, avec la décision de la règle
SELECT
    *,
    valeur > 500000000 AS declenchee
FROM
(
    SELECT
        service.name AS groupe,
        count() AS doc_count,
        avg(event.duration) AS valeur
    FROM logs.web
    WHERE service.environment = 'production'
      AND timestamp >= now() - INTERVAL 15 MINUTE
    GROUP BY groupe
    ORDER BY valeur DESC, groupe ASC
    LIMIT 5
);
```

### Règle d’alerte : Pic d’erreurs 5xx

Prête, 1,5 h. .es-query. Identifiant : `9c1f0a2e-0000-4000-8000-00000000r001`. Vue de données : logs-web-*. Table : logs.web.

À noter :
- **2 actions à recréer** : Notifications (.email, .slack) à recréer dans l’outil d’alerte cible, avec la planification « toutes les 1m ».

**Condition** — prête, couverture 100 %. Sur les 5 dernières minutes, garde les documents où http.response.status_code ≥ 500.

```sql
-- Comptage, avec la décision de la règle
SELECT
    *,
    count > 100 AS declenchee
FROM
(
    SELECT
        count() AS count
    FROM logs.web
    WHERE http.response.status_code >= 500
      AND timestamp >= now() - INTERVAL 5 MINUTE
);
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (règle d’alerte) : 1 h
- 2 actions à recréer : 0,5 h

</details>

### Règle d’alerte : Requête Elasticsearch : connexions refusées

Prête, 1 h. .es-query, désactivée. Identifiant : `9c1f0a2e-0000-4000-8000-00000000r003`. Vue de données : logs-web-*. Table : logs.web.

À noter :
- **planification** : La règle s’évalue toutes les 5m : à reproduire dans l’outil cible.

**Condition** — prête, couverture 100 %. Sur les 10 dernières minutes, garde les documents où message contient « connection refused ».

```sql
-- Comptage, avec la décision de la règle
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
      AND timestamp >= now() - INTERVAL 10 MINUTE
);
```

### Règle de détection : Accès à l’administration

À vérifier, 1,25 h. query. Identifiant : `web-admin-access`. Vue de données : logs-web-*. Table : logs.web.

À vérifier :
- **logique de détection à recréer** : Planification (5m), gravité, suppression des doublons et création des signaux se recréent dans l’outil cible ; la requête est traduite.

**Détection** — prête, couverture 100 %. Sur les 6 dernières minutes, garde les documents où url.path ~ /admin*, sauf user.name = admin ou user.name = ops, et renvoie 100 documents triés par timestamp (décroissant).

```sql
-- Documents
SELECT
    *
FROM logs.web
WHERE startsWith(url.path, '/admin')
  AND user.name NOT IN ('admin', 'ops')
  AND timestamp >= now() - INTERVAL 6 MINUTE
ORDER BY timestamp DESC
LIMIT 100;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (règle de détection) : 1 h
- logique de détection à recréer : 0,25 h

</details>

### Règle de détection : Connexion puis export massif

À reprendre, 5 h. eql. Identifiant : `web-sequence`.

À reprendre :
- **règle de détection eql** : Une séquence EQL se réécrit dans l’outil cible. Requête : sequence by user.name [authentication where event.outcome == "success"] [web where url.path : "/export*"]

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (règle de détection) : 1 h
- règle de détection eql : 4 h

</details>

### Règle de détection : Connexions refusées en rafale

À vérifier, 1,25 h. threshold. Identifiant : `web-brute-force`. Vue de données : logs-web-*. Table : logs.web.

À vérifier :
- **logique de détection à recréer** : Planification (5m), gravité, suppression des doublons et création des signaux se recréent dans l’outil cible ; la requête est traduite.

**Détection** — prête, couverture 100 %. Sur les 6 dernières minutes, garde les documents où event.category = authentication, event.outcome = failure, puis regroupe par source.ip (100 premiers).

```sql
-- Agrégation groupe
SELECT
    source.ip AS groupe,
    count() AS doc_count
FROM logs.web
WHERE event.category = 'authentication'
  AND event.outcome = 'failure'
  AND timestamp >= now() - INTERVAL 6 MINUTE
GROUP BY groupe
HAVING doc_count >= 20
ORDER BY doc_count DESC, groupe ASC
LIMIT 100;
```

<details><summary>Calcul de l’effort</summary>

- Recréer l’objet (règle de détection) : 1 h
- logique de détection à recréer : 0,25 h

</details>

### Connecteur : Canal #web-ops

Prête, 0,25 h. .slack. Identifiant : `9c1f0a2e-0000-4000-8000-00000000a002`.

À noter :
- **connecteur à recréer** : Le connecteur .slack (destination des notifications) se recrée dans l’outil d’alerte cible ; ses secrets ne sont pas exportés.

### Connecteur : Courriel de l’astreinte

Prête, 0,25 h. .email. Identifiant : `9c1f0a2e-0000-4000-8000-00000000a001`.

À noter :
- **connecteur à recréer** : Le connecteur .email (destination des notifications) se recrée dans l’outil d’alerte cible ; ses secrets ne sont pas exportés.

## Barème de l’effort

Recréer un objet : vue de données 0,25 h, recherche 0,25 h, requête enregistrée 0,1 h, visualisation 0,5 h, lens 0,5 h, carte 0,5 h, liens 0,25 h, tableau de bord 0,5 h, règle d’alerte 1 h, règle de détection 1 h, connecteur 0,25 h, canvas 0,5 h, graph 0,5 h, autre 0,5 h ; 0,1 h par panneau de tableau de bord. Vérifier une requête : 0,25 h si elle est à vérifier, 0,5 h si elle est à reprendre, plus 0,25 h par point à vérifier. Point à reprendre : visualisation Vega 6 h ; classeur Canvas 6 h ; carte 4 h ; TSVB ou Timelion 3 h ; requête ES|QL ou EQL 3 h ; logique de détection 4 h ; script Painless 2 h ; agrégation, mesure ou formule 1,5 h ; 1 h pour une clause ou un paramètre. Total arrondi au quart d’heure supérieur par objet ; un jour vaut 7 h.
