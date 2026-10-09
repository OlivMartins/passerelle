# Politique de sécurité

## Versions maintenues

| Version | Correctifs de sécurité |
|---|---|
| 1.0.x | Oui |

## Signaler une vulnérabilité

Merci de ne pas ouvrir de ticket public pour une faille de sécurité.

Utilisez le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability**. Le rapport n’est visible que des mainteneurs.

Pour un traitement rapide, précisez :

- la version de Passerelle et le mode d’utilisation (interface autonome, service systemd, API, CLI) ;
- la configuration concernée, sans secret réel ;
- les étapes pour reproduire et l’impact constaté.

Le correctif est publié dans une nouvelle version, accompagné d’un avis de sécurité. Le rapporteur y est crédité s’il le souhaite.

## Périmètre

Sont concernés le binaire `passerelle`, l’interface web, l’API REST, la ligne de commande, l’unité systemd et le script d’installation fournis dans ce dépôt.

Les configurations Vector et les requêtes SQL générées doivent être relues avant toute mise en production. Le guide d’installation, [docs/INSTALL.md](docs/INSTALL.md), décrit le durcissement en place.
