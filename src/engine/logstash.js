/* Passerelle — moteur partie 3 : Logstash → Vector */
const LS_MAX_DEPTH = 64;
function parseLogstash(src) {
  let i = 0;
  const s = String(src);
  const n = s.length;
  const lineAt = pos => s.slice(0, pos).split('\n').length;
  const fail = msg => {
    throw new Error(`Ligne ${lineAt(i)} : ${msg}`);
  };
  // Blocs, parenthèses, négations et valeurs s’imbriquent par récursion : une borne évite d’épuiser la pile
  let depth = 0;
  const nested = fn => {
    if (++depth > LS_MAX_DEPTH) fail(`imbrication sur plus de ${LS_MAX_DEPTH} niveaux`);
    try {
      return fn();
    } finally {
      depth--;
    }
  };
  function ws() {
    while (i < n) {
      const c = s[i];
      if (c === '#') {
        while (i < n && s[i] !== '\n') i++;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else break;
    }
  }
  function at(t) {
    ws();
    return s.startsWith(t, i);
  }
  function eat(t) {
    if (at(t)) {
      i += t.length;
      return true;
    }
    return false;
  }
  function expect(t) {
    if (!eat(t)) fail(`« ${t} » attendu${i < n ? ` (trouvé « ${s.slice(i, i + 12).split('\n')[0]} »)` : ''}`);
  }
  function word(w) {
    ws();
    return s.startsWith(w, i) && !/[A-Za-z0-9_]/.test(s[i + w.length] || '');
  }
  function bare() {
    ws();
    const m = /^[^\s"'=,{}\[\]()#]+/.exec(s.slice(i));
    if (!m) fail('identifiant attendu');
    i += m[0].length;
    return m[0];
  }
  function str() {
    ws();
    const q = s[i];
    i++;
    let out = '';
    while (i < n && s[i] !== q) {
      if (s[i] === '\\' && i + 1 < n) {
        out += s[i + 1] === q ? q : '\\' + s[i + 1];
        i += 2;
      } else out += s[i++];
    }
    if (i >= n) fail('chaîne non terminée');
    i++;
    return out;
  }
  function key() {
    ws();
    return s[i] === '"' || s[i] === "'" ? str() : bare();
  }
  function value() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return { t: 'str', v: str() };
    if (c === '[') {
      i++;
      const items = [];
      while (!at(']')) {
        if (i >= n) fail('« ] » attendu');
        items.push(nested(value));
        eat(',');
      }
      expect(']');
      return { t: 'arr', v: items };
    }
    if (c === '{') return { t: 'hash', v: nested(hash) };
    const m = /^-?\d+(\.\d+)?(?![A-Za-z_])/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return { t: 'num', v: +m[0] };
    }
    const b = bare();
    if (at('{')) return { t: 'plugin', v: pluginBody(b) };
    if (b === 'true' || b === 'false') return { t: 'bool', v: b === 'true' };
    return { t: 'bare', v: b };
  }
  function hash() {
    expect('{');
    const e = [];
    while (!at('}')) {
      if (i >= n) fail('« } » attendu');
      const k = key();
      expect('=>');
      e.push([k, value()]);
      eat(',');
    }
    expect('}');
    return e;
  }
  function pluginBody(name) {
    const line = lineAt(i);
    expect('{');
    const settings = [];
    while (!at('}')) {
      if (i >= n) fail(`« } » attendu pour ${name}`);
      const k = key();
      expect('=>');
      settings.push([k, value()]);
    }
    expect('}');
    return { name, settings, line };
  }
  function body() {
    const out = [];
    for (;;) {
      ws();
      if (i >= n) fail('« } » attendu');
      if (s[i] === '}') break;
      out.push(stmt());
    }
    return out;
  }
  function stmt() {
    if (word('if')) {
      const line = lineAt(i);
      i += 2;
      const branches = [];
      const c = cond();
      expect('{');
      const b = nested(body);
      expect('}');
      branches.push({ cond: c, body: b });
      for (;;) {
        if (!word('else')) break;
        i += 4;
        if (word('if')) {
          i += 2;
          const c2 = cond();
          expect('{');
          const b2 = nested(body);
          expect('}');
          branches.push({ cond: c2, body: b2 });
        } else {
          expect('{');
          const b3 = nested(body);
          expect('}');
          branches.push({ cond: null, body: b3 });
          break;
        }
      }
      return { k: 'if', branches, line };
    }
    const name = bare();
    ws();
    if (s[i] !== '{') fail(`« { » attendu après « ${name} »`);
    return Object.assign({ k: 'plugin' }, pluginBody(name));
  }
  function cond() {
    return orC();
  }
  function orC() {
    let l = andC();
    for (;;) {
      if (word('or')) {
        i += 2;
        l = { op: 'or', l, r: andC() };
      } else if (word('xor')) {
        i += 3;
        l = { op: 'xor', l, r: andC() };
      } else break;
    }
    return l;
  }
  function andC() {
    let l = notC();
    for (;;) {
      if (word('and')) {
        i += 3;
        l = { op: 'and', l, r: notC() };
      } else if (word('nand')) {
        i += 4;
        l = { op: 'nand', l, r: notC() };
      } else break;
    }
    return l;
  }
  function notC() {
    ws();
    if (s[i] === '!' && s[i + 1] !== '=' && s[i + 1] !== '~') {
      i++;
      return { op: 'not', e: nested(notC) };
    }
    if (word('not')) {
      i += 3;
      return { op: 'not', e: nested(notC) };
    }
    if (s[i] === '(') {
      i++;
      const e = nested(orC);
      expect(')');
      return e;
    }
    return comparison();
  }
  function comparison() {
    const l = rvalue();
    ws();
    for (const op of ['==', '!=', '<=', '>=', '=~', '!~', '<', '>']) {
      if (s.startsWith(op, i)) {
        i += op.length;
        if (op === '=~' || op === '!~') return { op: 'regex', l, r: rvalue(), neg: op === '!~' };
        return { op: 'cmp', cmp: op, l, r: rvalue() };
      }
    }
    if (word('in')) {
      i += 2;
      return { op: 'in', l, r: rvalue(), neg: false };
    }
    if (word('not')) {
      const save = i;
      i += 3;
      if (word('in')) {
        i += 2;
        return { op: 'in', l, r: rvalue(), neg: true };
      }
      i = save;
    }
    return { op: 'truthy', v: l };
  }
  function rvalue() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return { t: 'str', v: str() };
    if (c === '/') {
      i++;
      let v = '';
      while (i < n && s[i] !== '/') {
        if (s[i] === '\\' && s[i + 1] === '/') {
          v += '/';
          i += 2;
        } else if (s[i] === '\\') {
          v += s[i] + (s[i + 1] || '');
          i += 2;
        } else v += s[i++];
      }
      i++;
      return { t: 're', v };
    }
    if (c === '[') {
      let j = i + 1;
      while (s[j] === ' ') j++;
      if (s[j] === '"' || s[j] === "'" || s[j] === ']' || /[-\d]/.test(s[j])) return value();
      const segs = [];
      while (s[i] === '[') {
        const e = s.indexOf(']', i);
        if (e < 0) fail('« ] » attendu');
        segs.push(s.slice(i + 1, e).trim());
        i = e + 1;
      }
      return { t: 'field', v: segs };
    }
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return { t: 'num', v: +m[0] };
    }
    return { t: 'bare', v: bare() };
  }
  const out = { input: [], filter: [], output: [] };
  for (;;) {
    ws();
    if (i >= n) break;
    const sec = bare();
    if (!out[sec]) fail(`section inconnue « ${sec} » (input, filter ou output attendu)`);
    expect('{');
    out[sec].push(...body());
    expect('}');
  }
  return out;
}
function lsJs(v) {
  if (!v) return undefined;
  switch (v.t) {
    case 'str':
    case 'num':
    case 'bool':
    case 'bare':
      return v.v;
    case 'arr':
      return v.v.map(lsJs);
    case 'hash': {
      const o = {};
      v.v.forEach(([k, x]) => (o[k] = lsJs(x)));
      return o;
    }
    case 'plugin':
      return Object.assign({ __plugin: v.v.name }, lsSettings(v.v));
  }
  return undefined;
}
function lsSettings(p) {
  const o = {};
  for (const [k, v] of p.settings) {
    const x = lsJs(v);
    if (o[k] !== undefined && isObj(o[k]) && isObj(x)) Object.assign(o[k], x);
    else if (o[k] !== undefined && Array.isArray(o[k])) o[k] = o[k].concat(x);
    else o[k] = x;
  }
  return o;
}
function lsPairs(v) {
  if (isObj(v)) return Object.entries(v);
  if (Array.isArray(v)) {
    const out = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
    return out;
  }
  return [];
}
const lsList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
function fieldSegs(ref) {
  ref = String(ref).trim();
  if (ref.startsWith('[')) {
    const segs = [];
    ref.replace(/\[([^\]]+)\]/g, (m, x) => segs.push(x.trim()));
    return segs;
  }
  return [ref];
}
const KAFKA_META = {
  topic: 'topic',
  partition: 'partition',
  offset: 'offset',
  key: 'message_key',
  timestamp: 'timestamp',
  headers: 'headers',
  consumer_group: 'consumer_group'
};
function vPathOf(segs, ns) {
  if (segs[0] === '@metadata') {
    const rest = segs.slice(1);
    if (rest[0] === 'kafka' && rest[1]) {
      const k = KAFKA_META[rest[1]] || rest[1];
      if (ns) return `%kafka.${segName(k)}`;
      return k === 'timestamp' ? '.timestamp' : `._kafka_${k.replace(/\W/g, '_')}`;
    }
    return rest.length ? '%' + rest.map(segName).join('.') : '%';
  }
  return '.' + segs.map(segName).join('.');
}
/*
 * Expression régulière de Ruby (Onigmo, celle des conditions =~, de gsub et de prune) → moteur regex de VRL (Rust).
 * - ^ et $ valent pour chaque ligne en Ruby : (?m) leur donne ce sens en Rust ;
 * - le drapeau m de Ruby (le point prend le saut de ligne) s’écrit s en Rust ;
 * - \w, \d, \s et \h ne prennent que des caractères ASCII en Ruby, tout Unicode en Rust : ils sont écrits en classes.
 * Le reste (lookahead, \Z, quantificateurs possessifs) n’a pas d’équivalent : Vector refuse alors la configuration.
 */
const RUBY_CLASSES = { w: '0-9A-Za-z_', d: '0-9', s: '\\t\\n\\x0B\\x0C\\r ', h: '0-9a-fA-F' };
// Classes POSIX : Unicode en Ruby, ASCII en Rust (graph et print restent celles de Rust)
const RUBY_POSIX = {
  alnum: '\\p{L}\\p{M}\\p{Nd}',
  alpha: '\\p{L}\\p{M}',
  blank: '\\p{Zs}\\t',
  cntrl: '\\p{Cc}\\p{Cf}\\p{Cn}\\p{Co}',
  digit: '\\p{Nd}',
  lower: '\\p{Ll}',
  upper: '\\p{Lu}',
  punct: '\\p{P}\\x24+<=>\\^`|~',
  space: '\\p{Zs}\\p{Zl}\\p{Zp}\\t\\n\\x0B\\x0C\\r\\x{85}',
  xdigit: '0-9A-Fa-f',
  word: '\\p{L}\\p{M}\\p{Nd}\\p{Pc}'
};
function rubyRe(re) {
  re = String(re);
  let out = '';
  let depth = 0;
  let anchors = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') {
      const n = re[i + 1];
      i++;
      if (n === undefined) {
        out += c;
        break;
      }
      const k = n.toLowerCase();
      if (RUBY_CLASSES[k]) {
        const neg = n !== k;
        out += depth ? (neg ? `[^${RUBY_CLASSES[k]}]` : RUBY_CLASSES[k]) : `[${neg ? '^' : ''}${RUBY_CLASSES[k]}]`;
      } else out += c + n;
      continue;
    }
    if (depth) {
      const px = c === '[' && /^\[:(\^?)([a-z]+):\]/.exec(re.slice(i));
      if (px && RUBY_POSIX[px[2]]) {
        out += px[1] ? `[^${RUBY_POSIX[px[2]]}]` : RUBY_POSIX[px[2]];
        i += px[0].length - 1;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      out += c;
      continue;
    }
    if (c === '[') {
      depth = 1;
      out += c;
      if (re[i + 1] === '^') {
        out += '^';
        i++;
      }
      if (re[i + 1] === ']') {
        out += '\\]';
        i++;
      }
      continue;
    }
    if (c === '(' && re[i + 1] === '?') {
      const m = /^\(\?([imx]*)(?:-([imx]*))?([:)])/.exec(re.slice(i));
      if (m && (m[1] || m[2] !== undefined)) {
        const sw = f => f.replace(/m/g, 's');
        out += `(?${sw(m[1])}${m[2] !== undefined ? '-' + sw(m[2]) : ''}${m[3]}`;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '^' || c === '$') anchors = true;
    out += c;
  }
  return anchors ? '(?m)' + out : out;
}
function joda2strf(f) {
  let out = '';
  let i = 0;
  const tok = (c, run) => {
    switch (c) {
      case 'y':
      case 'Y':
      case 'u':
        return run === 2 ? '%y' : '%Y';
      case 'M':
        return run >= 4 ? '%B' : run === 3 ? '%b' : '%m';
      case 'd':
        return '%d';
      case 'D':
        return '%j';
      case 'H':
      case 'k':
        return '%H';
      case 'h':
      case 'K':
        return '%I';
      case 'm':
        return '%M';
      case 's':
        return '%S';
      case 'S':
        return run >= 9 ? '%9f' : run >= 6 ? '%6f' : '%3f';
      case 'Z':
        return run === 1 ? '%z' : run === 2 ? '%:z' : '%Z';
      case 'X':
      case 'x':
        return run === 1 ? '%z' : '%:z';
      case 'z':
        return '%Z';
      case 'a':
        return '%p';
      case 'E':
        return run >= 4 ? '%A' : '%a';
      case 'e':
        return '%u';
      default:
        return c.repeat(run);
    }
  };
  while (i < f.length) {
    const c = f[i];
    if (c === "'") {
      const j = f.indexOf("'", i + 1);
      const lit = j < 0 ? f.slice(i + 1) : f.slice(i + 1, j);
      out += lit === '' ? "'" : lit.replace(/%/g, '%%');
      i = j < 0 ? f.length : j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (f[j] === c) j++;
      out += tok(c, j - i);
      i = j;
      continue;
    }
    out += c === '%' ? '%%' : c;
    i++;
  }
  return out;
}
function compName(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'etape'
  );
}
// Valeurs qu’une condition « if [champ] » de Logstash tient pour fausses
const FALSY = '[null, false, "", "false"]';
// Types connus à la sortie d’un bloc conditionnel : ceux qui sont les mêmes par tous les chemins
function commonTypes(paths) {
  const merged = new Map();
  for (const k of new Set(paths.flatMap(m => [...m.keys()]))) {
    const vals = paths.map(m => m.get(k) || 'any');
    if (vals.every(x => x === vals[0]) && vals[0] !== 'any') merged.set(k, vals[0]);
  }
  return merged;
}

class VrlGen {
  constructor(v) {
    this.v = v;
    this.lines = [];
    this.ind = 0;
    this.types = new Map(v.ns ? [] : [['.', 'obj']]);
    this.blocks = [];
    this.usedAbort = false;
    this.plugins = [];
    this.todo = false;
    this.depth = 0;
  }
  root() {
    return this.types.get('.') === 'obj' ? '.' : 'object!(.)';
  }
  mergeRoot(x) {
    this.emit(`. = merge(${this.root()}, ${x})`);
    this.treset();
    this.types.set('.', 'obj');
  }
  emit(s) {
    this.lines.push('  '.repeat(this.ind) + s);
  }
  comment(s) {
    this.emit('# ' + s);
  }
  open(s) {
    this.emit(s + ' {');
    this.ind++;
    this.blocks.push({ before: new Map(this.types), ends: [], total: false });
  }
  // Ferme un bloc, ou passe à sa branche suivante (« } else { », « } else if … { »). Un type posé dans une branche
  // n’est plus connu après le bloc, sauf s’il est le même par tous les chemins : VRL le déduit ainsi, et refuse
  // un appel faillible que le moteur croirait sûr.
  close(s) {
    this.ind--;
    this.emit(s || '}');
    const b = this.blocks[this.blocks.length - 1];
    if (!b) return;
    b.ends.push(this.types);
    if (s) {
      b.total = /else \{$/.test(s);
      this.types = new Map(b.before);
      return;
    }
    this.blocks.pop();
    this.types = commonTypes(b.total ? b.ends : b.ends.concat(b.before));
  }
  code() {
    return this.lines.join('\n').trim() + '\n';
  }
  hasCode() {
    return this.lines.some(l => l.trim() && !l.trim().startsWith('#'));
  }
  path(ref) {
    return vPathOf(fieldSegs(ref), this.v.ns);
  }
  tget(p) {
    return this.types.get(p) || 'any';
  }
  // Champ dont le type est connu : il est présent et non nul, une garde d’existence serait inutile
  present(p) {
    const t = this.tget(p);
    return t !== 'any' && t !== 'null';
  }
  tset(p, t) {
    for (const k of [...this.types.keys()]) if (k !== '.' && (k === p || k.startsWith(p + '.'))) this.types.delete(k);
    if (t && t !== 'any') this.types.set(p, t);
  }
  treset() {
    const r = this.types.get('.');
    this.types.clear();
    if (r) this.types.set('.', r);
  }
  asStr(p) {
    const t = this.tget(p);
    if (t === 'str') return p;
    if (t === 'null') return '""';
    if (t === 'arr') return `(join(${p}, ",") ?? "")`;
    return `(to_string(${p}) ?? join(${p}, ",") ?? encode_json(${p}))`;
  }
  sprintf(s) {
    s = String(s);
    const parts = [];
    let last = 0;
    const re = /%\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(vq(s.slice(last, m.index)));
      const ref = m[1];
      if (ref.startsWith('+'))
        parts.push(
          `(format_timestamp(timestamp(."@timestamp") ?? parse_timestamp(."@timestamp", "%+") ?? now(), format: ${vq(joda2strf(ref.slice(1)))}) ?? "")`
        );
      else {
        // Champ absent ou nul : Logstash laisse « %{champ} » tel quel. Un tableau est joint par des virgules,
        // ses éléments écrits en texte (StringInterpolation de Logstash).
        const p = this.path(ref);
        const t = this.tget(p);
        const lit = vq(m[0]);
        // KeyNode.join : les tableaux imbriqués sont aplatis, un élément nul compte pour une chaîne vide
        const list = (x, known) =>
          `(join(map_values(flatten(${known ? x : `array!(${x})`})) -> |item| { if item == null { "" } else { to_string(item) ?? encode_json(item) } }, ",") ?? "")`;
        if (t === 'str') parts.push(p);
        else if (t === 'null') parts.push(lit);
        else if (t === 'arr') parts.push(list(p, true));
        else {
          // VRL n’accepte pas un if au milieu d’une expression : la valeur est calculée juste avant la ligne qui l’emploie
          const v = `ref_${++this.v.refN}`;
          this.emit(
            `${v} = if ${p} == null { ${lit} } else if is_array(${p}) { ${list(p)} } else { to_string(${p}) ?? encode_json(${p}) }`
          );
          parts.push(v);
        }
      }
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(vq(s.slice(last)));
    if (!parts.length) return '""';
    return parts.join(' + ');
  }
  sprintfValue(v) {
    return Array.isArray(v)
      ? `[${v.map(x => this.sprintf(x)).join(', ')}]`
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : this.sprintf(v);
  }
  assign(p, expr, t) {
    this.emit(`${p} = ${expr}`);
    this.tset(p, t || 'any');
  }
  // Affectation sous garde, sur une ligne : après elle, le type du champ n’est plus connu
  assignIf(c, p, expr) {
    this.emit(`if ${c} { ${p} = ${expr} }`);
    this.tset(p, 'any');
  }
  addTags(tags) {
    if (!tags.length) return;
    this.emit(`.tags = compact(flatten([.tags, ${tags.map(t => this.sprintf(t)).join(', ')}]))`);
    this.tset('.tags', 'arr');
  }
  removeTags(tags) {
    const keep = `-> |_index, tag| { !includes([${tags.map(vq).join(', ')}], tag) }`;
    if (this.tget('.tags') === 'arr') return this.emit(`.tags = filter(.tags) ${keep}`);
    // Sans champ tags, Logstash ne fait rien ; une étiquette seule, écrite en chaîne, devient un tableau
    this.assignIf('.tags != null', '.tags', `filter(flatten([.tags])) ${keep}`);
  }
  delField(f) {
    // Nom de champ calculé : la référence obtenue, « a » ou « [a][b] », est découpée en chemin
    if (/%\{/.test(String(f))) {
      this.emit(`. = remove!(., split(replace(${this.sprintf(f)}, r'^\\[|\\]$', ""), "]["))`);
      this.treset();
      this.types.delete('.');
      return;
    }
    const p = this.path(f);
    this.emit(`del(${p})`);
    this.tset(p, 'null');
  }
  common(s) {
    for (const [k, v] of lsPairs(s.add_field)) {
      if (/%\{/.test(k)) {
        this.v.note(
          'warn',
          'Nom de champ dynamique',
          `add_field « ${k} » : un nom calculé n’est pas pris en charge, champ ignoré.`
        );
        continue;
      }
      // Comme Logstash : sur un champ qui existe déjà, la valeur est ajoutée et le champ devient un tableau
      const p = this.path(k);
      const val = this.sprintfValue(v);
      if (this.tget(p) === 'null') this.assign(p, val, typeof v === 'string' ? 'str' : 'any');
      else {
        this.emit(`if exists(${p}) { ${p} = push(array(${p}) ?? [${p}], ${val}) } else { ${p} = ${val} }`);
        this.tset(p, 'any');
      }
    }
    lsList(s.remove_field).forEach(f => this.delField(f));
    if (s.add_tag) this.addTags(lsList(s.add_tag));
    if (s.remove_tag) this.removeTags(lsList(s.remove_tag));
  }
  failTags(tags) {
    if (tags.length) this.addTags(tags);
  }
  ok() {
    this.v.stats.ok++;
  }
  // Mode ECS : renomme les captures historiques des motifs composites (table GROK_ECS), comme le font les motifs ecs-v1
  grokEcs(patterns, under) {
    const seen = new Set();
    const rows = [];
    for (const pat of patterns)
      for (const [, name] of String(pat).matchAll(/%\{(\w+)\}/g)) {
        if (GROK_ECS[name])
          GROK_ECS[name].forEach(r => {
            if (!seen.has(r[0])) {
              seen.add(r[0]);
              rows.push(r);
            }
          });
        else if (GROK_COMPOSITE.test(name))
          this.v.note(
            'warn',
            `grok ${name} en mode ECS`,
            `Logstash capture ses champs sous des noms ECS ; la traduction garde les noms historiques de parse_grok. Vérifiez les noms attendus en aval, ou passez le filtre en ecs_compatibility => disabled.`
          );
      }
    if (!rows.length) return;
    this.comment('Mode ECS : captures renommées comme dans les motifs ecs-v1 de Logstash');
    for (const [legacy, ecs, how] of rows) {
      const L = under(legacy);
      if (how === 'drop') {
        this.emit(`del(${L})`);
        this.tset(L, 'null');
        continue;
      }
      const E = under(ecs);
      this.open(`if exists(${L})`);
      this.emit(how === 'qs' ? `v = replace(string(del(${L})) ?? "", r'^"|"$', "")` : `v = del(${L})`);
      // Le message capturé s’ajoute au message d’origine, comme toute capture sur un champ existant
      const set =
        ecs === 'message'
          ? `if exists(${E}) { ${E} = push(array(${E}) ?? [${E}], v) } else { ${E} = v }`
          : `${E} = ${how === 'int' ? 'to_int(v) ?? v' : 'v'}`;
      this.emit(how === 'dash' || how === 'qs' ? `if v != "-" { ${set} }` : set);
      this.close();
      this.tset(L, 'null');
      this.tset(E, 'any');
    }
  }
  // Mode ECS effectif d’un plugin : son réglage ecs_compatibility, sinon celui de la configuration
  ecsOn(s) {
    const e = s && s.ecs_compatibility;
    return e ? String(e) !== 'disabled' : this.v.ecs;
  }
  approx(title, detail) {
    this.v.stats.approx++;
    this.v.note('warn', title, detail);
  }
  ko(p, detail, code) {
    this.v.stats.ko++;
    this.todo = true;
    this.v.note('err', `Filtre ${p.name} non traduit (ligne ${p.line})`, detail, code);
    this.comment(`À TRADUIRE : filtre ${p.name}, ligne ${p.line} du pipeline Logstash`);
    if (code) code.split('\n').forEach(l => this.comment('  ' + l));
  }
  /* ----- structure ----- */
  stmt(st) {
    if (st.k === 'if') this.ifChain(st.branches);
    else this.plugin(st);
  }
  ifChain(branches) {
    const saved = new Map(this.types);
    const results = [];
    this.depth++;
    branches.forEach((b, idx) => {
      const head = b.cond ? `${idx === 0 ? 'if' : '} else if'} ${this.cond(b.cond)} {` : '} else {';
      if (idx > 0) this.ind--;
      this.emit(head);
      this.ind++;
      this.types = new Map(saved);
      const before = this.lines.length;
      b.body.forEach(x => this.stmt(x));
      if (!this.lines.slice(before).some(l => l.trim() && !l.trim().startsWith('#'))) this.emit('noop = true');
      results.push(this.types);
    });
    this.ind--;
    this.emit('}');
    this.depth--;
    if (!branches.some(b => !b.cond)) results.push(saved);
    this.types = commonTypes(results);
  }
  rv(x) {
    if (x.t === 'field') return vPathOf(x.v, this.v.ns);
    if (x.t === 'str') return vq(x.v);
    if (x.t === 'num') return String(x.v);
    if (x.t === 'arr') return `[${x.v.map(i => (i.t === 'num' ? String(i.v) : vq(lsJs(i)))).join(', ')}]`;
    if (x.t === 'bare')
      return x.v === 'true' || x.v === 'false' || x.v === 'nil' ? (x.v === 'nil' ? 'null' : x.v) : vq(x.v);
    if (x.t === 're') return vraw(rubyRe(x.v), 'r');
    return 'null';
  }
  numOf(x) {
    if (x.t !== 'field') return this.rv(x);
    const p = this.rv(x);
    const t = this.tget(p);
    return t === 'null' ? '0.0' : `(to_float(${p}) ?? 0.0)`;
  }
  cw(c) {
    const s = this.cond(c);
    return c.op === 'or' || c.op === 'xor' ? `(${s})` : s;
  }
  cond(c) {
    switch (c.op) {
      case 'and':
        return `${this.cw(c.l)} && ${this.cw(c.r)}`;
      case 'or':
        return `${this.cond(c.l)} || ${this.cond(c.r)}`;
      case 'xor':
        return `(${this.cond(c.l)}) != (${this.cond(c.r)})`;
      case 'nand':
        return `!(${this.cond(c.l)} && ${this.cond(c.r)})`;
      case 'not':
        return c.e.op === 'truthy' && c.e.v.t === 'field'
          ? `includes(${FALSY}, ${this.rv(c.e.v)})`
          : `!(${this.cond(c.e)})`;
      // Pour Logstash, un champ est faux s’il est absent, nul, false, ou s’il s’écrit « false » ou vide
      case 'truthy':
        return c.v.t !== 'field' ? this.rv(c.v) : `!includes(${FALSY}, ${this.rv(c.v)})`;
      case 'cmp': {
        if (c.cmp === '==' || c.cmp === '!=') return `${this.rv(c.l)} ${c.cmp} ${this.rv(c.r)}`;
        const numeric = c.l.t === 'num' || c.r.t === 'num';
        if (numeric) {
          // Un champ absent ou qui n’est pas un nombre : Logstash jette l’événement (avertissement dans son journal).
          // La traduction le garde et tient la condition pour fausse.
          const guards = [c.l, c.r]
            .filter(x => x.t === 'field')
            .map(x => this.rv(x))
            .filter(p => !['int', 'float'].includes(this.tget(p)))
            .map(p => `(is_integer(${p}) || is_float(${p}))`);
          const cmp = `${this.numOf(c.l)} ${c.cmp} ${this.numOf(c.r)}`;
          if (!guards.length) return cmp;
          this.v.note(
            'warn',
            'Comparaison à un nombre',
            'Quand le champ comparé est absent ou n’est pas un nombre, Logstash jette l’événement (avec un avertissement dans son journal). La traduction le garde et tient la condition pour fausse.'
          );
          return `(${guards.join(' && ')} && ${cmp})`;
        }
        const st = x => (x.t === 'field' ? this.asStr(this.rv(x)) : this.rv(x));
        return `${st(c.l)} ${c.cmp} ${st(c.r)}`;
      }
      case 'regex': {
        const re = c.r.t === 're' ? c.r.v : String(c.r.v);
        if (/\(\?<?[=!]/.test(re))
          this.v.note(
            'warn',
            'Assertion regex',
            `L’expression /${re}/ utilise une assertion (lookahead/lookbehind) non prise en charge par le moteur regex de Vector.`
          );
        const p = this.rv(c.l);
        const t = this.tget(p);
        const rx = vraw(rubyRe(re), 'r');
        const m = t === 'str' ? `match(${p}, ${rx})` : t === 'null' ? 'false' : `(match(${p}, ${rx}) ?? false)`;
        return c.neg ? `!${m}` : m;
      }
      case 'in': {
        const l = this.rv(c.l);
        let e;
        if (c.r.t === 'arr') e = `includes(${this.rv(c.r)}, ${l})`;
        else if (c.r.t === 'field') {
          const p = this.rv(c.r);
          const t = this.tget(p);
          if (t === 'arr') e = `includes(${p}, ${l})`;
          else if (t === 'str') e = `contains(${p}, ${c.l.t === 'field' ? this.asStr(l) : l})`;
          else
            e = `(includes(array(${p}) ?? [], ${l}) || contains(string(${p}) ?? "", ${c.l.t === 'field' ? this.asStr(l) : l}))`;
        } else e = `contains(${this.rv(c.r)}, ${l})`;
        return c.neg ? `!${e}` : e;
      }
    }
    return 'false';
  }
  plugin(p) {
    const s = lsSettings(p);
    this.plugins.push(p.name);
    this.comment(`${p.name}${s.id ? ` · ${s.id}` : ''}`);
    const fn = this['f_' + p.name];
    if (!fn)
      return this.ko(
        p,
        KO_HINTS[p.name] || `Le filtre « ${p.name} » n’a pas d’équivalent automatique.`,
        p.name === 'ruby' ? String(s.code || '') : ''
      );
    fn.call(this, s, p);
  }
  /* ----- filtres ----- */
  f_grok(s, p) {
    const custom = Object.assign({}, s.pattern_definitions || {});
    if (s.patterns_dir)
      this.v.note(
        'warn',
        'patterns_dir',
        'Les motifs grok personnalisés stockés dans des fichiers doivent être recopiés dans pattern_definitions pour être intégrés au programme VRL.'
      );
    const failTags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_grokparsefailure'];
    let matches = isObj(s.match) ? Object.entries(s.match) : lsPairs(s.match);
    if (!matches.length) return this.ko(p, 'grok sans option match.');
    for (const [field, pats0] of matches) {
      const conv = [];
      const moves = [];
      const pats = lsList(pats0).map(pat => {
        let x = String(pat);
        for (const [name, def] of Object.entries(custom))
          x = x.replace(new RegExp(`%\\{${name}(?::([^:}]+))?(?::(int|float))?\\}`, 'g'), (m, f) =>
            f ? `(?<${f}>${def})` : `(?:${def})`
          );
        x = x.replace(/%\{(\w+):([^:}]+):(int|float)\}/g, (m, pn, f, t) => {
          conv.push([f, t]);
          return `%{${pn}:${f}}`;
        });
        x = x.replace(/%\{(\w+):(\[[^}]+\])\}/g, (m, pn, f) => {
          const tmp =
            'ls__' +
            fieldSegs(f)
              .map(z => z.replace(/\W/g, '_'))
              .join('__');
          moves.push([tmp, f]);
          return `%{${pn}:${tmp}}`;
        });
        return x;
      });
      const src = this.path(field);
      // Avec target, les captures sont posées sous ce champ plutôt qu’à la racine
      const tgt = s.target ? this.path(s.target) : '';
      const under = f => (tgt ? `${tgt}.${fieldSegs(f).map(segName).join('.')}` : this.path(f));
      // Comme Logstash : une capture dont le champ existe déjà s’y ajoute, et le champ devient un tableau (sauf overwrite)
      const overwrite = lsList(s.overwrite);
      const landRoot = x => {
        this.emit('dup = {}');
        this.open(`for_each(${x}) -> |k, val|`);
        this.emit('old = get!(., [k])');
        this.emit(
          `if old != null${overwrite.length ? ` && !includes([${overwrite.map(vq).join(', ')}], k)` : ''} { dup = set!(dup, [k], push(array(old) ?? [old], val)) }`
        );
        this.close();
        this.mergeRoot(`merge(${x}, dup)`);
      };
      const land = x => (tgt ? this.assign(tgt, `merge(object(${tgt}) ?? {}, ${x})`) : landRoot(x));
      // Un nom capturé dans plusieurs branches d’une alternative (HTTPD_ERRORLOG, ou « %{A:x}|%{B:x} ») revient de
      // parse_grok sous le nom « x[1] » pour la seconde branche ; Logstash le range sous son nom
      const alt = lsList(pats0).some(
        x =>
          /%\{HTTPD_ERRORLOG\}/.test(x) ||
          [...String(x).matchAll(/%\{\w+:([^:}]+)/g)].map(m => m[1]).some((n, i, a) => a.indexOf(n) !== i)
      );
      const names = x => (alt ? `map_keys(${x}) -> |k| { replace(k, r'\\[\\d+\\]$', "") }` : x);
      if (pats.length === 1) {
        this.emit(`parsed, err = parse_grok(${src}, ${vraw(pats[0], 's')})`);
        this.open('if err == null');
        land(names('parsed'));
      } else {
        this.emit(`parsed = ${pats.map(x => `parse_grok(${src}, ${vraw(x, 's')})`).join(' ?? ')} ?? null`);
        this.open('if parsed != null');
        land(names('object!(parsed)'));
      }
      if (this.ecsOn(s)) this.grokEcs(lsList(pats0), under);
      for (const [tmp, f] of moves) this.assign(under(f), `del(${tgt}.${tmp})`);
      for (const [f, t] of conv) {
        const fp = under(f);
        this.assign(fp, `${t === 'int' ? 'to_int' : 'to_float'}(${fp}) ?? ${fp}`);
      }
      this.common(s);
      if (failTags.length) {
        this.close('} else {');
        this.ind++;
        this.failTags(failTags);
      }
      this.close();
    }
    if (moves_note(matches))
      this.v.note(
        'info',
        'Captures grok imbriquées',
        'Les noms [a][b] sont capturés sous un nom temporaire puis déplacés, car parse_grok produit des clés plates.'
      );
    this.ok();
  }
  f_date(s, p) {
    const m = lsList(s.match);
    if (m.length < 2) return this.ko(p, 'date sans option match complète.');
    const src = this.path(m[0]);
    const tgt = this.path(s.target || '@timestamp');
    const tz = s.timezone ? `, timezone: ${vq(s.timezone)}` : '';
    const lines = [];
    for (const f of m.slice(1)) {
      if (f === 'ISO8601') lines.push({ iso: true });
      else if (f === 'UNIX' || f === 'UNIX_MS') {
        lines.push({ unix: f });
      } else if (f === 'TAI64N') {
        this.approx('Format TAI64N', 'Non pris en charge par parse_timestamp : format ignoré.');
      } else {
        const sf = joda2strf(f);
        if (!/%[Yy]/.test(sf)) {
          lines.push({ yearless: sf });
          this.v.note(
            'info',
            'Date sans année',
            `Le format « ${f} » n’a pas d’année : comme Logstash, la traduction prend l’année en cours, celle d’avant pour un événement de décembre lu en janvier, celle d’après pour un événement de janvier lu en décembre.`
          );
        } else lines.push(`ts = parse_timestamp(${src}, ${vq(sf)}${tz}) ?? null`);
      }
    }
    // Champ absent ou nul : Logstash ne fait rien, pas même signaler un échec
    const guarded = !this.present(src);
    if (guarded) this.open(`if ${src} != null`);
    this.emit('ts = null');
    lines.forEach(l => {
      this.open('if ts == null');
      if (typeof l === 'string') this.emit(l);
      else if (l.iso) {
        // Formes ISO8601 que Logstash lit : avec ou sans fuseau, espace ou T, secondes et décimales facultatives
        // (point ou virgule), ou le jour seul, à minuit
        this.emit(`iso = replace(${this.tget(src) === 'str' ? src : `string(${src}) ?? ""`}, ",", ".")`);
        this.emit(`ts = ${isoParse('iso', tz)}`);
      } else if (l.yearless) {
        // Format sans année : l’année en cours, corrigée d’un an quand décembre et janvier se croisent
        const zone = s.timezone ? tz : ', timezone: "local"';
        const parse = year =>
          `parse_timestamp(to_string(${year}) + " " + text, ${vq('%Y ' + l.yearless)}${tz}) ?? null`;
        this.emit(`text = ${this.tget(src) === 'str' ? src : `to_string(${src}) ?? ""`}`);
        this.emit(`year = to_int!(format_timestamp!(now(), format: "%Y"${zone}))`);
        this.emit(`ts = ${parse('year')}`);
        this.open('if ts != null');
        this.emit(
          `months = format_timestamp!(ts, format: "%m"${zone}) + format_timestamp!(now(), format: "%m"${zone})`
        );
        this.emit(`if months == "1201" { ts = ${parse('year - 1')} }`);
        this.emit(`if months == "0112" { ts = ${parse('year + 1')} }`);
        this.close();
      } else if (l.unix === 'UNIX') {
        // Des secondes, avec ou sans décimales, en nombre ou en chaîne : comme Logstash, rien d’autre (ni « 1e9 », ni un booléen)
        this.open(`if match(${this.tget(src) === 'str' ? src : `to_string(${src}) ?? ""`}, r'^-?\\d+(\\.\\d+)?$')`);
        this.emit(`ts = from_unix_timestamp(to_int(to_float!(${src}) * 1000), unit: "milliseconds") ?? null`);
        this.close();
      } else {
        this.emit(`n = to_int(${src}) ?? null`);
        this.open('if n != null');
        this.emit('ts = from_unix_timestamp!(n, unit: "milliseconds")');
        this.close();
      }
      this.close();
    });
    // Hors @timestamp, que la finalisation met en forme, la cible est écrite comme le fait Logstash : en UTC, à la milliseconde
    const stamp =
      this.v.compat && tgt !== this.path('@timestamp')
        ? 'format_timestamp!(ts, format: "%Y-%m-%dT%H:%M:%S%.3fZ")'
        : 'ts';
    this.open('if ts != null');
    this.assign(tgt, stamp);
    this.common(s);
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_dateparsefailure'];
    if (tags.length) {
      this.close('} else {');
      this.ind++;
      this.failTags(tags);
    }
    this.close();
    if (guarded) this.close();
    if (s.locale && !/^en/i.test(String(s.locale)) && m.slice(1).some(f => /MMM|EEE/.test(f)))
      this.approx(
        'date locale',
        `Les noms de mois et de jours en « ${s.locale} » ne sont pas reconnus : parse_timestamp ne lit que l’anglais.`
      );
    this.ok();
  }
  f_mutate(s, p) {
    const order = [
      'coerce',
      'rename',
      'update',
      'replace',
      'convert',
      'gsub',
      'uppercase',
      'capitalize',
      'lowercase',
      'strip',
      'remove',
      'split',
      'join',
      'merge',
      'copy'
    ];
    // Une opération de chaîne ne touche qu’une chaîne : Logstash laisse tel quel un champ absent, nul ou d’un autre type
    // Un tableau n’est pas traité élément par élément (choix de lisibilité) : signalé quand le type du champ n’est pas connu
    const arrayNote = () =>
      this.v.note(
        'warn',
        'Tableaux dans mutate',
        'Sur un champ qui contient un tableau, Logstash applique l’opération à chaque élément ; la traduction laisse le tableau tel quel.'
      );
    const onString = (x, call, type) => {
      const t = this.tget(x);
      if (t === 'null') return;
      if (t === 'str') this.assign(x, call(''), type);
      else {
        this.assignIf(`is_string(${x})`, x, call('!'));
        if (t !== 'arr') arrayNote();
      }
    };
    const unary = (fields, fn) =>
      lsList(fields).forEach(f => {
        const x = this.path(f);
        onString(x, bang => `${fn}${bang}(${x})`, 'str');
      });
    for (const op of order) {
      const v = s[op];
      if (v === undefined) continue;
      switch (op) {
        // coerce ne remplace qu’un champ présent et nul
        case 'coerce':
          lsPairs(v).forEach(([f, d]) => {
            const x = this.path(f);
            if (this.tget(x) === 'null') return;
            this.open(`if exists(${x}) && ${x} == null`);
            this.assign(x, this.sprintf(d), 'str');
            this.close();
            this.tset(x, 'any');
          });
          break;
        case 'rename':
          lsPairs(v).forEach(([a, b]) => {
            const pa = this.path(a),
              pb = this.path(b);
            this.open(`if exists(${pa})`);
            this.assign(pb, `del(${pa})`);
            this.close();
            this.tset(pa, 'any');
            this.tset(pb, 'any');
          });
          break;
        case 'update':
          lsPairs(v).forEach(([f, val]) => {
            const x = this.path(f);
            this.open(`if exists(${x})`);
            this.assign(x, this.sprintfValue(val));
            this.close();
            this.tset(x, 'any');
          });
          break;
        case 'replace':
          lsPairs(v).forEach(([f, val]) => this.assign(this.path(f), this.sprintfValue(val), 'str'));
          break;
        case 'convert':
          lsPairs(v).forEach(([f, ty]) => {
            const x = this.path(f);
            if (this.tget(x) === 'null') return;
            const fn = {
              integer: 'to_int',
              float: 'to_float',
              string: 'to_string',
              boolean: 'to_bool',
              integer_eu: 'to_int',
              float_eu: 'to_float'
            }[ty];
            if (!fn) return this.v.note('warn', 'convert', `Type « ${ty} » inconnu pour ${f}.`);
            if (/_eu$/.test(ty))
              this.v.note(
                'warn',
                `convert ${ty}`,
                'Le format numérique européen (virgule décimale) n’est pas géré : remplacez la virgule avant la conversion.'
              );
            if (fn === 'to_string' && this.tget(x) === 'str') return;
            if (!['int', 'float', 'str', 'bool'].includes(this.tget(x))) arrayNote();
            if (fn !== 'to_string')
              this.v.note(
                'warn',
                'Conversion impossible dans mutate',
                'Une valeur qui ne se convertit pas reste telle quelle. Logstash pose en plus _mutate_error et n’applique pas la suite du mutate (add_field, add_tag…) ; la traduction l’applique.'
              );
            // Nombres lus comme Logstash : espaces autour, séparateurs « , » et « _ » ignorés ; pour un entier, aussi les
            // décimales (tronquées), la notation 1e3 et l’hexadécimal 0x1A
            const num = (ty === 'integer' || ty === 'float') && this.tget(x) !== 'int' && this.tget(x) !== 'float';
            const expr = !num
              ? `${fn}(${x}) ?? ${x}`
              : ty === 'integer'
                ? `to_int(${x}) ?? parse_int(num) ?? to_int(to_float(num) ?? ${x}) ?? ${x}`
                : `to_float(${x}) ?? to_float(num) ?? ${x}`;
            const numLine = `num = replace(replace(strip_whitespace(string(${x}) ?? ""), ",", ""), "_", "")`;
            // Un champ absent ou nul n’est pas converti : to_int(null) vaudrait 0
            if (this.present(x)) {
              if (num) this.emit(numLine);
              this.assign(x, expr);
            } else if (!num) this.assignIf(`${x} != null`, x, expr);
            else {
              this.open(`if ${x} != null`);
              this.emit(numLine);
              this.assign(x, expr);
              this.close();
              this.tset(x, 'any');
            }
          });
          break;
        case 'gsub': {
          const a = lsList(v);
          for (let i = 0; i + 2 < a.length; i += 3) {
            const x = this.path(a[i]);
            const rep = String(a[i + 2])
              .replace(/\$/g, '$$$$')
              .replace(/\\(\d)/g, '$${$1}');
            onString(x, bang => `replace${bang}(${x}, ${vraw(rubyRe(a[i + 1]), 'r')}, ${vq(rep)})`, 'str');
          }
          break;
        }
        case 'uppercase':
          unary(v, 'upcase');
          break;
        case 'lowercase':
          unary(v, 'downcase');
          break;
        case 'strip':
          unary(v, 'strip_whitespace');
          break;
        // La première lettre est prise par caractère : slice compte des octets et couperait une lettre accentuée
        case 'capitalize':
          lsList(v).forEach(f => {
            const x = this.path(f);
            onString(
              x,
              bang => `upcase(truncate${bang}(${x}, 1)) + downcase(replace${bang}(${x}, r'(?s)^.', ""))`,
              'str'
            );
          });
          break;
        case 'remove':
          lsList(v).forEach(f => this.delField(f));
          break;
        // Découpage à la manière de Ruby : les éléments vides de fin sont écartés, et un séparateur « espace » découpe sur les blancs
        case 'split':
          lsPairs(v).forEach(([f, sep0]) => {
            const x = this.path(f);
            const t = this.tget(x);
            const sep = String(sep0);
            if (sep === '' || sep === ' ')
              return onString(
                x,
                bang =>
                  `filter(split${bang}(${x}, ${sep ? "r'[ \\t\\n\\v\\f\\r]+'" : '""'})) -> |_index, part| { part != "" }`,
                'arr'
              );
            if (t === 'null') return;
            const one = sep.replace(/[\\^$.*+?()[\]{}|]/g, ch => (ch === '$' ? '\\x24' : '\\' + ch));
            const ending = vraw(`${sep.length > 1 ? `(?:${one})` : one}+$`, 'r');
            if (t !== 'str') this.open(`if is_string(${x})`);
            this.emit(`${x} = split(replace${t === 'str' ? '' : '!'}(${x}, ${ending}, ""), ${vq(sep)})`);
            this.emit(`if ${x} == [""] { ${x} = [] }`);
            if (t !== 'str') this.close();
            this.tset(x, t === 'str' ? 'arr' : 'any');
          });
          break;
        case 'join':
          lsPairs(v).forEach(([f, sep]) => {
            const x = this.path(f);
            if (this.tget(x) !== 'null') this.assignIf(`is_array(${x})`, x, `join(${x}, ${vq(sep)}) ?? ${x}`);
          });
          break;
        // Deux objets réunissent leurs clés, un objet et autre chose ne donnent rien, le reste devient un tableau
        case 'merge':
          lsPairs(v).forEach(([dst, src]) => {
            const d = this.path(dst),
              sp = this.path(src);
            this.open(`if is_object(${d})`);
            this.emit(`${d} = merge(${d}, ${sp}) ?? ${d}`);
            this.close(`} else if !is_object(${sp}) {`);
            this.ind++;
            this.emit(`${d} = compact(flatten([${d}, ${sp}]))`);
            this.close();
            this.tset(d, 'any');
          });
          break;
        // Un champ absent ou nul n’est pas copié
        case 'copy':
          lsPairs(v).forEach(([src, dst]) => {
            const a = this.path(src),
              b = this.path(dst);
            if (this.tget(a) === 'null') return;
            if (this.present(a)) this.assign(b, a, this.tget(a));
            else this.assignIf(`${a} != null`, b, a);
          });
          break;
      }
    }
    this.common(s);
    this.ok();
  }
  f_json(s) {
    const src = this.path(s.source || 'message');
    const there = this.present(src);
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_jsonparsefailure'];
    this.emit(`parsed, err = parse_json(${src})`);
    // Sans target, seul un objet peut être posé à la racine : pour Logstash, toute autre valeur JSON est un échec
    if (s.target) {
      this.open('if err == null');
      this.assign(this.path(s.target), 'parsed');
    } else {
      this.open('if err == null && is_object(parsed)');
      this.mergeRoot('object!(parsed)');
    }
    this.common(s);
    // Un JSON illisible n’est signalé ni avec skip_on_invalid_json, ni quand le champ source est absent ou nul
    const when = !s.skip_on_invalid_json ? (there ? '' : `${src} != null`) : s.target ? null : 'err == null';
    if (tags.length && when !== null) {
      this.close(when ? `} else if ${when} {` : '} else {');
      this.ind++;
      this.failTags(tags);
    }
    this.close();
    this.ok();
  }
  f_kv(s) {
    const src = this.path(s.source || 'message');
    const vd = String(s.value_split !== undefined ? s.value_split : '=');
    const fd = String(s.field_split !== undefined ? s.field_split : ' ');
    // Logstash lit field_split comme un ensemble de caractères, parse_key_value comme un seul séparateur :
    // les caractères de l’ensemble sont ramenés au premier avant l’analyse
    const many = fd.length > 1 && !fd.includes('\\');
    if (vd.length > 1 || (fd.length > 1 && !many))
      this.v.note(
        'warn',
        'kv : séparateurs multiples',
        `Logstash traite « ${vd.length > 1 ? vd : fd} » comme un ensemble de caractères ; seul le premier est utilisé par parse_key_value.`
      );
    if (many)
      this.v.note(
        'info',
        'kv : plusieurs séparateurs de champs',
        `Chaque caractère de « ${fd} » sépare les champs, comme dans Logstash : ils sont ramenés au premier avant l’analyse. Une valeur entre guillemets qui contiendrait l’un d’eux le verrait remplacé.`
      );
    if (s.field_split_pattern || s.value_split_pattern)
      this.v.note('warn', 'kv : séparateurs regex', 'field_split_pattern / value_split_pattern ne sont pas repris.');
    const set = vraw(
      `[${[...new Set(fd)].map(ch => (/[\][^&~-]/.test(ch) ? '\\' + ch : ch === '$' ? '\\x24' : ch)).join('')}]`,
      'r'
    );
    const text = !many ? src : `replace(${src}, ${set}, ${vq(fd[0])})${this.tget(src) === 'str' ? '' : ` ?? ${src}`}`;
    this.emit(
      `kv, err = parse_key_value(${text}, key_value_delimiter: ${vq(vd[0] || '=')}, field_delimiter: ${vq(fd[0] || ' ')})`
    );
    this.open('if err == null');
    // Un mot sans séparateur de valeur, que parse_key_value rend avec la valeur true, n’est pas une paire pour Logstash
    this.emit('kv = filter(kv) -> |_key, value| { value != true }');
    if (s.include_keys)
      this.emit(`kv = filter(kv) -> |key, _value| { includes([${lsList(s.include_keys).map(vq).join(', ')}], key) }`);
    if (s.exclude_keys)
      this.emit(`kv = filter(kv) -> |key, _value| { !includes([${lsList(s.exclude_keys).map(vq).join(', ')}], key) }`);
    if (s.prefix) this.emit(`kv = map_keys(kv) -> |key| { ${vq(s.prefix)} + key }`);
    if (s.target) this.assign(this.path(s.target), 'kv');
    else this.mergeRoot('kv');
    this.common(s);
    this.close();
    this.ok();
  }
  f_dissect(s, p) {
    const maps = lsPairs(s.mapping);
    if (!maps.length) return this.ko(p, 'dissect sans mapping.');
    for (const [field, pattern] of maps) {
      const d = dissectRegex(pattern, null, true);
      d.warnings.forEach(w => this.approx('dissect', w));
      const src = this.path(field);
      const there = this.present(src);
      this.emit(`parsed, err = parse_regex(${src}, ${vraw(d.regex, 'r')})`);
      this.open('if err == null');
      d.fields.forEach(f => this.assign(this.path(f.field), `parsed.${f.group}`));
      for (const [f, t] of lsPairs(s.convert_datatype)) {
        const x = this.path(f);
        this.assign(x, `${t === 'int' ? 'to_int' : 'to_float'}(${x}) ?? ${x}`);
      }
      this.common(s);
      const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_dissectfailure'];
      // Sans champ source, Logstash ne signale pas d’échec
      if (tags.length) {
        this.close(there ? '} else {' : `} else if exists(${src}) {`);
        this.ind++;
        this.failTags(tags);
      }
      this.close();
    }
    this.v.note(
      'info',
      'dissect → parse_regex',
      'Le motif dissect est converti en expression régulière ancrée avec groupes nommés.'
    );
    this.ok();
  }
  f_drop(s) {
    if (s.percentage !== undefined)
      this.approx(
        'drop percentage',
        'L’échantillonnage aléatoire n’est pas repris : utilisez le transform sample de Vector.'
      );
    this.emit('abort');
    this.usedAbort = true;
    this.ok();
  }
  f_useragent(s) {
    const src = this.path(s.source || 'message');
    const tgt = this.path(s.target || 'user_agent');
    if (this.tget(src) === 'str') this.assign(tgt, `parse_user_agent(${src})`);
    else {
      this.emit(`ua, err = parse_user_agent(${src})`);
      this.open('if err == null');
      this.assign(tgt, 'ua');
      this.common(s);
      this.close();
    }
    this.v.note(
      'warn',
      'useragent → parse_user_agent',
      'La structure produite diffère (browser.family, os.family, device.category) : adaptez les consommateurs ou remappez les champs.'
    );
    this.v.stats.approx++;
  }
  f_geoip(s) {
    const src = this.path(s.source || 'message');
    const tgt = this.path(s.target || 'geoip');
    this.v.enrich.geoip = { type: 'geoip', path: s.database || '/etc/vector/GeoLite2-City.mmdb' };
    this.emit(`geo, err = get_enrichment_table_record("geoip", { "ip": ${src} })`);
    this.open('if err == null');
    this.assign(tgt, 'geo');
    this.common(s);
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_geoip_lookup_failure'];
    if (tags.length) {
      this.close('} else {');
      this.ind++;
      this.failTags(tags);
    }
    this.close();
    this.v.note(
      'warn',
      'geoip : base MaxMind à fournir',
      `La table geoip lit ${this.v.enrich.geoip.path} au démarrage : montez ce fichier dans le conteneur Vector. Sans lui, Vector refuse la configuration (error[E401] invalid enum variant, sur get_enrichment_table_record). Les noms de champs suivent le format MaxMind (city_name, country_code…).`
    );
    this.ok();
  }
  f_translate(s, p) {
    const src = this.path(s.source || s.field || 'message');
    const tgt = this.path(
      s.target || s.destination || (this.ecsOn(s) ? s.source || s.field || 'message' : 'translation')
    );
    if (s.regex)
      this.approx('translate regex', 'Les clés regex ne sont pas reprises : correspondance exacte uniquement.');
    const entries = lsPairs(s.dictionary);
    if (!s.dictionary_path && !entries.length) return this.ko(p, 'translate sans dictionnaire.');
    // Logstash ne traduit que si le champ source est présent et si la cible n’existe pas encore, sauf avec override.
    // Sinon rien ne se passe : ni valeur de repli, ni add_field, ni add_tag.
    const when = [];
    if (!this.present(src)) when.push(`exists(${src})`);
    // Mode ECS sans cible : la traduction remplace la valeur du champ source, qui existe forcément
    const inPlace = !s.target && !s.destination && this.ecsOn(s);
    if (!s.override && !inPlace) when.push(`!exists(${tgt})`);
    if (when.length) this.open(`if ${when.join(' && ')}`);
    this.emit(`key = ${this.asStr(src)}`);
    // Sans valeur de repli, add_field, add_tag et remove_field ne valent que si la clé est trouvée
    const extras = s.fallback === undefined && (s.add_field || s.add_tag || s.remove_field || s.remove_tag);
    if (s.dictionary_path) {
      const name = compName(
        'dict_' +
          String(s.dictionary_path)
            .split('/')
            .pop()
            .replace(/\.\w+$/, '')
      );
      const csvPath = String(s.dictionary_path).replace(/\.(ya?ml|json)$/i, '.csv');
      this.v.enrich[name] = {
        type: 'file',
        file: { path: csvPath, encoding: { type: 'csv', include_headers: true } },
        schema: { key: 'string', value: 'string' }
      };
      this.emit(`row, err = get_enrichment_table_record(${vq(name)}, { "key": key })`);
      this.open('if err == null');
      this.assign(tgt, 'row.value');
      if (extras) this.common(s);
      if (s.fallback !== undefined) {
        this.close('} else {');
        this.ind++;
        this.assign(tgt, this.sprintf(s.fallback), 'str');
      }
      this.close();
      this.tset(tgt, 'any');
      this.v.note(
        'warn',
        'Dictionnaire externe',
        `${s.dictionary_path} doit être converti en ${csvPath}, un CSV avec l’en-tête key,value, pour la table d’enrichissement « ${name} ».`
      );
    } else {
      if (extras) this.emit('found = true');
      entries.forEach(([k, v], i) => {
        this.emit(`${i === 0 ? 'if' : '} else if'} key == ${vq(k)} {`);
        this.ind++;
        this.emit(`${tgt} = ${this.sprintfValue(v)}`);
        this.ind--;
      });
      if (s.fallback !== undefined) {
        this.emit('} else {');
        this.ind++;
        this.emit(`${tgt} = ${this.sprintf(s.fallback)}`);
        this.ind--;
      } else if (extras) {
        this.emit('} else {');
        this.ind++;
        this.emit('found = false');
        this.ind--;
      }
      this.emit('}');
      this.tset(tgt, s.fallback !== undefined ? 'str' : 'any');
      if (extras) {
        this.open('if found');
        this.common(s);
        this.close();
      }
      if (entries.length > 50)
        this.v.note(
          'opt',
          'Grand dictionnaire',
          'Au-delà de quelques dizaines d’entrées, une table d’enrichissement CSV est plus lisible et plus rapide qu’une cascade de if.'
        );
    }
    if (!extras) this.common(s);
    if (when.length) {
      this.close();
      this.tset(tgt, 'any');
    }
    this.ok();
  }
  f_fingerprint(s, p) {
    const srcs = lsList(s.source || 'message');
    const tgt = this.path(s.target || (this.ecsOn(s) ? '[event][hash]' : 'fingerprint'));
    const method = String(s.method || 'SHA1').toUpperCase();
    // MurmurHash3 n’existe pas en VRL : un autre hachage donnerait d’autres clés de dédoublonnage, en silence
    if (method === 'MURMUR3')
      return this.ko(
        p,
        'MurmurHash3 n’existe pas en VRL : aucune fonction ne reproduit l’empreinte de Logstash. Choisissez une autre méthode des deux côtés, ou calculez-la en aval.'
      );
    // Comme Logstash : avec concatenate_sources, les sources triées par nom forment « |a|x|b|y| » ;
    // sinon, chaque source est hachée tour à tour et la dernière l’emporte
    const val = s.concatenate_sources
      ? `"|" + ${[...srcs]
          .sort()
          .map(f => `${vq(f + '|')} + ${this.asStr(this.path(f))} + "|"`)
          .join(' + ')}`
      : this.asStr(this.path(srcs[srcs.length - 1]));
    let e;
    if (s.key) {
      e = `encode_base16(hmac(${val}, get_env_var!("FINGERPRINT_KEY"), algorithm: ${vq(method.replace(/^SHA(\d)/, 'SHA-$1').replace('SHA-1', 'SHA1'))}))`;
      this.v.note(
        'opt',
        'Clé HMAC hors configuration',
        'La clé de fingerprint est lue dans la variable d’environnement FINGERPRINT_KEY plutôt que stockée en clair dans la configuration.'
      );
      this.v.env.add('FINGERPRINT_KEY');
    } else
      e = {
        SHA1: `sha1(${val})`,
        SHA256: `sha2(${val}, variant: "SHA-256")`,
        SHA384: `sha2(${val}, variant: "SHA-384")`,
        SHA512: `sha2(${val}, variant: "SHA-512")`,
        MD5: `md5(${val})`,
        UUID: 'uuid_v4()'
      }[method];
    // Champ source (le dernier, sans concatenate_sources) absent : Logstash n’écrit pas d’empreinte
    const one = !s.concatenate_sources && method !== 'UUID' ? this.path(srcs[srcs.length - 1]) : null;
    if (!one || this.present(one)) this.assign(tgt, e || `sha1(${val})`, 'str');
    else if (this.tget(one) !== 'null') this.assignIf(`exists(${one})`, tgt, e || `sha1(${val})`);
    this.common(s);
    this.ok();
  }
  f_uuid(s) {
    const tgt = this.path(s.target || 'uuid');
    if (s.overwrite) this.assign(tgt, 'uuid_v4()', 'str');
    else {
      this.open(`if !exists(${tgt})`);
      this.assign(tgt, 'uuid_v4()');
      this.close();
      this.tset(tgt, 'any');
    }
    this.common(s);
    this.ok();
  }
  f_urldecode(s) {
    const x = this.path(s.field || 'message');
    const t = this.tget(x);
    // all_fields : chaque chaîne de l’événement est décodée, à toute profondeur
    if (s.all_fields) {
      this.emit(
        `. = map_values(${this.root()}, recursive: true) -> |value| { if is_string(value) { decode_percent!(value) } else { value } }`
      );
      this.treset();
      this.types.set('.', 'obj');
    } else if (t !== 'null')
      this.assign(
        x,
        t === 'str' ? `decode_percent(${x})` : `decode_percent(${x}) ?? ${x}`,
        t === 'str' ? 'str' : 'any'
      );
    this.common(s);
    this.ok();
  }
  f_split(s) {
    const x = this.path(s.field || 'message');
    const tgt = s.target ? this.path(s.target) : x;
    const term = s.terminator !== undefined ? s.terminator : '\n';
    // Comme Logstash : une chaîne est découpée, sauf si elle ne donne qu’un élément (rien ne se passe alors) ; un tableau
    // est pris tel quel ; toute autre valeur est un échec. Un élément vide ou nul ne donne pas d’événement.
    this.emit('parts = null');
    this.open(`if is_string(${x})`);
    this.emit(`parts = split!(${x}, ${vq(term)})`);
    this.emit(`if length(parts) == 1 && ${x} != "" { parts = null }`);
    this.close(`} else if is_array(${x}) {`);
    this.ind++;
    this.emit(`parts = ${x}`);
    this.close('} else {');
    this.ind++;
    this.failTags(['_split_type_failure']);
    this.close();
    this.open('if parts != null');
    this.emit(`${tgt} = filter(array!(parts)) -> |_index, value| { value != null && value != "" }`);
    this.common(s);
    this.emit(`. = unnest!(${tgt})`);
    this.close();
    this.treset();
    this.types.delete('.');
    this.splitDone = true;
    if (this.depth > 0)
      this.v.note(
        'warn',
        'split dans une condition',
        'Après unnest, la racine de l’événement devient un tableau : placez les filtres suivants dans une étape séparée.'
      );
    this.v.note('info', 'split → unnest', 'unnest() crée un événement par élément du tableau, comme le filtre split.');
    this.ok();
  }
  f_truncate(s) {
    const n = s.length_bytes || 1000;
    // Seule une chaîne est tronquée : un champ absent n’est pas créé.
    // length_bytes compte des octets et truncate des caractères : la coupe se fait sur le dernier caractère entier
    // qui tient dans la limite. slice, lui, coupe à l’octet : son résultat ne sert qu’à compter.
    lsList(s.fields).forEach(f => {
      const x = this.path(f);
      const t = this.tget(x);
      if (t === 'null') return;
      if (t !== 'str')
        this.v.note(
          'warn',
          'Tableaux dans truncate',
          'Sur un champ qui contient un tableau, Logstash tronque chaque élément ; la traduction laisse le tableau tel quel.'
        );
      this.open(t === 'str' ? `if length(${x}) > ${n}` : `if is_string(${x}) && length!(${x}) > ${n}`);
      this.emit(`chars = strlen!(slice!(${x}, 0, ${n}))`);
      this.emit(`${x} = truncate${t === 'str' ? '' : '!'}(${x}, chars)`);
      this.emit(`if length(${x}) > ${n} { ${x} = truncate(${x}, chars - 1) }`);
      this.close();
      if (t !== 'str') this.tset(x, 'any');
    });
    this.common(s);
    this.ok();
  }
  f_csv(s) {
    const src = this.path(s.source || 'message');
    this.emit(`row, err = parse_csv(${src}, delimiter: ${vq(s.separator || ',')})`);
    this.open('if err == null');
    // Comme Logstash : les colonnes nommées dans l’ordre, column<n> au-delà (ou sans columns), une valeur vide à null,
    // rien pour une colonne sans valeur, le tout sous target s’il est donné
    this.emit(`names = [${lsList(s.columns).map(vq).join(', ')}]`);
    this.emit('cols = {}');
    this.open('for_each(row) -> |i, v|');
    this.emit('name = string(get(names, [i]) ?? null) ?? "column" + to_string(i + 1)');
    this.emit('val = v');
    this.emit('if val == "" { val = null }');
    this.emit('cols = set!(cols, [name], val)');
    this.close();
    if (s.target) this.assign(this.path(s.target), 'cols');
    else this.emit('. = merge!(., cols)');
    for (const [f, t] of lsPairs(s.convert)) {
      const x = this.path(f);
      this.assign(x, `${{ integer: 'to_int', float: 'to_float', boolean: 'to_bool' }[t] || 'to_string'}(${x}) ?? ${x}`);
    }
    this.common(s);
    this.close();
    this.ok();
  }
  f_cidr(s) {
    const addrs = lsList(s.address).map(a => {
      const m = /^%\{([^}]+)\}$/.exec(String(a));
      return m ? this.path(m[1]) : vq(a);
    });
    const nets = lsList(s.network);
    const c = addrs.flatMap(a => nets.map(nw => `(ip_cidr_contains(${vq(nw)}, ${a}) ?? false)`)).join(' || ');
    this.open(`if ${c}`);
    this.common(s);
    if (!(s.add_field || s.add_tag || s.remove_field || s.remove_tag)) this.emit('noop = true');
    this.close();
    this.ok();
  }
  /*
   * prune : clés de premier niveau de l’événement (event.to_hash, @metadata exclu, @timestamp compris) gardées
   * ou retirées selon des expressions régulières non ancrées ; blacklist_names vaut par défaut %\{[^}]+\} (clés
   * restées avec une référence non résolue). Les valeurs sont filtrées après les noms, sur l’événement d’origine.
   */
  f_prune(s, p) {
    const pats = list => lsList(list).map(String);
    const wl = pats(s.whitelist_names);
    const bl = s.blacklist_names === undefined ? ['%\\{[^}]+\\}'] : pats(s.blacklist_names);
    const wv = lsPairs(s.whitelist_values);
    const bv = lsPairs(s.blacklist_values);
    if (truthy(s.interpolate) && [...wl, ...bl, ...wv.flat(), ...bv.flat()].some(x => /%\{/.test(String(x))))
      return this.ko(
        p,
        'prune avec interpolate : les expressions régulières calculées pour chaque événement n’existent pas en VRL, qui compile ses expressions à l’avance.'
      );
    const union = list => vraw(rubyRe(list.map(x => `(?:${x})`).join('|')), 'r');
    this.emit(`orig = ${this.root()}`);
    const keep = [];
    if (wl.length) keep.push(`match(key, ${union(wl)})`);
    if (bl.length) keep.push(`!match(key, ${union(bl)})`);
    if (keep.length) this.emit(`. = filter(orig) -> |key, _value| { ${keep.join(' && ')} }`);
    const values = (pairs, white) =>
      pairs.forEach(([k, re]) => {
        const key = `[${vq(k)}]`;
        const dot = `.${vq(k)}`;
        const r = vraw(rubyRe(re), 'r');
        const hit = x =>
          white ? `is_string(${x}) && match(string!(${x}), ${r})` : `!(is_string(${x}) && match(string!(${x}), ${r}))`;
        this.emit(`v = get!(orig, ${key})`);
        this.open('if v != null && v != false');
        this.open('if is_array(v)');
        this.emit(`kept = filter(array!(v)) -> |_index, x| { ${hit('x')} }`);
        // Un tableau dont aucun élément n’est retiré reste tel quel, vide compris
        this.emit(
          `if length(kept) != length(array!(v)) { if length(kept) == 0 { del(${dot}) } else { ${dot} = kept } }`
        );
        this.close(`} else if is_string(v) {`);
        this.ind++;
        this.emit(`if ${white ? '!' : ''}match(string!(v), ${r}) { del(${dot}) }`);
        this.close();
        this.close();
      });
    values(wv, true);
    values(bv, false);
    this.treset();
    this.types.set('.', 'obj');
    this.common(s);
    this.ok();
  }
  /*
   * de_dot : remplace les points des noms de champs. Sans fields, les clés de premier niveau ; avec recursive, celles
   * des objets imbriqués aussi (pas celles des objets rangés dans des tableaux). nested range le champ sous un chemin
   * ([a][b]) ; un parent qui n’est pas un objet fait échouer le filtre (_de_dot_error), comme dans Logstash.
   */
  f_de_dot(s, p) {
    const nested = truthy(s.nested);
    const sep = nested ? '][' : String(s.separator === undefined ? '_' : s.separator);
    if (!nested && sep.includes('.'))
      return this.ko(p, 'de_dot : le séparateur ne peut pas contenir de point (Logstash refuse la configuration).');
    const recursive = truthy(s.recursive);
    const failTag = s.tag_on_failure !== undefined ? String(s.tag_on_failure) : '_de_dot_error';
    if (s.fields !== undefined) {
      if (recursive)
        return this.ko(p, 'de_dot avec fields et recursive : à reprendre en VRL (map_keys sur les champs voulus).');
      const plan = [];
      for (const f of lsList(s.fields)) {
        const segs = fieldSegs(f);
        if (!String(f).includes('.')) continue;
        if (segs.slice(0, -1).some(x => x.includes('.')))
          return this.ko(
            p,
            `de_dot : le champ « ${f} » a un point dans un nom parent ; Logstash déplace alors tout le parent, à reprendre en VRL.`
          );
        plan.push({ segs, f });
      }
      this.emit(`dd = ${this.root()}`);
      for (const { segs, f } of plan) {
        const parent = segs.slice(0, -1).map(vq);
        const last = segs[segs.length - 1];
        const from = `[${parent.concat([vq(last)]).join(', ')}]`;
        const to = nested
          ? `[${parent.concat(last.split('.').map(vq)).join(', ')}]`
          : `[${parent.concat([vq(last.split('.').join(sep))]).join(', ')}]`;
        this.emit(`v = get!(dd, ${from})`);
        this.open(`if exists(${this.path(f)})`);
        this.emit(`dd = remove!(dd, ${from})`);
        this.emit(`dd = set!(dd, ${to}, v)`);
        this.close();
      }
      this.emit('. = dd');
      if (nested)
        this.v.note(
          'warn',
          'de_dot nested sur des champs nommés',
          'Un parent qui n’est pas un objet fait échouer le filtre dans Logstash (_de_dot_error) ; la traduction le remplace par un objet.'
        );
    } else if (!recursive && !nested) {
      // Clé par clé, comme Logstash : la nouvelle clé remplace une clé existante du même nom
      this.emit(`dd = ${this.root()}`);
      this.open(`for_each(${this.root()}) -> |key, value|`);
      this.emit(
        `if contains(key, ".") { dd = remove!(dd, [key]); dd = set!(dd, [replace(key, ".", ${vq(sep)})], value) }`
      );
      this.close();
      this.emit('. = dd');
    } else if (!recursive && nested) {
      // [a.b] → [a][b] ; un parent qui existe sans être un objet fait échouer le filtre et arrête le renommage
      this.emit(`dd = ${this.root()}`);
      this.emit('failed = false');
      this.open(`for_each(${this.root()}) -> |key, value|`);
      this.open('if !failed && contains(key, ".")');
      this.emit('segs = split(key, ".")');
      this.emit('parent = []');
      this.emit('blocked = false');
      this.emit(
        'for_each(slice!(segs, 0, length(segs) - 1)) -> |_index, seg| { parent = push(parent, seg); x = get!(dd, parent); if x != null && !is_object(x) { blocked = true } }'
      );
      this.emit('if blocked { failed = true } else { dd = remove!(dd, [key]); dd = set!(dd, segs, value) }');
      this.close();
      this.close();
      this.emit('. = dd');
      this.open('if failed');
      this.addTags([failTag]);
      this.close();
      this.v.note(
        'info',
        'de_dot nested : ordre des clés',
        'Logstash renomme les clés dans leur ordre d’arrivée et s’arrête au premier échec ; la traduction les parcourt dans l’ordre alphabétique. Le résultat ne diffère que si un renommage échoue.'
      );
    } else if (recursive && !nested) {
      // Renommage à chaque niveau d’objet, jusqu’à 10 niveaux ; les objets rangés dans des tableaux ne sont pas visités
      const DEPTH = 10;
      const level = (x, d) => {
        const renamed = `map_keys(${x}) -> |k${d}| { replace(k${d}, ".", ${vq(sep)}) }`;
        return d + 1 < DEPTH
          ? `map_values(${renamed}) -> |v${d}| { if is_object(v${d}) { ${level(`object!(v${d})`, d + 1)} } else { v${d} } }`
          : renamed;
      };
      this.emit(`. = ${level(this.root(), 0)}`);
      this.v.note(
        'info',
        'de_dot recursive',
        'Les clés sont renommées jusqu’à 10 niveaux d’objets imbriqués ; au-delà, elles restent telles quelles. Si une clé renommée rencontre une clé du même nom (a.b et a_b), la valeur gardée peut différer de Logstash, qui suit l’ordre d’arrivée des clés.'
      );
    } else return this.ko(p, 'de_dot avec nested et recursive : à reprendre en VRL.');
    this.treset();
    this.types.set('.', 'obj');
    this.common(s);
    this.ok();
  }
  /*
   * syslog_pri : priorité (13 par défaut) → facility (priorité >> 3) et severity (priorité & 7), puis leurs noms.
   * Champs ECS ([log][syslog][...]) ou historiques (syslog_*) selon ecs_compatibility. La priorité est lue comme le
   * fait Ruby (to_i) : entier, flottant tronqué, chaîne lue jusqu’au premier caractère non numérique.
   */
  f_syslog_pri(s, p) {
    const ecs = this.ecsOn(s);
    const src = this.path(s.syslog_pri_field_name || (ecs ? '[log][syslog][priority]' : 'syslog_pri'));
    const keys = ecs
      ? {
          fc: '[log][syslog][facility][code]',
          sc: '[log][syslog][severity][code]',
          fl: '[log][syslog][facility][name]',
          sl: '[log][syslog][severity][name]'
        }
      : { fc: 'syslog_facility_code', sc: 'syslog_severity_code', fl: 'syslog_facility', sl: 'syslog_severity' };
    const FAC = [
      'kernel',
      'user-level',
      'mail',
      'daemon',
      'security/authorization',
      'syslogd',
      'line printer',
      'network news',
      'uucp',
      'clock',
      'security/authorization',
      'ftp',
      'ntp',
      'log audit',
      'log alert',
      'clock',
      'local0',
      'local1',
      'local2',
      'local3',
      'local4',
      'local5',
      'local6',
      'local7'
    ];
    const SEV = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'informational', 'debug'];
    const fac = s.facility_labels !== undefined ? lsList(s.facility_labels).map(String) : FAC;
    const sev = s.severity_labels !== undefined ? lsList(s.severity_labels).map(String) : SEV;
    this.emit('pri = 13');
    this.emit(`raw = ${src}`);
    this.open('if raw != null && raw != false');
    this.emit('if is_array(raw) { raw = get!(raw, [0]) }');
    this.emit('pri = 0');
    this.open('if is_integer(raw)');
    this.emit('pri = int!(raw)');
    this.close('} else if is_float(raw) {');
    this.ind++;
    this.emit('pri = to_int!(raw)');
    this.close('} else if is_string(raw) {');
    this.ind++;
    // Ruby String#to_i : espaces en tête, signe, chiffres (soulignés permis entre chiffres), le reste ignoré
    this.emit("m = parse_regex(string!(raw), r'^\\s*(?P<n>[+-]?\\d+(?:_\\d+)*)') ?? null");
    this.emit('if m != null { pri = to_int(replace(string!(m.n), "_", "")) ?? 0 }');
    this.close();
    this.close();
    // >> et & de Ruby sur un entier signé : division euclidienne par 8
    this.emit('facility = to_int(floor(pri / 8))');
    this.emit('severity = pri - facility * 8');
    this.assign(this.path(keys.sc), 'severity');
    this.assign(this.path(keys.fc), 'facility');
    if (s.use_labels === undefined || truthy(s.use_labels)) {
      this.open(`if facility > ${fac.length - 1}`);
      this.addTags(['_syslogpriparsefailure']);
      this.close('} else {');
      this.ind++;
      // Un indice négatif se lit depuis la fin, comme un tableau Ruby
      this.emit(`labels = [${fac.map(vq).join(', ')}]`);
      this.emit('i = if facility < 0 { length(labels) + facility } else { facility }');
      this.emit(`name = get!(labels, [i])`);
      this.emit(`if name != null { ${this.path(keys.fl)} = name }`);
      this.emit(`sname = get!([${sev.map(vq).join(', ')}], [severity])`);
      this.emit(`if sname != null { ${this.path(keys.sl)} = sname }`);
      this.close();
      this.tset(this.path(keys.fl), 'any');
      this.tset(this.path(keys.sl), 'any');
    }
    this.common(s);
    this.ok();
  }
  /*
   * clone : une copie de l’événement par type. En mode ECS, le type s’ajoute aux étiquettes (tags) ; sinon il devient
   * le champ type. add_field, add_tag… ne valent que pour les copies. L’original et ses copies sortent ensemble, comme
   * un split : la racine devient la liste des événements.
   */
  f_clone(s, p) {
    const types = lsList(s.clones).map(String);
    if (!types.length) {
      this.v.note('info', 'clone sans copie', 'clones est vide : Logstash ne crée aucune copie.');
      this.ok();
      return;
    }
    const ecs = this.ecsOn(s);
    this.emit(`orig = ${this.root()}`);
    const names = [];
    types.forEach((t, i) => {
      this.emit('. = orig');
      this.treset();
      this.types.set('.', 'obj');
      if (ecs)
        this.emit(
          `if is_array(.tags) { .tags = push(array!(.tags), ${vq(t)}) } else if .tags == null { .tags = [${vq(t)}] } else { .tags = [.tags, ${vq(t)}] }`
        );
      else this.emit(`.type = ${vq(t)}`);
      this.tset('.tags', 'any');
      this.tset('.type', 'any');
      this.common(s);
      const n = `copie_${i + 1}`;
      this.emit(`${n} = .`);
      names.push(n);
    });
    this.emit(`. = [orig, ${names.join(', ')}]`);
    this.treset();
    this.types.delete('.');
    this.splitDone = true;
    if (this.depth > 0)
      this.v.note(
        'warn',
        'clone dans une condition',
        'Après clone, la racine de l’événement devient une liste : placez les filtres suivants de la branche dans une étape séparée.'
      );
    this.v.note(
      'info',
      'clone → plusieurs événements',
      'Le programme rend la liste [original, copies] : Vector émet un événement par élément, qui traverse la suite du pipeline.'
    );
    this.ok();
  }
  // environment : [@metadata][champ] = variable d’environnement (null si elle n’est pas définie)
  f_environment(s) {
    for (const [field, env] of lsPairs(s.add_metadata_from_env)) {
      const name = String(env);
      this.assign(vPathOf(['@metadata', String(field)], this.v.ns), `get_env_var(${vq(name)}) ?? null`);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) this.v.env.add(name);
    }
    this.v.note(
      'info',
      'environment → get_env_var',
      'Vector lit la variable dans son propre environnement, au moment du traitement : définissez-la dans le service Vector.'
    );
    this.common(s);
    this.ok();
  }
  /*
   * bytes : « 10 MB », « 1,5 kB »… → nombre d’octets, arrondi. Puissances de 1024 (binary) ou de 1000 (metric) ;
   * b et B comptent tous deux des octets, comme dans Logstash. Échec : tag_on_failure, la cible n’est pas écrite.
   */
  f_bytes(s, p) {
    if (s.target === undefined)
      return this.ko(
        p,
        'bytes sans target : Logstash n’a pas de champ cible par défaut et ne peut pas poser la valeur.'
      );
    const src = this.path(s.source || 'message');
    const tgt = this.path(s.target);
    const dec = String(s.decimal_separator || '.');
    if (dec !== '.' && dec !== ',')
      return this.ko(p, `bytes : decimal_separator « ${dec} » invalide (Logstash n’accepte que . et ,).`);
    const pow = String(s.conversion_method || 'binary') === 'metric' ? 1000 : 1024;
    const mult = ['k', 'm', 'g', 't', 'p', 'e']
      .map((x, i) => `${vq(x)}: ${(pow ** (i + 1)).toLocaleString('en', { useGrouping: false })}.0`)
      .join(', ');
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_bytesparsefailure'];
    if (tags.length) this.emit('done = false');
    this.open(`if is_string(${src})`);
    // String#strip! modifie la chaîne lue sur place : Logstash rend le champ source sans ses espaces de bord,
    // même quand la conversion échoue ensuite. Les ancres ^ et $ de Ruby valent pour chaque ligne.
    this.emit(`bs = replace(string!(${src}), r'\\A[\\x00\\t\\n\\x0B\\x0C\\r ]+|[\\x00\\t\\n\\x0B\\x0C\\r ]+\\z', "")`);
    this.emit(`${src} = bs`);
    this.emit(
      `m = parse_regex(bs, r'(?m)^(?P<n>[0-9 _,.]*)[\\t\\n\\x0B\\x0C\\r ]*(?P<p>[kKmMgGtTpPeE]?)[bB]?$') ?? null`
    );
    this.open(`if m != null && length(split(string!(m.n), ${vq(dec)})) <= 2`);
    this.emit(
      `num = replace(replace(strip_whitespace(string!(m.n)), r'[^0-9${dec === '.' ? '.' : ','}]', ""), ${vq(dec)}, ".")`
    );
    this.open('if num != ""');
    // String#to_f de Ruby : « . » vaut 0
    this.emit('f = to_float(num) ?? 0.0');
    this.emit(`if m.p != "" { f = f * float!(get!({ ${mult} }, [downcase(string!(m.p))])) }`);
    this.emit(`${tgt} = to_int(round(f))`);
    this.common(s);
    if (tags.length) this.emit('done = true');
    this.close();
    this.close();
    this.close();
    if (tags.length) {
      this.open('if !done');
      this.failTags(tags);
      this.close();
    }
    this.tset(tgt, 'any');
    this.ok();
  }
  // throttle dans une condition : le transform throttle de Vector ne se place pas sous une condition VRL
  f_throttle(s, p) {
    this.ko(
      p,
      'throttle sous condition : le transform throttle de Vector s’applique à tout un flux. Sortez le filtre de la condition, ou routez d’abord les événements concernés (transform route).'
    );
  }
  f_xml(s) {
    this.approx(
      'Forme de l’objet XML',
      'parse_xml de Vector ne rend pas l’objet comme Logstash (attributs, texte des éléments, valeurs en tableaux) : vérifiez la forme attendue par la suite du traitement.'
    );
    const src = this.path(s.source || 'message');
    const t = this.tget(src);
    this.emit(`parsed, err = parse_xml(${src})`);
    this.open('if err == null');
    this.assign(this.path(s.target || 'xml'), 'parsed');
    this.common(s);
    // Champ source absent, nul ou vide : Logstash ne signale pas d’échec
    this.close(
      t === 'str'
        ? `} else if strip_whitespace(${src}) != "" {`
        : this.present(src)
          ? '} else {'
          : `} else if ${src} != null && strip_whitespace(string(${src}) ?? "-") != "" {`
    );
    this.ind++;
    this.failTags(['_xmlparsefailure']);
    this.close();
    this.ok();
    if (s.xpath) this.approx('xml xpath', 'Les expressions XPath ne sont pas reprises : naviguez dans l’objet parsé.');
  }
}
function moves_note(matches) {
  return matches.some(([, pats]) => lsList(pats).some(x => /%\{\w+:\[/.test(String(x))));
}
const KO_HINTS = {
  ruby: 'Le code Ruby doit être réécrit en VRL (fonctions intégrées, closures for_each / map_values). Le code d’origine est recopié en commentaire.',
  aggregate:
    'L’agrégation d’événements corrélés se fait avec le transform reduce de Vector (group_by, merge_strategies, ends_when).',
  metrics: 'Utilisez le transform log_to_metric de Vector.',
  elasticsearch:
    'Les requêtes vers Elasticsearch pendant le traitement n’ont pas d’équivalent ; préférez une table d’enrichissement.',
  jdbc_streaming:
    'Préférez une table d’enrichissement (fichier CSV mis à jour périodiquement) aux requêtes SQL par événement.',
  jdbc_static: 'Exportez la table de référence en CSV et déclarez-la comme table d’enrichissement.',
  http: 'Les appels HTTP par événement n’ont pas d’équivalent dans un transform Vector.',
  memcached: 'Pas d’équivalent : préférez une table d’enrichissement.',
  sleep: 'Pas d’équivalent : inutile dans Vector.'
};

/* ---------- Sources, sinks, topologie ---------- */
function kafkaSecurity(v, s, cfg, obj) {
  const k = cfg.kafka;
  const proto = String(k.security_protocol || s.security_protocol || '').toUpperCase();
  if (/SASL/.test(proto)) {
    const mech = k.sasl_mechanism || s.sasl_mechanism || 'PLAIN';
    obj.sasl = {
      enabled: true,
      mechanism: mech,
      username: k.username || '${KAFKA_USERNAME}',
      password: k.password || '${KAFKA_PASSWORD}'
    };
    ['KAFKA_USERNAME', 'KAFKA_PASSWORD'].forEach(e => v.env.add(e));
    if (s.sasl_jaas_config)
      v.note(
        'opt',
        'Secrets Kafka hors configuration',
        'Les identifiants présents dans sasl_jaas_config ne sont pas recopiés : ils sont lus depuis des variables d’environnement (${KAFKA_USERNAME}, ${KAFKA_PASSWORD}).'
      );
  }
  if (/SSL/.test(proto)) {
    obj.tls = { enabled: true };
    const ca = k.ca_file || (s.ssl_truststore_location ? '/etc/vector/certs/ca.pem' : '');
    if (ca) obj.tls.ca_file = ca;
    if (s.ssl_truststore_location)
      v.note(
        'warn',
        'Truststore Java',
        `${s.ssl_truststore_location} (JKS) doit être converti en PEM pour Vector : keytool -exportcert -rfc.`
      );
  }
}
/*
 * Mode ECS : les motifs grok composites de Logstash (patterns ecs-v1) capturent sous des noms ECS, alors que
 * parse_grok de Vector garde les noms historiques (patterns legacy). Table de renommage tirée des deux jeux de
 * logstash-patterns-core 4.3.4 : [nom historique, nom ECS, traitement]. Traitements : int (typé comme « :int »),
 * dash (absent quand la valeur est « - »), qs (guillemets retirés, absent si « - »), drop (non capturé en ECS).
 */
const GROK_ECS_COMMON = [
  ['clientip', '[source][address]'],
  ['ident', '[apache][access][user][identity]', 'dash'],
  ['auth', '[user][name]', 'dash'],
  ['verb', '[http][request][method]'],
  ['request', '[url][original]'],
  ['httpversion', '[http][version]'],
  ['rawrequest', null, 'drop'],
  ['response', '[http][response][status_code]', 'int'],
  ['bytes', '[http][response][body][bytes]', 'int']
];
const GROK_ECS_COMBINED = GROK_ECS_COMMON.concat([
  ['referrer', '[http][request][referrer]', 'qs'],
  ['agent', '[user_agent][original]', 'qs']
]);
const GROK_ECS_ERROR = [
  ['loglevel', '[log][level]'],
  ['clientip', '[source][address]'],
  ['module', '[apache][error][module]'],
  ['pid', '[process][pid]', 'int'],
  ['tid', '[process][thread][id]', 'int'],
  ['proxy_errorcode', '[apache][error][proxy][error][code]'],
  ['proxy_message', '[apache][error][proxy][error][message]'],
  ['clientport', '[source][port]', 'int'],
  ['errorcode', '[error][code]']
];
const GROK_ECS_PROG = [
  ['program', '[process][name]'],
  ['pid', '[process][pid]', 'int']
];
const GROK_ECS_FACILITY = [
  ['facility', '[log][syslog][facility][code]', 'int'],
  ['priority', '[log][syslog][priority]', 'int']
];
const GROK_ECS_SYSLOG = GROK_ECS_PROG.concat(GROK_ECS_FACILITY, [
  ['logsource', '[host][hostname]'],
  ['timestamp8601', 'timestamp']
]);
const GROK_ECS_5424 = [
  ['syslog5424_pri', '[log][syslog][priority]', 'int'],
  ['syslog5424_ver', '[system][syslog][version]'],
  ['syslog5424_ts', 'timestamp'],
  ['syslog5424_host', '[host][hostname]'],
  ['syslog5424_app', '[process][name]'],
  ['syslog5424_proc', '[process][pid]', 'int'],
  ['syslog5424_msgid', '[event][code]'],
  ['syslog5424_sd', '[system][syslog][structured_data]'],
  ['syslog5424_msg', 'message']
];
const GROK_ECS = {
  COMMONAPACHELOG: GROK_ECS_COMMON,
  HTTPD_COMMONLOG: GROK_ECS_COMMON,
  COMBINEDAPACHELOG: GROK_ECS_COMBINED,
  HTTPD_COMBINEDLOG: GROK_ECS_COMBINED,
  HTTPD20_ERRORLOG: GROK_ECS_ERROR,
  HTTPD24_ERRORLOG: GROK_ECS_ERROR,
  HTTPD_ERRORLOG: GROK_ECS_ERROR,
  SYSLOGPROG: GROK_ECS_PROG,
  SYSLOGFACILITY: GROK_ECS_FACILITY,
  SYSLOGBASE: GROK_ECS_SYSLOG,
  SYSLOGBASE2: GROK_ECS_SYSLOG,
  SYSLOGLINE: GROK_ECS_SYSLOG,
  SYSLOG5424PRI: GROK_ECS_5424,
  SYSLOG5424BASE: GROK_ECS_5424,
  SYSLOG5424LINE: GROK_ECS_5424
};
// Autres familles de motifs composites qui capturent des champs : en mode ECS, leurs noms sont à vérifier
const GROK_COMPOSITE =
  /^(BACULA|BIND9|BRO_|CATALINA|CISCO|CLOUDFRONT|CRONLOG|ELB_|EXIM_|HAPROXY|HTTPD|JAVASTACKTRACE|MCOLLECTIVE|MONGO|NAGIOS|NETSCREEN|POSTGRESQL|RAILS3|REDIS|RPROCESSING|RT_FLOW|RUBY_LOGGER|S3_|SFW2|SHOREWALL|SQUID3|SYSLOG|TOMCATLOG|URIHOST)/;
// Lecture ISO8601 à la façon de Logstash : avec ou sans fuseau, espace ou T, secondes et décimales facultatives,
// ou le jour seul (à minuit) ; null si rien ne convient. x : variable VRL contenant la chaîne, virgule décimale déjà ramenée à un point.
function isoParse(x, tz) {
  const forms = ['%+', '%Y-%m-%dT%H:%M:%S%.f', '%Y-%m-%d %H:%M:%S%.f', '%Y-%m-%dT%H:%M', '%Y-%m-%d %H:%M'].map(
    f => `parse_timestamp(${x}, ${vq(f)}${tz || ''})`
  );
  return `${forms.join(' ?? ')} ?? parse_timestamp(${x} + "T00:00:00", "%Y-%m-%dT%H:%M:%S"${tz || ''}) ?? null`;
}
function codecOf(c) {
  if (!c) return null;
  if (typeof c === 'string') return c;
  if (isObj(c)) return c.__plugin;
  return null;
}
function buildSource(v, st, cfg, idx, used, opts) {
  const s = lsSettings(st);
  const name = uniq(used, compName(s.id || (st.name === 'kafka' ? 'kafka_in' : st.name + '_in')));
  let src;
  // Entrée pipeline { address } : les événements viennent d’un autre pipeline du même pipelines.yml
  if (st.name === 'pipeline') {
    const address = s.address === undefined ? '' : String(s.address);
    if (!opts || !opts.pipelineIO) {
      v.stats.ko++;
      v.note(
        'err',
        `Entrée pipeline non traduite (ligne ${st.line})`,
        `Les événements de l’adresse « ${address} » viennent d’un autre pipeline : traduisez l’ensemble depuis pipelines.yml (passerelle ls2vector pipelines.yml), qui relie les pipelines entre eux.`
      );
      return null;
    }
    if (!address) {
      v.stats.ko++;
      v.note(
        'err',
        `Entrée pipeline sans adresse (ligne ${st.line})`,
        'address est obligatoire : Logstash refuse la configuration.'
      );
      return null;
    }
    v.stats.ok++;
    return {
      name,
      src: {
        type: '__pipeline',
        address,
        __label: `pipeline ${address}`,
        __detail: 'liaison entre pipelines',
        __pipeline: true
      },
      s
    };
  }
  if (st.name === 'kafka') {
    src = { type: 'kafka' };
    src.bootstrap_servers = cfg.kafka.bootstrap_servers || s.bootstrap_servers || 'localhost:9092';
    // Ensemble de pipelines : les réglages kafka.consumer_group et input_topics ne visent qu’une source Kafka unique
    const own = !opts || opts.singleKafkaInput !== false;
    let group = (own && cfg.kafka.consumer_group) || s.group_id || 'logstash';
    if (cfg.vector.shadow_mode) group += '-shadow';
    src.group_id = group;
    const topics =
      own && cfg.kafka.input_topics && cfg.kafka.input_topics.length
        ? cfg.kafka.input_topics
        : s.topics_pattern
          ? ['^' + String(s.topics_pattern).replace(/^\^/, '')]
          : lsList(s.topics || 'logstash');
    src.topics = topics;
    if (s.auto_offset_reset) src.auto_offset_reset = s.auto_offset_reset;
    if (s.session_timeout_ms) src.session_timeout_ms = +s.session_timeout_ms;
    const lr = {};
    if (s.client_id) lr['client.id'] = String(s.client_id);
    if (s.max_poll_records)
      v.note(
        'info',
        'max_poll_records',
        'Pas d’équivalent direct : le débit se règle via fetch_wait_max_ms et librdkafka_options.'
      );
    if (Object.keys(lr).length) src.librdkafka_options = lr;
    kafkaSecurity(v, s, cfg, src);
    const codec = codecOf(s.codec) || 'plain';
    // Codec json : avec le namespace de logs, décodé à l’étape de préparation (une ligne invalide y est gardée)
    src.decoding = { codec: /json/.test(codec) && !v.ns ? 'json' : 'bytes' };
    src.__json = /json/.test(codec);
    if (v.ns) src.log_namespace = true;
    else
      Object.assign(src, {
        topic_key: '_kafka_topic',
        partition_key: '_kafka_partition',
        offset_key: '_kafka_offset',
        key_field: '_kafka_message_key',
        headers_key: '_kafka_headers'
      });
    if (s.consumer_threads && +s.consumer_threads > 1)
      v.note(
        'info',
        'consumer_threads',
        `Logstash lisait avec ${s.consumer_threads} threads : avec Vector, le parallélisme vient du nombre de réplicas du même groupe (au plus une par partition).`
      );
    if (s.decorate_events)
      v.note(
        'info',
        'decorate_events',
        v.ns
          ? 'Les métadonnées Kafka sont disponibles sous %kafka.topic, %kafka.partition, %kafka.offset, sans polluer l’événement.'
          : 'Les métadonnées Kafka sont copiées dans des champs _kafka_* supprimés avant l’écriture.'
      );
    src.__plain = !/json/.test(codec);
    src.__label = topics.join(', ');
    src.__detail = `groupe ${group}`;
    v.stats.ok++;
  } else {
    const map = {
      beats: () => ({ type: 'logstash', address: `0.0.0.0:${s.port || 5044}` }),
      tcp: () => ({ type: 'socket', mode: 'tcp', address: `0.0.0.0:${s.port || 5000}` }),
      udp: () => ({ type: 'socket', mode: 'udp', address: `0.0.0.0:${s.port || 5000}` }),
      http: () => ({ type: 'http_server', address: `0.0.0.0:${s.port || 8080}` }),
      file: () => ({ type: 'file', include: lsList(s.path) }),
      stdin: () => ({ type: 'stdin' }),
      generator: () => ({ type: 'demo_logs', format: 'shuffle', lines: lsList(s.lines || s.message || 'Hello world') })
    };
    if (!map[st.name]) {
      v.stats.ko++;
      v.note(
        'err',
        `Entrée ${st.name} non traduite (ligne ${st.line})`,
        'Aucune source Vector équivalente n’a été choisie automatiquement.'
      );
      return null;
    }
    src = map[st.name]();
    src.__label = st.name;
    src.__detail = src.type;
    src.__plain = !/json/.test(codecOf(s.codec) || '');
    // Codec json : avec le namespace de logs, décodé à l’étape de préparation, ce qui garde une ligne invalide
    // et évite l’option decoding, que la source file ne connaît pas
    src.__json = /json/.test(codecOf(s.codec) || '');
    if (src.__json && !v.ns) src.decoding = { codec: 'json' };
    // Le VRL de préparation suppose le namespace de logs, quelle que soit la source
    if (v.ns) src.log_namespace = true;
    if (['beats', 'tcp', 'http'].includes(st.name)) listenTLS(v, s, src, st.name);
    v.stats.ok++;
    v.note(
      'info',
      `Entrée ${st.name}`,
      `Traduite en source ${src.type}. Le sujet de la migration étant Kafka, vérifiez les options réseau.`
    );
  }
  return { name, src, s };
}
/*
 * TLS d’une source qui écoute (beats, tcp, http) : options ssl_* de l’entrée Logstash → tls de la source Vector.
 * Sans TLS, tout hôte qui atteint le port peut injecter des événements : c’est signalé « à vérifier ».
 */
function listenTLS(v, s, src, name) {
  const on = truthy(s.ssl_enabled) || truthy(s.ssl);
  const addr = src.address;
  if (!on) {
    v.stats.approx++;
    v.note(
      'warn',
      `Entrée ${name} sans TLS`,
      `Vector écoutera sur ${addr} en clair, comme le pipeline d’origine : tout hôte qui atteint ce port peut y envoyer des événements. Activez ssl_enabled (ssl_certificate, ssl_key) côté Logstash, ou limitez l’adresse d’écoute et le pare-feu.`
    );
    return;
  }
  const tls = { enabled: true };
  const keystore = s.ssl_keystore_path || s.keystore;
  const pair = s.ssl_certificate && s.ssl_key;
  if (pair) {
    tls.crt_file = String(s.ssl_certificate);
    tls.key_file = String(s.ssl_key);
  } else {
    // Vector ne lit que du PEM : sans certificat et clé PEM, des chemins à remplir sont posés plutôt qu’une source qui n’accepterait aucun client
    tls.crt_file = '/etc/vector/certs/tls.crt';
    tls.key_file = '/etc/vector/certs/tls.key';
    v.stats.approx++;
    v.note(
      'warn',
      `TLS de l’entrée ${name} : certificat à fournir`,
      keystore
        ? `${keystore} (JKS ou PKCS12) se convertit en PEM pour Vector (keytool -importkeystore puis openssl pkcs12 -nodes) ; renseignez ensuite tls.crt_file et tls.key_file, posés ici sur ${tls.crt_file} et ${tls.key_file}.`
        : `ssl_certificate et ssl_key (PEM) sont nécessaires : tls.crt_file et tls.key_file sont posés sur ${tls.crt_file} et ${tls.key_file}.`
    );
  }
  if (s.ssl_key_passphrase !== undefined)
    tls.key_pass = secretRef(v, s.ssl_key_passphrase, 'LOGSTASH_SSL_KEY_PASS', 'Phrase secrète de la clé TLS');
  const cas = lsList(s.ssl_certificate_authorities);
  if (cas.length) tls.ca_file = String(cas[0]);
  if (cas.length > 1) {
    v.stats.approx++;
    v.note(
      'warn',
      'Plusieurs autorités de certification',
      `Vector lit un seul fichier : concaténez ${cas.join(', ')} en un seul PEM.`
    );
  }
  // Authentification des clients : ssl_client_authentication (none, optional, required) ou l’ancien ssl_verify_mode (none, peer, force_peer)
  const mode = String(s.ssl_client_authentication || s.ssl_verify_mode || 'none').toLowerCase();
  if (mode === 'required' || mode === 'force_peer') {
    tls.verify_certificate = true;
    if (!tls.ca_file)
      v.note(
        'info',
        `Certificats clients de l’entrée ${name}`,
        'Aucune ssl_certificate_authorities : Vector vérifiera les certificats clients avec les autorités du système.'
      );
  } else if (mode === 'optional' || mode === 'peer') {
    tls.verify_certificate = true;
    v.stats.approx++;
    v.note(
      'warn',
      `Certificat client de l’entrée ${name}`,
      'Logstash acceptait aussi les clients sans certificat (optional) ; Vector n’a pas ce mode : le certificat client est exigé.'
    );
  }
  if (s.ssl_cipher_suites || s.ssl_supported_protocols)
    v.note(
      'info',
      `Suites et protocoles TLS de l’entrée ${name}`,
      'ssl_cipher_suites et ssl_supported_protocols ne sont pas repris : Vector applique ses valeurs par défaut (TLS 1.2 et suivants).'
    );
  src.tls = tls;
}
function uniq(used, base) {
  let n = base,
    i = 2;
  while (used.has(n)) n = `${base}_${i++}`;
  used.add(n);
  return n;
}
function buildSink(v, st, cfg, used, singleKafka, opts) {
  const s = lsSettings(st);
  const tplOf = t =>
    String(t).replace(/%\{([^}]+)\}/g, (m, ref) => {
      if (ref.startsWith('+')) return joda2strf(ref.slice(1));
      // Une métadonnée (%nom) se lit aussi dans un modèle Vector : vérifié avec Vector 0.59
      const p = vPathOf(fieldSegs(ref), v.ns);
      return `{{ ${p.replace(/^\./, '')} }}`;
    });
  let sink;
  if (st.name === 'kafka') {
    const name = uniq(used, compName(s.id || 'kafka_out'));
    let topic = singleKafka && cfg.kafka.output_topic ? cfg.kafka.output_topic : tplOf(s.topic_id || 'logstash');
    if (cfg.vector.shadow_mode) topic += '-shadow';
    sink = {
      type: 'kafka',
      inputs: [],
      bootstrap_servers: cfg.kafka.bootstrap_servers || s.bootstrap_servers || 'localhost:9092',
      topic
    };
    // Vector 0.57 et suivants refusent un nom de topic tiré entièrement d’un champ, sans préfixe littéral
    if (/^\{\{/.test(topic)) {
      sink.dangerously_allow_unconfined_template_resolution = true;
      v.note(
        'warn',
        'Topic tiré d’un champ',
        `Le topic « ${topic} » vient entièrement de l’événement : Vector 0.57 et suivants l’exigent explicitement (dangerously_allow_unconfined_template_resolution). Un événement peut ainsi écrire dans n’importe quel topic ; ajoutez un préfixe fixe si possible.`
      );
    }
    if (s.message_key) {
      const m = /^%\{([^}]+)\}$/.exec(String(s.message_key));
      if (m) sink.key_field = vPathOf(fieldSegs(m[1]), v.ns).replace(/^\./, '');
      else
        v.note(
          'warn',
          'message_key',
          'Une clé mixte (texte + champ) n’est pas reprise : Vector utilise un champ comme clé.'
        );
    }
    const codec = codecOf(s.codec);
    if (!codec)
      v.note(
        'warn',
        'Codec de sortie absent',
        'Logstash utilise le codec plain par défaut ; Vector écrit ici en JSON, format le plus courant pour Kafka → Kafka.'
      );
    sink.encoding = { codec: codec && /plain|line/.test(codec) ? 'text' : 'json' };
    if (s.compression_type && s.compression_type !== 'none') sink.compression = s.compression_type;
    const lr = {};
    if (s.acks !== undefined) lr.acks = String(s.acks);
    if (s.linger_ms !== undefined) lr['linger.ms'] = String(s.linger_ms);
    if (s.batch_size !== undefined) lr['batch.size'] = String(s.batch_size);
    if (Object.keys(lr).length) sink.librdkafka_options = lr;
    kafkaSecurity(v, s, cfg, sink);
    if (cfg.vector.acknowledgements) sink.acknowledgements = { enabled: true };
    sink.__label = topic;
    v.stats.ok++;
    return { name, sink };
  }
  const name = uniq(used, compName(s.id || st.name + '_out'));
  // Sortie pipeline { send_to } : reliée à l’entrée du pipeline destinataire, sans sink Vector
  if (st.name === 'pipeline') {
    const to = lsList(s.send_to).map(String).filter(Boolean);
    if (!opts || !opts.pipelineIO) {
      v.stats.ko++;
      v.note(
        'err',
        `Sortie pipeline non traduite (ligne ${st.line})`,
        `Les événements partent vers ${to.length ? to.map(x => `« ${x} »`).join(', ') : 'un autre pipeline'} : traduisez l’ensemble depuis pipelines.yml (passerelle ls2vector pipelines.yml), qui relie les pipelines entre eux.`
      );
      return null;
    }
    if (!to.length) {
      v.stats.ko++;
      v.note(
        'err',
        `Sortie pipeline sans send_to (ligne ${st.line})`,
        'send_to est obligatoire : Logstash refuse la configuration.'
      );
      return null;
    }
    v.stats.ok++;
    return { name, sink: { type: '__pipeline', inputs: [], send_to: to, __label: `pipeline → ${to.join(', ')}` } };
  }
  // Sortie elasticsearch → ClickHouse (vector.elasticsearch_output: clickhouse) : mise en forme, puis sink clickhouse
  if (st.name === 'elasticsearch' && cfg.vector.elasticsearch_output === 'clickhouse') {
    const ds = s.data_stream === undefined ? '' : String(s.data_stream).toLowerCase();
    let index;
    if (ds === 'true')
      index = `${s.data_stream_type || 'logs'}-${s.data_stream_dataset || 'generic'}-${s.data_stream_namespace || 'default'}`;
    else {
      const raw = String(s.index || 'logstash-%{+yyyy.MM.dd}');
      if (!/%\{/.test(raw)) index = raw;
      else {
        const pre = [];
        const parts = [];
        let last = 0;
        let n = 0;
        let ts = false;
        let m;
        const re = /%\{([^}]+)\}/g;
        while ((m = re.exec(raw))) {
          if (m.index > last) parts.push(vq(raw.slice(last, m.index)));
          if (m[1].startsWith('+')) {
            if (!ts) {
              pre.push(
                'ts = now()',
                'tv = ."@timestamp"',
                'if is_timestamp(tv) {',
                '  ts = tv',
                '} else if is_string(tv) {',
                '  ts = parse_timestamp(string!(tv), "%+") ?? now()',
                '}'
              );
              ts = true;
            }
            pre.push(`d${++n} = format_timestamp!(ts, format: ${vq(joda2strf(m[1].slice(1)))}, timezone: "UTC")`);
          } else pre.push(`d${++n} = to_string(${vPathOf(fieldSegs(m[1]), v.ns)}) ?? ""`);
          parts.push(`d${n}`);
          last = re.lastIndex;
        }
        if (last < raw.length) parts.push(vq(raw.slice(last)));
        index = { pre, expr: parts.join(' + ') };
      }
    }
    for (const o of ['action', 'document_id', 'pipeline', 'script', 'routing', 'parent', 'doc_as_upsert', 'upsert']) {
      if (s[o] !== undefined && !(o === 'action' && String(s[o]) === 'index')) {
        v.stats.approx++;
        v.note(
          'warn',
          `Option ${o} non reprise (sortie ClickHouse)`,
          `L’option ${o} de la sortie elasticsearch n’a pas d’équivalent dans l’écriture ClickHouse : chaque événement est ajouté à la table (INSERT), sans identifiant de document.`
        );
      }
    }
    const r = clickhouseOutput(v, cfg, index, 'Sortie elasticsearch');
    for (const [lv, t, d] of r.notes) v.note(lv, t, d);
    r.sink.__label = `ClickHouse ${r.tables.join(', ')}`;
    v.stats.ok++;
    return { name, sink: r.sink, pre: { name: uniq(used, `${name}_lignes`), source: r.shape } };
  }
  const others = {
    elasticsearch: () => elasticsearchSink(v, s, tplOf),
    stdout: () => ({ type: 'console', inputs: [], encoding: { codec: 'json' } }),
    file: () =>
      Object.assign(
        { type: 'file', inputs: [], path: tplOf(s.path || '/tmp/out.log'), encoding: { codec: 'json' } },
        truthy(s.gzip) ? { compression: 'gzip' } : {}
      ),
    http: () => httpSink(v, s),
    null: () => ({ type: 'blackhole', inputs: [] })
  };
  if (!others[st.name]) {
    v.stats.ko++;
    v.note(
      'err',
      `Sortie ${st.name} non traduite (ligne ${st.line})`,
      'Aucun sink Vector équivalent n’a été choisi automatiquement.'
    );
    return null;
  }
  sink = others[st.name]();
  sink.__label = st.name;
  v.stats.ok++;
  unhandledOptions(v, st, s);
  return { name, sink };
}

/* ---------- Sorties autres que Kafka ---------- */
// Options de sortie : traitées par la traduction (handled) ou sans effet sur les données écrites (noEffect).
// Toute autre option est signalée « à vérifier » au lieu de disparaître.
const OUTPUT_COMMON = ['id', 'enable_metric', 'workers', 'codec', 'ecs_compatibility'];
const OUTPUT_OPTIONS = {
  elasticsearch: {
    handled: [
      'hosts',
      'index',
      'user',
      'password',
      'cloud_id',
      'cloud_auth',
      'api_key',
      'data_stream',
      'data_stream_type',
      'data_stream_dataset',
      'data_stream_namespace',
      'data_stream_auto_routing',
      'data_stream_sync_fields',
      'action',
      'document_id',
      'pipeline',
      'routing',
      'ssl',
      'ssl_enabled',
      'cacert',
      'ssl_certificate_authorities',
      'ssl_certificate_verification',
      'ssl_verification_mode',
      'ssl_certificate',
      'ssl_key',
      'keystore',
      'keystore_password',
      'truststore',
      'truststore_password',
      'http_compression',
      'timeout',
      'custom_headers',
      'proxy',
      'manage_template',
      'template',
      'template_name',
      'template_overwrite',
      'template_api',
      'ilm_enabled',
      'ilm_rollover_alias',
      'ilm_pattern',
      'ilm_policy',
      'doc_as_upsert',
      'upsert',
      'script',
      'script_type',
      'script_lang',
      'script_var_name',
      'scripted_upsert',
      'version',
      'version_type',
      'parent',
      'join_field'
    ],
    noEffect: [
      'retry_initial_interval',
      'retry_max_interval',
      'retry_on_conflict',
      'sniffing',
      'sniffing_delay',
      'sniffing_path',
      'pool_max',
      'pool_max_per_route',
      'resurrect_delay',
      'validate_after_inactivity',
      'silence_errors_in_log',
      'failure_type_logging_whitelist',
      'dlq_custom_codes',
      'dlq_on_failed_indexname_interpolation',
      'compression_level'
    ]
  },
  stdout: { handled: [], noEffect: [] },
  null: { handled: [], noEffect: [] },
  file: {
    handled: ['path', 'gzip'],
    noEffect: ['flush_interval', 'create_if_deleted', 'dir_mode', 'file_mode', 'stale_cleanup_interval']
  },
  http: {
    handled: ['url', 'http_method', 'format', 'headers', 'content_type'],
    noEffect: [
      'retry_failed',
      'retry_non_idempotent',
      'retryable_codes',
      'automatic_retries',
      'pool_max',
      'pool_max_per_route',
      'keepalive',
      'connect_timeout',
      'socket_timeout',
      'request_timeout',
      'cookies',
      'follow_redirects',
      'ignorable_codes'
    ]
  }
};
function unhandledOptions(v, st, s) {
  const known = OUTPUT_OPTIONS[st.name];
  if (!known) return;
  const left = Object.keys(s).filter(
    k => !OUTPUT_COMMON.includes(k) && !known.handled.includes(k) && !known.noEffect.includes(k)
  );
  if (!left.length) return;
  v.stats.approx++;
  v.note(
    'warn',
    `Sortie ${st.name} : option${left.length > 1 ? 's' : ''} non reprise${left.length > 1 ? 's' : ''} (ligne ${st.line})`,
    `${left.join(', ')} : sans équivalent automatique dans le sink Vector. Vérifiez que l’écriture n’en dépend pas.`
  );
}
const truthy = x => x === true || String(x).toLowerCase() === 'true';
const LS_ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}$/;
// ${VAR:défaut} de Logstash s’écrit ${VAR:-défaut} pour Vector
const vectorEnv = x => String(x).replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*):(?!-)/, '${$1:-');
// Un secret écrit en clair dans le pipeline n’est jamais recopié : il est lu dans une variable d’environnement
function secretRef(v, value, variable, what) {
  const m = LS_ENV_REF.exec(String(value === undefined ? '' : value));
  if (m) {
    v.env.add(m[1]);
    return vectorEnv(value);
  }
  v.env.add(variable);
  if (value !== undefined && value !== '')
    v.note(
      'opt',
      `${what} hors configuration`,
      `La valeur écrite dans le pipeline n’est pas recopiée : elle est lue dans la variable d’environnement ${variable}.`
    );
  return '${' + variable + '}';
}
function elasticsearchSink(v, s, tplOf) {
  const https = truthy(s.ssl) || truthy(s.ssl_enabled);
  // Sans schéma, Logstash parle HTTP, ou HTTPS avec ssl_enabled
  const endpoints = lsList(s.hosts || 'localhost:9200').map(h =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(String(h)) ? String(h) : `${https ? 'https' : 'http'}://${h}`
  );
  const sink = { type: 'elasticsearch', inputs: [], endpoints };
  const todo = (title, detail) => {
    v.stats.ko++;
    v.note('err', title, detail);
  };
  const review = (title, detail) => {
    v.stats.approx++;
    v.note('warn', title, detail);
  };
  if (s.cloud_id)
    todo(
      'cloud_id non traduit',
      'Vector ne connaît pas l’identifiant Elastic Cloud : renseignez dans endpoints l’URL Elasticsearch du déploiement.'
    );

  // Authentification : clé d’API, ou utilisateur et mot de passe (cloud_auth : « utilisateur:mot de passe »)
  const request = {};
  if (s.api_key) {
    request.headers = {
      Authorization: `ApiKey ${secretRef(v, s.api_key, 'ELASTICSEARCH_API_KEY', 'Clé d’API Elasticsearch')}`
    };
    v.note(
      'warn',
      'Clé d’API Elasticsearch',
      'Logstash attend « id:clé » et l’encode lui-même. La variable doit contenir la forme encodée : echo -n "id:clé" | base64.'
    );
  } else if (s.user !== undefined || s.password !== undefined || s.cloud_auth !== undefined) {
    const pair =
      s.cloud_auth !== undefined && !LS_ENV_REF.test(String(s.cloud_auth)) ? String(s.cloud_auth).split(':') : [];
    let user = s.user !== undefined ? s.user : pair[0];
    if (user === undefined) {
      user = '${ELASTICSEARCH_USER}';
      v.env.add('ELASTICSEARCH_USER');
    } else if (LS_ENV_REF.test(String(user))) {
      v.env.add(LS_ENV_REF.exec(String(user))[1]);
      user = vectorEnv(user);
    }
    const password = s.password !== undefined ? s.password : pair.length > 1 ? pair.slice(1).join(':') : undefined;
    sink.auth = {
      strategy: 'basic',
      user: String(user),
      password: secretRef(v, password, 'ELASTICSEARCH_PASSWORD', 'Mot de passe Elasticsearch')
    };
  }
  if (isObj(s.custom_headers)) request.headers = Object.assign({}, s.custom_headers, request.headers);
  if (s.timeout !== undefined) request.timeout_secs = Number(s.timeout) || 60;
  if (Object.keys(request).length) sink.request = request;
  if (truthy(s.http_compression)) sink.compression = 'gzip';
  if (s.proxy) sink.proxy = { enabled: true, http: String(s.proxy), https: String(s.proxy) };

  // Destination : data stream, ou index (avec son action et l’identifiant du document)
  const ds = s.data_stream === undefined ? '' : String(s.data_stream).toLowerCase();
  if (ds === 'true') {
    sink.mode = 'data_stream';
    sink.data_stream = {
      type: s.data_stream_type || 'logs',
      dataset: s.data_stream_dataset || 'generic',
      namespace: s.data_stream_namespace || 'default'
    };
    if (s.data_stream_auto_routing !== undefined) sink.data_stream.auto_routing = truthy(s.data_stream_auto_routing);
    if (s.data_stream_sync_fields !== undefined) sink.data_stream.sync_fields = truthy(s.data_stream_sync_fields);
    if (s.index)
      v.note(
        'info',
        'index ignoré',
        'En mode data stream, la destination est type-dataset-namespace : index est ignoré, comme par Logstash.'
      );
  } else {
    if (ds === 'auto')
      review(
        'data_stream => auto',
        'Logstash choisit le mode selon Elasticsearch et les autres options ; la traduction écrit dans un index. Si la destination est un data stream, passez le sink en mode: data_stream.'
      );
    const index = tplOf(s.index || 'logstash-%{+yyyy.MM.dd}');
    sink.bulk = { index };
    // Vector 0.57 et suivants refusent un modèle sans préfixe littéral : les noms d’index viennent alors de l’événement
    if (/^\{\{/.test(index)) {
      sink.dangerously_allow_unconfined_template_resolution = true;
      v.note(
        'warn',
        'Index tiré d’un champ',
        `L’index « ${index} » vient entièrement de l’événement : Vector 0.57 et suivants l’exigent explicitement (dangerously_allow_unconfined_template_resolution). Un événement peut ainsi écrire dans n’importe quel index ; ajoutez un préfixe fixe si possible.`
      );
    }
    if (s.action !== undefined) {
      const action = String(s.action);
      if (/^(index|create)$/.test(action) || /%\{/.test(action)) sink.bulk.action = tplOf(action);
      else
        todo(
          `action « ${action} » non traduite`,
          'Le sink Vector écrit avec index ou create ; une mise à jour ou une suppression de documents se réécrit à la main.'
        );
    }
  }
  if (s.document_id !== undefined) {
    const m = /^%\{([^}]+)\}$/.exec(String(s.document_id));
    const path = m ? vPathOf(fieldSegs(m[1]), v.ns) : '';
    // id_key désigne un champ de l’événement : Vector 0.59 refuse une métadonnée (%id)
    if (path && !path.startsWith('%')) sink.id_key = path.replace(/^\./, '');
    else
      review(
        'document_id non repris',
        `« ${s.document_id} » ${path ? 'vient d’une métadonnée' : 'mêle texte et champs'} : calculez-le dans un champ de l’événement par une étape VRL, puis désignez ce champ par id_key.`
      );
  }
  if (s.pipeline !== undefined) {
    if (/%\{/.test(String(s.pipeline)))
      review(
        'pipeline tiré d’un champ',
        `« ${s.pipeline} » : le sink Vector prend un nom de pipeline d’ingestion fixe.`
      );
    else sink.pipeline = String(s.pipeline);
  }
  if (s.routing !== undefined)
    review(
      'routing non repris',
      `« ${s.routing} » : le sink Vector ne choisit pas le shard de destination ; les requêtes qui passent routing doivent s’en passer.`
    );

  // TLS
  const tls = {};
  const cas = lsList(s.ssl_certificate_authorities || s.cacert);
  if (cas.length) tls.ca_file = String(cas[0]);
  if (cas.length > 1)
    review(
      'Plusieurs autorités de certification',
      `Vector lit un seul fichier : concaténez ${cas.join(', ')} en un seul PEM.`
    );
  if (s.ssl_certificate) tls.crt_file = String(s.ssl_certificate);
  if (s.ssl_key) tls.key_file = String(s.ssl_key);
  if (
    String(s.ssl_verification_mode || '').toLowerCase() === 'none' ||
    (s.ssl_certificate_verification !== undefined && !truthy(s.ssl_certificate_verification))
  ) {
    tls.verify_certificate = false;
    v.note(
      'warn',
      'Certificat Elasticsearch non vérifié',
      'Repris du pipeline d’origine : à corriger avant la production.'
    );
  }
  if (Object.keys(tls).length) sink.tls = tls;
  if (s.keystore || s.truststore)
    review(
      'Magasins de certificats Java',
      'keystore et truststore (JKS, PKCS12) se convertissent en PEM pour Vector : tls.crt_file, tls.key_file, tls.ca_file.'
    );

  // Ce que Logstash fait dans Elasticsearch, en dehors de l’écriture
  if (
    [
      'manage_template',
      'template',
      'template_name',
      'template_overwrite',
      'template_api',
      'ilm_enabled',
      'ilm_rollover_alias',
      'ilm_pattern',
      'ilm_policy'
    ].some(k => s[k] !== undefined)
  ) {
    review(
      'Modèles d’index et ILM',
      'Logstash installe le modèle d’index et la politique ILM au démarrage ; Vector ne le fait pas. Installez-les une fois avec l’API d’Elasticsearch.'
    );
  }
  const updates = [
    'doc_as_upsert',
    'upsert',
    'script',
    'scripted_upsert',
    'version',
    'version_type',
    'parent',
    'join_field'
  ].filter(k => s[k] !== undefined);
  if (updates.length)
    todo(
      'Mise à jour de documents non traduite',
      `${updates.join(', ')} : le sink Vector ajoute des documents, il ne les met pas à jour.`
    );
  return sink;
}
function httpSink(v, s) {
  const sink = { type: 'http', inputs: [], uri: s.url || 'http://localhost', encoding: { codec: 'json' } };
  const method = String(s.http_method || 'post').toLowerCase();
  if (method !== 'post') sink.method = method;
  const headers = Object.assign({}, isObj(s.headers) ? s.headers : {});
  if (s.content_type) headers['Content-Type'] = String(s.content_type);
  if (Object.keys(headers).length) sink.request = { headers };
  const format = String(s.format || 'json');
  if (format === 'json' || format === 'json_batch')
    v.note(
      'warn',
      'Sortie http : envoi par lots',
      `Vector envoie les événements par lots, un JSON par ligne ; Logstash (${format}) ${format === 'json' ? 'envoie un événement par requête' : 'envoie un tableau JSON'}. Vérifiez que le destinataire l’accepte.`
    );
  else {
    v.stats.ko++;
    v.note(
      'err',
      `Sortie http : format « ${format} » non traduit`,
      'Seuls json et json_batch ont un équivalent : le corps de la requête est à réécrire.'
    );
  }
  return sink;
}
function flatOutputs(stmts, conds, out) {
  for (const st of stmts) {
    if (st.k === 'plugin') out.push({ plugin: st, conds: conds.slice() });
    else {
      const prev = [];
      st.branches.forEach(b => {
        const own = b.cond ? [{ c: b.cond }] : [];
        const negs = prev.map(c => ({ c, neg: true }));
        flatOutputs(b.body, conds.concat(negs, own), out);
        if (b.cond) prev.push(b.cond);
      });
    }
  }
  return out;
}
/*
 * throttle de Logstash : compte les événements par clé et par tranche de « period » secondes (horodatage de
 * l’événement), et applique add_tag, add_field… à ceux qui dépassent after_count. Le filtre ne supprime rien : un
 * « if "étiquette" in [tags] { drop {} } » le suit d’ordinaire. Le transform throttle de Vector supprime directement
 * ce qui dépasse le seuil, sur une fenêtre glissante de temps de traitement : il ne vaut que si l’étiquette sert à
 * supprimer, ce qui est vérifié dans la suite du pipeline.
 */
function throttleTransform(v, st, rest) {
  const s = lsSettings(st);
  const ko = why => {
    v.stats.ko++;
    v.note('err', `Filtre throttle non traduit (ligne ${st.line})`, why);
    return { threshold: 1, window_secs: 1, __ko: true };
  };
  if (s.before_count !== undefined && +s.before_count !== -1)
    return ko(
      'before_count marque les premiers événements de chaque tranche : le transform throttle de Vector ne sait que limiter ceux qui dépassent un seuil.'
    );
  if (s.after_count === undefined || +s.after_count === -1)
    return ko('throttle sans after_count : rien n’est marqué, aucun équivalent à produire.');
  const period = String(s.period === undefined ? '60' : s.period);
  if (/%\{/.test(period))
    return ko('period calculée pour chaque événement : la fenêtre du transform throttle est fixe.');
  const window = parseInt(period, 10) || 60;
  const tags = lsList(s.add_tag).map(String);
  // L’étiquette sert-elle à supprimer ? « if "x" in [tags] { drop {} } » dans la suite du pipeline
  const drops = tag =>
    rest.some(function walk(x) {
      if (!x) return false;
      if (x.k === 'if')
        return x.branches.some(
          b =>
            (b.cond &&
              JSON.stringify(b.cond).includes(JSON.stringify(tag)) &&
              b.body.some(y => y.k === 'plugin' && y.name === 'drop')) ||
            b.body.some(walk)
        );
      return false;
    });
  const dropped = tags.length && tags.every(drops);
  const key =
    s.key === undefined
      ? null
      : String(s.key).replace(/%\{([^}]+)\}/g, (m, ref) => `{{ ${vPathOf(fieldSegs(ref), v.ns).replace(/^\./, '')} }}`);
  const out = { threshold: Math.max(0, parseInt(s.after_count, 10)), window_secs: window };
  if (key) out.key_field = key;
  if (!dropped) {
    v.stats.ko++;
    v.note(
      'err',
      `Filtre throttle non traduit (ligne ${st.line})`,
      `Logstash étiquette${tags.length ? ` (${tags.join(', ')})` : ''} les événements au-delà de ${s.after_count} par ${window} s sans les supprimer, et la suite du pipeline les garde. Le transform throttle de Vector les supprimerait : il est proposé ici, à n’activer que si ces événements doivent disparaître.`
    );
  } else {
    v.stats.approx++;
    v.note(
      'warn',
      'throttle → transform throttle',
      `Les événements au-delà de ${out.threshold} par ${window} s${key ? ` et par ${key}` : ''} sont supprimés par Vector, comme le faisait le drop sur l’étiquette ${tags.join(', ')}. Différence : Vector compte sur une fenêtre glissante, à l’heure de traitement, là où Logstash découpe des tranches fixes selon l’horodatage des événements.`
    );
  }
  if (s.max_counters !== undefined || s.max_age !== undefined)
    v.note(
      'info',
      'throttle : max_age, max_counters',
      'Vector gère seul la mémoire de ses compteurs : ces réglages n’ont pas d’équivalent.'
    );
  return out;
}
function translateLogstash(src, cfg, opts) {
  try {
    return translatePipeline(src, cfg, opts || {});
  } catch (e) {
    // Une construction hors de portée (pile épuisée) ne doit pas devenir une erreur interne du service
    if (e instanceof RangeError) return { error: 'Pipeline trop imbriqué pour être traduit.' };
    throw e;
  }
}
function translatePipeline(src, cfg, opts) {
  opts = opts || {};
  const notes = makeNotes();
  // Compatibilité ECS : celle de la configuration (v8 par défaut, comme Logstash 8 et suivants), sauf réglage du plugin
  const v = {
    ns: cfg.vector.log_namespace !== false,
    compat: !!cfg.vector.logstash_compat,
    ecs: String(cfg.vector.ecs_compatibility || 'v8') !== 'disabled',
    stats: { ok: 0, approx: 0, ko: 0 },
    enrich: {},
    env: new Set(),
    refN: 0,
    note: (l, t, d, c) => notes.add(l, t, d, c)
  };
  let ast;
  try {
    ast = parseLogstash(src);
  } catch (e) {
    return { error: e.message };
  }
  if (!ast.input.length && !ast.filter.length && !ast.output.length) return { empty: true };
  const used = new Set();
  const sources = {};
  const transforms = {};
  const sinks = {};
  const graph = { nodes: [], edges: [] };
  const srcList = [];
  ast.input.forEach((st, i) => {
    if (st.k !== 'plugin') {
      v.note('warn', 'Condition dans input', 'Les conditions de la section input sont ignorées.');
      return;
    }
    const r = buildSource(v, st, cfg, i, used, opts);
    if (r) srcList.push(r);
  });
  if (!srcList.length) {
    const r = {
      name: uniq(used, 'kafka_in'),
      src: {
        type: 'kafka',
        bootstrap_servers: cfg.kafka.bootstrap_servers || 'localhost:9092',
        group_id: cfg.kafka.consumer_group || 'vector',
        topics: cfg.kafka.input_topics.length ? cfg.kafka.input_topics : ['logs'],
        decoding: { codec: 'json' },
        __label: 'logs',
        __detail: 'source par défaut'
      },
      s: {}
    };
    if (v.ns) r.src.log_namespace = true;
    srcList.push(r);
    v.note('warn', 'Aucune entrée', 'Une source Kafka par défaut a été ajoutée.');
  }
  let prev = [];
  for (const r of srcList) {
    const clean = Object.fromEntries(Object.entries(r.src).filter(([k]) => !k.startsWith('__')));
    sources[r.name] = clean;
    graph.nodes.push({ id: r.name, kind: 'source', type: r.src.type, label: r.src.__label, detail: r.src.__detail });
    // Étape d’initialisation propre à chaque source
    const g = new VrlGen(v);
    // Mode ECS : les codecs de Logstash gardent la ligne reçue dans [event][original]
    const original = v.ns && g.ecsOn(r.s);
    if (r.src.__pipeline) {
      // L’événement arrive déjà décodé ; la finalisation du pipeline expéditeur a écrit @timestamp en texte
      if (cfg.vector.logstash_compat) {
        g.comment('Événement reçu d’un autre pipeline : @timestamp redevient une date, comme dans Logstash');
        g.open('if is_string(."@timestamp")');
        g.emit('."@timestamp" = parse_timestamp(string!(."@timestamp"), "%+") ?? ."@timestamp"');
        g.close();
      }
    } else if (v.ns && r.src.__plain) {
      g.comment('Codec plain : le message brut devient le champ message, comme dans Logstash');
      g.emit(original ? '. = { "message": ., "event": { "original": . } }' : '. = { "message": . }');
    } else if (v.ns && r.src.__json) {
      // Comme le codec json de Logstash : une ligne invalide est gardée dans message, avec _jsonparsefailure
      g.comment('Codec json : décodage de la ligne (invalide : gardée dans message, avec _jsonparsefailure)');
      g.emit('raw = string(.) ?? ""');
      g.emit('parsed, err = parse_json(raw)');
      g.open('if err == null');
      g.emit('. = object(parsed) ?? { "message": parsed }');
      // Mode ECS : la ligne reçue est gardée dans [event][original], sauf pour une ligne invalide (comme Logstash)
      if (original) g.emit('.event.original = raw');
      g.close('} else {');
      g.ind++;
      g.emit('. = { "message": raw, "tags": ["_jsonparsefailure"] }');
      g.close();
    } else if (v.ns) {
      g.comment('Garantit un objet à la racine (un JSON scalaire est rangé dans message)');
      g.emit(
        original ? '. = object(.) ?? { "message": ., "event": { "original": . } }' : '. = object(.) ?? { "message": . }'
      );
    }
    if (cfg.vector.logstash_compat) {
      g.comment('Compatibilité Logstash : @timestamp et @version présents sur chaque événement');
      g.open('if !exists(."@timestamp")');
      g.emit('."@timestamp" = now()');
      g.close();
      g.open('if !exists(."@version")');
      g.emit('."@version" = "1"');
      g.close();
    }
    if (r.s.type) g.assign('.type', vq(r.s.type), 'str');
    g.common({ add_field: r.s.add_field, add_tag: r.s.tags });
    if (g.hasCode()) {
      const tn = uniq(used, `${r.name}_init`);
      transforms[tn] = { type: 'remap', inputs: [r.name], source: g.code() };
      graph.nodes.push({
        id: tn,
        kind: 'transform',
        type: 'remap',
        label: 'Préparation',
        detail: 'compatibilité Logstash'
      });
      graph.edges.push([r.name, tn]);
      prev.push(tn);
    } else prev.push(r.name);
  }
  // Filtres
  let pending = [];
  ast.filter.forEach((st, idx) => {
    // throttle au premier niveau : le transform throttle de Vector, qui limite le flux par clé
    if (st.k === 'plugin' && st.name === 'throttle') {
      const t = throttleTransform(v, st, ast.filter.slice(idx + 1));
      if (t) {
        const s0 = lsSettings(st);
        const tn = uniq(used, compName(s0.id || 'throttle'));
        const { __ko, ...cfgT } = t;
        transforms[tn] = Object.assign({ type: 'throttle', inputs: prev.slice() }, cfgT);
        graph.nodes.push({
          id: tn,
          kind: 'transform',
          type: 'throttle',
          label: 'throttle',
          detail: `${t.threshold} par ${t.window_secs} s${t.key_field ? `, par ${t.key_field}` : ''}`
        });
        prev.forEach(x => graph.edges.push([x, tn]));
        prev = [tn];
        return;
      }
    }
    const g = new VrlGen(v);
    pending.forEach(l => g.lines.push(l));
    pending = [];
    g.stmt(st);
    const s = st.k === 'plugin' ? lsSettings(st) : {};
    if (!g.hasCode()) {
      pending = g.lines.slice();
      return;
    }
    const base = st.k === 'plugin' ? s.id || st.name : `condition_${idx + 1}`;
    const tn = uniq(used, compName(base));
    const t = { type: 'remap', inputs: prev.slice(), source: g.code() };
    if (g.usedAbort) t.drop_on_abort = true;
    transforms[tn] = t;
    const plugins = [...new Set(g.plugins)];
    graph.nodes.push({
      id: tn,
      kind: 'transform',
      type: 'remap',
      label: st.k === 'plugin' ? st.name : 'si … alors',
      detail: st.k === 'plugin' ? s.id || '' : plugins.join(', '),
      todo: g.todo,
      drop: g.usedAbort
    });
    prev.forEach(p => graph.edges.push([p, tn]));
    prev = [tn];
  });
  // Finalisation
  const fin = new VrlGen(v);
  pending.forEach(l => fin.lines.push(l));
  if (cfg.vector.logstash_compat) {
    // @timestamp venu du document (codec ou filtre json) : Logstash le convertit, ou range une valeur illisible dans
    // _@timestamp avec _timestampparsefailure et garde l’horodatage d’ingestion
    fin.comment('@timestamp venu du document : lu comme par Logstash ; illisible, rangé dans _@timestamp');
    fin.open('if exists(."@timestamp") && !is_timestamp(."@timestamp")');
    fin.emit('iso = replace(string(."@timestamp") ?? "", ",", ".")');
    fin.emit(`ts = ${isoParse('iso')}`);
    fin.open('if ts == null');
    fin.emit('."_@timestamp" = ."@timestamp"');
    fin.emit('."@timestamp" = now()');
    fin.failTags(['_timestampparsefailure']);
    fin.close('} else {');
    fin.ind++;
    fin.emit('."@timestamp" = ts');
    fin.close();
    fin.close();
    fin.comment('Format de date identique à Logstash (millisecondes, UTC)');
    fin.open('if is_timestamp(."@timestamp")');
    fin.emit('."@timestamp" = format_timestamp!(."@timestamp", format: "%Y-%m-%dT%H:%M:%S%.3fZ")');
    fin.close();
  }
  if (!v.ns) {
    fin.comment('Retire les champs techniques ajoutés par la source Kafka');
    fin.emit('del(.source_type)');
    ['_kafka_topic', '_kafka_partition', '_kafka_offset', '_kafka_message_key', '_kafka_headers'].forEach(f =>
      fin.emit(`del(.${f})`)
    );
    v.note(
      'warn',
      'Champ timestamp',
      'Sans namespace de logs, Vector ajoute un champ timestamp (horodatage Kafka) qui peut écraser un champ du même nom. Activez log_namespace pour l’éviter.'
    );
  }
  if (fin.hasCode()) {
    const tn = uniq(used, 'logstash_finalize');
    transforms[tn] = { type: 'remap', inputs: prev.slice(), source: fin.code() };
    graph.nodes.push({ id: tn, kind: 'transform', type: 'remap', label: 'Finalisation', detail: 'format de sortie' });
    prev.forEach(p => graph.edges.push([p, tn]));
    prev = [tn];
  }
  // Sorties
  const outs = flatOutputs(ast.output, [], []);
  const kafkaOuts = outs.filter(o => o.plugin.name === 'kafka').length;
  const routes = {};
  let routeName = null;
  const condCache = new Map();
  const condStr = conds => {
    const g = new VrlGen(v);
    return conds.map(x => (x.neg ? `!(${g.cond(x.c)})` : g.cw(x.c))).join(' && ');
  };
  const hasConds = outs.some(o => o.conds.length);
  if (hasConds) routeName = uniq(used, 'routage');
  let ri = 0;
  for (const o of outs) {
    // Ensemble de pipelines : kafka.output_topic ne remplace le topic que s’il n’y a qu’une sortie Kafka dans tout l’ensemble
    const r = buildSink(
      v,
      o.plugin,
      cfg,
      used,
      opts.singleKafka !== undefined ? opts.singleKafka : kafkaOuts === 1,
      opts
    );
    if (!r) continue;
    let input = prev.slice();
    if (o.conds.length) {
      const key = condStr(o.conds);
      let rn = condCache.get(key);
      if (!rn) {
        rn = compName(r.sink.__label || `route_${++ri}`).slice(0, 40) || `route_${++ri}`;
        while (routes[rn]) rn += '_b';
        routes[rn] = key;
        condCache.set(key, rn);
      }
      input = [`${routeName}.${rn}`];
    }
    if (r.pre) {
      transforms[r.pre.name] = { type: 'remap', inputs: input, source: r.pre.source };
      graph.nodes.push({
        id: r.pre.name,
        kind: 'transform',
        type: 'remap',
        label: 'Mise en forme ClickHouse',
        detail: 'colonnes de la table'
      });
      input.forEach(i => graph.edges.push([i.split('.')[0], r.pre.name]));
      input = [r.pre.name];
    }
    r.sink.inputs = input;
    const label = r.sink.__label;
    delete r.sink.__label;
    sinks[r.name] = r.sink;
    graph.nodes.push({
      id: r.name,
      kind: 'sink',
      type: r.sink.type,
      label,
      detail: o.conds.length ? 'sous condition' : ''
    });
    input.forEach(i => graph.edges.push([i.split('.')[0], r.name]));
  }
  if (routeName) {
    transforms[routeName] = { type: 'route', inputs: prev.slice(), reroute_unmatched: false, route: routes };
    graph.nodes.push({
      id: routeName,
      kind: 'transform',
      type: 'route',
      label: 'Routage',
      detail: `${Object.keys(routes).length} règle${Object.keys(routes).length > 1 ? 's' : ''}`
    });
    prev.forEach(p => graph.edges.push([p, routeName]));
    v.note(
      'info',
      'Conditions de sortie → route',
      'Les if/else de la section output deviennent un transform route ; chaque branche est une condition VRL exclusive.'
    );
  }
  if (!Object.keys(sinks).length) v.note('err', 'Aucune sortie', 'Le pipeline n’a pas de sortie traduisible.');
  // Pipeline d’un ensemble (pipelines.yml) : la configuration est assemblée avec les autres, puis écrite une fois
  if (opts.pipelineIO)
    return {
      parts: { sources, transforms, sinks, enrich: v.enrich },
      v,
      notes: notes.list,
      stats: v.stats,
      graph,
      env: [...v.env],
      srcList,
      prev
    };
  const { config, yaml, toml } = vectorDocument(
    v,
    { sources, transforms, sinks, enrich: v.enrich },
    cfg,
    'depuis un pipeline Logstash'
  );
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  notes.list.sort((a, b) => order[a.level] - order[b.level]);
  const inTopics = srcList.map(r => r.src.__label).join(', ');
  const outLabels = graph.nodes.filter(nd => nd.kind === 'sink').map(nd => nd.label);
  const steps = graph.nodes.filter(
    nd => nd.kind === 'transform' && nd.type === 'remap' && !['Préparation', 'Finalisation'].includes(nd.label)
  );
  const group = srcList[0] && srcList[0].src.group_id;
  const sentenceTxt = `Lit ${inTopics}${group ? ` (groupe ${group})` : ''}, applique ${steps.length} étape${steps.length > 1 ? 's' : ''}${steps.length ? ` (${[...new Set(steps.map(x => x.label))].join(', ')})` : ''}, puis écrit ${outLabels.length > 1 ? `selon des conditions vers ${outLabels.slice(0, -1).join(', ')} ou ${outLabels[outLabels.length - 1]}` : `vers ${outLabels[0] || '—'}`}.`;
  const first = Object.keys(transforms)[0];
  const last = prev[0];
  return {
    config,
    yaml,
    toml,
    notes: notes.list,
    stats: v.stats,
    graph,
    sentence: sentenceTxt,
    env: [...v.env],
    firstTransform: first,
    lastTransform: last
  };
}

/*
 * Configuration Vector complète, à partir des composants d’un pipeline ou d’un ensemble de pipelines : $ doublés,
 * notes communes (API, accusés de réception, namespace), en-tête, YAML et TOML.
 */
function vectorDocument(v, parts, cfg, origin) {
  const { sources, transforms, sinks } = parts;
  // Vector interpole ${VAR} et $VAR dans tout le fichier : les $ du code VRL sont doublés
  let dollar = false;
  const esc = x => {
    if (x.includes('$')) {
      dollar = true;
      return x.replace(/\$/g, '$$$$');
    }
    return x;
  };
  for (const t of Object.values(transforms)) {
    if (t.source) t.source = esc(t.source);
    if (t.route) for (const k of Object.keys(t.route)) t.route[k] = esc(t.route[k]);
  }
  if (dollar)
    v.note(
      'info',
      'Symbole $ doublé',
      'Vector remplace $VAR et ${VAR} par des variables d’environnement dans tout le fichier : les $ du code VRL sont écrits $$ pour rester littéraux.'
    );
  // Depuis Vector 0.57, ce remplacement n’a lieu qu’avec une option explicite : sans elle, ${VAR} reste tel quel et $$ n’est pas ramené à $
  const interpolation = dollar || v.env.size > 0;
  if (interpolation)
    v.note(
      'warn',
      'Vector 0.57 et suivants : interpolation à activer',
      'Ce fichier utilise des variables d’environnement ${VAR} ou des $ doublés. Lancez Vector avec --dangerously-allow-env-var-interpolation, ou VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true dans son environnement.'
    );
  // L’API de Vector n’a pas d’authentification : elle n’écoute que sur la boucle locale, ce qui suffit à « vector top »
  const config = { data_dir: '/var/lib/vector', api: { enabled: true, address: '127.0.0.1:8686' } };
  v.note(
    'info',
    'API Vector sur la boucle locale',
    'L’API de Vector (vector top, santé) écoute sur 127.0.0.1:8686 : elle n’a pas d’authentification et ne doit pas être joignable du réseau. Dans un conteneur, pour l’atteindre depuis l’hôte, remplacez l’adresse par 0.0.0.0:8686 et ne publiez le port que sur une interface de confiance.'
  );
  if (Object.keys(parts.enrich || {}).length) config.enrichment_tables = parts.enrich;
  config.sources = sources;
  config.transforms = transforms;
  config.sinks = sinks;
  if (!Object.keys(transforms).length) delete config.transforms;
  if (cfg.vector.acknowledgements) {
    // Le texte suit les composants réels : seules certaines sources de Vector savent attendre l’écriture
    const srcTypes = Object.values(sources).map(x => x.type);
    const sinkTypes = Object.values(sinks).map(x => x.type);
    const where =
      sinkTypes.length && sinkTypes.every(t => t === 'kafka')
        ? 'l’écriture dans le topic de sortie'
        : 'l’écriture par les sorties';
    const ACK = [
      'kafka',
      'logstash',
      'http_server',
      'file',
      'journald',
      'opentelemetry',
      'splunk_hec',
      'fluent',
      'vector',
      'amqp',
      'aws_s3',
      'aws_sqs'
    ];
    const without = [...new Set(srcTypes.filter(t => !ACK.includes(t)))];
    const text =
      srcTypes.length && srcTypes.every(t => t === 'kafka')
        ? `Les offsets Kafka ne sont validés qu’après ${where} : aucun message perdu en cas d’arrêt brutal.`
        : `Les sources n’accusent réception qu’après ${where}` +
          (without.length
            ? ` ; ${without.join(', ')} n’ont pas d’accusé de réception et peuvent perdre des événements en cas d’arrêt brutal.`
            : ' : aucun événement perdu en cas d’arrêt brutal.');
    v.note('opt', 'Accusés de réception de bout en bout', text);
  }
  if (cfg.vector.shadow_mode)
    v.note(
      'info',
      'Mode shadow',
      'Le groupe de consommateurs et les topics de sortie sont suffixés par -shadow : Vector tourne en parallèle de Logstash sans lui prendre de partitions.'
    );
  if (v.ns)
    v.note(
      'info',
      'Namespace de logs',
      'log_namespace isole les métadonnées Kafka (topic, offset, clé) de la charge utile : les messages écrits restent identiques à ceux de Logstash.'
    );
  // Les bases MaxMind lues au démarrage : sans elles, Vector refuse le VRL (error[E401])
  const mmdb = Object.values(parts.enrich || {})
    .filter(t => t && t.type === 'geoip')
    .map(t => t.path);
  const header = `Configuration Vector générée par Passerelle ${origin}\nVérification complète (VRL compilé) : vector validate --skip-healthchecks <fichier>${interpolation ? '\nVector 0.57 et suivants : lancer avec --dangerously-allow-env-var-interpolation (variables d’environnement, symboles $ doublés)' : ''}${v.env.size ? `\nVariables d’environnement attendues : ${[...v.env].join(', ')}` : ''}${mmdb.length ? `\nBase${mmdb.length > 1 ? 's' : ''} geoip à fournir : ${mmdb.join(', ')} (sans ${mmdb.length > 1 ? 'elles' : 'elle'}, Vector refuse le VRL : error[E401])` : ''}`;
  const yaml =
    header
      .split('\n')
      .map(l => '# ' + l)
      .join('\n') +
    '\n\n' +
    toYAML(config) +
    '\n';
  const toml =
    header
      .split('\n')
      .map(l => '# ' + l)
      .join('\n') +
    '\n\n' +
    toTOML(config) +
    '\n';
  return { config, yaml, toml };
}
/* ---------- Sérialisation ---------- */
function yq(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function yamlKey(k) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(k) ? k : yq(k);
}
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (
    s === '' ||
    /^\s|\s$/.test(s) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
    /: |\s#/.test(s) ||
    /^(true|false|yes|no|null|on|off|~)$/i.test(s) ||
    /^[-+]?(\d|\.\d)/.test(s) ||
    /[{}\[\],]/.test(s) ||
    s.includes('${')
  )
    return yq(s);
  return s;
}
function toYAML(obj, ind) {
  ind = ind || 0;
  const pad = ' '.repeat(ind);
  const L = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = pad + yamlKey(k) + ':';
    if (isObj(v)) {
      if (!Object.keys(v).length) L.push(key + ' {}');
      else {
        L.push(key);
        L.push(toYAML(v, ind + 2));
      }
    } else if (Array.isArray(v)) {
      if (!v.length) L.push(key + ' []');
      else if (v.every(x => !isObj(x) && !Array.isArray(x)) && v.map(yamlScalar).join(', ').length < 70)
        L.push(`${key} [${v.map(yamlScalar).join(', ')}]`);
      else {
        L.push(key);
        v.forEach(x => {
          if (isObj(x)) {
            const inner = toYAML(x, ind + 4).split('\n');
            L.push(pad + '  - ' + inner[0].trim());
            inner.slice(1).forEach(l => L.push(l));
          } else L.push(pad + '  - ' + yamlScalar(x));
        });
      }
    } else if (typeof v === 'string' && v.includes('\n')) {
      L.push(key + ' |');
      v.replace(/\n+$/, '')
        .split('\n')
        .forEach(l => L.push(l ? pad + '  ' + l : ''));
    } else L.push(key + ' ' + yamlScalar(v));
  }
  return L.join('\n');
}
function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}
function tomlVal(v) {
  if (typeof v === 'string') {
    if (v.includes('\n'))
      return v.includes("'''")
        ? '"""\n' + v.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""') + '"""'
        : "'''\n" + v.replace(/\n+$/, '') + "\n'''";
    return JSON.stringify(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(tomlVal).join(', ') + ']';
  if (isObj(v))
    return (
      '{ ' +
      Object.entries(v)
        .map(([k, x]) => `${tomlKey(k)} = ${tomlVal(x)}`)
        .join(', ') +
      ' }'
    );
  return '""';
}
function toTOML(obj) {
  const out = [];
  (function table(path, o) {
    const simple = Object.entries(o).filter(([, x]) => !isObj(x) && x !== undefined);
    const complex = Object.entries(o).filter(([, x]) => isObj(x));
    if (path.length && (simple.length || !complex.length)) out.push('', `[${path.map(tomlKey).join('.')}]`);
    simple.forEach(([k, x]) => out.push(`${tomlKey(k)} = ${tomlVal(x)}`));
    complex.forEach(([k, x]) => table(path.concat(k), x));
  })([], obj);
  return out.join('\n').replace(/^\n+/, '');
}
/* Petit analyseur YAML pour importer le fichier de configuration de Passerelle */
function parseYAMLConfig(text) {
  const lines = String(text)
    .split('\n')
    .map(l => l.replace(/\s+#.*$/, '').replace(/^#.*$/, ''))
    .filter(l => l.trim());
  const scalar = s => {
    s = s.trim();
    if (s === '') return '';
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(s)) return JSON.parse(s);
    if (/^\[.*\]$/.test(s)) {
      const inner = s.slice(1, -1).trim();
      return inner ? inner.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(scalar) : [];
    }
    if (s === '{}') return {};
    // Table en ligne : { clé: valeur, 'autre clé': [a, b] }
    if (/^\{.*\}$/.test(s)) {
      const out = {};
      for (const pair of splitTopArgs(s.slice(1, -1))) {
        const kv = /^('[^']*'|"[^"]*"|[^:]+):\s*(.*)$/.exec(pair.trim());
        if (!kv) throw new Error(`table en ligne illisible : ${s}`);
        out[scalar(kv[1])] = scalar(kv[2]);
      }
      return out;
    }
    if (/^(true|false)$/.test(s)) return s === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  let pos = 0;
  function block(indentLvl) {
    let obj = null;
    while (pos < lines.length) {
      const line = lines[pos];
      const ind = line.match(/^ */)[0].length;
      if (ind < indentLvl) break;
      const t = line.trim();
      if (t.startsWith('- ')) {
        if (!obj) obj = [];
        const rest = t.slice(2);
        // « - clé: valeur » : un élément qui est une table. Sa première paire est sur la ligne du tiret, les autres
        // à deux colonnes du tiret ; la ligne est lue comme si elle était déjà à cette indentation.
        if (/^('[^']*'|"[^"]*"|[A-Za-z_][\w.-]*):(\s|$)/.test(rest)) {
          lines[pos] = ' '.repeat(ind + 2) + rest;
          obj.push(block(ind + 2));
          continue;
        }
        obj.push(scalar(rest));
        pos++;
        continue;
      }
      const m = /^('[^']*'|"[^"]*"|[^:]+):(\s+(.*))?$/.exec(t);
      if (!m) {
        pos++;
        continue;
      }
      if (!obj) obj = {};
      const k = scalar(m[1]);
      pos++;
      if (m[3] !== undefined && m[3] !== '') obj[k] = scalar(m[3]);
      else {
        const nextInd = pos < lines.length ? lines[pos].match(/^ */)[0].length : 0;
        obj[k] = nextInd > ind ? block(nextInd) : '';
      }
    }
    return obj || {};
  }
  return block(0);
}
function configToYAML(cfg) {
  const head =
    '# Configuration Passerelle — à versionner avec vos pipelines (infrastructure as code)\n# Les secrets restent des variables d’environnement ${…}, résolues au déploiement.\n\n';
  return head + toYAML({ version: 1, clickhouse: cfg.clickhouse, kafka: cfg.kafka, vector: cfg.vector }) + '\n';
}
/* Archive ZIP sans compression (stored), pour regrouper les fichiers générés */
function makeZip(files) {
  const enc = new TextEncoder();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = b => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0x21),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0)
    ]);
    chunks.push(local, name, data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(0),
        ...u16(0x21),
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset)
      ]),
      name
    );
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(cdSize),
    ...u32(offset),
    ...u16(0)
  ]);
  const all = chunks.concat(central, [end]);
  const total = all.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
