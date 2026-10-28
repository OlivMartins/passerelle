#!/usr/bin/env node
/*
 * Faux Vector des tests de « passerelle assist ». Il ne sait ni compiler ni jouer du VRL : il lit la configuration (YAML ou
 * JSON), refuse celle qui contient VECTOR_FAKE_REFUSE, et rejoue les événements avec le seul sous-ensemble que les tests
 * emploient dans les transforms remap :
 *     rb_x = <littéral>      .champ = <littéral> | rb_x      del(.champ)
 * Le reste du VRL est ignoré. Les symboles $$ redeviennent $ (l’interpolation que Vector fait avec l’option demandée).
 *   validate --skip-healthchecks FICHIER     code 0, ou 1 avec une erreur au format de Vector
 *   --quiet --color never --config FICHIER   les événements de l’entrée standard vont dans les sorties « file »
 * Variables (préfixe VECTOR_ : seules celles-là passent jusqu’à « vector validate », qui filtre l’environnement) :
 *   VECTOR_FAKE_LOG (journal JSON), VECTOR_FAKE_ENGINE (scripts/engine.mjs), VECTOR_FAKE_REFUSE, VECTOR_FAKE_FAIL, VECTOR_FAKE_TWEAK=champ=valeur
 */
const fs = require('fs');
const { pathToFileURL } = require('url');
const log = o => { if (process.env.VECTOR_FAKE_LOG) fs.appendFileSync(process.env.VECTOR_FAKE_LOG, JSON.stringify(o) + '\n'); };
const literal = t => {
  t = t.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return { v: JSON.parse(t) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { v: Number(t) };
  if (t === 'true' || t === 'false') return { v: t === 'true' };
  if (t === 'null') return { v: null };
  return null;
};
(async () => {
  const args = process.argv.slice(2);
  if (args.includes('validate')) {
    const text = fs.readFileSync(args[args.length - 1], 'utf8');
    log({ tool: 'vector', mode: 'validate', text });
    const bad = process.env.VECTOR_FAKE_REFUSE;
    if (bad && text.includes(bad)) { process.stdout.write(`error[E100]: fallible predicate (faux Vector : « ${bad} » refusé)\n`); process.exit(1); }
    process.stdout.write('Validated\n'); process.exit(0);
  }
  const conf = args[args.indexOf('--config') + 1];
  const text = fs.readFileSync(conf, 'utf8');
  log({ tool: 'vector', mode: 'replay', args, interp: process.env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION, text });
  if (process.env.VECTOR_FAKE_FAIL) { process.stderr.write('configuration refusée par le faux Vector\n'); process.exit(3); }
  const { loadEngine } = await import(pathToFileURL(process.env.VECTOR_FAKE_ENGINE).href);
  const cfg = /\.json$/.test(conf) ? JSON.parse(text) : loadEngine().yamlLoad(text);
  const events = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const prog = Object.values(cfg.transforms || {}).filter(t => t && t.type === 'remap').map(t => String(t.source || '')).join('\n').replace(/\$\$/g, '$').split('\n').filter(l => !/^\s*#/.test(l));
  for (const e of events) {
    const vars = {};
    for (const line of prog) {
      let m;
      if ((m = /^\s*(rb_\w+) = (.+)$/.exec(line))) { const l = literal(m[2]); if (l) vars[m[1]] = l.v; continue; }
      if ((m = /^\s*\.(\w+) = (.+)$/.exec(line))) {
        const l = literal(m[2]);
        if (l) e[m[1]] = l.v; else if (/^rb_\w+$/.test(m[2].trim()) && m[2].trim() in vars) e[m[1]] = vars[m[2].trim()];
        continue;
      }
      if ((m = /^\s*del\(\.(\w+)\)\s*$/.exec(line))) delete e[m[1]];
    }
    if (process.env.VECTOR_FAKE_TWEAK) { const [k, v] = process.env.VECTOR_FAKE_TWEAK.split('='); e[k] = v; }
  }
  const sinks = Object.values(cfg.sinks || {}).filter(s => s && s.type === 'file' && s.path);
  if (!sinks.length) { process.stderr.write('aucun sink file dans la configuration\n'); process.exit(4); }
  for (const s of sinks) fs.writeFileSync(s.path, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
})().catch(e => { process.stderr.write(`faux Vector : ${e.stack}\n`); process.exit(5); });
