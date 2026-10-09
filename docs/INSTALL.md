# Passerelle 1.0.0 — Linux x86_64

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

- **Validation SQL** (`/v1/validate/sql`) : un accès HTTP(S) à un ClickHouse de recette et un compte en lecture seule.
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
sha256sum -c passerelle-1.0.0-linux-x86_64.tar.gz.sha256
tar xzf passerelle-1.0.0-linux-x86_64.tar.gz
cd passerelle-1.0.0-linux-x86_64
sudo ./install.sh
```

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

## API

Toutes les routes `/v1/*` exigent l’en-tête `Authorization: Bearer <PASSERELLE_TOKEN>`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/healthz` | État du service (sans jeton) |
| GET | `/v1/config` | Configuration active, secrets masqués |
| POST | `/v1/translate/dsl?index=logs-*` | DSL (JSON ou format console Kibana) vers SQL |
| POST | `/v1/translate/logstash?format=yaml` | Pipeline `.conf` vers configuration Vector (`yaml` ou `toml`) |
| POST | `/v1/validate/sql` | `EXPLAIN indexes = 1` sur le ClickHouse configuré (SELECT seul, `readonly=2`) |
| POST | `/v1/validate/vector?format=yaml` | Compilation complète de la configuration et du VRL par `vector validate` |

```bash
TOKEN=$(sudo sed -n 's/^PASSERELLE_TOKEN=//p' /etc/passerelle/passerelle.env)
curl -sS -X POST "http://127.0.0.1:8080/v1/translate/dsl?index=logs-*" \
  -H "Authorization: Bearer $TOKEN" --data-binary @requete.json | jq -r .sql
```

Les corps de requête sont limités à 2 Mio. Au plus deux validations Vector tournent en parallèle.

## Ligne de commande (CI, dépôts Git)

```bash
passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
passerelle ls2vector pipelines/ --config passerelle.yaml --format yaml --out build/vector --fail-on todo
```

Codes de sortie : `0` succès, `1` erreur, `2` éléments « à reprendre » détectés avec `--fail-on todo`. `--verbose` affiche les remarques de chaque fichier.

## Sécurité

- Le service tourne sous un utilisateur dédié, sans capacité ni élévation de privilèges, avec un système de fichiers en lecture seule et un `/tmp` privé.
- Un filtre seccomp restreint les appels système au groupe `@system-service`. Les appels réellement utilisés, y compris l’exécution de `vector validate`, ont été relevés et sont tous couverts.
- Score `systemd-analyze security passerelle` : **1.2 (OK)**. Les points restants sont inhérents à la fonction : accès réseau, et pages exécutables nécessaires au JIT de V8.
- En-têtes HTTP : politique CSP stricte (script autorisé par empreinte SHA-256, aucun `unsafe-eval`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Le jeton est comparé en temps constant. La validation SQL n’accepte qu’un seul SELECT et s’exécute en `readonly=2` avec une limite de 15 s.
- Les traductions faites dans l’interface restent dans le navigateur. Seuls les appels explicites à l’API passent par le serveur.
- L’interface ne charge aucune ressource externe (polices système, aucun CDN) : aucune donnée de navigation ne sort vers un tiers.

## Exploitation

```bash
systemctl status passerelle
journalctl -u passerelle -f          # journaux JSON, une ligne par requête
sudo systemctl reload passerelle     # relit passerelle.yaml
systemctl edit passerelle            # surcharges locales (port, limites…)
```

Pour changer d’adresse d’écoute, définissez `PASSERELLE_LISTEN=0.0.0.0:8080` dans `passerelle.env`, avec le jeton obligatoire et un pare-feu.

Désinstallation : `sudo ./install.sh --uninstall`. Ajoutez `--purge` pour effacer aussi `/etc/passerelle` et l’utilisateur.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `glibc … trop ancienne` | Distribution antérieure à RHEL 8 ou Debian 10. |
| Le service ne démarre pas | `journalctl -u passerelle -n 50` ; l’étape `check-config` signale une configuration illisible. |
| `/v1/validate/vector` renvoie 503 | `vector` absent : installez-le ou renseignez `PASSERELLE_VECTOR_BIN`. |
| `/v1/validate/sql` renvoie 502 | ClickHouse injoignable depuis le serveur (réseau, TLS, pare-feu). |
