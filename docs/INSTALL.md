# Passerelle 1.6.0 — Linux x86_64

Passerelle traduit les requêtes DSL Elasticsearch en SQL ClickHouse et les pipelines Logstash (Kafka vers Kafka) en configurations Vector. Un seul binaire fournit l’interface web, l’API REST et la ligne de commande. Le moteur Node.js 24 LTS est embarqué : rien d’autre à installer.

## Prérequis

| Élément | Exigence |
|---|---|
| Système | Linux x86_64 avec glibc 2.28 ou plus récente : RHEL, Rocky ou Alma 8+, Debian 10+, Ubuntu 20.04+. Les distributions musl (Alpine) ne sont pas prises en charge. |
| Service | systemd (pour l’unité fournie) et un accès root pour l’installation. |
| Ressources | 130 Mo de disque ; environ 55 Mo de mémoire au repos et 75 Mo en charge, plafonnés à 1 Go par l’unité. |
| Réseau | Aucun accès Internet requis. Le port 8080 est ouvert sur 127.0.0.1 uniquement. |
| Navigateur | Chrome, Edge, Firefox ou Safari de 2023 ou plus récent. |

Facultatif, selon les fonctions utilisées :

- **Validation SQL** (`/v1/validate/sql`) : un accès HTTP(S) à un ClickHouse de recette et un compte limité aux tables traduites (voir [Compte ClickHouse de validation](#compte-clickhouse-de-validation)).
- **Validation Vector** (`/v1/validate/vector`) : le binaire `vector` installé sur la machine. Les fichiers cités par les configurations testées (certificat CA, base GeoIP, dictionnaires CSV) doivent y être présents.
- **Publication** : un reverse proxy TLS (nginx, HAProxy) pour exposer l’interface aux utilisateurs.

## Contenu de l’archive

```
bin/passerelle                 binaire autonome (Node.js 24 LTS embarqué)
systemd/passerelle.service     unité systemd durcie
etc/passerelle.yaml            configuration d’exemple
etc/passerelle.env.example     variables d’environnement (secrets)
install.sh                     installation, mise à jour, désinstallation
LICENSE, NOTICE                licence Apache 2.0 de Passerelle
THIRD_PARTY_LICENSES/          licence de Node.js, embarqué dans le binaire
SHA256SUMS                     sommes de contrôle
```

## Installation

```bash
sha256sum -c passerelle-1.6.0-linux-x86_64.tar.gz.sha256
tar xzf passerelle-1.6.0-linux-x86_64.tar.gz
cd passerelle-1.6.0-linux-x86_64
sudo ./install.sh
```

La somme de contrôle détecte un fichier abîmé. Pour vérifier aussi que l’archive a été construite par la CI du dépôt, à partir de l’étiquette de la release : `gh attestation verify passerelle-1.6.0-linux-x86_64.tar.gz -R OlivMartins/passerelle`.

Le script vérifie l’architecture, la glibc et l’intégrité des fichiers. Il crée ensuite l’utilisateur système `passerelle` et installe `/usr/local/bin/passerelle`, `/etc/passerelle/` et l’unité systemd. Un jeton d’API aléatoire est écrit dans `/etc/passerelle/passerelle.env`, puis le service est démarré.

Relancer `install.sh` depuis une archive plus récente met à jour le binaire et l’unité, conserve la configuration et redémarre le service.

## Configuration

`/etc/passerelle/passerelle.yaml` décrit les endpoints ClickHouse et Kafka, les correspondances index → table et champs, les topics, le groupe de consommateurs et les options Vector. C’est le même format que celui exporté par l’onglet Configuration de l’interface : versionnez-le dans Git.

Les secrets ne vont jamais dans ce fichier. Il contient des références `${CLICKHOUSE_PASSWORD}`, `${KAFKA_PASSWORD}`… dont les valeurs sont définies dans `/etc/passerelle/passerelle.env`.

```bash
sudoedit /etc/passerelle/passerelle.yaml
passerelle check-config --config /etc/passerelle/passerelle.yaml
sudo systemctl reload passerelle      # rechargement à chaud (SIGHUP), sans coupure
```

### TLS de la source qui reçoit les agents

Les pipelines d’ingestion traduits écoutent Elastic Agent et Beats sur `0.0.0.0:5044`. Sans TLS, tout hôte qui atteint ce port peut envoyer des documents : la traduction le signale « à vérifier ». Pour chiffrer et authentifier la liaison :

```yaml
vector:
  ingest_source:
    address: 10.0.0.5:5044          # restreindre l’adresse d’écoute
    tls:
      crt_file: /etc/vector/certs/tls.crt
      key_file: /etc/vector/certs/tls.key
      ca_file: /etc/vector/certs/ca.pem   # autorité des certificats clients
      verify_client: true                 # exige un certificat de chaque agent
```

Côté Elastic Agent, la sortie Logstash active `ssl.certificate_authorities` (et `ssl.certificate`, `ssl.key` avec `verify_client`). Une entrée `beats`, `tcp` ou `http` d’un pipeline Logstash reprend ses options `ssl_*` de la même façon ; un magasin Java (JKS, PKCS12) doit être converti en PEM.

### Compte ClickHouse de validation

`/v1/validate/sql` soumet le SQL à `EXPLAIN indexes = 1`. Or ClickHouse évalue alors les sous-requêtes scalaires et imprime leur valeur dans le plan : une requête de validation peut donc lire des données. Deux barrières s’en chargent.

1. **Passerelle** analyse d’abord la requête par `EXPLAIN AST`, qui ne lit rien, et refuse toute table absente de la configuration (`index_mapping`, `default_table`, `lists.table`), toute fonction de table (`url`, `file`, `remote`…) et toute lecture de dictionnaire (`dictGet`, `joinGet`).
2. **ClickHouse** n’accorde au compte du service que la lecture de ces mêmes tables. C’est la barrière qui compte : un droit absent ne se contourne pas.

```sql
CREATE USER passerelle IDENTIFIED WITH sha256_password BY '…';
GRANT SELECT ON logs.events TO passerelle;
GRANT SELECT ON logs.passerelle_lists TO passerelle;     -- listes nommées, si clickhouse.lists est utilisé
-- Plafond que la requête ne peut pas lever
CREATE SETTINGS PROFILE passerelle_validation SETTINGS max_execution_time = 15 MAX 15 TO passerelle;
```

Une table par entrée de `index_mapping`. Aucun autre droit : sans `CREATE TEMPORARY TABLE` ni droit sur les sources (`URL`, `REMOTE`, `FILE`), les fonctions de table sont refusées par ClickHouse lui-même. Le compte se déclare dans `passerelle.env` (`CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`).

### Compte ClickHouse de la sortie Vector

Avec `vector.elasticsearch_output: clickhouse`, la configuration Vector générée écrit dans les tables ClickHouse. Le compte de validation ci-dessus n’a que `SELECT` : donnez à Vector son propre compte, avec `INSERT` sur les tables de `index_mapping`.

```yaml
clickhouse:
  user: ${CLICKHOUSE_USER}                    # lecture seule, pour la validation
  password: ${CLICKHOUSE_PASSWORD}
  sink_user: ${CLICKHOUSE_SINK_USER}          # écriture, pour Vector
  sink_password: ${CLICKHOUSE_SINK_PASSWORD}
```

```sql
CREATE USER vector_ecriture IDENTIFIED WITH sha256_password BY '…';
GRANT INSERT ON logs.events TO vector_ecriture;
```

Sans `sink_user` ni `sink_password`, le puits reprend `clickhouse.user` et la traduction le signale « à vérifier ». Les deux restent des références à des variables d’environnement, listées dans le résultat de la traduction : Vector les lit au démarrage.

## Équivalence sur vos données

`passerelle verify` compare, sur vos données, une requête jouée par Elasticsearch et sa traduction jouée par ClickHouse (voir le [README](../README.md#prouver-léquivalence-sur-vos-données)). Il se lance depuis un poste ou un serveur qui atteint les deux moteurs ; le service `passerelle` n’en a pas besoin.

```yaml
elasticsearch:
  endpoint: https://elasticsearch.internal:9200
  user: ${ES_USER}                  # ou api_key: ${ES_API_KEY}, qui l’emporte
  password: ${ES_PASSWORD}
verify:
  window: { length: 1h, lag: 10m }  # 1 h se terminant 10 minutes avant le lancement
  tolerance: 1e-9                   # écart relatif toléré sur les nombres flottants
  examples: 3                       # écarts cités par requête
  timeout: 60                       # secondes, par requête et par moteur
```

Un certificat d’autorité privée se déclare comme pour tout programme Node.js, par `NODE_EXTRA_CA_CERTS=/chemin/ca.pem`.

**Compte Elasticsearch** : lecture des seuls index comparés, plus le privilège de cluster `monitor`, qu’exige la route `GET /` pour lire la version.

```
POST _security/role/passerelle_verify
{ "cluster": ["monitor"], "indices": [{ "names": ["logs-*"], "privileges": ["read"] }] }
```

**Compte ClickHouse** : le compte de validation ci-dessus convient (`SELECT` sur les tables de `index_mapping`). Chaque requête part sous `readonly = 1` et `max_execution_time = verify.timeout`.

Choisissez la fenêtre dans une période où les deux moteurs ont reçu les mêmes documents. Si Elasticsearch et ClickHouse sont alimentés en parallèle, gardez un retard (`lag`) supérieur au délai de la plus lente des deux chaînes d’ingestion, sans quoi les dernières minutes diffèrent pour une raison qui n’a rien à voir avec la traduction.

Pour un pipeline, `--sample` est un export du topic Kafka d’entrée, un événement JSON par ligne. Logstash le relit par une entrée fichier, Vector par son entrée standard ; les métadonnées Kafka (`[@metadata][kafka]`) ne sont pas rejouées, et le rapport le signale quand le pipeline s’en sert. Un échantillon de moins de 100 événements ne dit rien des cas rares.

## Aide aux cas à reprendre

`passerelle assist` prépare, compile et rejoue une proposition pour les filtres `ruby` de Logstash et les scripts Painless que la traduction laisse « à reprendre » (voir le [README](../README.md#aide-aux-cas-à-reprendre)). Il se lance depuis un poste ou un serveur qui a Vector (`--vector-bin` ou `PASSERELLE_VECTOR_BIN`) ; le service `passerelle` n’en a pas besoin.

```bash
# Filtres ruby : l’échantillon est rejoué dans le Logstash du client, ou comparé à des événements déjà produits
passerelle assist ruby pipelines/web.conf --sample echantillon.ndjson --logstash-bin /usr/share/logstash/bin/logstash --out aide/

# Painless : la référence est ce que votre Elasticsearch produit pour les mêmes documents
curl -s -u "$ES_USER:$ES_PASSWORD" -H 'content-type: application/json' "$ES/_ingest/pipeline/mon-pipeline/_simulate" \
  -d "{\"docs\": $(jq -s '[.[] | {_source: .}]' documents.ndjson)}" | jq -c '.docs[].doc._source' > attendus.ndjson
passerelle assist painless ingest/ --local-model --model-name qwen2.5-coder:14b --sample documents.ndjson --reference attendus.ndjson --out aide/
```

Sans `--sample` et sans référence, les propositions sont compilées par Vector mais pas rejouées : le rapport les donne « non rejouées ». Un champ que les deux moteurs ne peuvent pas produire égal (un horodatage d’ingestion, par exemple `event.ingested`) s’écarte des deux côtés par `--ignore event.ingested`.

**Le modèle local** est facultatif. Il se déclare dans `passerelle.yaml`, et ne sert que si `--local-model` est passé :

```yaml
assist:
  model:
    endpoint: http://127.0.0.1:11434   # Ollama ; seule la boucle locale est admise (127.0.0.1, ::1, localhost), en http
    api: ollama                        # ou openai : un serveur local compatible avec /v1/chat/completions (llama.cpp, vLLM…)
    model: qwen2.5-coder:14b
    timeout: 300                       # secondes, par demande
    max_attempts: 2                    # essais par cas ; le message du compilateur de Vector est rendu au modèle entre deux essais
```

Ce que le modèle reçoit : le code du cas, la raison donnée par le traducteur, les règles de VRL à suivre, et au second essai le message du compilateur. Jamais un événement de l’échantillon, ni la configuration, ni un nom de machine, de fichier ou de topic. Aucune demande ne porte de jeton. Un modèle distant, même derrière un tunnel, se refuse : l’adresse est vérifiée avant toute connexion, et la demande ne passe par aucun proxy de l’environnement. `check-config` signale une adresse qui n’est pas locale.

**Ce que la preuve vaut.** Le rejeu compare le pipeline entier : un écart peut venir d’un autre filtre que celui qu’on a repris, et `passerelle verify pipelines` dit si la traduction seule est en cause. « Confirmée sur l’échantillon » veut dire identique à la référence sur les événements rejoués, pas sur ceux que l’échantillon ne contient pas : élargissez-le (au moins une centaine d’événements, avec les cas rares) avant de reprendre une proposition, et relisez-la. Vector rejoue l’échantillon avec une entrée standard et des sorties en fichiers ; une proposition qui lit l’environnement ou appelle le réseau est écartée avant d’être compilée.

**Ce que les règles ne couvrent pas** : un Ruby hors du sous-ensemble (classes, appels système, bibliothèques, blocs de plusieurs instructions, noms de champs calculés, `+` entre deux champs dont on ne connaît pas le type, division dont on ne sait pas si elle est entière) n’a pas de proposition, avec la raison dans le rapport. Quand Ruby lève une exception (une méthode sur `nil`), Logstash étiquette l’événement `_rubyexception` et s’arrête là ; la proposition continue avec une valeur neutre, et le banc le montre comme un écart. Les règles sont éprouvées contre un vrai Ruby et un vrai VRL par `npm run test:assist` (voir [tests/README.md](../tests/README.md)).

## Accès à l’interface

Le service n’écoute que sur `127.0.0.1:8080`. Deux options :

- **Poste d’administration** : `ssh -L 8080:127.0.0.1:8080 serveur`, puis http://localhost:8080.
- **Publication** : reverse proxy TLS, par exemple avec nginx :

```nginx
server {
    listen 443 ssl http2;
    server_name passerelle.exemple.interne;
    ssl_certificate     /etc/pki/tls/certs/passerelle.crt;
    ssl_certificate_key /etc/pki/tls/private/passerelle.key;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

L’interface ne contient aucun secret, car la configuration diffusée masque les mots de passe. Elle est donc servie sans jeton. Pour en restreindre l’accès, placez une authentification SSO devant le proxy, par exemple oauth2-proxy.

## Watches d’un cluster

`passerelle watcher pull` lit les watches du cluster décrit par la section `elasticsearch` (ou `--es URL`), page par page, par `POST _watcher/_query/watches` (Elasticsearch 7.11 et suivants ; avant, l’index `.watches` est lu par `_search`). Il n’appelle que `GET /` et cette route, en lecture seule, puis produit le même rapport que `passerelle watcher watches.json`.

**Compte Elasticsearch** : les privilèges de cluster `monitor_watcher` (lire les watches) et `monitor` (lire la version).

```
POST _security/role/passerelle_watcher
{ "cluster": ["monitor", "monitor_watcher"] }
```

Avec `--out`, le dossier reçoit le rapport (`rapport.md`, `.html`, `.csv`, `.json`), un fichier SQL par watch et `export-watches.json`, l’export lu, qui se relit hors ligne (`passerelle watcher export-watches.json`). Elasticsearch masque déjà les secrets des actions (`::es_redacted::`) ; Passerelle masque en plus les mots de passe, jetons, en-têtes d’autorisation et identifiants d’URL qui resteraient, et écrit le fichier en `0600`. Le rapport ne cite ni adresse e-mail ni secret.

Les requêtes attendent `{scheduled_time:String}`, l’heure prévue de l’exécution, que le planificateur fournit à chaque passage : `clickhouse-client --param_scheduled_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --queries-file sql/erreurs-5xx.sql`.

## API

Toutes les routes `/v1/*` exigent l’en-tête `Authorization: Bearer <PASSERELLE_TOKEN>`, ou celui d’un [jeton à portée](#jetons-à-portée-identité-et-audit) qui ouvre la route demandée. Chaque réponse porte un `X-Request-Id`, qu’on retrouve dans le journal et l’audit.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/healthz` | État du service (sans jeton) |
| GET | `/metrics` | Métriques au format texte de Prometheus (jeton de portée `metrics`) |
| GET | `/v1/config` | Configuration active, secrets masqués |
| POST | `/v1/translate/dsl?index=logs-*` | DSL (JSON ou format console Kibana) vers SQL, avec verdict, paramètres et remarques |
| POST | `/v1/translate/logstash?format=yaml` | Pipeline `.conf` vers configuration Vector (`yaml` ou `toml`), avec verdict |
| POST | `/v1/translate/logstash/pipelines?format=yaml` | `pipelines.yml` (ou JSON `{ "pipelines": "…", "files": { "chemin": "contenu" } }`) vers une configuration Vector reliant les pipelines |
| POST | `/v1/translate/ingest?format=yaml` | Pipeline d’ingestion Elasticsearch (YAML, JSON ou requête `PUT _ingest/pipeline` de la console Kibana ; ou JSON `{ "files": { "nom": "contenu" } }`) vers Vector, VRL compris |
| POST | `/v1/inventory/kibana?format=json` | Export d’objets sauvegardés Kibana (NDJSON) vers un inventaire (`json`, `md`, `html`, `csv`) ; `timezone=` fixe le fuseau des dates relatives |
| POST | `/v1/translate/watcher?format=json` | Watches Elasticsearch (export `_query/watches`, `GET _watcher/watch/<id>`, console Kibana) vers un rapport par watch : SQL, décision de la condition, planification, actions (`json`, `md`, `html`, `csv`) |
| POST | `/v1/translate/grafana?index=logs-*` | Tableau de bord Grafana (JSON) vers un rapport par panneau et le tableau réécrit (`format=md` pour le rapport seul) |
| POST | `/v1/schema/ddl?preset=otel&format=sql` | Mapping, modèle d’index ou réponse d’API Elasticsearch (ou JSON `{ "files": { "nom": "contenu" } }`) vers le `CREATE TABLE` ClickHouse. `preset` (`otel`, `otel-json`), `compact`, `json`, `table` comme en ligne de commande ; sans `format=sql`, JSON avec verdict, profils par table et remarques |
| POST | `/v1/schema/analyzers?text=…&field=…` | Plan ClickHouse des analyseurs personnalisés d’un mapping, avec l’aperçu des mots du texte donné ; `format=md` pour le rapport |
| POST | `/v1/validate/sql?param_nom=…` | Tables vérifiées par `EXPLAIN AST`, puis `EXPLAIN indexes = 1` sur le ClickHouse configuré (SELECT seul, `readonly=1`). Les `param_*` renseignent les paramètres `{nom:Type}` |
| POST | `/v1/validate/vector?format=yaml` | Compilation complète de la configuration et du VRL par `vector validate` |

```bash
TOKEN=$(sudo sed -n 's/^PASSERELLE_TOKEN=//p' /etc/passerelle/passerelle.env)
curl -sS -X POST "http://127.0.0.1:8080/v1/translate/dsl?index=logs-*" \
  -H "Authorization: Bearer $TOKEN" --data-binary @requete.json | jq -r .sql
```

Chaque traduction porte un `verdict` : `ready` (prête), `review` (à vérifier), `todo` (à reprendre : le SQL s’arrête sur `throwIf`). Une entrée que Passerelle refuse, comme Elasticsearch la refuserait, répond 422 avec `verdict: "unrecognized"`.

Les corps de requête sont limités à 2 Mio, et à 32 Mio pour `/v1/inventory/kibana`, `/v1/translate/watcher`, `/v1/translate/grafana`, `/v1/translate/ingest`, `/v1/translate/logstash/pipelines`, `/v1/schema/ddl` et `/v1/schema/analyzers`. Au plus deux validations, Vector et SQL confondues, tournent en parallèle.

Un navigateur ne peut pas appeler l’API depuis un autre site : `/v1/*` refuse les requêtes intersites. Sans jeton, cas d’un `passerelle serve` lancé sur un poste, l’API ne répond qu’aux requêtes adressées à `localhost`, `127.0.0.1` ou `[::1]`.

## Ligne de commande (CI, dépôts Git)

```bash
passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
passerelle ls2vector pipelines/ --config passerelle.yaml --format yaml --out build/vector --fail-on review
passerelle ingest ingest/ --config passerelle.yaml --out build/vector --fail-on review
passerelle kibana export.ndjson --format md --out build/kibana
passerelle grafana tableaux/ --index 'logs-*' --out build/grafana
passerelle watcher watches.json --out build/watcher
passerelle watcher pull --out build/watcher
passerelle schema ddl mappings/ --preset otel --out build/ddl
passerelle schema analyzers mappings/ --text "texte d’essai" --format md
passerelle verify queries requetes/ --index 'logs-*' --out rapport/
passerelle assist ruby pipelines/ --sample echantillon.ndjson --logstash-bin /usr/share/logstash/bin/logstash --out aide/
```

Chaque fichier reçoit un verdict : prête, à vérifier, à reprendre ou non reconnue. Codes de sortie : `0` succès, `1` erreur ou fichier non reconnu, `2` fichier à reprendre (`--fail-on todo`), ou à vérifier ou à reprendre (`--fail-on review`). `--verbose` affiche les remarques de chaque fichier.

## Jetons à portée, identité et audit

`PASSERELLE_TOKEN` ouvre toute l’API. Pour donner à chaque client ce dont il a besoin, déclarez des jetons dans `passerelle.yaml`, avec leur valeur dans `passerelle.env` :

```yaml
server:
  tokens:
    - name: ci                          # paraît dans le journal, l’audit et les métriques
      token: '${PASSERELLE_TOKEN_CI}'
      scopes: [translate, validate]
    - name: prometheus
      token: '${PASSERELLE_TOKEN_PROMETHEUS}'
      scopes: [metrics]
```

| Portée | Routes |
|---|---|
| `translate` | `/v1/translate/*`, `/v1/inventory/*`, `/v1/schema/*`, `/v1/config` |
| `validate` | `/v1/validate/sql`, `/v1/validate/vector` |
| `metrics` | `/metrics` |

`PASSERELLE_TOKEN` reste valable, avec les trois portées, sous le nom `principal`. Un jeton qui n’a pas la portée d’une route reçoit `403`, un jeton absent ou inconnu `401`. Les valeurs ne sont jamais écrites : le journal, l’audit et `/metrics` ne citent que le nom du jeton.

Le service refuse de démarrer (et `systemctl reload` refuse de recharger, en gardant la configuration précédente) si la variable d’un jeton est vide ou absente, si deux jetons ont la même valeur ou si une portée est inconnue : l’API ne reste pas ouverte par une faute de frappe. `passerelle check-config` signale un jeton écrit en clair, mais signale seulement, sans bloquer, une variable absente de l’environnement du contrôle (une intégration continue ne connaît pas vos secrets).

### Identité transmise par le reverse proxy

Derrière un proxy qui authentifie (oauth2-proxy, par exemple), le journal et l’audit peuvent dire **qui** a appelé, pas seulement quel jeton :

```yaml
server:
  trusted_proxies: [127.0.0.1]          # adresses ou réseaux CIDR
  identity_header: X-Forwarded-User
```

```nginx
proxy_set_header X-Forwarded-User $remote_user;     # ou $upstream_http_x_auth_request_user
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Request-Id $request_id;
```

Seuls les pairs listés dans `trusted_proxies` sont crus : leur en-tête d’identité est repris (200 caractères au plus), leur `X-Forwarded-For` donne l’adresse du client (le premier saut, en partant de la droite, qui n’est pas lui-même un proxy de confiance), et leur `X-Request-Id` devient l’identifiant de la requête, celui de leur journal d’accès. Venant de tout autre pair, ces trois en-têtes sont ignorés : l’identifiant du client est gardé à part (`client_request_id`), et l’audit note `identity_untrusted` quand une identité a été refusée. L’identité n’est jamais une preuve d’accès : c’est le jeton qui ouvre les routes.

### Journal d’audit

```yaml
server:
  audit_log: /var/log/passerelle/audit.jsonl
```

Une ligne JSON par appel à l’API (`/v1/*`) et par refus sur `/metrics` : date, `request_id`, jeton, identité, adresse du client, action (`translate.dsl`, `validate.sql`…), statut, issue (`ok`, `refused`, `rejected`, `error`, `aborted`), verdict, durée, taille du corps et son empreinte SHA-256 tronquée à 16 caractères, qui permet de reconnaître la même requête sans la conserver. **Le contenu des requêtes n’y figure jamais.** Ni `/healthz`, ni l’interface, ni un relevé de `/metrics` réussi ne sont audités.

Le fichier est créé en `0600`. Le service ne démarre pas s’il ne peut pas l’ouvrir. L’unité systemd fournie crée `/var/log/passerelle` (`LogsDirectory=`), le seul dossier ouvert en écriture au service. Pour la rotation, `logrotate` déplace le fichier et demande au service de le rouvrir :

```
/var/log/passerelle/audit.jsonl {
    weekly
    rotate 52
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload passerelle >/dev/null 2>&1 || true
    endscript
}
```

Sans `audit_log`, l’audit passe par le journal du service (`journalctl -u passerelle`), avec `"msg":"audit"`.

## Sécurité

- Le service tourne sous un utilisateur dédié, sans capacité ni élévation de privilèges, avec un système de fichiers en lecture seule et un `/tmp` privé.
- Un filtre seccomp restreint les appels système au groupe `@system-service`. Les appels réellement utilisés, y compris l’exécution de `vector validate`, ont été relevés et sont tous couverts.
- Score `systemd-analyze security passerelle` : **1.2 (OK)**. Les points restants sont inhérents à la fonction : accès réseau, et pages exécutables nécessaires au JIT de V8.
- En-têtes HTTP : politique CSP stricte (script autorisé par empreinte SHA-256, aucun `unsafe-eval`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Les jetons sont comparés en temps constant, tous à chaque appel, et chacun a une portée (`translate`, `validate`, `metrics`) ; le contenu des requêtes n’est jamais écrit dans l’audit. La validation SQL n’accepte qu’un seul SELECT, sur les seules tables de la configuration vérifiées par `EXPLAIN AST`, et s’exécute en `readonly=1`, qui interdit aussi de modifier les réglages, dont la limite de 15 s.
- `passerelle.env` n’est lisible que par root (0600) : systemd le lit au démarrage. `vector validate` ne reçoit aucune variable d’environnement du service, secrets compris.
- Les traductions faites dans l’interface restent dans le navigateur. Seuls les appels explicites à l’API passent par le serveur.
- L’interface ne charge aucune ressource externe (polices système, aucun CDN) : aucune donnée de navigation ne sort vers un tiers.

## Exploitation

```bash
systemctl status passerelle
journalctl -u passerelle -f          # journaux JSON, une ligne par requête, avec son request_id
sudo systemctl reload passerelle     # relit passerelle.yaml
systemctl edit passerelle            # surcharges locales (port, limites…)
```

### Métriques

`GET /metrics` répond au format texte de Prometheus, avec un jeton de portée `metrics`. Les étiquettes sont d’un nombre fixe : une route inconnue est comptée sous `route="autre"`, jamais sous le chemin demandé.

```yaml
scrape_configs:
  - job_name: passerelle
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/passerelle.token
    static_configs:
      - targets: ['passerelle.exemple.interne:443']
    scheme: https
```

| Famille | Contenu |
|---|---|
| `passerelle_http_requests_total{method,route,status}` | requêtes servies |
| `passerelle_http_request_duration_seconds{route}` | durées (histogramme) |
| `passerelle_http_requests_in_flight` | requêtes en cours |
| `passerelle_token_requests_total{token}` | requêtes par nom de jeton |
| `passerelle_auth_failures_total{reason}` | refus : `absent`, `invalide`, `portee`, `intersite` |
| `passerelle_translations_total{action,verdict}` | traductions par verdict (`ready`, `review`, `todo`, `unrecognized`) |
| `passerelle_validations_total{action,result}` | validations : `valid`, `invalid`, `rejected`, `error` |
| `passerelle_validation_jobs_running`, `passerelle_validation_rejected_total` | validations en cours, refusées (429) faute de place |
| `passerelle_config_reloads_total{result}` | rechargements acceptés ou refusés |
| `passerelle_audit_events_total`, `passerelle_audit_write_errors_total` | audit |
| `passerelle_trace_spans_exported_total`, `…_dropped_total`, `passerelle_trace_export_errors_total` | export des traces |
| `process_*`, `passerelle_build_info` | mémoire, processeur, démarrage, version |

`server.metrics: false` retire la route. Alerte conseillée : `rate(passerelle_audit_write_errors_total[5m]) > 0`, car un audit qui ne s’écrit plus ne se voit pas ailleurs.

### Traces OpenTelemetry

```yaml
server:
  tracing:
    endpoint: http://collecteur:4318/v1/traces    # OTLP/HTTP, JSON
    headers:
      authorization: 'Bearer ${OTEL_AUTHORIZATION}'
    sample_ratio: 1
```

Chaque requête donne un span serveur (`POST /v1/translate/dsl`), et chaque appel à ClickHouse (validation SQL) ou à Vector un span enfant. Un en-tête `traceparent` entrant est repris : la trace continue celle de l’appelant, et celui-ci peut demander de ne pas échantillonner. ClickHouse reçoit le `traceparent` de chaque appel, pour relier ses propres traces (`system.opentelemetry_span_log`). La ligne de journal de chaque requête porte son `trace_id`. **Aucun span ne contient de requête, de SQL ni de jeton.** Les spans partent par lots toutes les 5 secondes et à l’arrêt du service ; un collecteur en panne ne gêne pas le service : les échecs sont comptés dans `/metrics` et signalés une fois par minute dans le journal.

Pour changer d’adresse d’écoute, définissez `PASSERELLE_LISTEN=0.0.0.0:8080` dans `passerelle.env`, avec le jeton obligatoire et un pare-feu.

Désinstallation : `sudo ./install.sh --uninstall`. Ajoutez `--purge` pour effacer aussi `/etc/passerelle` et l’utilisateur.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `glibc … trop ancienne` | Distribution antérieure à RHEL 8 ou Debian 10. |
| Le service ne démarre pas | `journalctl -u passerelle -n 50` ; l’étape `check-config` signale une configuration illisible. |
| `/v1/validate/vector` renvoie 503 | `vector` absent : installez-le ou renseignez `PASSERELLE_VECTOR_BIN`. |
| `/v1/validate/sql` renvoie 502 | ClickHouse injoignable depuis le serveur (réseau, TLS, pare-feu). |
