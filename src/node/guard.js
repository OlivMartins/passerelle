/*
 * Garde réseau du service : qui peut appeler l'API quand aucun jeton n'est configuré.
 *
 * Sans jeton, l'API n'est ouverte qu'à la machine elle-même. Trois verrous, qui se couvrent l'un l'autre :
 *   1. le démarrage : le service refuse d'écouter hors de la boucle locale sans jeton (requireTokenOffLoopback) ;
 *   2. la connexion : l'adresse du pair doit être une adresse de bouclage (on ne lit jamais X-Forwarded-For, que
 *      n'importe qui peut écrire) ;
 *   3. l'en-tête Host : une page web qui joue le DNS rebinding arrive depuis la boucle locale, sous un autre nom.
 * Avec un jeton, seuls les refus intersites s'appliquent : le jeton fait foi.
 */
import { isIPv4 } from 'node:net';
import { opsNormIp } from './ops.js';

// 127.0.0.0/8, ::1 et la forme IPv4-mappée de la première (::ffff:127.0.0.1)
export function isLoopbackAddress(addr) {
  const a = opsNormIp(addr);
  return a === '::1' || (isIPv4(a) && a.startsWith('127.'));
}

// Hôte d'écoute : localhost ou une adresse de bouclage. 0.0.0.0, :: et toute autre adresse écoutent le réseau.
export function isLoopbackListen(host) {
  return host === 'localhost' || isLoopbackAddress(host);
}

// Lève une erreur si l'adresse d'écoute expose l'API au réseau sans jeton.
export function requireTokenOffLoopback(host, port, authRequired) {
  if (authRequired || isLoopbackListen(host)) return;
  throw new Error(
    `écoute sur ${host}:${port} sans jeton : le service refuse de s’exposer au réseau sans authentification. ` +
      'Définissez PASSERELLE_TOKEN (ou server.tokens), ou écoutez sur la boucle locale (127.0.0.1:8080).'
  );
}

// Refus d'une requête, en clair (chaîne vide : acceptée). `rt` est la configuration d'exploitation (rt.authRequired).
// Une page web ouverte sur le poste ne doit pas pouvoir appeler l'API : requête intersite (CSRF), ou nom de domaine
// qui pointe soudain vers 127.0.0.1 (DNS rebinding), ce que seul un jeton empêchait.
export function crossSiteRefusal(req, rt) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return 'requête intersite refusée';
  if (rt.authRequired) return '';
  // Le pair, pas l'en-tête : « Host: localhost » est écrit par le client. Sans adresse (connexion déjà fermée) : refus.
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress))
    return 'sans jeton configuré (PASSERELLE_TOKEN ou server.tokens), l’API ne répond qu’aux connexions de la machine locale (127.0.0.1 ou ::1)';
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(req.headers.host || '');
  const host = m ? m[1].replace(/^\[|\]$/g, '').toLowerCase() : '';
  return host === 'localhost' || isLoopbackAddress(host)
    ? ''
    : 'sans jeton configuré (PASSERELLE_TOKEN ou server.tokens), l’API ne répond qu’aux requêtes adressées à localhost, 127.0.0.1 ou [::1]';
}
