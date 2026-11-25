# Log vers Vector : d’un échantillon de journal à un pipeline VRL

Vous avez des journaux, pas encore de pipeline. Collez quelques lignes dans la section **Log vers Vector** de l’interface (ou passez le fichier à `passerelle log2vector`, ou à `POST /v1/translate/log`) : Passerelle reconnaît le format, écrit le programme VRL qui découpe chaque ligne en champs typés et nommés, et une configuration Vector complète dont les **tests unitaires rejouent vos lignes**. `vector test` vérifie alors, champ par champ, chaque valeur que Passerelle annonce.

Rien ne quitte le navigateur : l’analyse est locale, comme les autres traductions.

## Ce que Passerelle reconnaît

Le format est choisi d’après l’échantillon : celui qui lit le plus de lignes l’emporte, et l’onglet « Remarques » cite les autres formats possibles. Le menu « Format » de l’interface (`--log-format` en ligne de commande, `log_format` dans l’API) impose un format quand la détection hésite.

| Famille | Format | Identifiant | Échantillon |
|---|---|---|---|
| Web | Journal d’accès HTTP, `combined` ou `common` (nginx, Apache), avec `X-Forwarded-For` et durée en fin de ligne | `combined` | `nginx_acces.log`, `nginx_main_xff.log`, `apache_acces.log` |
| Web | Journal d’erreurs nginx (client, serveur, requête, upstream, Host) | `nginxError` | `nginx_erreur.log` |
| Web | Journal d’erreurs Apache httpd (module, PID, thread, client, code AH) | `apacheError` | `apache_erreur.log` |
| Java | Logback ou Log4j 2, `date [thread] NIVEAU logger - message` | `javaThreadFirst` | `java_logback.log` |
| Java | Log4j 2 ou Logback, `date NIVEAU [thread] logger - message` | `javaLevelFirst` | — |
| Java | Spring Boot, format par défaut (avec ou sans nom d’application) | `springBoot` | `java_spring_boot.log` |
| Python | `logging`, `date - logger - NIVEAU - message` | `pythonDash` | `python_logging.log` |
| Python | `logging.basicConfig`, `NIVEAU:logger:message` | `pythonBasic` | — |
| Python | Gunicorn | `gunicorn` | `python_gunicorn.log` |
| Go | paquet `log` standard (avec ou sans fichier:ligne) | `goStd` | `go_std.log` |
| Go | klog ou glog (Kubernetes), messages structurés compris | `klog` | `kubernetes_klog.log` |
| Go | zap en console (collecteur OpenTelemetry, ses champs JSON en fin de ligne) | `otelZap` | `otel_collector.log` |
| Plateforme | Elasticsearch 7 et antérieurs (texte) | `elasticsearchText` | `elasticsearch_texte.log` |
| Plateforme | Apache Kafka (log4j, `[date] NIVEAU [composant] message (classe)`) | `kafka` | `kafka_server.log` |
| Plateforme | ClickHouse, journal du serveur (thread, identifiant de requête) | `clickhouse` | `clickhouse_serveur.log` |
| Plateforme | HashiCorp hclog : Nomad, Vault, Consul (paires clé=valeur comprises) | `hclog` | `nomad.log`, `vault_serveur.log` |
| Linux | Syslog BSD : `/var/log/messages`, `syslog`, `auth.log`, `kern.log` (PRI facultatif) | `syslog3164` | `syslog_messages.log`, `syslog_kern.log` |
| Linux | Syslog RFC 5424 (données structurées gardées telles quelles) | `syslog5424` | `syslog_rfc5424.log` |
| Linux | Syslog horodaté ISO 8601 : rsyslog récent, `journalctl -o short-iso` | `syslogIso` | `syslog_iso.log`, `journald_short_iso.log` |
| Linux | Noyau (`dmesg`) | `dmesg` | `dmesg.log` |
| Linux | auditd (`audit.log`) | `auditd` | `auditd.log` |
| Objets | JSON, un objet par ligne : Elasticsearch 8 et ECS, Go zap et slog, pino, Logback (logstash-logback-encoder), python-json-logger, hclog en `-log-json` (Nomad, Vault), audit de Vault, ClickHouse en JSON, `journalctl -o json`, Docker `json-file` | `json` | `elasticsearch_json.log`, `go_zap_json.log`, `node_pino.log`, `nomad_json.log`, `vault_audit.log`, `clickhouse_json.log`, `journald_json.log`, `docker_json.log` |
| Objets | logfmt (Go slog en texte, Prometheus, Loki…) | `logfmt` | `go_logfmt.log` |
| Repli | Un horodatage et un niveau en tête, le reste en message : « à vérifier » | `generic` | — |

Les échantillons sont dans [`examples/logs`](../examples/logs) ; dix d’entre eux sont proposés par le menu « Charger un exemple ». Un journal qu’aucun format ne lit (`inconnu.log`) donne un pipeline « à reprendre » qui garde le message tel quel.

Dans un objet (JSON, logfmt), les clés usuelles sont reconnues par leur nom et leur type : horodatage (`@timestamp`, `time`, `ts`, `date_time`, `__REALTIME_TIMESTAMP`…, en texte ISO 8601 ou en secondes, millisecondes, microsecondes Unix), niveau (`level`, `log.level`, `@level`, `severity`, les niveaux numériques de pino et la `PRIORITY` de journald), message, logger, thread, `caller` de zap (fichier et ligne), trace et span, erreur et trace de pile, hôte, service, PID. Les autres clés sont gardées : en attributs à clés pointées (OpenTelemetry) ou à la racine (ECS).

## Ce que le pipeline écrit

- **Un découpage exact.** `parse_regex` avec l’expression du format, ou `parse_json` et `parse_logfmt`. Chaque champ est typé : entiers (`to_int`), flottants, horodatages (`parse_timestamp` avec le format strptime de la ligne), texte. Un « - » de journal d’accès ou de syslog veut dire « absent » : le champ n’est pas écrit.
- **Aucun événement perdu.** Une ligne d’un autre format traverse le pipeline marquée (`attributes."log.parse.error"` en OpenTelemetry, étiquette `_vrl_parse_failure` et `error.message` en ECS). Le VRL suit les règles de typage de Vector 0.59 : chaque appel faillible est traité.
- **Les dates sans fuseau** sont lues dans le fuseau choisi (UTC par défaut, à changer si le serveur écrit en heure locale) : le paramètre `timezone` de `parse_timestamp`. C’est une remarque « à vérifier ».
- **Les dates sans année** (syslog BSD, klog) prennent l’année du jour, ou la précédente si la date tombe à plus d’un jour dans le futur (un journal de décembre lu en janvier). Les tests vérifient alors le mois, le jour et l’heure.
- **Les traces de pile** (Java, Python, Go) restent attachées à leur événement : la configuration lit le fichier avec la source `file` et son regroupement `multiline` (mode `halt_before`), le VRL garde la première ligne comme message et range la suite en exception : type, message, trace (`exception.*` en OpenTelemetry, `error.*` en ECS).
- **Des champs en plus, quand l’échantillon les montre** : connexions SSH de `sshd` (utilisateur, adresse et port source, méthode, succès ou échec), commandes `sudo` (utilisateur, utilisateur effectif, terminal, répertoire, commande), horloge du noyau (`[secondes]` en tête de message), messages structurés de klog (`"message" clé=valeur`), paires clé=valeur de hclog, champs JSON de zap en console.
- **La ligne d’origine** est gardée (`log.record.original`, `event.original`), sauf avec `--no-original` ou `keep_original=false`. En OpenTelemetry, le corps d’un journal d’accès reste la ligne : elle n’est pas recopiée.

VRL a des fonctions natives pour certains formats (`parse_nginx_log`, `parse_apache_log`, `parse_syslog`, `parse_klog`). Elles sont plus rapides, mais leurs noms de champs sont imposés et leurs valeurs ne se prédisent pas aussi sûrement. Passerelle écrit `parse_regex` pour nommer les champs selon la convention choisie et pour que chaque valeur soit vérifiée ; une remarque « Optimisation » rappelle la fonction native.

## Conventions de nommage

Deux conventions, au choix dans l’interface (`--convention`, `convention`).

- **OpenTelemetry** (par défaut) : la forme des événements de la source `opentelemetry` de Vector, celle qu’attend sa sortie OTLP. Le corps dans `.message`, l’horodatage dans `.timestamp`, le niveau dans `.severity_text` et `.severity_number` (numéros du modèle de données OpenTelemetry), les attributs et les ressources dans `.attributes` et `.resources`, deux tables à clés pointées que la sortie OTLP ou ClickHouse reprend telles quelles (`LogAttributes`, `ResourceAttributes` et `ServiceName` de ClickStack). Les noms suivent les conventions sémantiques d’OpenTelemetry.
- **ECS** (Elastic Common Schema) : des objets imbriqués, comme les écrirait un pipeline d’ingestion Elasticsearch ou Logstash ; `@timestamp` remplace le `timestamp` de Vector. Les sources de Vector ajoutent un champ `host` en texte : réglez `log_schema.host_key` sur `host.name`.

| Rôle | OpenTelemetry | ECS |
|---|---|---|
| Message (corps) | `message` | `message` |
| Ligne d’origine | `log.record.original` (attribut) | `event.original` |
| Horodatage | `timestamp` | `@timestamp` |
| Niveau | `severity_text` | `log.level` |
| Logger, module | `scope.name` | `log.logger` |
| Thread | `thread.name` (attribut) | `process.thread.name` |
| Identifiant de thread | `thread.id` (attribut) | `process.thread.id` |
| Processus (PID) | `process.pid` (ressource) | `process.pid` |
| Programme syslog | `service.name` (ressource) | `process.name` |
| Service, application | `service.name` (ressource) | `service.name` |
| Hôte | `host.name` (ressource) | `host.name` |
| Client HTTP | `client.address` (attribut) | `source.address` |
| Port du client | `client.port` (attribut) | `source.port` |
| Adresse source (SSH) | `source.address` (attribut) | `source.ip` |
| Port source | `source.port` (attribut) | `source.port` |
| Utilisateur | `user.name` (attribut) | `user.name` |
| Utilisateur effectif (sudo) | `user.effective.name` (attribut) | `user.effective.name` |
| Méthode HTTP | `http.request.method` (attribut) | `http.request.method` |
| Chemin | `url.path` (attribut) | `url.path` |
| Chaîne de requête | `url.query` (attribut) | `url.query` |
| Requête HTTP illisible | `http.request.line` (attribut) | `http.request.line` |
| Protocole | `network.protocol.name` (attribut) | `network.protocol` |
| Version du protocole | `network.protocol.version` (attribut) | `http.version` |
| Statut HTTP | `http.response.status_code` (attribut) | `http.response.status_code` |
| Taille de la réponse | `http.response.body.size` (attribut) | `http.response.body.bytes` |
| Referer | `http.request.header.referer` (attribut) | `http.request.referrer` |
| User-Agent | `user_agent.original` (attribut) | `user_agent.original` |
| X-Forwarded-For | `http.request.header.x-forwarded-for` (attribut) | `network.forwarded_ip` |
| Durée de la requête | `http.server.request.duration` (attribut) | `event.duration` |
| Serveur (nginx) | `server.address` (attribut) | `server.address` |
| En-tête Host | `http.request.header.host` (attribut) | `url.domain` |
| Fichier source | `code.file.path` (attribut) | `log.origin.file.name` |
| Ligne du fichier source | `code.line.number` (attribut) | `log.origin.file.line` |
| Trace | `trace_id` | `trace.id` |
| Span | `span_id` | `span.id` |
| Type d’exception | `exception.type` (attribut) | `error.type` |
| Message d’erreur | `exception.message` (attribut) | `error.message` |
| Trace de pile | `exception.stacktrace` (attribut) | `error.stack_trace` |
| Secondes depuis le démarrage (noyau) | `host.uptime` (attribut) | `host.uptime` |
| Priorité syslog | `syslog.priority` (attribut) | `log.syslog.priority` |
| Facilité syslog | `syslog.facility` (attribut) | `log.syslog.facility.name` |
| Sévérité syslog | `syslog.severity` (attribut) | `log.syslog.severity.name` |
| MSGID syslog | `syslog.msgid` (attribut) | `log.syslog.msgid` |
| Données structurées syslog | `syslog.structured_data` (attribut) | `log.syslog.structured_data` |
| Version syslog | `syslog.version` (attribut) | `log.syslog.version` |
| Résultat (succès, échec) | `event.outcome` (attribut) | `event.outcome` |
| Méthode SSH | `ssh.method` (attribut) | `system.auth.ssh.method` |
| Terminal (sudo) | `sudo.tty` (attribut) | `system.auth.sudo.tty` |
| Répertoire (sudo) | `sudo.pwd` (attribut) | `system.auth.sudo.pwd` |
| Commande | `process.command_line` (attribut) | `process.command_line` |
| Flux (stdout, stderr) | `log.iostream` (attribut) | `stream` |
| Ligne non reconnue | `log.parse.error` (attribut) | `error.message` |

Les champs propres à un produit gardent son espace de noms : `nginx.*`, `apache.*`, `kafka.*`, `elasticsearch.*`, `clickhouse.*`, `auditd.*`. Les paires clé=valeur de hclog et de klog vont dans les attributs (OpenTelemetry) ou sous `labels` (ECS).

## La configuration générée

```yaml
sources:
  journaux:
    type: stdin          # file avec multiline quand des traces de pile suivent les messages
transforms:
  analyse_<journal>:
    type: remap
    inputs: [journaux]
    source: |
      # le VRL de l’onglet « VRL »
sinks:
  sortie:
    type: console
    inputs: [analyse_<journal>]
    encoding:
      codec: json
tests:
  - name: 'reconnue : <début de la ligne>'
    inputs:
      - insert_at: analyse_<journal>
        type: log
        log_fields:
          message: '<la ligne de l’échantillon>'
    outputs:
      - extract_from: analyse_<journal>
        conditions:
          - type: vrl
            source: |
              assert_eq!(.attributes."http.response.status_code", 200)
              assert_eq!(.timestamp, t'2026-05-01T08:00:00Z')
              …
```

Un test par événement de l’échantillon (douze au plus), et un pour une ligne non reconnue s’il y en a une. En production, remplacez la source `journaux` (`file`, `kafka`, `journald`, `opentelemetry`…) et la sortie `sortie` ; le transform se reprend tel quel. Aucune variable d’environnement n’est référencée : la configuration se lance sans `--dangerously-allow-env-var-interpolation`.

## Vérifier un pipeline avec les échantillons

Chaque échantillon de `examples/logs` sert de test, et chacun se rejoue à la main en trois commandes :

```bash
# 1. Générer la configuration et le VRL d’un échantillon (ici : Java, une trace de pile)
passerelle log2vector examples/logs/java_logback.log --out essai/ --convention otel

# 2. Rejouer l’échantillon : chaque champ annoncé est vérifié par Vector
vector test essai/java_logback.yaml

# 3. Voir les événements produits, sur un journal d’une seule ligne par événement
passerelle log2vector examples/logs/nginx_acces.log --out essai/
vector --config essai/nginx_acces.yaml < examples/logs/nginx_acces.log
```

Pour éprouver vos propres journaux, collez une centaine de lignes variées (niveaux différents, une erreur avec sa trace, des champs vides) : plus l’échantillon est varié, plus le pipeline est juste. Ce qu’il faut regarder pour chaque famille :

| Échantillon | Ce qui doit en sortir |
|---|---|
| `nginx_acces.log` | Statut et taille en entiers, chemin et chaîne de requête séparés, referer et user-agent absents quand ils valent « - », la requête « - » de la dernière ligne lue sans méthode, l’heure convertie en UTC (`+0200`) |
| `nginx_erreur.log` | Le message seul, puis client, serveur, requête, upstream et Host ; le niveau `notice` (sévérité 10) |
| `apache_erreur.log` | Module, PID et thread, client et son port, code `AH…`, microsecondes de l’horodatage |
| `java_logback.log`, `java_spring_boot.log` | Trace de pile rattachée à l’événement `ERROR`, type et message de l’exception (`IllegalStateException`, pas le `Caused by`), nom de l’application Spring en `service.name` |
| `python_logging.log` | Traceback rattaché, exception `ValueError` et son message, niveau `WARNING` en sévérité 13 |
| `kafka_server.log` | Composant entre crochets, classe entre parenthèses en logger, exception `IOException` |
| `clickhouse_serveur.log` | Identifiant de requête (absent quand `{}` est vide), thread, niveau `Information` en sévérité 9 |
| `nomad.log`, `vault_serveur.log` | Module en logger, message sans les paires, paires clé=valeur en attributs (`alloc_id`, `task`), guillemets retirés |
| `vault_audit.log` | Chemin, opération, identité (`auth.display_name`), erreur `permission denied` en message d’erreur |
| `otel_collector.log` | Fichier et ligne du `caller`, champs JSON de fin de ligne en attributs typés (`dropped_items` entier) |
| `kubernetes_klog.log` | Niveau `I` lu `INFO`, message structuré sans guillemets, paires en attributs |
| `syslog_messages.log` | Connexion SSH réussie et refusée (utilisateur, adresse, port, `event.outcome`), commande `sudo`, programme en `service.name` |
| `syslog_kern.log`, `dmesg.log` | Secondes depuis le démarrage en flottant, message sans le crochet |
| `syslog_rfc5424.log` | Priorité, facilité et sévérité tirées du PRI, MSGID et données structurées, PID numérique seulement |
| `journald_json.log` | `PRIORITY` « 3 » lu `err`, horodatage à la microseconde, unité et identifiant gardés |
| `auditd.log` | Type d’enregistrement, numéro de séquence, horodatage à la milliseconde, paires de l’enregistrement, `msg='…'` imbriqué gardé en texte |
| `inconnu.log` | Verdict « à reprendre », message gardé, ligne marquée non reconnue |

Les attentes exactes de chaque échantillon sont écrites dans [`tests/logs/cases.mjs`](../tests/logs/cases.mjs).

## Les bancs de tests

- **`npm test`**, sans Vector : chaque échantillon, dans les deux conventions, doit être reconnu dans le bon format, avec le bon nombre d’événements et les champs attendus de `tests/logs/cases.mjs` ; la configuration générée est comparée à son instantané (`tests/snapshots/logs`). S’y ajoutent les options (fuseau, format imposé, ligne d’origine), les lignes non reconnues, le format générique, les traces de pile, un `$` dans une ligne, l’échantillon tronqué.
- **`npm run test:logs`**, avec Vector (`VECTOR_BIN`) : pour chaque échantillon et chaque convention, `vector test` passe sur la configuration générée, en YAML et en TOML, sans avertissement de compilation ; puis chaque événement produit par Vector doit être **exactement** celui que Passerelle annonce (`assert_eq!(., …)`), types compris : un champ en trop ou en moins est un écart. La CI le joue avec Vector 0.59.0.

## Limites

- Un seul format par pipeline : un fichier qui mêle deux formats donne des lignes « à vérifier », marquées dans le pipeline. Découpez-le, ou routez en amont (`route`).
- Les champs d’un message libre ne sont pas devinés au-delà des enrichissements listés plus haut : complétez le VRL avec `parse_regex` ou `parse_grok`.
- Les formats d’accès personnalisés (`log_format` nginx, `LogFormat` Apache) ne sont reconnus que s’ils commencent comme `combined` ; sinon, le repli générique ou un format imposé.
- Une date sans année rejouée longtemps après coup prend une année fausse : c’est la limite du format, pas du pipeline.
