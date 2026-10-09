# Journal des modifications

Toutes les évolutions notables de Passerelle sont consignées ici. Le format s’inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les versions suivent le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- Présentation du projet : README, bannière, démonstration animée et captures en thème clair et sombre.
- Fichiers `LICENSE`, `NOTICE` et licence de Node.js inclus dans l’archive de release.
- Politique de sécurité (`SECURITY.md`).

## [1.0.0] - 2026-10-08

### Ajouté

- Traduction des requêtes DSL Elasticsearch en SQL ClickHouse : 28 types de requêtes, 51 agrégations, champs runtime Painless, syntaxe Lucene, format console Kibana.
- Traduction des pipelines Logstash en configurations Vector : 18 filtres, conditions, aiguillage des sorties, Kafka en entrée et en sortie, mode shadow.
- Interface web autonome, API REST et ligne de commande pour l’intégration continue.
- Configuration `passerelle.yaml` versionnable, secrets par variables d’environnement.
- Paquet Linux x86_64 : binaire unique, unité systemd durcie, script d’installation.

[Non publié]: https://github.com/OlivMartins/passerelle/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OlivMartins/passerelle/releases/tag/v1.0.0
