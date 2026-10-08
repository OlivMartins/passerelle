# Passerelle

Passerelle accompagne la migration d’une plateforme Elasticsearch / Logstash vers ClickHouse et Vector :

- **Requêtes** : traduit une requête DSL Elasticsearch (JSON ou format console Kibana), y compris ses champs runtime Painless, en SQL optimisé pour ClickHouse.
- **Pipelines** : traduit un pipeline Logstash Kafka → Kafka en configuration Vector (YAML ou TOML) avec des étapes VRL typées.
- **Configuration** : un fichier `passerelle.yaml`, versionné avec les requêtes et les pipelines, décrit les endpoints ClickHouse et Kafka, les topics et le groupe de consommateurs.

Chaque traduction affiche un taux de couverture, une lecture en langage clair et des remarques classées : à reprendre, à vérifier, optimisation, information.

Un seul binaire fournit l’interface web, une API REST et une ligne de commande pour la CI.

## Installation

Les binaires sont publiés dans les [releases](../../releases) : `passerelle-<version>-linux-x86_64.tar.gz`, accompagné de sa somme de contrôle.

```bash
sha256sum -c passerelle-1.0.0-linux-x86_64.tar.gz.sha256
tar xzf passerelle-1.0.0-linux-x86_64.tar.gz
cd passerelle-1.0.0-linux-x86_64
sudo ./install.sh
```

Prérequis : Linux x86_64 avec glibc 2.28 ou plus récente (RHEL 8+, Debian 10+, Ubuntu 20.04+) et systemd. Node.js est embarqué dans le binaire.

Le guide complet couvre les prérequis, la configuration, l’API, le reverse proxy, la sécurité et le dépannage : [docs/INSTALL.md](docs/INSTALL.md).

## Utilisation

**Interface web** : le service écoute sur `127.0.0.1:8080`. La page `dist/passerelle.html` fonctionne aussi seule dans un navigateur, sans serveur.

**API**, avec un jeton `Authorization: Bearer` :

```bash
curl -sS -X POST "http://127.0.0.1:8080/v1/translate/dsl?index=logs-*" \
  -H "Authorization: Bearer $PASSERELLE_TOKEN" --data-binary @requete.json | jq -r .sql
```

**Ligne de commande**, en CI : le code de sortie vaut 2 si une traduction contient un élément à reprendre.

```bash
passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
passerelle ls2vector pipelines/ --config passerelle.yaml --out build/vector --fail-on todo
```

## Construire depuis les sources

Il faut Node.js 24 ; la construction du binaire demande en plus Linux x86_64.

```bash
npm ci
npm test                 # traduit tous les exemples et vérifie les résultats
npm run build:ui         # dist/passerelle.html seulement
npm run build            # interface, binaire et archive de release dans dist/
```

Si le Node.js courant n’est pas un Node.js 24 officiel pour Linux x86_64, indiquez celui à embarquer :

```bash
NODE_SEA_BASE=/chemin/vers/node24/bin/node npm run build
```

## Organisation du dépôt

```
src/engine/       moteur de traduction (socle, DSL → SQL, Logstash → Vector)
src/server.js     serveur HTTP (interface + API) et ligne de commande
src/ui/           interface web (gabarit, styles, script)
examples/         requêtes DSL et pipelines Logstash d’exemple
packaging/        unité systemd, script d’installation, configuration d’exemple
docs/INSTALL.md   guide d’installation et d’exploitation, inclus dans l’archive
scripts/          construction et tests
```

## Secrets et confidentialité

- Aucun secret n’est versionné. Les mots de passe sont des références `${VARIABLE}`, résolues au déploiement depuis `/etc/passerelle/passerelle.env`, qui n’est jamais committé.
- Les noms d’hôtes des exemples (`clickhouse.internal`, `kafka-1:9092`…) sont fictifs.
- `.gitignore` exclut les fichiers d’environnement, les certificats et clés, ainsi que les produits de construction.
- Les traductions faites dans l’interface restent dans le navigateur. Seuls les appels explicites à l’API passent par le serveur.
- L’interface ne charge aucune ressource externe : polices système, aucun CDN, aucun appel vers un tiers.

## Limites connues

- Les boucles Painless (`for`, `while`) ne sont pas traduites.
- Les requêtes `nested` doivent être réécrites avec `arrayExists`.
- Les filtres Logstash `ruby` et `aggregate` sont signalés « à reprendre », avec le code d’origine recopié en commentaire.
- `useragent` produit une structure différente de Logstash : les consommateurs doivent s’adapter.

## Licence

Apache 2.0 : voir [LICENSE](LICENSE).
