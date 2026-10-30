#!/usr/bin/env node
/*
 * Banc des règles « filtre ruby → VRL » de « passerelle assist ».
 * Chaque cas est un morceau de Ruby et des événements. Le Ruby est joué pour de bon (shim.rb : un faux LogStash::Event
 * sur un Hash, les mêmes get / set / remove / tag / cancel), sa traduction par le VRL de Vector (sous-commande « vector vrl »
 * ou binaire « vrl »), et les événements obtenus sont comparés champ par champ, types compris.
 *
 * Ce que Ruby refuse (une exception de Ruby) n’est pas comparé : Logstash étiquette l’événement _rubyexception, ce que la
 * proposition ne cherche pas à reproduire ; le nombre d’événements écartés est affiché.
 *
 *   node tests/assist/ruby.mjs              ignoré (sortie 0) sans Ruby ou sans VRL
 *   node tests/assist/ruby.mjs --require    échoue sans Ruby ou sans VRL (la CI)
 *   RUBY=…  VRL_BIN=…  VECTOR_BIN=…         binaires à employer (VECTOR_BIN : « vector vrl » ; VRL_BIN : le binaire « vrl »)
 *   --only=<regex>  --verbose
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../scripts/engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const E = loadEngine();
const args = process.argv.slice(2);
const require_ = args.includes('--require');
const verbose = args.includes('--verbose');
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const RUBY = process.env.RUBY || 'ruby';
const VRL = process.env.VRL_BIN
  ? [process.env.VRL_BIN]
  : process.env.VECTOR_BIN
    ? [process.env.VECTOR_BIN, 'vrl']
    : ['vrl'];

const probe = (cmd, a) => {
  const r = spawnSync(cmd, a, { encoding: 'utf8' });
  return !r.error && r.status === 0;
};
const missing = [];
if (!probe(RUBY, ['--version'])) missing.push(`Ruby (${RUBY})`);
if (!probe(VRL[0], VRL.slice(1).concat(['--help']))) missing.push(`VRL (${VRL.join(' ')})`);
if (missing.length) {
  process.stdout.write(
    `${require_ ? '✗' : '–'} banc ruby → VRL ${require_ ? 'impossible' : 'ignoré'} : ${missing.join(' et ')} introuvable\n`
  );
  process.exit(require_ ? 1 : 0);
}

const TMP = mkdtempSync(join(tmpdir(), 'essai-assist-'));
let failures = 0;
let checks = 0;
const check = (ok, label, detail) => {
  checks++;
  if (verbose || !ok)
    process.stdout.write(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${String(detail).slice(0, 900)}`}\n`);
  if (!ok) failures++;
};
const canon = x =>
  Array.isArray(x)
    ? x.map(canon)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, canon(x[k])])
        )
      : x;
const J = JSON.stringify;

function rubyRun(code, events) {
  const rb = join(TMP, 'c.rb');
  const ev = join(TMP, 'e.ndjson');
  writeFileSync(rb, code);
  writeFileSync(ev, events.map(e => J(e)).join('\n') + '\n');
  const r = spawnSync(RUBY, [join(HERE, 'shim.rb'), rb, ev], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ruby : ${r.stderr}`);
  return r.stdout
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
}
function vrlRun(program, event) {
  const one = join(TMP, 'one.json');
  const vp = join(TMP, 'p.vrl');
  writeFileSync(one, J(event) + '\n');
  writeFileSync(vp, program + '\n');
  const r = spawnSync(VRL[0], VRL.slice(1).concat(['-i', one, '-p', vp, '-o']), { encoding: 'utf8' });
  const text = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
  if (/error\[E\d+\]/.test(text)) return { compile: text.split('\n').slice(0, 12).join('\n') };
  if (/^\s*aborted\s*$/m.test(text) && !/^\s*\{/m.test(text)) return { event: null };
  try {
    return { event: JSON.parse((r.stdout || '').trim()) };
  } catch (e) {
    return { unreadable: text.slice(0, 400) };
  }
}

/* Les cas : [identifiant, code Ruby, événements] */
const SAME = [
  [
    'produit',
    "event.set('computed', event.get('[body][items][qty]').to_i * 2)",
    [
      { body: { items: { qty: '4' } } },
      { body: { items: { qty: 'x' } } },
      { body: { items: { qty: 7 } } },
      { body: { items: { qty: '12.9' } } },
      {}
    ]
  ],
  [
    'interpolation',
    "event.set('x', \"#{event.get('a')}-#{event.get('b')}\")\nevent.remove('tmp') if event.get('lvl') == 'debug'",
    [{ a: 'p', b: 'q', lvl: 'debug', tmp: 1 }, { a: 1, b: 2.5, lvl: 'info', tmp: 1 }, { a: 'z' }]
  ],
  [
    'si-sinon',
    "if event.get('a') =~ /^foo\\d+/\n  event.tag('foo')\nelsif event.get('b').to_i > 3\n  event.set('c', 1)\nelse\n  event.cancel\nend",
    [{ a: 'foo12' }, { a: 'bar', b: '9' }, { a: 'bar', b: '1' }, { a: 'foo', tags: ['x'] }]
  ],
  [
    'sinon-si-calculé',
    "if event.get('a').to_s.empty?\n  event.set('k', 'vide')\nelsif event.get('b').to_i > 5\n  event.set('k', 'grand')\nelsif event.get('b').to_i > 2 && event.get('c')\n  event.set('k', 'moyen')\nelse\n  event.set('k', 'petit')\nend",
    [
      { a: '', b: 9 },
      { a: 'x', b: 9 },
      { a: 'x', b: 3, c: 'y' },
      { a: 'x', b: 3 },
      { a: 'x', b: '1' }
    ]
  ],
  [
    'découpe',
    "event.set('p', event.get('a').split(','))",
    [{ a: 'a,b,,' }, { a: 'a,b' }, { a: '' }, { a: ',,,' }, { a: ',a' }, { a: 'a' }]
  ],
  [
    'texte',
    "event.set('u', event.get('a').to_s.upcase.strip)\nevent.set('l', event.get('a').to_s.length)\nevent.set('e', event.get('a').to_s.empty?)",
    [{ a: ' hello ' }, { a: '' }, { a: 12 }, {}]
  ],
  [
    'tranches',
    "event.set('s', event.get('msg').to_s[0..3])\nevent.set('t', event.get('msg').to_s[1...3])\nevent.set('u', event.get('msg').to_s[2..-1])",
    [{ msg: 'abcdefg' }, { msg: 'ab' }, { msg: '' }]
  ],
  [
    'sub-gsub',
    "event.set('q', event.get('a').gsub(/\\s+/, '_').downcase)\nevent.set('r', event.get('a').sub(/(\\w+) (\\w+)/, '\\2 \\1'))",
    [{ a: 'Hello Big  World' }, { a: 'x' }]
  ],
  [
    'nombres',
    "event.set('d', event.get('a').to_f / 3)\nevent.set('e', event.get('a').to_i / 3)\nevent.set('f', event.get('a').to_i % 3)",
    [{ a: '10' }, { a: '-7' }, { a: 'abc' }, { a: 9 }]
  ],
  [
    'division-modulo',
    "event.set('q', event.get('a').to_i / event.get('b').to_i)\nevent.set('r', event.get('a').to_f / event.get('b').to_f)\nevent.set('m', event.get('a').to_i % event.get('b').to_i)",
    [
      { a: '7', b: '2' },
      { a: '7', b: '0' },
      { a: '-7', b: '-2' },
      { a: '7', b: '-2' },
      { a: '-7', b: '2' }
    ]
  ],
  [
    'to_i-to_f',
    "event.set('i', event.get('a').to_i)\nevent.set('f', event.get('a').to_f)",
    [
      { a: '12abc' },
      { a: ' 7' },
      { a: '-3.9' },
      { a: '1e3' },
      { a: '.5' },
      { a: 'abc' },
      { a: '' },
      { a: 4.7 },
      { a: true }
    ]
  ],
  [
    'valeur-par-défaut',
    "event.set('y', event.get('a') || 'défaut')\nevent.set('z', event.get('a') ? 'oui' : 'non')",
    [{ a: 'v' }, { a: '' }, { a: 0 }, { a: false }, { a: null }, {}]
  ],
  [
    '||=',
    "t = event.get('a')\nt ||= 'neuf'\nevent.set('t', t)\nn = 0\nn ||= 5\nevent.set('n', n)",
    [{ a: 'v' }, {}, { a: false }]
  ],
  [
    'logique',
    "ok = event.get('a') && event.get('b')\nevent.set('ok', ok)\nko = event.get('a') || event.get('b')\nevent.set('ko', ko)\nevent.set('neg', !event.get('a'))",
    [{ a: '1', b: '2' }, { a: null, b: '2' }, { a: '1' }, {}]
  ],
  [
    'ternaire',
    "event.set('s', event.get('n').to_i > 10 ? 'big' : 'small')\nevent.set('u', event.get('n').to_i.zero? ? 1 : 2)",
    [{ n: '11' }, { n: '3' }, { n: '0' }]
  ],
  [
    'regex',
    "if event.get('m') =~ /^ERR(\\d+)/\n  event.tag('err')\nend\nevent.tag('ok') if event.get('m') !~ /fatal/i\nevent.set('mm', event.get('m').to_s.match?(/a.c/))",
    [{ m: 'ERR12 boom' }, { m: 'FATAL' }, { m: 'abc' }, { m: 'xx' }]
  ],
  [
    'étiquettes',
    "event.tag('t1')\nevent.tag('t1')\nevent.tag('t2') if event.get('x') == 'y'",
    [{}, { tags: ['t1'] }, { tags: 'solo', x: 'y' }]
  ],
  [
    'retrait-annulation',
    "event.remove('secret')\nevent.cancel if event.get('drop') == 'yes'",
    [{ secret: 'x', drop: 'yes' }, { secret: 'x', drop: 'no' }, {}]
  ],
  [
    'présence',
    "event.set('has', event.include?('a'))\nevent.set('inc', event.get('tags').include?('b'))",
    [{ a: 1, tags: ['a', 'b'] }, { tags: ['a'] }, { tags: 'b' }, {}]
  ],
  [
    'taille-et-appartenance',
    "event.set('l', event.get('a').length)\nevent.set('i', event.get('a').include?('b'))",
    [{ a: 'abc' }, { a: ['b', 'c'] }, { a: [] }]
  ],
  [
    'boucle-somme',
    "total = 0\nevent.get('items').each do |it|\n  total += it['qty'].to_i\nend\nevent.set('total', total)",
    [{ items: [{ qty: '2' }, { qty: 3 }] }, { items: [] }]
  ],
  [
    'boucle-condition',
    "n = 0\nevent.get('a').each do |v|\n  if v.to_s.start_with?('x')\n    n += 1\n  end\nend\nevent.set('n', n)",
    [{ a: ['xa', 'b', 'xc'] }, { a: [] }]
  ],
  [
    'boucle-clés',
    "res = []\nevent.get('h').each do |k, v|\n  res << k\nend\nevent.set('keys', res)",
    [{ h: { a: 1, b: 2 } }]
  ],
  [
    'boucle-indice',
    "event.get('a').each_with_index do |v, i|\n  event.set('f', \"#{i}=#{v}\")\nend",
    [{ a: ['p', 'q'] }, { a: [] }]
  ],
  [
    'map-select',
    "event.set('b', event.get('a').map { |v| v.to_s.upcase })\nevent.set('c', event.get('a').select { |v| v != 'x' })",
    [{ a: ['x', 'y'] }, { a: [] }]
  ],
  [
    'reject-compact-uniq',
    "event.set('r', event.get('a').reject { |v| v.to_s.empty? })\nevent.set('c', event.get('a').compact.uniq)",
    [{ a: ['x', '', 'y', 'x', null] }, { a: [] }]
  ],
  [
    'join-first-last',
    "event.set('j', event.get('a').join('/'))\nevent.set('f', event.get('a').first)\nevent.set('l', event.get('a').last)",
    [{ a: ['p', 'q', 'r'] }, { a: ['z'] }]
  ],
  [
    'flatten',
    "event.set('f', [event.get('a'), event.get('b')].flatten.compact)",
    [{ a: [1, 2], b: 3 }, { a: 1, b: [2, [3]] }, {}]
  ],
  [
    'préfixe-suffixe',
    "event.tag('api') if event.get('path').to_s.start_with?('/api')\nevent.tag('json') if event.get('path').to_s.end_with?('.json')",
    [{ path: '/api/x.json' }, { path: '/web' }, {}]
  ],
  [
    'champs-imbriqués',
    "event.set('[a][b][c]', event.get('x'))\nevent.set('[a][n]', 1)",
    [{ x: 'v' }, { x: { k: 1 } }, { a: { z: 1 } }]
  ],
  [
    'arrondis',
    "event.set('r', event.get('a').to_f.round)\nevent.set('r2', event.get('a').to_f.round(1))\nevent.set('fl', event.get('a').to_f.floor)\nevent.set('ce', event.get('a').to_f.ceil)",
    [{ a: '2.5' }, { a: '-2.5' }, { a: '3.14159' }]
  ],
  [
    'variables-de-branche',
    "if event.get('a')\n  x = 'A'\n  if event.get('b')\n    y = 'B'\n  else\n    y = 'b'\n  end\n  event.set('xy', x + y)\nend",
    [{ a: 1, b: 1 }, { a: 1 }, { b: 1 }]
  ],
  ['nil-vers-texte', "n = nil\nevent.set('n', n.to_s)\nevent.set('m', \"v=#{n}\")", [{}]],
  [
    'interpolation-nombre',
    "event.set('s', \"n=#{event.get('n').to_i + 1} v=#{event.get('v')}\")",
    [{ n: '4', v: 'z' }, { n: 'x' }, {}]
  ]
];

/* Ce que le module doit refuser plutôt que traduire de travers : [identifiant, code Ruby, morceau du motif attendu] */
const REFUSED = [
  ['méthode inconnue', "event.set('a', event.get('b').frobnicate)", /non reprise/],
  ['champ calculé', "k = 'a'\nevent.set(k, 1)", /champ|variable/],
  ['plus entre deux inconnus', "event.set('c', event.get('a') + event.get('b'))", /type inconnu/],
  ['division de type inconnu', "event.set('c', event.get('a') / 2)", /entière ou décimale/],
  ['anticipation', "event.set('c', event.get('a') =~ /a(?=b)/)", /expression régulière|syntaxe/],
  [
    'bloc à plusieurs instructions',
    "event.set('c', event.get('a').map { |v| w = v.to_s; w.upcase })",
    /une expression|syntaxe/
  ],
  ['instruction sans effet', "puts event.get('a')", /sans effet|non repris|syntaxe/],
  ['aucune instruction', '# rien', /aucune instruction/],
  ['appel système', "event.set('a', `ls`)", /caractère|syntaxe|non repris/],
  ['require', "require 'json'\nevent.set('a', JSON.parse(event.get('m')))", /non repris|inconnue|syntaxe/]
];

let ran = 0;
let skipped = 0;
for (const [id, code, events] of SAME) {
  if (only && !new RegExp(only).test(id)) continue;
  ran++;
  const r = E.assistRuby(code);
  if (r.error) {
    check(false, `${id} : une proposition était attendue`, r.error);
    continue;
  }
  const expected = rubyRun(code, events);
  let bad = '';
  let compared = 0;
  events.forEach((ev, i) => {
    if (bad) return;
    const exp = expected[i];
    const got = vrlRun(r.vrl, ev);
    if (got.compile) {
      bad = `le VRL ne compile pas :\n${got.compile}\n--- VRL ---\n${r.vrl}`;
      return;
    }
    if (got.unreadable) {
      bad = `sortie illisible : ${got.unreadable}`;
      return;
    }
    if (exp.exception) {
      skipped++;
      return;
    }
    compared++;
    const want = exp.cancelled ? null : exp.event;
    if (J(canon(got.event)) !== J(canon(want))) bad = `événement ${J(ev)} : Ruby ${J(want)} ≠ VRL ${J(got.event)}`;
  });
  check(!bad, `${id} (${compared} événement${compared > 1 ? 's' : ''} comparé${compared > 1 ? 's' : ''})`, bad);
}
for (const [id, code, motif] of REFUSED) {
  if (only && !new RegExp(only).test(id)) continue;
  ran++;
  const r = E.assistRuby(code);
  check(!!r.error && motif.test(r.error), `refusé : ${id}`, r.error ? r.error : `proposé : ${r.vrl}`);
}

rmSync(TMP, { recursive: true, force: true });
process.stdout.write(
  `${failures ? '✗' : '✓'} banc ruby → VRL : ${ran} cas, ${checks - failures} vérifications réussies${failures ? `, ${failures} échec(s)` : ''}${skipped ? ` (${skipped} événements écartés : exception de Ruby)` : ''}\n`
);
process.exit(failures ? 1 : 0);
