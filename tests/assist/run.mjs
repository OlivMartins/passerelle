#!/usr/bin/env node
/*
 * Tests de « passerelle assist » (aide aux cas « à reprendre »).
 *   A  le moteur : les cas retrouvés dans une traduction, la proposition glissée à leur place, la réponse d’un modèle,
 *      la demande qu’on lui fait, les rapports
 *   B  la ligne de commande sur des filtres ruby, avec de faux Vector et Logstash (règles seules)
 *   C  le modèle local : jamais sans --local-model, jamais hors de la boucle locale, jamais autre chose que le code du cas
 *   D  la ligne de commande sur des scripts Painless
 *   E  la configuration, l’aide et le service
 * Aucun vrai moteur n’est lancé : les règles Ruby → VRL sont éprouvées contre un vrai Ruby et un vrai VRL par
 * tests/assist/ruby.mjs ; ces tests-ci prouvent que la commande compile, rejoue, signale et se tait comme elle le dit.
 * Linux seulement (les faux binaires sont des scripts exécutables).
 *   node tests/assist/run.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, copyFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { loadEngine, engineSource, serverSource } from '../../scripts/engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const E = loadEngine();
const TMP = mkdtempSync(join(tmpdir(), 'essai-assist-'));
let failures = 0;
const check = (ok, label, detail) => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${String(detail).slice(0, 700)}`}\n`);
  if (!ok) failures++;
};
const J = JSON.stringify;
const same = (a, b, label) => check(J(a) === J(b), label, `${J(a)} ≠ ${J(b)}`);
const section = name => process.stdout.write(`\n${name}\n`);

/* ---------- Jeux d’essai ---------- */
const SECRET = 'valeur-secrete-5d2c';
const logstash = (code, extra) => `input { kafka { bootstrap_servers => "kafka-interne:9092" topics => ["web-in"] codec => json } }
filter {
  ruby {
    code => "${code.replace(/"/g, '\\"')}"
  }${extra || ''}
}
output { kafka { bootstrap_servers => "kafka-interne:9092" topic_id => "web-out" codec => json } }
`;
const RULED = "event.set('computed', 'v')";          // les règles savent le reprendre
const UNRULED = "File.read('/etc/hosts')";            // elles ne le savent pas
const ingestPipeline = JSON.stringify({ description: 'essai', processors: [{ set: { field: 'ok', value: 'oui' } }, { script: { lang: 'painless', source: "label: for (def a : ctx.l) {\n  for (def b : a) { if (b == 1) { break label; } }\n}\nctx.found = true;" } }] });

/* ====================================================================== */
section('A. Le moteur');

{
  const t = E.translateLogstash(logstash("event.set('price', 'a$b')\nx = 1"), E.DEFAULT_CONFIG);
  const cases = E.assistCases(t.config);
  check(cases.length === 1 && cases[0].kind === 'ruby' && cases[0].id === 'ruby-1' && /^filtre ruby, ligne \d+$/.test(cases[0].label), 'un filtre ruby non traduit est un cas', J(cases));
  check(cases[0].code === "event.set('price', 'a$b')\nx = 1", 'le code du cas est celui d’origine : $ simple (Vector veut $$ dans le fichier), lignes dans l’ordre', J(cases[0].code));
  check(Object.values(t.config.transforms).some(x => x.source && x.source.includes("a$$b")), 'la traduction écrit bien $$ : le cas a été relu à l’envers, pas recopié');
  const before = J(t.config);
  const out = E.assistApply(t.config, cases, { 'ruby-1': { vrl: 'rb_x = 1\n.price = "a$b"', origin: 'règles' } });
  check(J(t.config) === before, 'la configuration d’origine n’est pas modifiée (une proposition n’entre jamais dans une traduction)');
  const src = out.transforms[cases[0].transform].source;
  check(/# PROPOSITION À VÉRIFIER \(règles\) — filtre ruby, ligne \d+/.test(src) && !/À TRADUIRE/.test(src), 'la proposition prend la place du commentaire, marquée « à vérifier »', src);
  check(src.includes("#   event.set('price', 'a$$b')") && src.includes('.price = "a$$b"'), 'le code d’origine reste en commentaire et la proposition est écrite avec des $$, comme tout le fichier');
  check(E.assistCases(out).length === 0, 'une proposition n’est plus un cas : on ne reprend pas deux fois');
  same(E.assistApply(t.config, cases, {}).transforms[cases[0].transform].source, t.config.transforms[cases[0].transform].source, 'sans proposition, rien ne change');

  const two = E.translateLogstash(logstash("event.set('a', 'b')", "\n  ruby { code => \"event.set('c', 'd')\" }"), E.DEFAULT_CONFIG);
  const c2 = E.assistCases(two.config);
  check(c2.length === 2 && c2[0].id === 'ruby-1' && c2[1].id === 'ruby-2' && c2[0].code.includes("'a'") && c2[1].code.includes("'c'"), 'deux filtres : deux cas, dans l’ordre', J(c2.map(c => c.code)));
  const out2 = E.assistApply(two.config, c2, { 'ruby-1': { vrl: '.a = "b"', origin: 'règles' } });
  const s2 = out2.transforms[c2[0].transform].source;
  check(s2.includes('# PROPOSITION À VÉRIFIER') && s2.includes('# À TRADUIRE : filtre ruby') && s2.indexOf('PROPOSITION') < s2.indexOf('À TRADUIRE'), 'un cas sans proposition garde son commentaire, l’autre reçoit la sienne', s2);

  const ing = E.translateIngest([{ name: 'essai', text: ingestPipeline }], E.DEFAULT_CONFIG);
  const pc = E.assistCases(ing.config);
  check(pc.length === 1 && pc[0].kind === 'painless' && pc[0].code.startsWith('label: for') && /symbole inattendu/.test(pc[0].why), 'un script Painless « à reprendre » est un cas, avec la raison du traducteur', J(pc));
}

{
  const ok = E.assistFromModel('Voici :\n```vrl\n.a = 1\n```\nfin');
  check(ok.vrl === '.a = 1', 'la réponse d’un modèle : le bloc de code, rien d’autre', J(ok));
  check(E.assistFromModel('IMPOSSIBLE').error && /ne peut pas garder/.test(E.assistFromModel('IMPOSSIBLE').error), 'IMPOSSIBLE est une réponse admise');
  check(/pas de bloc/.test(E.assistFromModel('juste du texte').error), 'une réponse sans bloc de code est refusée');
  check(/vide/.test(E.assistFromModel('```vrl\n\n```').error), 'un bloc vide est refusé');
  check(/trop longue/.test(E.assistFromModel('```vrl\n' + 'a = 1\n'.repeat(500) + '```').error), 'une proposition trop longue pour être relue est refusée');
  for (const fn of ['get_env_var!("HOME")', 'get_env_var ! ("HOME")', 'get_secret("k")', 'set_secret("k", "v")', 'remove_secret("k")', 'http_request("http://x")', 'dns_lookup("x")', 'reverse_dns("1.1.1.1")', 'get_hostname!()', 'get_enrichment_table_record("t", {})', 'find_enrichment_table_records!("t", {})', 'exec(["ls"])']) {
    const r = E.assistFromModel('```vrl\n.x = ' + fn + '\n```');
    check(!!r.error && /lit hors de l’événement/.test(r.error), `fonction interdite : ${fn.split('(')[0].trim()}`, J(r));
  }
  check(!E.assistFromModel('```vrl\n.tag = "exec"\n```').error, 'un texte qui contient « exec » n’est pas un appel');

  const p = E.assistPrompt({ kind: 'ruby', code: "event.set('a', 1)", why: '', transform: 'SECRET-TRANSFORM', sample: [SECRET], config: { x: SECRET } });
  check(Object.keys(p).sort().join() === 'system,user' && p.user.includes("event.set('a', 1)") && !p.user.includes('SECRET') && !p.system.includes('SECRET'), 'la demande tient dans le code du cas : ni transform, ni échantillon, ni configuration', J(p));
  check(!/translator stopped/.test(p.user) && !/refused by the VRL compiler/.test(p.user), 'sans raison ni refus antérieur, la demande n’en dit rien');
  const p2 = E.assistPrompt({ kind: 'painless', code: 'x', why: 'symbole inattendu' }, 'error[E100]: fallible');
  check(/translator stopped on: symbole inattendu/.test(p2.user) && /refused by the VRL compiler:\nerror\[E100\]: fallible/.test(p2.user) && /Painless/.test(p2.user), 'la raison du traducteur et le refus du compilateur sont dans la demande');
  check(/get_env_var/.test(p.system) && /IMPOSSIBLE/.test(p.system), 'les règles données au modèle interdisent de lire l’environnement et admettent IMPOSSIBLE');
}

{
  const rep = {
    kind: 'ruby', generated_at: '2026-10-28T12:00:00.000Z', passerelle: '9.9.9', values_hidden: false,
    conditions: { engines: { Vector: 'vector' }, sample: '6 événements (e.ndjson)', model: 'aucun : règles seules', notes: ['une remarque | avec barre'] },
    items: [
      { title: 'a|b <script>alert(1)</script>.conf', source: 'x;y', state: 'different', reason: 'raison; "citée"', docs: 6, diffs: ['[événement 1] k : valeurs différentes'], cases: [{ label: 'filtre ruby, ligne 3', status: 'proposed', origin: 'règles', notes: ['une note'], vrl: '.k = "<b>"' }] },
      { title: 'ok.conf', source: 'ok.conf', state: 'confirmed', reason: '', docs: 6, cases: [{ label: 'filtre ruby, ligne 2', status: 'proposed', origin: 'règles', vrl: '.z = 1' }] },
      { title: 'rien.conf', source: 'rien.conf', state: 'none', reason: '', cases: [] },
      { title: 'non.conf', source: 'non.conf', state: 'refused', reason: 'aucune proposition', cases: [{ label: 'filtre ruby, ligne 9', status: 'refused', reason: 'règles : non reprise' }] }
    ]
  };
  rep.summary = E.assistSummarize(rep.items);
  same(rep.summary.byState, { different: 1, error: 0, inconclusive: 0, not_replayed: 0, refused: 1, confirmed: 1, none: 1 }, 'bilan par état');
  check(E.assistSentence(rep.summary, 'pipeline') === '4 pipelines : 1 confirmé, 1 différent, 1 sans proposition, 1 sans cas à reprendre.', 'la phrase de bilan', E.assistSentence(rep.summary, 'pipeline'));
  const md = E.assistReportMarkdown(rep);
  check(md.includes('**Daté du 2026-10-28 12:00:00 UTC**') && md.includes('Une proposition n’est pas une traduction') && md.includes('à vérifier'), 'Markdown : daté, et la mise en garde en tête');
  check(md.indexOf('a\\|b') < md.indexOf('| ok.conf') && md.indexOf('| ok.conf') < md.indexOf('| rien.conf'), 'Markdown : les écarts d’abord, puis le reste');
  check(md.includes('```vrl\n.k = "<b>"\n```') && md.includes('(règles, **à vérifier**)') && md.includes('une remarque \\| avec barre'), 'Markdown : la proposition est citée avec son origine, les barres sont échappées');
  const html = E.assistReportHTML(rep);
  check(!html.includes('<script>alert(1)') && html.includes('a|b &lt;script&gt;alert(1)&lt;/script&gt;.conf') && html.includes('.k = &quot;&lt;b&gt;&quot;'), 'HTML : titres et propositions échappés');
  check(/prefers-color-scheme: dark/.test(html) && !/src=|href=|@import|url\(/.test(html), 'HTML : autonome, thème clair et sombre, aucune référence externe');
  const csv = E.assistReportCSV(rep);
  check(csv.startsWith('﻿') && csv.split('\r\n')[0] === '﻿titre;source;etat;cas;origine;statut_cas;raison;ecarts' && csv.includes('"raison; ""citée"""'), 'CSV : BOM, séparateur point-virgule, champs entre guillemets doublés');
  check(E.assistReportMarkdown(Object.assign({}, rep, { values_hidden: true })).includes('masquées'), 'Markdown : la mention « valeurs masquées »');
}

/* ====================================================================== */
const BIN = join(TMP, 'passerelle.cjs');
writeFileSync(BIN, "'use strict';\n" + engineSource() + serverSource());
const BINDIR = join(TMP, 'bin'); mkdirSync(BINDIR);
const FAKE_VECTOR = join(BINDIR, 'vector'); const FAKE_LOGSTASH = join(BINDIR, 'logstash');
copyFileSync(join(HERE, 'fake-vector.cjs'), FAKE_VECTOR); copyFileSync(join(HERE, 'fake-logstash.cjs'), FAKE_LOGSTASH);
chmodSync(FAKE_VECTOR, 0o755); chmodSync(FAKE_LOGSTASH, 0o755);
const FAKE_LOG = join(TMP, 'fake.log');
const fakeLog = () => (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const resetLog = () => rmSync(FAKE_LOG, { force: true });
const validations = () => fakeLog().filter(x => x.tool === 'vector' && x.mode === 'validate');
const replays = () => fakeLog().filter(x => x.tool === 'vector' && x.mode === 'replay');

function cli(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: Object.assign({ PATH: process.env.PATH, FAKE_LOG, VECTOR_FAKE_LOG: FAKE_LOG, VECTOR_FAKE_ENGINE: join(ROOT, 'scripts', 'engine.mjs'), PASSERELLE_VECTOR_BIN: FAKE_VECTOR }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const json = r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } };
const acli = (args, env) => cli(['assist', ...args], env);

const PIPES = join(TMP, 'pipelines'); mkdirSync(PIPES);
const write = (name, text) => { const f = join(PIPES, name); writeFileSync(f, text); return f; };
const WEB = write('web.conf', logstash(RULED));
const NOPE = write('nope.conf', logstash(UNRULED));
const MIX = write('mix.conf', logstash(RULED, `\n  ruby { code => "${UNRULED}" }`));
const PLAIN = write('plain.conf', `input { kafka { bootstrap_servers => "kafka-interne:9092" topics => ["web-in"] codec => json } }
filter { mutate { add_field => { "pipeline" => "web" } } }
output { kafka { bootstrap_servers => "kafka-interne:9092" topic_id => "web-out" codec => json } }
`);
const PRICE = write('price.conf', logstash("event.set('price', 'a$b')"));
const SAMPLE = join(TMP, 'echantillon.ndjson');
writeFileSync(SAMPLE, Array.from({ length: 6 }, (_, i) => J({ n: i + 1, user: i % 2 ? SECRET : 'visiteur', level: 'info' })).join('\n') + '\n');
const workDirs = () => new Set(readdirSync(tmpdir()).filter(f => /^passerelle-assist-/.test(f)));

/* ====================================================================== */
section('B. passerelle assist ruby (règles seules, faux Vector et faux Logstash)');

{
  const leftovers = workDirs();
  resetLog();
  let r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  let rep = json(r);
  check(r.code === 0 && rep, 'une proposition qui donne les mêmes événements : confirmée, code 0', `${r.code} ${r.stderr}`);
  if (rep) {
    const it = rep.items[0];
    check(rep.kind === 'ruby' && it.state === 'confirmed' && it.docs === 6 && it.cases.length === 1, 'un pipeline, un cas, six événements', J(rep.items));
    const c = it.cases[0];
    check(c.status === 'proposed' && c.origin === 'règles' && c.vrl === '.computed = "v"', 'la proposition vient des règles et est citée', J(c));
    check(rep.conditions.model === 'aucun : règles seules' && /6 événements \(echantillon\.ndjson\)/.test(rep.conditions.sample) && /logstash/.test(rep.conditions.engines.Référence), 'le rapport dit le modèle (aucun), l’échantillon et la référence', J(rep.conditions));
    check(rep.conditions.notes.some(n => /moins de 100 événements/.test(n)), 'un petit échantillon est signalé');
  }
  const vs = validations(); const rp = replays();
  check(vs.length === 2 && /À TRADUIRE : filtre ruby/.test(vs[0].text) && !/À TRADUIRE/.test(vs[1].text) && /PROPOSITION À VÉRIFIER/.test(vs[1].text), 'Vector compile deux fois : la traduction seule, puis la traduction avec la proposition', vs.map(x => x.text.slice(0, 80)));
  check(rp.length === 1 && rp[0].interp === 'true' && rp[0].args.includes('--quiet') && /\.computed = "v"/.test(rp[0].text) && !/À TRADUIRE/.test(rp[0].text), 'Vector rejoue l’échantillon avec la proposition à la place du commentaire', rp[0] && rp[0].text.slice(0, 200));
  check(rp[0] && /^api:\n {2}enabled: false$/m.test(rp[0].text) && /^data_dir: .*passerelle-assist-/m.test(rp[0].text) && /type: file/.test(rp[0].text) && !/kafka/.test(rp[0].text), 'le rejeu : pas d’API, un dossier de données à soi, des sorties en fichiers, aucun Kafka', rp[0] && rp[0].text.slice(0, 300));
  check([...workDirs()].every(f => leftovers.has(f)), 'les fichiers de travail sont supprimés');

  // Les fichiers du rapport et la configuration proposée
  const OUT = join(TMP, 'aide');
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--out', OUT]);
  const files = existsSync(OUT) ? readdirSync(OUT) : [];
  check(r.code === 0 && ['md', 'html', 'csv', 'json'].every(e => files.some(f => /^assistance-ruby-\d{8}-\d{6}Z\./.test(f) && f.endsWith(`.${e}`))) && files.includes('web.propositions.yaml'), '--out : le rapport en quatre formats, et la configuration proposée à côté', files.join(' '));
  const yaml = existsSync(join(OUT, 'web.propositions.yaml')) ? readFileSync(join(OUT, 'web.propositions.yaml'), 'utf8') : '';
  check(/^# Configuration Vector générée par Passerelle/.test(yaml) && /# PROPOSITIONS À VÉRIFIER \(passerelle assist\)/.test(yaml) && /# PROPOSITION À VÉRIFIER \(règles\)/.test(yaml) && /\.computed = "v"/.test(yaml) && /type: kafka/.test(yaml), 'la configuration proposée est celle du pipeline entier, en-tête conservé, chaque proposition marquée', yaml.slice(0, 400));
  const md = files.find(f => f.endsWith('.md')) ? readFileSync(join(OUT, files.find(f => f.endsWith('.md'))), 'utf8') : '';
  check(/Une proposition n’est pas une traduction/.test(md) && /confirmée sur l’échantillon/.test(md) && /```vrl\n\.computed = "v"\n```/.test(md), 'le rapport Markdown porte la mise en garde, l’état et la proposition');
  check(/rapport →/.test(r.stderr) && /propositions \(à vérifier\)/.test(r.stderr), 'la sortie dit où sont le rapport et les propositions');

  // Un écart
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_LS_TWEAK: `computed=${SECRET}-ref` });
  rep = json(r);
  check(r.code === 2 && rep && rep.items[0].state === 'different' && rep.items[0].diffs.some(d => /computed : Logstash .*-ref" \/ Vector avec la proposition/.test(d)) && rep.items[0].diffs.length <= 4, 'la proposition diffère de Logstash : code 2, l’écart cite le champ et les deux valeurs', J(rep && rep.items[0].diffs));
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--no-values'], { FAKE_LS_TWEAK: `computed=${SECRET}-ref` });
  check(r.code === 2 && !r.stdout.includes(SECRET) && /valeurs différentes/.test(r.stdout), '--no-values : l’écart reste signalé, aucune valeur n’est citée');
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--ignore', 'computed'], { FAKE_LS_TWEAK: 'computed=autre' });
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'confirmed' && rep.conditions.notes.some(n => /Champs écartés des deux côtés avant la comparaison : computed/.test(n)), '--ignore : le champ est écarté des deux côtés, et le rapport le dit', r.stderr);

  // Référence déjà produite
  const REF = join(TMP, 'reference.ndjson');
  writeFileSync(REF, readFileSync(SAMPLE, 'utf8').split('\n').filter(Boolean).map(l => J(Object.assign(JSON.parse(l), { computed: 'v' }))).join('\n') + '\n');
  const lsBefore = fakeLog().filter(x => x.tool === 'logstash').length;
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--reference', REF, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'confirmed' && fakeLog().filter(x => x.tool === 'logstash').length === lsBefore && /événements déjà produits/.test(rep.conditions.engines.Référence), '--reference : pas de Logstash lancé, les événements déjà produits servent de référence', r.stderr);

  // $ : le code Ruby d’un texte contenant « $ » traverse le fichier de Vector sans se déformer
  r = await acli(['ruby', PRICE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'confirmed' && replays().at(-1).text.includes('a$$b') && rep.items[0].cases[0].vrl === '.price = "a$b"', 'un « $ » dans le code : écrit $$ dans la configuration de Vector, rendu $ dans la proposition citée, événement identique', r.stderr);

  // Pas de rejeu, pas de proposition, proposition partielle, rien à reprendre
  const rpBefore = replays().length;
  r = await acli(['ruby', WEB, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'not_replayed' && /non rejouée/.test(rep.items[0].reason) && replays().length === rpBefore && rep.conditions.notes.some(n => /Aucune proposition n’a été rejouée/.test(n)), 'sans échantillon ni référence : compilée par Vector, non rejouée, et le rapport le dit', r.stderr);
  r = await acli(['ruby', WEB, '--format', 'json', '--strict']);
  check(r.code === 2, '--strict : une proposition non rejouée fait échouer');
  r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'refused' && rep.items[0].cases[0].status === 'refused' && /règles : /.test(rep.items[0].cases[0].reason) && /--local-model peut en demander/.test(rep.items[0].cases[0].reason), 'ce que les règles ne savent pas : sans proposition, avec la raison et la piste du modèle local', J(rep && rep.items[0]));
  r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--strict']);
  check(r.code === 2, '--strict : un cas sans proposition fait échouer');
  const rpMix = replays().length;
  r = await acli(['ruby', MIX, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'inconclusive' && rep.items[0].cases.map(c => c.status).join() === 'proposed,refused' && /1 cas sur 2 sans proposition/.test(rep.items[0].reason) && replays().length === rpMix, 'un cas sur deux : non concluant, et rien n’est rejoué (un pipeline à moitié repris ne prouve rien)', J(rep && rep.items[0]));
  r = await acli(['ruby', PLAIN, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--strict']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'none', 'un pipeline sans filtre ruby : rien à reprendre, même avec --strict');
  r = await acli(['ruby', PIPES, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json']);
  rep = json(r);
  check(rep && rep.items.length === 5 && rep.summary.total === 5, 'un dossier : chaque pipeline est un élément du rapport', r.stderr);

  // Les refus de Vector
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { VECTOR_FAKE_REFUSE: '.computed' });
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'refused' && rep.items[0].cases[0].status === 'refused' && /Vector refuse la proposition \(error\[E100\]/.test(rep.items[0].cases[0].reason), 'Vector refuse la proposition : elle n’est ni gardée ni rejouée', J(rep && rep.items[0].cases[0]));
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { VECTOR_FAKE_REFUSE: 'À TRADUIRE' });
  rep = json(r);
  check(r.code === 1 && rep && rep.items[0].state === 'error' && /Vector refuse déjà la traduction/.test(rep.items[0].reason), 'Vector refuse déjà la traduction : en erreur, la proposition n’y est pour rien', J(rep && rep.items[0].reason));
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { VECTOR_FAKE_FAIL: '1' });
  rep = json(r);
  check(r.code === 1 && rep && rep.items[0].state === 'error' && /Vector : code 3/.test(rep.items[0].reason), 'Vector échoue au rejeu : en erreur (code 1)', J(rep && rep.items[0].reason));
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json'], { FAKE_LS_FAIL: '1' });
  rep = json(r);
  check(r.code === 1 && rep && /Logstash : code 3/.test(rep.items[0].reason), 'Logstash échoue : en erreur (code 1)');
  r = await acli(['ruby', WEB, '--format', 'json', '--vector-bin', join(TMP, 'absent')]);
  check(r.code === 1 && /binaire introuvable/.test(r.stderr), 'Vector introuvable : message clair, code 1', r.stderr);

  // Arguments
  r = await acli(['ruby']);
  check(r.code === 1 && /aucun pipeline à lire/.test(r.stderr), 'sans pipeline : message clair');
  r = await acli(['ruby', WEB, '--sample', join(TMP, 'absent.ndjson')]);
  check(r.code === 1 && /échantillon introuvable/.test(r.stderr), 'échantillon introuvable : message clair');
  r = await acli(['ruby', WEB, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--reference', REF]);
  check(r.code === 1 && /deux références/.test(r.stderr), '--logstash-bin et --reference ensemble : refusé');
  r = await acli(['ruby', WEB, '--format', 'xml']);
  check(r.code === 1 && /--format attend/.test(r.stderr), 'format inconnu : message clair');
  r = await acli(['ruby', join(TMP, 'rien')]);
  check(r.code === 1 && /introuvable/.test(r.stderr), 'chemin inexistant : message clair');
  r = await acli(['frobnicate']);
  check(r.code === 1 && /sous-commande inconnue : assist frobnicate/.test(r.stderr), 'sous-commande inconnue');
  r = await acli([]);
  check(r.code === 1 && /sous-commande inconnue : assist/.test(r.stderr), 'sans sous-commande');
}

/* ====================================================================== */
section('C. Le modèle local');

// Un faux modèle sur la boucle locale ; chaque demande reçue est gardée
function fakeModel(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(body); } catch (e) { /* gardé tel quel */ }
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw: body, body: parsed });
      const a = answer(seen.length, parsed, req);
      if (a === 'hang') return;
      res.writeHead(a.status || 200, { 'content-type': 'application/json' });
      res.end(a.raw !== undefined ? a.raw : J(req.url.includes('chat/completions') ? { choices: [{ message: { content: a.content } }] } : { message: { content: a.content } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
const fence = vrl => '```vrl\n' + vrl + '\n```';
const mcli = (m, args, env, extra) => acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--local-model', '--model-endpoint', m.url, '--model-name', 'fake'].concat(extra || [], args || []), Object.assign({ FAKE_LS_TWEAK: 'computed=modèle' }, env));
const flat = m => m.seen.map(s => s.raw).join('\n');

{
  // Le chemin normal : règles refusées, le modèle propose, Vector compile, le banc rejoue
  const m = await fakeModel(() => ({ content: fence('.computed = "modèle"') }));
  let r = await mcli(m);
  let rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'confirmed' && rep.items[0].cases[0].origin === 'modèle local fake' && rep.items[0].cases[0].vrl === '.computed = "modèle"', 'le modèle propose ce que les règles ne savent pas : compilée, rejouée, confirmée', `${r.code} ${r.stderr}`);
  check(m.seen.length === 1 && m.seen[0].method === 'POST' && m.seen[0].url === '/api/chat' && m.seen[0].body.model === 'fake' && m.seen[0].body.stream === false && m.seen[0].body.options.temperature === 0, 'une seule demande, à /api/chat, sans flux, à température 0', J(m.seen.map(s => [s.url, s.body && s.body.model])));
  check(rep && /ollama, modèle fake, 127\.0\.0\.1:\d+ \(boucle locale; il ne reçoit que le code des cas/.test(rep.conditions.model.replace('boucle locale ;', 'boucle locale;')), 'le rapport dit quel modèle, où, et ce qu’il a reçu', rep && rep.conditions.model);
  const body = flat(m);
  check(body.includes(UNRULED.replace(/'/g, "'")) && m.seen[0].body.messages.length === 2 && m.seen[0].body.messages[1].content.includes("File.read('/etc/hosts')"), 'la demande contient le code du cas');
  for (const forbidden of [SECRET, 'visiteur', 'kafka-interne', 'web-in', 'web-out', 'bootstrap', TMP, 'logstash_finalize', 'data_dir', 'nope.conf']) check(!body.includes(forbidden), `la demande ne contient pas « ${forbidden === TMP ? 'le dossier de travail' : forbidden} »`, body.slice(0, 300));
  check(!m.seen[0].headers.authorization && m.seen[0].headers.host === `127.0.0.1:${m.port}`, 'la demande ne porte aucun jeton');
  check(replays().at(-1).text.includes('# PROPOSITION À VÉRIFIER (modèle local fake)'), 'la proposition du modèle est marquée « à vérifier » avec son origine dans la configuration rejouée');
  const mdOut = join(TMP, 'aide-modele');
  r = await mcli(m, [], {}, ['--out', mdOut]);
  const md = readFileSync(join(mdOut, readdirSync(mdOut).find(f => f.endsWith('.md'))), 'utf8');
  check(/modèle local fake, \*\*à vérifier\*\*/.test(md) && /relisez-la ligne à ligne/.test(md), 'le rapport range la proposition d’un modèle parmi celles à relire de près');
  m.server.close();
}

{
  // Un modèle configuré n’est pas un modèle permis : il faut --local-model
  const m = await fakeModel(() => ({ content: fence('.computed = "modèle"') }));
  const CFG = join(TMP, 'avec-modele.yaml');
  writeFileSync(CFG, `assist:\n  model:\n    endpoint: ${m.url}\n    model: fake\n`);
  let r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--config', CFG]);
  let rep = json(r);
  check(m.seen.length === 0 && rep && rep.items[0].state === 'refused' && /aucune proposition|--local-model peut en demander/.test(rep.items[0].cases[0].reason), 'une adresse de modèle dans la configuration ne suffit pas : sans --local-model, aucune connexion', `${m.seen.length} ${r.stderr}`);
  r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--config', CFG, '--local-model'], { FAKE_LS_TWEAK: 'computed=modèle' });
  rep = json(r);
  check(m.seen.length === 1 && rep && rep.items[0].state === 'confirmed', 'avec --local-model, l’adresse de la configuration est employée', r.stderr);
  r = await acli(['ruby', NOPE, '--local-model', '--model-endpoint', m.url]);
  check(r.code === 1 && /nom du modèle/.test(r.stderr), '--local-model sans nom de modèle : refusé');
  r = await acli(['ruby', NOPE, '--local-model', '--model-endpoint', m.url, '--model-name', 'x', '--model-api', 'gopher']);
  check(r.code === 1 && /--model-api attend ollama ou openai/.test(r.stderr), 'API de modèle inconnue : refusée');
  r = await acli(['ruby', NOPE, '--local-model', '--model-name', 'x']);
  check(r.code === 1 && /n’a pas d’adresse/.test(r.stderr), 'pas d’adresse de modèle : refusé');
  m.server.close();
}

{
  // Seule la boucle locale est admise, avant toute connexion
  const m = await fakeModel(() => ({ content: fence('.computed = "modèle"') }));
  const bad = ['http://192.0.2.7:11434', 'http://10.0.0.5', 'http://example.com:11434', 'http://0.0.0.0:11434', 'http://[::ffff:7f00:1]:11434', 'http://localhost.evil.example:11434', 'https://127.0.0.1:11434', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:11434', 'http://[2001:db8::1]:11434', 'http://169.254.169.254', 'not an url'];
  for (const url of bad) {
    const t0 = Date.now();
    const r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--local-model', '--model-endpoint', url, '--model-name', 'fake']);
    check(r.code === 1 && /boucle locale|illisible|identifiant|bouclage|n’a pas d’adresse/.test(r.stderr) && Date.now() - t0 < 5000, `modèle refusé : ${url}`, `${r.code} ${r.stderr.slice(0, 200)}`);
  }
  check(m.seen.length === 0, 'aucune de ces adresses n’a donné lieu à une connexion');
  for (const url of [`http://localhost:${m.port}`, `http://127.0.0.1:${m.port}/`, `http://127.1:${m.port}`, `http://127.0.0.1:${m.port}/api`]) {
    const before = m.seen.length;
    const r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--local-model', '--model-endpoint', url, '--model-name', 'fake'], { FAKE_LS_TWEAK: 'computed=modèle' });
    check(r.code === 0 && m.seen.length === before + 1, `modèle admis : ${url}`, `${r.code} ${r.stderr.slice(0, 200)}`);
  }
  check(m.seen.at(-1).url === '/api/api/chat', 'un préfixe dans l’adresse est conservé');
  // Aucun proxy : la demande est directe
  const before = m.seen.length;
  const r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--local-model', '--model-endpoint', m.url, '--model-name', 'fake'], { FAKE_LS_TWEAK: 'computed=modèle', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' });
  check(r.code === 0 && m.seen.length === before + 1, 'le modèle est joint directement, jamais par le proxy de l’environnement', r.stderr);
  m.server.close();
}

{
  // Compilation et nouvel essai
  const answers = [fence('.computed = BROKEN'), fence('.computed = "modèle"')];
  const m = await fakeModel(n => ({ content: answers[Math.min(n - 1, 1)] }));
  let r = await mcli(m, [], { VECTOR_FAKE_REFUSE: 'BROKEN' });
  let rep = json(r);
  check(rep && rep.items[0].state === 'confirmed' && m.seen.length === 2, 'une proposition que Vector refuse : le modèle réessaie, la seconde est gardée', `${m.seen.length} ${r.stderr}`);
  const retry = m.seen[1].body.messages[1].content;
  check(/refused by the VRL compiler/.test(retry) && /error\[E100\]: fallible predicate/.test(retry) && !/<tmp>|passerelle-assist/.test(retry), 'le second essai reçoit le message du compilateur, sans chemin de la machine', retry.slice(-300));
  check(!replays().some(x => x.text.includes('BROKEN')), 'une proposition refusée par Vector n’est jamais rejouée');
  m.seen.length = 0;
  r = await mcli(m, [], { VECTOR_FAKE_REFUSE: 'BROKEN' }, []);
  const CFG1 = join(TMP, 'un-essai.yaml'); writeFileSync(CFG1, `assist:\n  model:\n    max_attempts: 1\n`);
  m.seen.length = 0;
  r = await mcli(m, ['--config', CFG1], { VECTOR_FAKE_REFUSE: 'BROKEN' });
  rep = json(r);
  check(m.seen.length === 1 && rep && rep.items[0].state === 'refused' && /modèle local : Vector refuse la proposition/.test(rep.items[0].cases[0].reason) && /après 1 essai/.test(rep.items[0].cases[0].reason), 'max_attempts: 1 : un seul essai, puis sans proposition', J(rep && rep.items[0].cases[0]));
  m.server.close();
}

{
  // Ce que le modèle répond de refusable
  const scenarios = [
    ['une fonction qui lit l’environnement', () => ({ content: fence('.computed = get_env_var!("HOME")') }), /lit hors de l’événement/, 2],
    ['IMPOSSIBLE', () => ({ content: 'IMPOSSIBLE' }), /ne peut pas garder le comportement/, 1],
    ['une réponse sans bloc de code', () => ({ content: 'je ne sais pas' }), /pas de bloc de code/, 2],
    ['une erreur HTTP', () => ({ status: 500, raw: '{"error":"boom"}' }), /modèle local : HTTP 500/, 1],
    ['une réponse illisible', () => ({ raw: 'pas du json' }), /réponse illisible/, 1]
  ];
  for (const [label, answer, reason, calls] of scenarios) {
    const m = await fakeModel(answer);
    const r = await mcli(m);
    const rep = json(r);
    check(r.code === 0 && rep && rep.items[0].state === 'refused' && reason.test(rep.items[0].cases[0].reason) && m.seen.length === calls, `modèle : ${label} → sans proposition (${calls} demande${calls > 1 ? 's' : ''})`, `${m.seen.length} ${J(rep && rep.items[0].cases[0])}`);
    m.server.close();
  }
  check(!validations().some(x => x.text.includes('get_env_var')), 'une proposition qui lit l’environnement n’est ni compilée ni rejouée');
  // Le modèle ne tourne pas, ou ne répond pas
  const dead = await fakeModel(() => ({ content: '' })); const port = dead.port; await new Promise(r => dead.server.close(r));
  let r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--local-model', '--model-endpoint', `http://127.0.0.1:${port}`, '--model-name', 'fake']);
  let rep = json(r);
  check(r.code === 0 && rep && /modèle local : connexion refusée/.test(rep.items[0].cases[0].reason), 'le modèle ne tourne pas : sans proposition, message clair', J(rep && rep.items[0].cases[0]));
  const slow = await fakeModel(() => 'hang');
  const CFGT = join(TMP, 'delai.yaml'); writeFileSync(CFGT, `assist:\n  model:\n    timeout: 1\n    max_attempts: 1\n`);
  const t0 = Date.now();
  r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--config', CFGT, '--local-model', '--model-endpoint', slow.url, '--model-name', 'fake']);
  rep = json(r);
  check(r.code === 0 && rep && /modèle local : délai dépassé/.test(rep.items[0].cases[0].reason) && Date.now() - t0 < 15000, 'le modèle ne répond pas : délai dépassé après la durée configurée', J(rep && rep.items[0].cases[0]));
  slow.server.closeAllConnections(); slow.server.close();
  // Une API compatible OpenAI
  const o = await fakeModel(() => ({ content: fence('.computed = "modèle"') }));
  r = await mcli(o, ['--model-api', 'openai']);
  rep = json(r);
  check(rep && rep.items[0].state === 'confirmed' && o.seen[0].url === '/v1/chat/completions' && o.seen[0].body.temperature === 0 && o.seen[0].body.messages.length === 2, 'API compatible OpenAI : /v1/chat/completions, même demande', `${o.seen[0] && o.seen[0].url} ${r.stderr}`);
  r = await acli(['ruby', NOPE, '--sample', SAMPLE, '--logstash-bin', FAKE_LOGSTASH, '--format', 'json', '--local-model', '--model-endpoint', `${o.url}/v1`, '--model-name', 'fake', '--model-api', 'openai'], { FAKE_LS_TWEAK: 'computed=modèle' });
  check(o.seen.at(-1).url === '/v1/chat/completions', 'une adresse qui finit par /v1 ne double pas le préfixe');
  o.server.close();
}

/* ====================================================================== */
section('D. passerelle assist painless');

{
  const IDIR = join(TMP, 'ingest'); mkdirSync(IDIR);
  const INGEST = join(IDIR, 'essai.json');
  writeFileSync(INGEST, ingestPipeline);
  const ISAMPLE = join(TMP, 'docs.ndjson');
  const docs = Array.from({ length: 4 }, (_, i) => ({ n: i + 1, l: [[1, 2], [3]], user: i % 2 ? SECRET : 'visiteur' }));
  writeFileSync(ISAMPLE, docs.map(d => J(d)).join('\n') + '\n');
  const IREF = join(TMP, 'attendu.ndjson');
  writeFileSync(IREF, docs.map(d => J(Object.assign({}, d, { ok: 'oui', found: true }))).join('\n') + '\n');
  const m = await fakeModel(() => ({ content: fence('.found = true') }));
  const pcli = (args, env) => acli(['painless', INGEST, '--format', 'json'].concat(args), env);

  let r = await pcli(['--local-model', '--model-endpoint', m.url, '--model-name', 'fake', '--sample', ISAMPLE, '--reference', IREF]);
  let rep = json(r);
  check(r.code === 0 && rep && rep.kind === 'painless' && rep.items[0].state === 'confirmed' && rep.items[0].docs === 4 && rep.items[0].cases[0].origin === 'modèle local fake', 'un script Painless repris par le modèle, rejoué contre les documents d’Elasticsearch : confirmé', `${r.code} ${r.stderr}`);
  const body = flat(m);
  check(m.seen.length === 1 && body.includes('label: for (def a : ctx.l)') && /translator stopped on: .*symbole inattendu/.test(m.seen[0].body.messages[1].content) && /Painless/.test(m.seen[0].body.messages[1].content), 'la demande contient le script et la raison du traducteur', body.slice(0, 300));
  for (const forbidden of [SECRET, 'visiteur', 'essai.json', TMP, 'agent_in', 'data_dir', '0.0.0.0:5044']) check(!body.includes(forbidden), `la demande ne contient pas « ${forbidden === TMP ? 'le dossier de travail' : forbidden} »`);
  const rp = replays().at(-1);
  const cfg = JSON.parse(rp.text);
  check(cfg.sources.agent_in_raw.type === 'stdin' && Object.values(cfg.sinks).every(s => s.type === 'file') && cfg.api.enabled === false && cfg.data_dir.includes('passerelle-assist-') && Object.keys(cfg.sources).length === 1, 'le rejeu : l’entrée standard à la place de la source Elastic Agent, des fichiers à la place des sorties, pas d’API', J(Object.keys(cfg.sources)));
  check(cfg.transforms.ingest_essai.source.includes('# PROPOSITION À VÉRIFIER (modèle local fake)') && cfg.transforms.ingest_essai.source.includes('.found = true') && !cfg.transforms.ingest_essai.source.includes('À REPRENDRE'), 'la proposition prend la place du commentaire « À REPRENDRE »');

  const OUT = join(TMP, 'aide-ingest');
  r = await pcli(['--local-model', '--model-endpoint', m.url, '--model-name', 'fake', '--sample', ISAMPLE, '--reference', IREF, '--out', OUT]);
  check(existsSync(join(OUT, 'ingest.propositions.yaml')) && /PROPOSITION À VÉRIFIER \(modèle local fake\)/.test(readFileSync(join(OUT, 'ingest.propositions.yaml'), 'utf8')), 'la configuration proposée est écrite à part', existsSync(OUT) && readdirSync(OUT).join(' '));

  // Un écart avec Elasticsearch, un champ écarté, pas de référence, pas de modèle
  writeFileSync(IREF + '.2', docs.map(d => J(Object.assign({}, d, { ok: 'oui', found: false }))).join('\n') + '\n');
  r = await pcli(['--local-model', '--model-endpoint', m.url, '--model-name', 'fake', '--sample', ISAMPLE, '--reference', IREF + '.2']);
  rep = json(r);
  check(r.code === 2 && rep && rep.items[0].state === 'different' && rep.items[0].diffs.some(d => /found : référence false \/ Vector avec la proposition true/.test(d)), 'la proposition diffère d’Elasticsearch : code 2, écart cité', J(rep && rep.items[0].diffs));
  r = await pcli(['--local-model', '--model-endpoint', m.url, '--model-name', 'fake', '--sample', ISAMPLE, '--reference', IREF + '.2', '--ignore', 'found']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'confirmed', '--ignore found : champ écarté des deux côtés');
  r = await pcli(['--local-model', '--model-endpoint', m.url, '--model-name', 'fake']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'not_replayed' && rep.items[0].cases[0].status === 'proposed', 'sans échantillon ni référence : proposée, compilée, non rejouée');
  const before = m.seen.length;
  r = await pcli(['--sample', ISAMPLE, '--reference', IREF]);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'refused' && /aucune règle pour Painless/.test(rep.items[0].cases[0].reason) && m.seen.length === before, 'sans --local-model, un script Painless n’a pas de proposition (les règles ne couvrent que Ruby)');
  r = await pcli(['--logstash-bin', FAKE_LOGSTASH]);
  check(r.code === 1 && /ne sert qu’aux filtres ruby/.test(r.stderr), '--logstash-bin avec Painless : refusé');
  r = await acli(['painless', join(IDIR, 'rien.json'), '--format', 'json']);
  check(r.code === 1 && /introuvable/.test(r.stderr), 'fichier introuvable : message clair');
  const NONE = join(IDIR, 'simple.json'); writeFileSync(NONE, J({ processors: [{ set: { field: 'a', value: 'b' } }] }));
  r = await acli(['painless', NONE, '--format', 'json']);
  rep = json(r);
  check(r.code === 0 && rep && rep.items[0].state === 'none', 'un pipeline sans script à reprendre : rien à reprendre');
  m.server.close();
}

/* ====================================================================== */
section('E. Configuration, aide et service');

{
  const CFG = join(TMP, 'modele-distant.yaml');
  writeFileSync(CFG, 'assist:\n  model:\n    endpoint: http://10.0.0.5:11434\n    model: gros\n');
  let r = await cli(['check-config', '--config', CFG]);
  check(/attention : assist\.model\.endpoint : 10\.0\.0\.5 n’est pas une adresse de bouclage/.test(r.stderr) && /assist:/.test(r.stdout) && /model: gros/.test(r.stdout), 'check-config signale une adresse de modèle hors de la boucle locale, et montre la section', r.stderr + r.stdout.slice(-200));
  writeFileSync(CFG, 'assist:\n  model:\n    endpoint: http://localhost:11434\n    model: petit\n');
  r = await cli(['check-config', '--config', CFG]);
  check(!/assist\.model/.test(r.stderr) && /configuration lisible\./.test(r.stderr), 'une adresse locale ne donne aucun avertissement', r.stderr);
  writeFileSync(CFG, 'assist:\n  model:\n    endpoint: https://127.0.0.1:1\n');
  r = await cli(['check-config', '--config', CFG]);
  check(/https:\/\/ n’est pas admis/.test(r.stderr), 'https est signalé');
  writeFileSync(CFG, 'assist:\n  model:\n    endpont: http://127.0.0.1:1\n');
  r = await cli(['check-config', '--config', CFG]);
  check(r.code === 1 && /clé inconnue dans .*assist\.model\.endpont/.test(r.stderr), 'une clé mal écrite est refusée');
  r = await cli(['check-config']);
  check(r.code === 0 && !/^assist:/m.test(r.stdout), 'avec les valeurs par défaut, la section assist n’est pas affichée');
  r = await cli(['--help']);
  check(/passerelle assist ruby/.test(r.stdout + r.stderr) && /passerelle assist painless/.test(r.stdout + r.stderr) && /--local-model/.test(r.stdout + r.stderr), 'l’aide présente la commande');

  // Le service ne diffuse pas l’adresse du modèle
  const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  writeFileSync(CFG, 'assist:\n  model:\n    endpoint: http://127.0.0.1:41999\n    model: secret-model-name\n');
  const UI = join(TMP, 'ui.html'); writeFileSync(UI, '<!doctype html><title>essai</title>');
  const srv = spawn(process.execPath, [BIN, 'serve', '--config', CFG, '--listen', `127.0.0.1:${port}`], { env: { PATH: process.env.PATH, PASSERELLE_UI: UI }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', d => { srvErr += d; });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { const h = await fetch(`http://127.0.0.1:${port}/healthz`); up = h.ok; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  check(up, 'le service démarre avec la section assist', srvErr);
  if (up) {
    const text = await (await fetch(`http://127.0.0.1:${port}/v1/config`)).text();
    check(!/assist|41999|secret-model-name/.test(text), 'GET /v1/config ne cite ni la section assist ni l’adresse du modèle');
  }
  srv.kill();
}

/* ---------- Fin ---------- */
rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${failures ? `${failures} échec(s)` : 'tout est vert'}\n`);
process.exit(failures ? 1 : 0);
