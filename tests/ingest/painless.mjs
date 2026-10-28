#!/usr/bin/env node
/*
 * Scripts Painless traduits : les documents rejoués dans Vector donnent ce que Painless donnerait. Chaque cas de
 * tests/ingest/cas/ est joué sur des documents dont le résultat attendu est écrit ici, à la main, d’après la sémantique de Java.
 *
 *   VECTOR_BIN=vector node tests/ingest/painless.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E, play } from './commun.mjs';

const cas = join(dirname(fileURLToPath(import.meta.url)), 'cas');
let failed = 0;
const check = (ok, name, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failed++; };
const canon = x => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])])) : x;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const traduire = f => { const r = E.translateIngest([{ name: f, text: readFileSync(join(cas, f), 'utf8') }], E.DEFAULT_CONFIG); const err = r.notes.filter(n => n.level === 'err'); if (err.length) throw new Error(`${f} non traduit : ${err[0].detail}`); return r; };

// Expressions régulières, lambdas, ensembles, StringBuilder, caractères, bits, dates, throw, gsub MAC
{
  const r = traduire('painless_regex.yml');
  const base = { nom: 'fooBarBaz', num: '123', total: 9, cat: { a: 1, b_c: 2 }, event: {}, items: ['x', null, '', 'y'], tags: ['a', 'b', 'a', 'c'], seen: [], debut: '2020-04-01T12:03:00Z', fin: '2020-04-01T12:03:02.5Z', _conf: { z: 1 }, flags: 13, big: 72057594037927936, mac: 'aabbccddeeff', json: { a: 1, b: null, workspace_id: null }, h: '0x1F', mode: 420 };
  const [d] = play(r, [base]);
  const att = {
    snake: 'foo_Bar_Baz', snake2: 'foo_bar_baz', est_num: true, a_num: false, event: { a: 1, b_c: 2 }, items: ['x', 'y'], seen: ['a', 'b', 'a', 'c'],
    uniques: ['a', 'b', 'c'], sb: 'fooBarBaz-4', res: 'foo_bar_baz', n: 1, sous: ['b', 'a', 'c'], duree: 2500000000, sec: 1585742580,
    conf_vu: { z: 1 }, bit: true, bas: 5, haut: true, milieu: 'a', plus: 1585915380, apres: false, mac: 'aa-bb-cc-dd-ee-ff', apres_throw: true, hex: 31, oct: '644', json: { a: 1, workspace_id: 'Default' }, json_txt: '{"a":1,"workspace_id":"Default"}',
    empreinte: 'dbea8cd007898de3c8a902068e956c9cd09ab50e'
  };
  for (const [k, v] of Object.entries(att)) check(same(d[k], v), `Painless ${k}`, `attendu ${JSON.stringify(v)}, obtenu ${JSON.stringify(d[k])}`);
  check(d._conf === undefined, 'Painless ctx.remove supprime le champ', JSON.stringify(d._conf));
  // L’ordre de sortie n’est pas garanti entre documents réussis et en échec : chacun est retrouvé par son contenu
  const sortie = play(r, [{ ...base, mac: 'aabbc' }, { ...base, stop: 'oui' }]);
  const impair = sortie.find(x => !x.__echec) || {}; const arret = sortie.find(x => x.__echec) || {};
  check(impair.mac === 'aa-bb-c', 'gsub (..)(?!$) : longueur impaire', impair.mac);
  check(arret.__echec && /arrêt demandé : oui/.test(arret.__echec.message), 'throw : le processeur échoue avec le message', JSON.stringify(arret.__echec));
}

// Fonction récursive : recopiée sur des niveaux bornés ; trop profond, le document échoue
{
  const r = traduire('painless_recursion.yml');
  const sortie = play(r, [
    { donnees: { firstName: 'A', subObj: { userId: 1, deepObj: { xY: 3 } } } },
    { donnees: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } }
  ]);
  const ok = sortie.find(x => !x.__echec) || {}; const trop = sortie.find(x => x.__echec) || {};
  check(same(ok.donnees, { first_name: 'A', sub_obj: { user_id: 1, deep_obj: { x_y: 3 } } }), 'récursion : snake_case à tous les niveaux', JSON.stringify(ok.donnees));
  check(trop.__echec && /plus profond/.test(trop.__echec.message), 'récursion : un document trop profond échoue, il n’est pas traité de travers', JSON.stringify(trop.__echec));
}

// Références : une variable qui désigne un objet de ctx, un argument modifié par une fonction, l’élément d’une boucle
{
  const r = traduire('painless_reference.yml');
  const [d] = play(r, [{
    a: {}, c: {}, l: [{}, {}], audit: { obj: {} }, rules: [{ groups: ['', 'apps'] }, { groups: ['x', ''] }], m: { p: {}, q: {}, r: 1 },
    n: { a: 'x', b: 2 }, o: { a: null, b: { c: '', d: 1 }, e: [null, 'z', {}] }, o2: { a: '', b: { c: null }, d: 1 }, r: { x: 1 }, s: {}, u: {}, garde: ''
  }]);
  const att = {
    a: { b: 1 }, c: { d: 2 }, l: [{ f: 3 }, { f: 3 }], audit: { obj: { g: 'core' } }, rules: [{ groups: ['core', 'apps'] }, { groups: ['x', 'core'] }],
    found: ['i-1', 'i-2'], device: { id: ['a', 'b'] }, m: { p: { seen: true }, q: { seen: true }, r: 1 }, n: { a: 'X', b: 2 },
    o: { b: { d: 1 }, e: ['z'] }, o2: { d: 1 }, r: {}, s: { t: 5 }, seen_t: 5, u: { v: 7 }, p1v: 7, garde: ''
  };
  for (const [k, v] of Object.entries(att)) check(same(d[k], v), `référence ${k}`, `attendu ${JSON.stringify(v)}, obtenu ${JSON.stringify(d[k])}`);
  // Rattachement selon la branche : seul l’objet de la branche suivie est modifié
  const base = { a: {}, c: {}, l: [], audit: {}, rules: [], m: {}, n: {}, o: {}, o2: {}, r: {}, s: {}, u: {}, za: {}, zc: {} };
  const [k1, k2, k3, d1, d2] = play(r, [{ ...base, k: 1 }, { ...base, k: 2 }, { ...base, k: 3 }, { ...base, k: 1, lg: { details: { x: 1 } } }, { ...base, k: 1, lg: { details: 'texte' } }]);
  check(same([k1.za, k1.zc], [{ b: 1 }, {}]), 'branche 1 : seul ctx.za est modifié', JSON.stringify([k1.za, k1.zc]));
  check(same([k2.za, k2.zc], [{}, { b: 1 }]), 'branche 2 : seul ctx.zc est modifié', JSON.stringify([k2.za, k2.zc]));
  check(same([k3.za, k3.zc, k3.zlocal], [{}, {}, { b: 1 }]), 'aucune branche : la table locale est modifiée, ctx ne l’est pas', JSON.stringify([k3.za, k3.zc, k3.zlocal]));
  check(same(d1.lg, { details: { x: 1, cle: 'valeur' } }) && same(d2.lg, { details: { cle: 'valeur' } }), 'table existante complétée, sinon remplacée', JSON.stringify([d1.lg, d2.lg]));
}

// Boucles à compteur, while, tri (script et processeur sort), tableaux, conversion vers une classe Java
{
  const r = traduire('painless_boucles.yml');
  const [d] = play(r, [{ nums: [5, 3, 9, 1, 7], texte: 'a,b,,c', mots: ['poire', 'Abricot', 'pomme', 'abricot'], objs: [{ k: 'b', v: 1 }, { k: 'a', v: 2 }, { k: 'c', v: 3 }], nombre: 42, prio: 134 }]);
  const att = {
    pairs: [3, 1], rev: [7, 1, 9, 3, 5], virgules: 3, j: 8, tries: ['Abricot', 'abricot', 'poire', 'pomme'],
    objs: [{ k: 'a', v: 2 }, { k: 'b', v: 1 }, { k: 'c', v: 3 }], desc: [9, 7, 5, 3, 1], big: 42, cles: ['k', 'v'],
    mots_desc: ['pomme', 'poire', 'abricot', 'Abricot'], sev: 6, fac: 16, dbl: 268
  };
  for (const [k, v] of Object.entries(att)) check(same(d[k], v), `boucle/tri ${k}`, `attendu ${JSON.stringify(v)}, obtenu ${JSON.stringify(d[k])}`);
  const [mix] = play(r, [{ nums: [1], texte: '', mots: ['a', 1], objs: [{ k: 'a' }], nombre: 1 }]);
  check(mix.__echec && /cannot be cast|non comparables/.test(mix.__echec.message), 'tri d’une liste mêlant textes et nombres : le document échoue', JSON.stringify(mix.__echec));
}

// Matcher en variable, Pattern.split, String.split à la Java, remove en expression, flux
{
  const r = traduire('painless_flux.yml');
  const [d] = play(r, [{ tags: 'T1059 et T1027.002', ver: 'tlsv1.2', mac: 'AB12-CD34-EF56', liste: 'a|b||c', csv: 'a,b,,', res: { ARN: 'x', y: 1 }, nums: [1, 2, 3, 4, 5, 6], mots: ['poire', 'pomme', 'kiwi'], metriques: { '1m_rate': 1, '5m_rate': 2, '1m_count': 3 } }]);
  const att = {
    ids: ['1059', '1027'], proto: 'tlsv', num: '1', mac_ok: true, morceaux: ['a', 'b', '', 'c'], java_split: ['a', 'b'], java_split_tout: ['a', 'b', '', ''],
    res: { y: 1 }, arn: 'x', dernier: 6, reste: [1, 2, 3, 4, 5], pairs: [20, 40, 60], un_grand: true, joints: 'POIRE-POMME-KIWI', premier: 'poire'
  };
  for (const [k, v] of Object.entries(att)) check(same(d[k], v), `flux/matcher ${k}`, `attendu ${JSON.stringify(v)}, obtenu ${JSON.stringify(d[k])}`);
  check(same([...d.rate].sort(), ['1m_count', '1m_rate']), 'flux sur keySet() filtré', JSON.stringify(d.rate));
}

if (failed) { console.log(`\n${failed} échec(s)`); process.exit(1); }
console.log('\nTous les tests Painless passent.');
