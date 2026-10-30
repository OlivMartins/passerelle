#!/usr/bin/env node
/*
 * Faux Logstash des tests de « passerelle assist » : il rejoue l’échantillon (entrée fichier) et applique les seuls
 * event.set('champ', 'texte') du pipeline, où qu’ils soient. Variables : FAKE_LOG, FAKE_LS_FAIL, FAKE_LS_TWEAK=champ=valeur.
 */
const fs = require('fs');
const args = process.argv.slice(2);
const conf = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
if (process.env.FAKE_LOG)
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'logstash', args, conf }) + '\n');
if (process.env.FAKE_LS_FAIL) {
  process.stderr.write('[ERROR] pipeline interrompu\n');
  process.exit(3);
}
const input = /path => "([^"]+)" mode => "read"/.exec(conf)[1];
const events = fs
  .readFileSync(input, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => JSON.parse(l));
const sets = [...conf.matchAll(/event\.set\(\s*'([^']+)'\s*,\s*'([^']*)'\s*\)/g)].map(m => [m[1], m[2]]);
for (const e of events) {
  for (const [k, v] of sets) e[k] = v;
  if (process.env.FAKE_LS_TWEAK) {
    const [k, v] = process.env.FAKE_LS_TWEAK.split('=');
    e[k] = v;
  }
}
for (const m of conf.matchAll(/file \{ path => "([^"]+)" codec => json_lines \}/g))
  fs.writeFileSync(m[1], events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
