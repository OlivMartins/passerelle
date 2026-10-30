/* Passerelle — moteur : aide aux cas « à reprendre » (filtres ruby de Logstash, scripts Painless) */
/*
 * Une traduction qui ne sait pas faire laisse un commentaire « À TRADUIRE » / « À REPRENDRE » et le code d’origine.
 * Ce module prépare une PROPOSITION pour ce code : jamais une traduction. Une proposition est toujours « à vérifier » ;
 * elle n’est reprise qu’après avoir été compilée par Vector et rejouée par le banc (src/node/assist.js) sur un
 * échantillon, avec ce que le moteur d’origine produit.
 *
 *   assistCases        les cas que les remarques d’une traduction laissent à reprendre
 *   assistRuby         règles : un sous-ensemble de Ruby (event.get / set / remove / tag, conditions, texte, nombres)
 *                      vers VRL. Ce qui sort du sous-ensemble n’a pas de proposition : jamais de demi-traduction.
 *   assistPrompt       la demande faite à un modèle local : le code du cas, et rien d’autre
 *   assistFromModel    ce que l’on garde de sa réponse (un bloc de VRL, sans fonction qui lit l’environnement)
 *   assistApply        la proposition glissée à la place du commentaire, dans la configuration Vector
 *
 * Rien ici n’ouvre de connexion ni de fichier : les entrées-sorties sont dans src/node/assist.js.
 */

class AssistError extends Error {}
const assistFail = msg => {
  throw new AssistError(msg);
};

/* ====================================================================== */
/* Ruby : analyse lexicale                                                */
/* ====================================================================== */
const ASSIST_RUBY_KW = new Set([
  'if',
  'elsif',
  'else',
  'unless',
  'end',
  'then',
  'and',
  'or',
  'not',
  'true',
  'false',
  'nil',
  'do'
]);
const ASSIST_RUBY_NOPE = new Set([
  'while',
  'until',
  'for',
  'case',
  'when',
  'begin',
  'rescue',
  'ensure',
  'return',
  'next',
  'break',
  'def',
  'class',
  'module',
  'loop',
  'yield',
  'redo',
  'retry',
  'lambda',
  'proc',
  'require',
  'puts',
  'print',
  'raise'
]);
const ASSIST_RUBY_OPS = [
  '**=',
  '||=',
  '&&=',
  '<=>',
  '===',
  '...',
  '**',
  '==',
  '!=',
  '=~',
  '!~',
  '<=',
  '>=',
  '&&',
  '||',
  '..',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<',
  '>>',
  '&.',
  '::',
  '->',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '?',
  ':',
  ',',
  '.',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '&',
  '^',
  '~'
];

function assistRubyTokens(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const prev = () => toks[toks.length - 1];
  // Une barre oblique ouvre une expression régulière quand une valeur est attendue
  const valueExpected = () => {
    const p = prev();
    return (
      !p ||
      p.t === 'nl' ||
      (p.t === 'op' && ![')', ']', '}'].includes(p.v)) ||
      (p.t === 'kw' && !['true', 'false', 'nil', 'end'].includes(p.v))
    );
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      // Le saut de ligne ne termine pas une instruction qui attend la suite : opérateur en fin de ligne, ou « .méthode » au début de la suivante
      const p = prev();
      let j = i + 1;
      while (j < n && /[ \t\r\n]/.test(src[j])) j++;
      const continues = p && p.t === 'op' && !['(', ')', ']', '}'].includes(p.v) && !(p.v === '|' && false);
      const leadingDot = c === '\n' && src[j] === '.' && /[A-Za-z_]/.test(src[j + 1] || '');
      if (!(continues || leadingDot) && p && p.t !== 'nl') toks.push({ t: 'nl' });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m[0].replace(/_/g, '');
      toks.push({ t: 'num', v: Number(text), float: /[.eE]/.test(text) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      let w = m[0];
      i += w.length;
      // nom? et nom! : une méthode, sauf « nom!= » (différent) et « nom?: » d’un ternaire sans espace
      if (
        (src[i] === '?' || src[i] === '!') &&
        src[i + 1] !== '=' &&
        !(src[i] === '?' && src[i + 1] === ':') &&
        !(src[i] === '!' && /[~]/.test(src[i + 1] || ''))
      ) {
        w += src[i];
        i++;
      }
      if (ASSIST_RUBY_NOPE.has(w)) assistFail(`construction Ruby non reprise : ${w}`);
      toks.push(ASSIST_RUBY_KW.has(w) ? { t: 'kw', v: w } : { t: 'id', v: w });
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && (src[i + 1] === "'" || src[i + 1] === '\\')) {
          s += src[i + 1];
          i += 2;
        } else s += src[i++];
      }
      if (i >= n) assistFail('chaîne non terminée');
      i++;
      toks.push({ t: 'str', parts: [s] });
      continue;
    }
    if (c === '"') {
      const parts = [];
      let s = '';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          const e = src[i + 1];
          i += 2;
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e === 'e' ? '\x1b' : e;
        } else if (src[i] === '#' && src[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          if (depth) assistFail('interpolation non terminée');
          if (s) parts.push(s);
          s = '';
          parts.push({ code: src.slice(i + 2, j - 1) });
          i = j;
        } else s += src[i++];
      }
      if (i >= n) assistFail('chaîne non terminée');
      i++;
      if (s || !parts.length) parts.push(s);
      toks.push({ t: 'str', parts });
      continue;
    }
    if (c === '/' && valueExpected()) {
      let j = i + 1;
      let re = '';
      while (j < n && src[j] !== '/') {
        if (src[j] === '\n') assistFail('expression régulière non terminée');
        if (src[j] === '\\') {
          re += src[j] + (src[j + 1] || '');
          j += 2;
        } else re += src[j++];
      }
      if (j >= n) assistFail('expression régulière non terminée');
      j++;
      let flags = '';
      while (/[imxounse]/.test(src[j] || '')) flags += src[j++];
      if (/#\{/.test(re)) assistFail('expression régulière interpolée');
      toks.push({ t: 're', src: re, flags });
      i = j;
      continue;
    }
    if (c === ':' && /[A-Za-z_"']/.test(src[i + 1] || '') && src[i + 1] !== ':' && valueExpected())
      assistFail('symbole Ruby non repris');
    if (c === '@' || c === '$') assistFail('variable d’instance ou globale non reprise (une capture $1 non plus)');
    const op = ASSIST_RUBY_OPS.find(o => src.startsWith(o, i));
    if (!op) assistFail(`caractère non reconnu : ${c}`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  if (toks.length && toks[toks.length - 1].t !== 'nl') toks.push({ t: 'nl' });
  return toks;
}

/* ====================================================================== */
/* Ruby : analyse syntaxique (sous-ensemble)                              */
/* ====================================================================== */
function assistRubyParse(src) {
  const toks = assistRubyTokens(src);
  let p = 0;
  const peek = () => toks[p] || { t: 'eof' };
  const isOp = v => peek().t === 'op' && peek().v === v;
  const isKw = v => peek().t === 'kw' && peek().v === v;
  const eatOp = v => (isOp(v) ? (p++, true) : false);
  const eatKw = v => (isKw(v) ? (p++, true) : false);
  const expectOp = v => {
    if (!eatOp(v)) assistFail(`« ${v} » attendu`);
  };
  const skipNl = () => {
    while (peek().t === 'nl') p++;
  };

  function block(stops, brace) {
    const body = [];
    skipNl();
    while (peek().t !== 'eof' && !(peek().t === 'kw' && stops.includes(peek().v)) && !(brace && isOp('}'))) {
      body.push(statement());
      skipNl();
    }
    return body;
  }
  function statement() {
    const t = peek();
    if (t.t === 'kw' && t.v === 'if') return ifStmt(false);
    if (t.t === 'kw' && t.v === 'unless') return ifStmt(true);
    let st = simple();
    // Forme postfixée : « instruction if condition »
    while (isKw('if') || isKw('unless')) {
      const neg = peek().v === 'unless';
      p++;
      const cond = expr();
      st = { k: 'if', branches: [{ cond: neg ? { k: 'un', op: '!', e: cond } : cond, body: [st] }], other: null };
    }
    if (peek().t !== 'nl' && peek().t !== 'eof' && !isOp('}'))
      assistFail(`syntaxe Ruby non reprise près de « ${tokText(peek())} »`);
    return st;
  }
  function ifStmt(neg) {
    p++;
    let cond = expr();
    eatKw('then');
    if (neg) cond = { k: 'un', op: '!', e: cond };
    const branches = [{ cond, body: block(['elsif', 'else', 'end']) }];
    let other = null;
    while (isKw('elsif')) {
      p++;
      const c = expr();
      eatKw('then');
      branches.push({ cond: c, body: block(['elsif', 'else', 'end']) });
    }
    if (eatKw('else')) other = block(['end']);
    if (!eatKw('end')) assistFail('« end » attendu');
    return { k: 'if', branches, other };
  }
  function simple() {
    const e = expr();
    // Affectation : variable locale seulement (event.set est une méthode)
    if (peek().t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '||=', '&&='].includes(peek().v)) {
      const op = peek().v;
      p++;
      if (e.k !== 'var') assistFail('affectation à autre chose qu’une variable locale');
      return { k: 'asgn', name: e.name, op, e: expr() };
    }
    return { k: 'expr', e };
  }
  const tokText = t => (t.t === 'op' || t.t === 'kw' || t.t === 'id' ? t.v : t.t === 'num' ? String(t.v) : t.t);

  // Priorités, de la plus faible à la plus forte
  function expr() {
    return lowOr();
  }
  function lowOr() {
    let l = lowNot();
    while (isKw('and') || isKw('or')) {
      const op = peek().v === 'and' ? '&&' : '||';
      p++;
      l = { k: 'bin', op, l, r: lowNot() };
    }
    return l;
  }
  function lowNot() {
    if (eatKw('not')) return { k: 'un', op: '!', e: lowNot() };
    return ternary();
  }
  function ternary() {
    const c = range();
    if (isOp('?')) {
      p++;
      const a = ternary();
      expectOp(':');
      const b = ternary();
      return { k: 'tern', c, a, b };
    }
    return c;
  }
  function range() {
    const a = orOp();
    if (isOp('..') || isOp('...')) {
      const excl = peek().v === '...';
      p++;
      const b = orOp();
      return { k: 'range', a, b, excl };
    }
    return a;
  }
  function orOp() {
    let l = andOp();
    while (isOp('||')) {
      p++;
      l = { k: 'bin', op: '||', l, r: andOp() };
    }
    return l;
  }
  function andOp() {
    let l = notOp();
    while (isOp('&&')) {
      p++;
      l = { k: 'bin', op: '&&', l, r: notOp() };
    }
    return l;
  }
  function notOp() {
    if (isOp('!')) {
      p++;
      return { k: 'un', op: '!', e: notOp() };
    }
    return eq();
  }
  function eq() {
    let l = cmp();
    while (peek().t === 'op' && ['==', '!=', '=~', '!~'].includes(peek().v)) {
      const op = peek().v;
      p++;
      l = { k: 'bin', op, l, r: cmp() };
    }
    return l;
  }
  function cmp() {
    let l = bitor();
    while (peek().t === 'op' && ['<', '>', '<=', '>='].includes(peek().v)) {
      const op = peek().v;
      p++;
      l = { k: 'bin', op, l, r: bitor() };
    }
    return l;
  }
  function bitor() {
    let l = shift();
    while (isOp('|')) {
      p++;
      l = { k: 'bin', op: '|', l, r: shift() };
    }
    return l;
  }
  function shift() {
    let l = add();
    while (isOp('<<')) {
      p++;
      l = { k: 'bin', op: '<<', l, r: add() };
    }
    return l;
  }
  function add() {
    let l = mul();
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = peek().v;
      p++;
      l = { k: 'bin', op, l, r: mul() };
    }
    return l;
  }
  function mul() {
    let l = unary();
    while (peek().t === 'op' && ['*', '/', '%'].includes(peek().v)) {
      const op = peek().v;
      p++;
      l = { k: 'bin', op, l, r: unary() };
    }
    return l;
  }
  function unary() {
    if (isOp('-')) {
      p++;
      const e = unary();
      return e.k === 'lit' && (e.t === 'int' || e.t === 'num')
        ? Object.assign({}, e, { v: -e.v })
        : { k: 'un', op: '-', e };
    }
    if (isOp('!')) {
      p++;
      return { k: 'un', op: '!', e: unary() };
    }
    return postfix();
  }
  function args() {
    const out = [];
    expectOp('(');
    skipNl();
    if (!isOp(')')) {
      do {
        skipNl();
        out.push(expr());
        skipNl();
      } while (eatOp(','));
    }
    expectOp(')');
    return out;
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (isOp('.') || isOp('&.')) {
        const safe = peek().v === '&.';
        p++;
        if (peek().t !== 'id' && peek().t !== 'kw') assistFail('nom de méthode attendu');
        const name = peek().v;
        p++;
        let a = [];
        if (isOp('(')) a = args();
        else if (peek().t === 'str' || peek().t === 're' || (peek().t === 'num' && false)) a = [expr()]; // « x.include? 'a' »
        const call = { k: 'call', recv: e, name, args: a, safe };
        // Bloc : « do |x| … end » ou « { |x| … } »
        if (isKw('do') || (isOp('{') && toks[p + 1] && toks[p + 1].t === 'op' && toks[p + 1].v === '|')) {
          const brace = isOp('{');
          p++;
          const params = [];
          if (eatOp('|')) {
            while (!isOp('|')) {
              if (peek().t !== 'id') assistFail('paramètre de bloc attendu');
              params.push(peek().v);
              p++;
              if (!eatOp(',')) break;
            }
            expectOp('|');
          }
          const body = brace ? block([], true) : block(['end']);
          if (brace) expectOp('}');
          else if (!eatKw('end')) assistFail('« end » attendu');
          call.block = { params, body };
        }
        e = call;
        continue;
      }
      if (isOp('[')) {
        p++;
        skipNl();
        const idx = expr();
        skipNl();
        expectOp(']');
        e = { k: 'idx', recv: e, index: idx };
        continue;
      }
      break;
    }
    return e;
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') {
      p++;
      return { k: 'lit', t: t.float ? 'num' : 'int', v: t.v };
    }
    if (t.t === 'str') {
      p++;
      if (t.parts.every(x => typeof x === 'string')) return { k: 'lit', t: 'str', v: t.parts.join('') };
      return { k: 'dstr', parts: t.parts.map(x => (typeof x === 'string' ? x : parseSub(x.code))) };
    }
    if (t.t === 're') {
      p++;
      return { k: 're', src: t.src, flags: t.flags };
    }
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) {
      p++;
      return { k: 'lit', t: 'bool', v: t.v === 'true' };
    }
    if (t.t === 'kw' && t.v === 'nil') {
      p++;
      return { k: 'lit', t: 'nil' };
    }
    if (t.t === 'id') {
      p++;
      // Appel de fonction sans receveur : non repris (sauf event, variables)
      if (isOp('(')) assistFail(`appel de fonction Ruby non repris : ${t.v}(…)`);
      return { k: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      p++;
      skipNl();
      const e = expr();
      skipNl();
      expectOp(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      p++;
      const items = [];
      skipNl();
      if (!isOp(']')) {
        do {
          skipNl();
          items.push(expr());
          skipNl();
        } while (eatOp(','));
      }
      expectOp(']');
      return { k: 'arr', items };
    }
    if (t.t === 'op' && t.v === '{') assistFail('table (hash) Ruby non reprise');
    assistFail(`syntaxe Ruby non reprise près de « ${tokText(t)} »`);
  }
  function parseSub(code) {
    const sub = assistRubyParse('x = (' + code + ')');
    return sub[0].e;
  }

  const prog = block([]);
  if (peek().t !== 'eof') assistFail(`syntaxe Ruby non reprise près de « ${tokText(peek())} »`);
  return prog;
}

/* ====================================================================== */
/* Ruby → VRL                                                             */
/* ====================================================================== */
/*
 * Types suivis pendant la traduction : str, int, float (flottant connu), num (entier ou flottant), bool, list, null, any.
 * Un champ lu par event.get est « any ». VRL refuse un repli (« ?? ») ou une affectation d’erreur sur une expression
 * qu’il sait infaillible, et une expression qu’il juge faillible sans l’un des deux : il en sait souvent plus que ce
 * module (une variable qui vient de recevoir 0 est un entier pour lui). Aucune conversion n’emploie donc « ?? » : elle
 * teste le type à l’exécution (is_string, is_integer…) puis convertit avec « ! », que VRL accepte sur les deux.
 * Les expressions que VRL n’accepte pas entre parenthèses (if / else) sont rangées dans une variable rb__N.
 * Quand le type manque pour choisir, il n’y a pas de proposition.
 */
class AssistRuby {
  constructor(opts) {
    this.ns = !(opts && opts.ns === false);
    this.lines = [];
    this.ind = 0;
    this.locals = new Map();
    this.notes = new Set();
    this.n = 0;
    // Plusieurs propositions partagent un même programme VRL : leurs variables temporaires ne portent pas les mêmes noms
    this.tag = opts && opts.tag ? `${opts.tag}_` : '';
  }
  note(s) {
    this.notes.add(s);
  }
  emit(s) {
    this.lines.push('  '.repeat(this.ind) + s);
  }
  fresh() {
    return `rb__${this.tag}${++this.n}`;
  }
  varName(n) {
    return `rb_${n}`;
  }
  nilNote() {
    this.note(
      'Ruby lève une exception (étiquette _rubyexception) quand une méthode s’applique à nil ; la proposition prend alors une valeur neutre ("" ou 0) et continue.'
    );
  }
  path(key) {
    if (key.k !== 'lit' || key.t !== 'str')
      assistFail('nom de champ calculé : seul un texte fixe est repris dans event.get / event.set');
    return vPathOf(fieldSegs(key.v), this.ns);
  }
  hoist(code, t) {
    const v = this.fresh();
    this.emit(`${v} = ${code}`);
    return { c: v, t };
  }
  // Une expression qui sera répétée dans un test : un chemin ou une variable, sinon rangée dans une variable
  simple(e) {
    return /^(\.|%|rb_)[A-Za-z0-9_."@%-]*$/.test(e.c) ? e : this.hoist(e.c, e.t);
  }
  merge(maps) {
    const out = new Map();
    for (const k of new Set(maps.flatMap(m => [...m.keys()]))) {
      const ts = maps.map(m => m.get(k));
      out.set(k, ts.every(t => t === ts[0]) ? ts[0] : 'any');
    }
    return out;
  }

  /* ----- conversions ----- */
  str(e) {
    if (e.t === 'str') return e.c;
    if (e.t === 'null') return '""';
    if (e.t === 'int' || e.t === 'float' || e.t === 'num' || e.t === 'bool') return `to_string(${e.c})`;
    if (e.t === 'list') return `encode_json(${e.c})`;
    const x = this.simple(e).c;
    this.nilNote();
    return this.hoist(
      `if is_string(${x}) { string!(${x}) } else if is_null(${x}) { "" } else if is_array(${x}) || is_object(${x}) { encode_json(${x}) } else { to_string!(${x}) }`,
      'str'
    ).c;
  }
  num(e) {
    if (e.t === 'int' || e.t === 'float' || e.t === 'num') return e;
    if (e.t !== 'any') assistFail('un texte, une liste ou un booléen est employé comme un nombre');
    const x = this.simple(e).c;
    this.nilNote();
    return this.hoist(`if is_integer(${x}) { int!(${x}) } else if is_float(${x}) { float!(${x}) } else { 0 }`, 'num');
  }
  // String#to_i : le début numérique du texte (« 12abc » → 12, « abc » → 0), un flottant tronqué
  toInt(e) {
    if (e.t === 'int') return e;
    if (e.t === 'float' || e.t === 'num') return { c: `to_int(${e.c})`, t: 'int' };
    if (e.t !== 'any' && e.t !== 'str') assistFail('to_i sur autre chose qu’un texte ou un nombre');
    const x = this.simple(e).c;
    this.nilNote();
    const out = this.fresh();
    const m = this.fresh();
    this.emit(`${out} = 0`);
    this.emit(`if is_integer(${x}) {`);
    this.ind++;
    this.emit(`${out} = int!(${x})`);
    this.ind--;
    this.emit(`} else if is_float(${x}) {`);
    this.ind++;
    this.emit(`${out} = to_int!(${x})`);
    this.ind--;
    this.emit(`} else if is_timestamp(${x}) {`);
    this.ind++;
    this.emit(`${out} = to_unix_timestamp!(${x})`);
    this.ind--;
    this.emit(`} else if is_string(${x}) {`);
    this.ind++;
    this.emit(`${m} = parse_regex(string!(${x}), r'^\\s*(?P<n>[+-]?[0-9]+)') ?? { "n": "0" }`);
    this.emit(`${out} = to_int(${m}.n) ?? 0`);
    this.ind--;
    this.emit('}');
    return { c: out, t: 'int' };
  }
  toFloat(e) {
    if (e.t === 'float') return e;
    if (e.t === 'int' || e.t === 'num') return { c: `to_float(${e.c})`, t: 'float' };
    if (e.t !== 'any' && e.t !== 'str') assistFail('to_f sur autre chose qu’un texte ou un nombre');
    const x = this.simple(e).c;
    this.nilNote();
    const out = this.fresh();
    const m = this.fresh();
    this.emit(`${out} = 0.0`);
    this.emit(`if is_integer(${x}) || is_float(${x}) || is_timestamp(${x}) {`);
    this.ind++;
    this.emit(`${out} = to_float!(${x})`);
    this.ind--;
    this.emit(`} else if is_string(${x}) {`);
    this.ind++;
    this.emit(
      `${m} = parse_regex(string!(${x}), r'^\\s*(?P<n>[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?)') ?? { "n": "0" }`
    );
    this.emit(`${out} = to_float(${m}.n) ?? 0.0`);
    this.ind--;
    this.emit('}');
    return { c: out, t: 'float' };
  }
  list(e) {
    if (e.t === 'list') return e;
    if (e.t !== 'any') assistFail('un texte ou un nombre est employé comme une liste');
    const x = this.simple(e).c;
    const v = this.fresh();
    this.emit(`${v} = []`);
    this.emit(`if is_array(${x}) { ${v} = array!(${x}) }`);
    return { c: v, t: 'list' };
  }
  truthy(e) {
    if (e.t === 'bool') return e.c;
    if (e.t === 'null') return 'false';
    if (e.t === 'any') {
      const x = this.simple(e).c;
      return `(${x} != null && ${x} != false)`;
    }
    return 'true';
  }
  lit(n) {
    if (n.t === 'str') return { c: vq(n.v), t: 'str' };
    if (n.t === 'int') return { c: String(n.v), t: 'int' };
    if (n.t === 'num') return { c: Number.isInteger(n.v) ? `${n.v}.0` : String(n.v), t: 'float' };
    if (n.t === 'bool') return { c: String(n.v), t: 'bool' };
    return { c: 'null', t: 'null' };
  }
  regex(n) {
    if (/\(\?[=!<]/.test(n.src) || /\\[GZzAkg1-9]/.test(n.src))
      assistFail(
        'expression régulière sans équivalent dans VRL (anticipation, rétrospection, référence arrière ou ancre propre à Ruby)'
      );
    const flags = n.flags.replace(/[^imx]/g, '');
    return vraw(rubyRe((flags ? `(?${flags})` : '') + n.src), 'r');
  }

  /* ----- expressions ----- */
  expr(n) {
    switch (n.k) {
      case 'lit':
        return this.lit(n);
      case 'dstr': {
        const parts = n.parts.map(x => (typeof x === 'string' ? vq(x) : this.str(this.expr(x))));
        return { c: parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`, t: 'str' };
      }
      case 'arr':
        return { c: `[${n.items.map(x => this.expr(x).c).join(', ')}]`, t: 'list' };
      case 'var': {
        if (!this.locals.has(n.name)) assistFail(`variable ou constante inconnue : ${n.name}`);
        return { c: this.varName(n.name), t: this.locals.get(n.name) };
      }
      case 'un': {
        if (n.op === '!') return { c: `!${this.cond(n.e)}`, t: 'bool' };
        const e = this.num(this.expr(n.e));
        return { c: `(0 - ${e.c})`, t: e.t };
      }
      case 'tern': {
        const c = this.cond(n.c);
        const a = this.expr(n.a);
        const b = this.expr(n.b);
        return this.hoist(`if ${c} { ${a.c} } else { ${b.c} }`, a.t === b.t ? a.t : 'any');
      }
      case 'bin':
        return this.bin(n);
      case 'idx':
        return this.idx(n);
      case 'call':
        return this.call(n);
      case 're':
        assistFail('expression régulière hors d’une comparaison (=~, match?, sub, gsub, split)');
      case 'range':
        assistFail('intervalle hors d’un index');
      default:
        assistFail('expression non reprise');
    }
  }
  cond(n) {
    if (n.k === 'bin' && (n.op === '&&' || n.op === '||')) return `(${this.cond(n.l)} ${n.op} ${this.cond(n.r)})`;
    if (n.k === 'un' && n.op === '!') return `!${this.cond(n.e)}`;
    return this.truthy(this.expr(n));
  }
  bin(n) {
    const op = n.op;
    if (op === '&&' || op === '||') {
      const l = this.simple(this.expr(n.l));
      const r = this.expr(n.r);
      if (l.t === 'bool' && r.t === 'bool') return { c: `(${l.c} ${op} ${r.c})`, t: 'bool' };
      const t = l.t === r.t ? l.t : 'any';
      return this.hoist(
        op === '||'
          ? `if ${this.truthy(l)} { ${l.c} } else { ${r.c} }`
          : `if ${this.truthy(l)} { ${r.c} } else { ${l.c} }`,
        t
      );
    }
    if (op === '=~' || op === '!~') {
      let l = n.l;
      let r = n.r;
      if (l.k === 're') [l, r] = [r, l];
      if (r.k !== 're') assistFail('=~ avec autre chose qu’une expression régulière littérale');
      const m = `match(${this.str(this.expr(l))}, ${this.regex(r)})`;
      return { c: op === '=~' ? m : `!${m}`, t: 'bool' };
    }
    const l = this.expr(n.l);
    const r = this.expr(n.r);
    if (op === '==' || op === '!=') return { c: `(${l.c} ${op} ${r.c})`, t: 'bool' };
    if (op === '+') {
      if (l.t === 'str' || r.t === 'str') {
        if (l.t !== 'str' && l.t !== 'any' && r.t === 'str')
          assistFail('texte + autre chose qu’un texte : Ruby lève une exception');
        return { c: `(${this.str(l)} + ${this.str(r)})`, t: 'str' };
      }
      if (l.t === 'list' && r.t === 'list') return { c: `append(${l.c}, ${r.c})`, t: 'list' };
      if (l.t === 'any' && r.t === 'any')
        assistFail('« + » entre deux champs de type inconnu : texte ou nombre ? Précisez avec .to_s ou .to_i / .to_f');
      if (l.t === 'list' || r.t === 'list') assistFail('« + » entre une liste et autre chose');
      return this.arith(op, l, r);
    }
    if (['-', '*', '/', '%'].includes(op)) return this.arith(op, l, r);
    if (['<', '>', '<=', '>='].includes(op)) {
      if (l.t === 'str' || r.t === 'str') assistFail('comparaison de textes non reprise');
      return { c: `(${this.num(l).c} ${op} ${this.num(r).c})`, t: 'bool' };
    }
    assistFail(`opérateur « ${op} » non repris`);
  }
  arith(op, l, r) {
    const a = this.num(l);
    const b = this.num(r);
    const lit = x => /^-?\d+(\.\d+)?$/.test(x.c);
    const nonzero = x => lit(x) && Number(x.c) !== 0;
    // Diviseur qui peut être nul : écarté en null, que VRL tient pour faillible, d’où le repli
    const divisor = x => (nonzero(x) ? x : this.hoist(`if ${x.c} == 0 { null } else { ${x.c} }`, 'any'));
    if (op === '/') {
      if (a.t === 'int' && b.t === 'int') {
        this.note('Division entière de Ruby : le résultat est arrondi vers le bas.');
        const d = divisor(b);
        return {
          c: nonzero(b) ? `to_int(floor(${a.c} / ${d.c}))` : `(to_int(floor((${a.c} / ${d.c}) ?? 0)) )`,
          t: 'int'
        };
      }
      if (a.t !== 'float' && b.t !== 'float')
        assistFail(
          'division dont on ne sait pas si elle est entière ou décimale (Ruby : 7 / 2 vaut 3) : précisez avec .to_f ou .to_i'
        );
      const d = divisor(b);
      return { c: nonzero(b) ? `(${a.c} / ${d.c})` : `((${a.c} / ${d.c}) ?? 0.0)`, t: 'float' };
    }
    if (op === '%') {
      if (a.t !== 'int' || b.t !== 'int') assistFail('« % » hors de deux entiers connus');
      // Ruby donne au reste le signe du diviseur, VRL celui du dividende : on corrige quand ils diffèrent
      const bs = lit(b) ? b : this.simple(b);
      const d = divisor(bs);
      const r = this.hoist(`to_int!(${nonzero(b) ? `mod(${a.c}, ${d.c})` : `(mod(${a.c}, ${d.c}) ?? 0)`})`, 'int');
      return this.hoist(
        `if ${r.c} != 0 && ((${r.c} < 0) != (${bs.c} < 0)) { ${r.c} + ${bs.c} } else { ${r.c} }`,
        'int'
      );
    }
    const type = a.t === 'int' && b.t === 'int' ? 'int' : a.t === 'float' || b.t === 'float' ? 'float' : 'num';
    return { c: `(${a.c} ${op} ${b.c})`, t: type };
  }
  idx(n) {
    const r = this.expr(n.recv);
    if (n.index.k === 'range') {
      if (r.t === 'list' || r.t === 'int') assistFail('tranche de liste non reprise');
      const lit = x => (x.k === 'lit' && x.t === 'int' ? x.v : null);
      const a = lit(n.index.a);
      const b = lit(n.index.b);
      if (a === null || b === null) assistFail('tranche dont les bornes ne sont pas des entiers littéraux');
      // a..b comprend b ; a...b l’exclut. Une borne de fin à 0 après ce calcul (s[1..-1]) signifie « jusqu’à la fin »
      const end = n.index.excl ? b : b + 1;
      this.note('Tranche de texte : nil en Ruby (null ici) quand le début dépasse la fin du texte.');
      return { c: `(slice(${this.str(r)}, start: ${a}${end === 0 ? '' : `, end: ${end}`}) ?? null)`, t: 'any' };
    }
    if (n.index.k === 'lit' && n.index.t === 'str') {
      if (!/^(\.|rb_|%)[A-Za-z0-9_."@%-]*$/.test(r.c))
        assistFail('clé d’une table calculée : seul un champ ou une variable est repris');
      return { c: `${r.c}.${segName(n.index.v)}`, t: 'any' };
    }
    const i = this.expr(n.index);
    if (i.t === 'int' && /^-?\d+$/.test(i.c)) {
      if (r.t === 'str') assistFail('caractère d’un texte non repris (utilisez une tranche)');
      return { c: `${r.c}[${i.c}]`, t: 'any' };
    }
    assistFail('index qui n’est pas un entier littéral');
  }

  call(n) {
    if (n.recv.k === 'var' && n.recv.name === 'event') return this.eventCall(n);
    const m = n.name;
    const a = n.args;
    const r = this.expr(n.recv);
    const arg = i => {
      if (!a[i]) assistFail(`${m} sans argument`);
      return this.expr(a[i]);
    };
    if (n.block) return this.blockCall(n, r);
    if (a.length > 2) assistFail(`${m} avec trop d’arguments`);
    switch (m) {
      case 'to_s':
      case 'to_str':
        return { c: this.str(r), t: 'str' };
      case 'to_i':
      case 'to_int':
        return this.toInt(r);
      case 'to_f':
        return this.toFloat(r);
      case 'round':
      case 'floor':
      case 'ceil': {
        const x = this.num(r);
        if (m === 'round' && a.length === 1) {
          const d = this.expr(a[0]);
          if (d.t !== 'int') assistFail('round avec une précision qui n’est pas un entier');
          return { c: `round(${x.c}, precision: ${d.c})`, t: 'float' };
        }
        if (x.t === 'int') return x;
        return { c: `to_int(${m}(${x.c}))`, t: 'int' };
      }
      case 'abs': {
        const x = this.num(r);
        return { c: `abs(${x.c})`, t: x.t };
      }
      case 'downcase':
      case 'upcase':
        return { c: `${m}(${this.str(r)})`, t: 'str' };
      case 'strip':
        return { c: `strip_whitespace(${this.str(r)})`, t: 'str' };
      case 'length':
      case 'size': {
        if (r.t === 'str') return { c: `strlen(${r.c})`, t: 'int' };
        if (r.t === 'list') return { c: `length(${r.c})`, t: 'int' };
        const x = this.simple(r).c;
        const v = this.fresh();
        this.emit(`${v} = 0`);
        this.emit(
          `if is_array(${x}) { ${v} = length(array!(${x})) } else if is_string(${x}) { ${v} = strlen(string!(${x})) }`
        );
        return { c: v, t: 'int' };
      }
      case 'empty?':
        if (r.t === 'str') return { c: `(${r.c} == "")`, t: 'bool' };
        if (r.t === 'list') return { c: `(length(${r.c}) == 0)`, t: 'bool' };
        {
          const x = this.simple(r).c;
          return { c: `(${x} == null || ${x} == "" || ${x} == [] || ${x} == {})`, t: 'bool' };
        }
      case 'nil?':
        return { c: `(${r.c} == null)`, t: 'bool' };
      case 'zero?':
        return { c: `(${this.num(r).c} == 0)`, t: 'bool' };
      case 'positive?':
        return { c: `(${this.num(r).c} > 0)`, t: 'bool' };
      case 'negative?':
        return { c: `(${this.num(r).c} < 0)`, t: 'bool' };
      case 'include?': {
        const x = arg(0);
        if (r.t === 'list') return { c: `includes(${r.c}, ${x.c})`, t: 'bool' };
        if (r.t === 'str') return { c: `contains(${r.c}, ${this.str(x)})`, t: 'bool' };
        const rr = this.simple(r).c;
        const v = this.fresh();
        const xs = this.simple(x);
        this.emit(`${v} = false`);
        this.emit(
          `if is_array(${rr}) { ${v} = includes(array!(${rr}), ${xs.c}) } else if is_string(${rr}) { ${v} = contains(string!(${rr}), ${this.str(xs)}) }`
        );
        return { c: v, t: 'bool' };
      }
      case 'start_with?':
      case 'end_with?': {
        if (a.length !== 1) assistFail(`${m} avec plusieurs préfixes ou suffixes`);
        return {
          c: `${m === 'start_with?' ? 'starts_with' : 'ends_with'}(${this.str(r)}, ${this.str(arg(0))})`,
          t: 'bool'
        };
      }
      case 'match?': {
        if (!a[0] || a[0].k !== 're') assistFail('match? avec autre chose qu’une expression régulière littérale');
        return { c: `match(${this.str(r)}, ${this.regex(a[0])})`, t: 'bool' };
      }
      case 'split': {
        if (a.length !== 1) assistFail('split sans séparateur (espaces) ou avec limite');
        const sep = a[0].k === 're' ? this.regex(a[0]) : this.str(arg(0));
        // Ruby retire les éléments vides de fin de liste, VRL les garde : on coupe après le dernier élément non vide
        const v = this.fresh();
        const k = this.fresh();
        this.emit(`${v} = split(${this.str(r)}, ${sep})`);
        this.emit(`${k} = 0`);
        this.emit(`for_each(${v}) -> |rb__i, rb__e| { if rb__e != "" { ${k} = rb__i + 1 } }`);
        this.emit(`${v} = slice!(${v}, start: 0, end: ${k})`);
        return { c: v, t: 'list' };
      }
      case 'join': {
        const sep = a.length ? this.str(arg(0)) : '""';
        if (r.t === 'str') assistFail('join sur un texte');
        const l = this.list(r);
        const v = this.fresh();
        this.emit(`${v} = join!(map_values(${l.c}) -> |rb__e| { to_string(rb__e) ?? encode_json(rb__e) }, ${sep})`);
        return { c: v, t: 'str' };
      }
      case 'first':
        if (a.length) assistFail('first(n) non repris');
        return { c: `${r.c}[0]`, t: 'any' };
      case 'last':
        if (a.length) assistFail('last(n) non repris');
        return { c: `${r.c}[-1]`, t: 'any' };
      case 'uniq':
        return { c: `unique(${this.list(r).c})`, t: 'list' };
      case 'compact':
        return {
          c: `compact(${this.list(r).c}, recursive: false, string: false, array: false, object: false)`,
          t: 'list'
        };
      case 'flatten':
        return { c: `flatten(${this.list(r).c})`, t: 'list' };
      case 'sub':
      case 'gsub': {
        if (a.length !== 2) assistFail(`${m} avec un bloc ou une table de remplacement`);
        const pat = a[0].k === 're' ? this.regex(a[0]) : this.str(arg(0));
        if (a[1].k !== 'lit' || a[1].t !== 'str') assistFail(`${m} dont le remplacement n’est pas un texte fixe`);
        const rep = String(a[1].v)
          .replace(/\$/g, '$$$$')
          .replace(/\\(\d)/g, '$${$1}');
        return { c: `replace(${this.str(r)}, ${pat}, ${vq(rep)}${m === 'sub' ? ', count: 1' : ''})`, t: 'str' };
      }
      case 'dup':
      case 'clone':
      case 'freeze':
        return r;
      default:
        assistFail(`méthode Ruby non reprise : ${m}`);
    }
  }
  // map / select / reject : la fermeture est écrite dans une variable, ses éventuelles lignes préalables restent dans son corps
  blockCall(n, r) {
    const m = n.name;
    const bp = n.block.params;
    if (!['map', 'select', 'reject', 'filter'].includes(m)) assistFail(`bloc sur ${m} non repris`);
    if (bp.length !== 1) assistFail(`${m} avec ${bp.length} paramètres de bloc`);
    if (n.block.body.length !== 1 || n.block.body[0].k !== 'expr')
      assistFail(`le bloc de ${m} doit tenir en une expression`);
    const l = this.list(r);
    const v = this.fresh();
    const x = this.varName(bp[0]);
    const saved = this.locals;
    this.locals = new Map(saved);
    this.locals.set(bp[0], 'any');
    this.emit(`${v} = ${m === 'map' ? `map_values(${l.c}) -> |${x}|` : `filter(${l.c}) -> |_i, ${x}|`} {`);
    this.ind++;
    try {
      const body = n.block.body[0].e;
      if (m === 'map') this.emit(this.expr(body).c);
      else {
        const c = this.cond(body);
        this.emit(m === 'reject' ? `!${c}` : c);
      }
    } finally {
      this.ind--;
      this.locals = saved;
    }
    this.emit('}');
    return { c: v, t: 'list' };
  }
  eventCall(n) {
    const m = n.name;
    const a = n.args;
    switch (m) {
      case 'get':
        if (a.length !== 1) assistFail('event.get attend un nom de champ');
        return { c: this.path(a[0]), t: 'any' };
      case 'include?':
        if (a.length !== 1) assistFail('event.include? attend un nom de champ');
        {
          const p = this.path(a[0]);
          return { c: `(exists(${p}) && ${p} != null)`, t: 'bool' };
        }
      case 'set':
      case 'remove':
      case 'tag':
      case 'cancel':
        assistFail(`event.${m} employé comme une valeur`);
      default:
        assistFail(`event.${m} non repris`);
    }
  }

  /* ----- instructions ----- */
  stmts(list) {
    list.forEach(s => this.stmt(s));
  }
  stmt(s) {
    if (s.k === 'if') return this.ifStmt(s);
    if (s.k === 'asgn') return this.assign(s);
    const e = s.e;
    if (e.k === 'bin' && e.op === '<<' && e.l.k === 'var') return this.append(e);
    if (e.k === 'call' && e.recv.k === 'var' && e.recv.name === 'event') return this.eventStmt(e);
    if (e.k === 'call' && e.block && (e.name === 'each' || e.name === 'each_with_index')) return this.eachStmt(e);
    assistFail(
      'instruction sans effet sur l’événement (seuls event.set, remove, tag, cancel et les affectations locales sont repris)'
    );
  }
  // liste << valeur, texte << texte : la variable locale prend la valeur allongée
  append(e) {
    const name = e.l.name;
    if (!this.locals.has(name)) assistFail(`variable ou constante inconnue : ${name}`);
    const t = this.locals.get(name);
    const v = this.expr(e.r);
    if (t === 'list') this.emit(`${this.varName(name)} = push(${this.varName(name)}, ${v.c})`);
    else if (t === 'str') this.emit(`${this.varName(name)} = ${this.varName(name)} + ${this.str(v)}`);
    else assistFail('« << » sur une variable dont le type (liste ou texte) n’est pas connu');
  }
  eventStmt(e) {
    const m = e.name;
    const a = e.args;
    if (m === 'set') {
      if (a.length !== 2) assistFail('event.set attend un champ et une valeur');
      const p = this.path(a[0]);
      const v = this.expr(a[1]);
      this.emit(`${p} = ${v.c}`);
      return;
    }
    if (m === 'remove') {
      if (a.length !== 1) assistFail('event.remove attend un champ');
      this.emit(`del(${this.path(a[0])})`);
      return;
    }
    if (m === 'cancel') {
      this.emit('abort');
      this.note('event.cancel : l’événement est écarté (abort), comme Logstash le fait.');
      return;
    }
    if (m === 'tag') {
      if (a.length !== 1) assistFail('event.tag attend un texte');
      const t = this.expr(a[0]);
      if (t.t !== 'str') assistFail('event.tag avec un texte calculé');
      this.emit(
        `.tags = unique(compact(flatten([.tags, ${t.c}]), recursive: false, string: false, array: false, object: false))`
      );
      return;
    }
    assistFail(`event.${m} non repris`);
  }
  assign(s) {
    const name = this.varName(s.name);
    let e;
    if (s.op === '=') e = this.expr(s.e);
    else if (s.op === '||=') {
      if (!this.locals.has(s.name)) assistFail(`${s.name} ||= sans valeur de départ`);
      const cur = { c: name, t: this.locals.get(s.name) };
      const val = this.expr(s.e);
      e = this.hoist(`if ${this.truthy(cur)} { ${cur.c} } else { ${val.c} }`, cur.t === val.t ? cur.t : 'any');
    } else if (s.op === '&&=') assistFail('&&= non repris');
    else {
      if (!this.locals.has(s.name)) assistFail(`${s.name} ${s.op} sans valeur de départ`);
      e = this.bin({ k: 'bin', op: s.op.slice(0, -1), l: { k: 'var', name: s.name }, r: s.e });
    }
    this.locals.set(s.name, e.t);
    this.emit(`${name} = ${e.c}`);
  }
  ifStmt(s) {
    const pre = new Map(this.locals);
    const ends = [];
    let nest = 0;
    s.branches.forEach((b, i) => {
      if (i === 0) this.emit(`if ${this.cond(b.cond)} {`);
      else {
        // La condition d’un « elsif » qui demande des lignes préalables s’écrit dans un « else » imbriqué
        const saved = this.lines;
        this.lines = [];
        this.ind++;
        const c = this.cond(b.cond);
        this.ind--;
        const before = this.lines;
        this.lines = saved;
        if (!before.length) this.emit(`} else if ${c} {`);
        else {
          this.emit('} else {');
          this.ind++;
          nest++;
          before.forEach(l => this.lines.push(l));
          this.emit(`if ${c} {`);
        }
      }
      this.ind++;
      this.locals = new Map(pre);
      if (!b.body.length) this.emit('null');
      else this.stmts(b.body);
      ends.push(this.locals);
      this.ind--;
    });
    if (s.other) {
      this.emit('} else {');
      this.ind++;
      this.locals = new Map(pre);
      if (!s.other.length) this.emit('null');
      else this.stmts(s.other);
      ends.push(this.locals);
      this.ind--;
    } else ends.push(pre);
    this.emit('}');
    for (let k = 0; k < nest; k++) {
      this.ind--;
      this.emit('}');
    }
    this.locals = this.merge(ends);
  }
  eachStmt(e) {
    const bp = e.block.params;
    const r = this.expr(e.recv);
    let head;
    if (e.name === 'each_with_index') {
      if (bp.length !== 2) assistFail('each_with_index attend deux paramètres de bloc');
      head = `for_each(${this.list(r).c}) -> |${this.varName(bp[1])}, ${this.varName(bp[0])}|`;
    } else if (bp.length === 1) head = `for_each(${this.list(r).c}) -> |_i, ${this.varName(bp[0])}|`;
    else if (bp.length === 2) {
      const x = this.simple(r).c;
      const o = this.fresh();
      this.emit(`${o} = {}`);
      this.emit(`if is_object(${x}) { ${o} = object!(${x}) }`);
      head = `for_each(${o}) -> |${this.varName(bp[0])}, ${this.varName(bp[1])}|`;
    } else assistFail('each sans paramètre de bloc');
    const pre = new Map(this.locals);
    for (const x of bp) this.locals.set(x, 'any');
    this.emit(head + ' {');
    this.ind++;
    if (!e.block.body.length) this.emit('null');
    else this.stmts(e.block.body);
    this.ind--;
    this.emit('}');
    // Le bloc s’exécute zéro fois ou plus : un type posé dedans n’est sûr que s’il est celui d’avant
    const post = this.locals;
    for (const x of bp) post.delete(x);
    this.locals = this.merge([pre, post]);
  }
}

// Variables posées à l’intérieur d’une branche ou d’un bloc : déclarées avant, VRL ne les voit pas hors de leur bloc
function assistRubyNested(list, depth, out) {
  list.forEach(s => {
    if (s.k === 'asgn' && depth > 0) out.add(s.name);
    if (s.k === 'if') {
      s.branches.forEach(b => assistRubyNested(b.body, depth + 1, out));
      if (s.other) assistRubyNested(s.other, depth + 1, out);
    }
    if (s.k === 'expr' && s.e.k === 'call' && s.e.block) assistRubyNested(s.e.block.body, depth + 1, out);
  });
  return out;
}

/*
 * Code Ruby d’un filtre → { vrl, notes } ou { error }. Le VRL est celui du corps d’un transform remap, sur l’événement « . ».
 */
function assistRuby(code, opts) {
  try {
    const ast = assistRubyParse(String(code));
    if (!ast.length) return { error: 'le filtre ne contient aucune instruction' };
    const g = new AssistRuby(opts);
    // Déclarations préalables des variables posées dans un bloc
    for (const name of assistRubyNested(ast, 0, new Set())) {
      g.emit(`${g.varName(name)} = null`);
      g.locals.set(name, 'null');
    }
    g.stmts(ast);
    return { vrl: g.lines.join('\n'), notes: [...g.notes] };
  } catch (e) {
    if (e instanceof AssistError) return { error: e.message };
    throw e;
  }
}

/* ====================================================================== */
/* Les cas : ce qu’une traduction laisse « à reprendre »                  */
/* ====================================================================== */
const ASSIST_HEAD_RUBY = /^(\s*)# À TRADUIRE : filtre (\w+), ligne (\d+) du pipeline Logstash$/;
const ASSIST_HEAD_SCRIPT = /^(\s*)# À REPRENDRE : (.*)$/;
const ASSIST_CODE_LINE = /^\s*#   (.*)$/;
// Vector interpole $VAR dans tout le fichier : la traduction écrit chaque $ du VRL (et de ses commentaires) $$
const assistUndollar = x => String(x).replace(/\$\$/g, '$');
const assistDollar = x => String(x).replace(/\$/g, '$$$$');

/*
 * Les blocs « À TRADUIRE » (Logstash) et « À REPRENDRE » (ingestion) suivis du code d’origine en commentaire, dans les
 * transforms remap d’une configuration Vector. Les blocs de l’ingestion sans code (un processeur qui n’est pas un
 * script) ne sont pas des cas : il n’y a rien à proposer. Rend [{ id, kind, label, code, why, transform, at, length, indent }].
 */
function assistCases(config) {
  const out = [];
  for (const [tname, t] of Object.entries((config && config.transforms) || {})) {
    if (!t || t.type !== 'remap' || typeof t.source !== 'string') continue;
    const lines = t.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = assistUndollar(lines[i]);
      let m = ASSIST_HEAD_RUBY.exec(text);
      let kind = null;
      let label = '';
      let why = '';
      if (m) {
        if (m[2] !== 'ruby') continue;
        kind = 'ruby';
        label = `filtre ruby, ligne ${m[3]}`;
      } else if ((m = ASSIST_HEAD_SCRIPT.exec(text))) {
        kind = 'painless';
        why = m[2];
        label = 'script Painless';
      } else continue;
      let j = i + 1;
      const code = [];
      while (j < lines.length) {
        if (lines[j].trim() === '#') {
          code.push('');
          j++;
          continue;
        }
        const c = ASSIST_CODE_LINE.exec(assistUndollar(lines[j]));
        if (!c) break;
        code.push(c[1]);
        j++;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      while (code.length && !code[0].trim()) code.shift();
      if (!code.length) continue;
      out.push({
        id: `${kind}-${out.length + 1}`,
        kind,
        label,
        why,
        code: code.join('\n'),
        transform: tname,
        at: i,
        length: j - i,
        indent: m[1]
      });
    }
  }
  return out;
}

/*
 * Une copie de la configuration où chaque proposition prend la place du commentaire de son cas.
 * proposals : { [id du cas]: { vrl, origin } }. Le code d’origine reste en commentaire, la proposition est marquée.
 */
function assistApply(config, cases, proposals) {
  const out = JSON.parse(JSON.stringify(config));
  const byTransform = new Map();
  for (const c of cases)
    if (proposals[c.id] && proposals[c.id].vrl) {
      if (!byTransform.has(c.transform)) byTransform.set(c.transform, []);
      byTransform.get(c.transform).push(c);
    }
  for (const [tname, list] of byTransform) {
    const lines = out.transforms[tname].source.split('\n');
    for (const c of list.sort((a, b) => b.at - a.at)) {
      const pr = proposals[c.id];
      const pad = c.indent;
      const block = [
        `${pad}# PROPOSITION À VÉRIFIER (${pr.origin || 'Passerelle'}) — ${c.label}`,
        `${pad}# Elle n’est pas une traduction : à relire, puis à confirmer par « passerelle assist » sur un échantillon. Code d’origine :`,
        ...c.code.split('\n').map(l => assistDollar(`${pad}#   ${l}`.replace(/\s+$/, ''))),
        ...pr.vrl.split('\n').map(l => (l.trim() ? assistDollar(pad + l) : ''))
      ];
      lines.splice(c.at, c.length, ...block);
    }
    out.transforms[tname].source = lines.join('\n');
  }
  return out;
}

/* ====================================================================== */
/* Modèle local : la demande, et ce que l’on garde de la réponse          */
/* ====================================================================== */
const ASSIST_FORBIDDEN =
  /\b(get_env_var|get_secret|set_secret|remove_secret|http_request|dns_lookup|reverse_dns|get_hostname|get_enrichment_table_record|find_enrichment_table_records|exec)\s*!?\s*\(/;
const ASSIST_RULES_VRL = [
  'You translate a small piece of code into VRL (Vector Remap Language), for the body of a Vector `remap` transform.',
  'Reply with exactly one fenced code block, ```vrl ... ```, and nothing else. If the behaviour cannot be kept exactly, reply with the single word IMPOSSIBLE.',
  'Rules:',
  '- The event is `.`; the field a.b is `.a.b`; the Logstash field [a][b] is `.a.b`; @timestamp is `."@timestamp"`.',
  '- Every fallible function call must be handled in VRL: `!` suffix, `?? fallback`, or error assignment. An infallible call must not get `??`.',
  '- Name your own variables with the prefix rb_. Use `abort` to drop the event, `del(.field)` to remove a field.',
  '- Never read the environment or secrets and never call out: get_env_var, get_secret, http_request and similar functions are forbidden.',
  '- Keep the behaviour of the original on the normal path; do not add behaviour.'
].join('\n');
const ASSIST_KIND_VRL = {
  ruby: 'The code is the body of a Logstash `ruby` filter. event.get("[a][b]") reads the field, event.set("[a][b]", v) writes it, event.remove("f") deletes it, event.tag("t") appends a tag to `tags`, event.cancel drops the event.',
  painless:
    'The code is an Elasticsearch ingest `script` processor in Painless. `ctx` is the document: ctx.a.b is `.a.b`; ctx.remove("x") deletes a field. Loops over lists become `for_each(...) -> |_i, item| { ... }` in VRL.'
};
/*
 * La demande faite à un modèle local : le code du cas et la raison donnée par le traducteur, rien d’autre. Ni événement,
 * ni échantillon, ni configuration, ni nom de machine ne sont dans la demande.
 */
function assistPrompt(c, previousError) {
  const user = [
    ASSIST_KIND_VRL[c.kind] || '',
    c.why ? `The automatic translator stopped on: ${c.why}` : '',
    'Code:',
    '```',
    c.code,
    '```',
    previousError
      ? `Your previous answer was refused by the VRL compiler:\n${previousError}\nFix it and reply again with one fenced block.`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
  return { system: ASSIST_RULES_VRL, user };
}
// Le VRL d’une réponse de modèle, ou la raison de son refus
function assistFromModel(text) {
  const t = String(text || '');
  const m = /```(?:vrl|VRL|ruby)?[ \t]*\r?\n([\s\S]*?)```/.exec(t);
  if (!m)
    return {
      error: /\bIMPOSSIBLE\b/.test(t)
        ? 'le modèle annonce qu’il ne peut pas garder le comportement'
        : 'la réponse du modèle ne contient pas de bloc de code'
    };
  const vrl = m[1].replace(/\s+$/, '').replace(/^\s*\n/, '');
  if (!vrl.trim()) return { error: 'bloc de code vide' };
  if (vrl.length > 20000 || vrl.split('\n').length > 400) return { error: 'proposition trop longue pour être relue' };
  const bad = ASSIST_FORBIDDEN.exec(vrl);
  if (bad) return { error: `proposition refusée : ${bad[1]}() lit hors de l’événement` };
  return { vrl };
}

/* ====================================================================== */
/* Le rapport                                                             */
/* ====================================================================== */
const ASSIST_STATES = {
  confirmed: 'confirmée sur l’échantillon',
  different: 'différente',
  inconclusive: 'non concluante',
  not_replayed: 'non rejouée',
  refused: 'sans proposition',
  none: 'rien à reprendre',
  error: 'en erreur'
};
const ASSIST_STATE_ORDER = ['different', 'error', 'inconclusive', 'not_replayed', 'refused', 'confirmed', 'none'];
const ASSIST_CASE_STATUS = { proposed: 'proposée', refused: 'sans proposition' };
const ASSIST_BANNER =
  'Une proposition n’est pas une traduction : elle est à relire. « Confirmée » veut dire identique à la référence sur l’échantillon rejoué, pas sur toutes les données.';

function assistSummarize(items) {
  const by = Object.fromEntries(ASSIST_STATE_ORDER.map(k => [k, 0]));
  for (const it of items) by[it.state]++;
  return { total: items.length, byState: by };
}
function assistSentence(sum, what) {
  const s = sum.byState;
  if (!sum.total) return `Aucun ${what} lu.`;
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const parts = [];
  if (s.confirmed) parts.push(`${s.confirmed} confirmé${s.confirmed > 1 ? 's' : ''}`);
  if (s.different) parts.push(`${s.different} différent${s.different > 1 ? 's' : ''}`);
  if (s.error) parts.push(`${s.error} en erreur`);
  if (s.inconclusive) parts.push(`${s.inconclusive} non concluant${s.inconclusive > 1 ? 's' : ''}`);
  if (s.not_replayed) parts.push(`${s.not_replayed} non rejoué${s.not_replayed > 1 ? 's' : ''}`);
  if (s.refused) parts.push(`${s.refused} sans proposition`);
  if (s.none) parts.push(`${s.none} sans cas à reprendre`);
  return `${plural(sum.total, what)} : ${parts.join(', ')}.`;
}
const assistSorted = items =>
  items
    .map((it, i) => [it, i])
    .sort((a, b) => ASSIST_STATE_ORDER.indexOf(a[0].state) - ASSIST_STATE_ORDER.indexOf(b[0].state) || a[1] - b[1])
    .map(x => x[0]);
const assistTitle = rep => (rep.kind === 'painless' ? 'scripts Painless' : 'filtres ruby de Logstash');

function assistReportMarkdown(rep) {
  const L = [];
  const what = rep.kind === 'painless' ? 'pipeline d’ingestion' : 'pipeline';
  L.push(`# Aide aux cas « à reprendre » — ${assistTitle(rep)}`, '');
  L.push(`**Daté du ${eqFrDate(rep.generated_at)}** · Passerelle ${rep.passerelle}`, '');
  L.push(`> ${ASSIST_BANNER}`, '', `> ${assistSentence(rep.summary, what)}`, '');
  L.push('## Conditions', '');
  for (const [name, v] of Object.entries(rep.conditions.engines || {})) L.push(`- ${name} : ${eqMd(v)}`);
  if (rep.conditions.sample) L.push(`- Échantillon : ${eqMd(rep.conditions.sample)}`);
  L.push(`- Modèle local : ${eqMd(rep.conditions.model)}`);
  for (const line of rep.conditions.notes || []) L.push(`- ${eqMd(line)}`);
  L.push('', '## Bilan', '', '| État | Nombre |', '|---|---:|');
  for (const k of ASSIST_STATE_ORDER) L.push(`| ${ASSIST_STATES[k]} | ${rep.summary.byState[k]} |`);
  L.push(
    '',
    `## Détail par ${what}`,
    '',
    `| ${what[0].toUpperCase()}${what.slice(1)} | Cas | Propositions | État | Événements |`,
    '|---|---:|---:|---|---:|'
  );
  for (const it of assistSorted(rep.items)) {
    const cases = it.cases || [];
    L.push(
      `| ${eqMd(it.title)} | ${cases.length} | ${cases.filter(c => c.status === 'proposed').length} | ${ASSIST_STATES[it.state]} | ${it.docs === null || it.docs === undefined ? '' : it.docs} |`
    );
  }
  L.push('');
  const detailed = assistSorted(rep.items).filter(it => it.state !== 'confirmed' && it.state !== 'none');
  if (detailed.length) {
    L.push('## À lire', '');
    for (const it of detailed) {
      L.push(`### ${eqMd(it.title)} — ${ASSIST_STATES[it.state]}`, '');
      if (it.source) L.push(`Source : \`${eqMd(it.source)}\``, '');
      if (it.reason) L.push(it.reason, '');
      for (const d of it.diffs || []) L.push(`- ${d}`);
      if ((it.diffs || []).length) L.push('');
    }
  }
  const withCases = assistSorted(rep.items).filter(it => (it.cases || []).length);
  if (withCases.length) {
    L.push('## Propositions', '');
    for (const it of withCases) {
      L.push(`### ${eqMd(it.title)}`, '');
      for (const c of it.cases) {
        L.push(
          `#### ${eqMd(c.label)} — ${ASSIST_CASE_STATUS[c.status]}${c.origin ? ` (${eqMd(c.origin)}, **à vérifier**)` : ''}`,
          ''
        );
        if (c.reason) L.push(c.reason, '');
        for (const n of c.notes || []) L.push(`- ${n}`);
        if ((c.notes || []).length) L.push('');
        if (c.vrl) L.push('```vrl', c.vrl, '```', '');
      }
    }
  }
  L.push(
    '---',
    '',
    rep.values_hidden
      ? 'Les valeurs des données sont masquées : le rapport ne contient que des comptes et le code des propositions.'
      : 'Ce rapport peut citer des valeurs des données comparées. Relancez avec --no-values avant de le partager hors de l’organisation.'
  );
  return L.join('\n') + '\n';
}
function assistReportCSV(rep) {
  const cell = v => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['titre', 'source', 'etat', 'cas', 'origine', 'statut_cas', 'raison', 'ecarts'].join(';')];
  for (const it of rep.items) {
    const cases = it.cases && it.cases.length ? it.cases : [{}];
    for (const c of cases)
      rows.push(
        [
          it.title,
          it.source,
          it.state,
          c.label,
          c.origin,
          c.status,
          c.reason || it.reason,
          (it.diffs || []).join(' | ')
        ]
          .map(cell)
          .join(';')
      );
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}
function assistReportHTML(rep) {
  const h = eqHtml;
  const what = rep.kind === 'painless' ? 'pipeline d’ingestion' : 'pipeline';
  const badge = st => `<span class="v v-${st}">${h(ASSIST_STATES[st])}</span>`;
  const rows = assistSorted(rep.items)
    .map(
      it =>
        `<tr><td>${h(it.title)}</td><td class="n">${(it.cases || []).length}</td><td class="n">${(it.cases || []).filter(c => c.status === 'proposed').length}</td><td>${badge(it.state)}</td><td class="n">${it.docs === null || it.docs === undefined ? '' : it.docs}</td></tr>`
    )
    .join('');
  const details = assistSorted(rep.items)
    .filter(it => it.state !== 'confirmed' && it.state !== 'none')
    .map(
      it =>
        `<section class="obj"><h3>${h(it.title)} ${badge(it.state)}</h3>${it.source ? `<p class="muted"><code>${h(it.source)}</code></p>` : ''}${it.reason ? `<p>${h(it.reason)}</p>` : ''}${(it.diffs || []).length ? `<ul>${it.diffs.map(d => `<li>${h(d)}</li>`).join('')}</ul>` : ''}</section>`
    )
    .join('');
  const props = assistSorted(rep.items)
    .filter(it => (it.cases || []).length)
    .map(
      it =>
        `<section class="obj"><h3>${h(it.title)}</h3>${it.cases.map(c => `<h4>${h(c.label)} — ${h(ASSIST_CASE_STATUS[c.status])}${c.origin ? ` <span class="muted">(${h(c.origin)}, à vérifier)</span>` : ''}</h4>${c.reason ? `<p>${h(c.reason)}</p>` : ''}${(c.notes || []).length ? `<ul>${c.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}${c.vrl ? `<pre>${h(c.vrl)}</pre>` : ''}`).join('')}</section>`
    )
    .join('');
  const lines = Object.entries(rep.conditions.engines || {}).map(([n, v]) => `${h(n)} : ${h(v)}`);
  if (rep.conditions.sample) lines.push(`Échantillon : ${h(rep.conditions.sample)}`);
  lines.push(`Modèle local : ${h(rep.conditions.model)}`);
  for (const l of rep.conditions.notes || []) lines.push(h(l));
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aide aux cas à reprendre</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--ok:#2f7d4f;--warn:#b7791f;--bad:#c0392b;--none:#7a7a7a;--code:#f3f2ee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--card:#1f1f1d;--ok:#5fbf86;--warn:#e0a84a;--bad:#ec7063;--none:#a0a0a0;--code:#262624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 10px}h3{font-size:16px;margin:0 0 4px}h4{font-size:14px;margin:14px 0 4px}
.muted{color:var(--muted)}.banner{border-left:4px solid var(--warn);background:var(--card);padding:10px 14px;border-radius:6px}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse}tr:last-child td{border-bottom:0}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;font-size:13px;color:var(--muted)}td.n,th.n{text-align:right;white-space:nowrap}
.v{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.v-confirmed{color:var(--ok)}.v-different,.v-error{color:var(--bad)}.v-inconclusive,.v-not_replayed{color:var(--warn)}.v-refused,.v-none{color:var(--none)}
.obj{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.obj ul{margin:6px 0 0;padding-left:20px}
code,pre{background:var(--code);border-radius:4px;font-size:13px}code{padding:0 4px}pre{padding:10px;overflow-x:auto;margin:6px 0}
</style></head><body><main>
<h1>Aide aux cas « à reprendre » — ${h(assistTitle(rep))}</h1>
<p class="muted">Daté du ${h(eqFrDate(rep.generated_at))} · Passerelle ${h(rep.passerelle)}</p>
<p class="banner">${h(ASSIST_BANNER)}</p>
<p><b>${h(assistSentence(rep.summary, what))}</b></p>
<h2>Conditions</h2><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
<h2>Détail par ${h(what)}</h2>
<div class="tw"><table><thead><tr><th>${h(what[0].toUpperCase() + what.slice(1))}</th><th class="n">Cas</th><th class="n">Propositions</th><th>État</th><th class="n">Événements</th></tr></thead><tbody>${rows}</tbody></table></div>
${details ? `<h2>À lire</h2>${details}` : ''}
${props ? `<h2>Propositions</h2>${props}` : ''}
<p class="muted">${rep.values_hidden ? 'Les valeurs des données sont masquées : le rapport ne contient que des comptes et le code des propositions.' : 'Ce rapport peut citer des valeurs des données comparées. Relancez avec --no-values avant de le partager hors de l’organisation.'}</p>
</main></body></html>
`;
}
