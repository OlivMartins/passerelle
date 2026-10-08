/* Passerelle — moteur partie 3 : Logstash → Vector */
function parseLogstash(src) {
  let i = 0; const s = String(src); const n = s.length;
  const lineAt = pos => s.slice(0, pos).split('\n').length;
  const fail = msg => { throw new Error(`Ligne ${lineAt(i)} : ${msg}`); };
  function ws() { while (i < n) { const c = s[i]; if (c === '#') { while (i < n && s[i] !== '\n') i++; } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++; else break; } }
  function at(t) { ws(); return s.startsWith(t, i); }
  function eat(t) { if (at(t)) { i += t.length; return true; } return false; }
  function expect(t) { if (!eat(t)) fail(`« ${t} » attendu${i < n ? ` (trouvé « ${s.slice(i, i + 12).split('\n')[0]} »)` : ''}`); }
  function word(w) { ws(); return s.startsWith(w, i) && !/[A-Za-z0-9_]/.test(s[i + w.length] || ''); }
  function bare() { ws(); const m = /^[^\s"'=,{}\[\]()#]+/.exec(s.slice(i)); if (!m) fail('identifiant attendu'); i += m[0].length; return m[0]; }
  function str() {
    ws(); const q = s[i]; i++; let out = '';
    while (i < n && s[i] !== q) { if (s[i] === '\\' && i + 1 < n) { out += s[i + 1] === q ? q : '\\' + s[i + 1]; i += 2; } else out += s[i++]; }
    if (i >= n) fail('chaîne non terminée'); i++; return out;
  }
  function key() { ws(); return s[i] === '"' || s[i] === "'" ? str() : bare(); }
  function value() {
    ws(); const c = s[i];
    if (c === '"' || c === "'") return { t: 'str', v: str() };
    if (c === '[') { i++; const items = []; while (!at(']')) { if (i >= n) fail('« ] » attendu'); items.push(value()); eat(','); } expect(']'); return { t: 'arr', v: items }; }
    if (c === '{') return { t: 'hash', v: hash() };
    const m = /^-?\d+(\.\d+)?(?![A-Za-z_])/.exec(s.slice(i));
    if (m) { i += m[0].length; return { t: 'num', v: +m[0] }; }
    const b = bare();
    if (at('{')) return { t: 'plugin', v: pluginBody(b) };
    if (b === 'true' || b === 'false') return { t: 'bool', v: b === 'true' };
    return { t: 'bare', v: b };
  }
  function hash() { expect('{'); const e = []; while (!at('}')) { if (i >= n) fail('« } » attendu'); const k = key(); expect('=>'); e.push([k, value()]); eat(','); } expect('}'); return e; }
  function pluginBody(name) {
    const line = lineAt(i); expect('{'); const settings = [];
    while (!at('}')) { if (i >= n) fail(`« } » attendu pour ${name}`); const k = key(); expect('=>'); settings.push([k, value()]); }
    expect('}'); return { name, settings, line };
  }
  function body() { const out = []; for (;;) { ws(); if (i >= n) fail('« } » attendu'); if (s[i] === '}') break; out.push(stmt()); } return out; }
  function stmt() {
    if (word('if')) {
      const line = lineAt(i); i += 2; const branches = [];
      const c = cond(); expect('{'); const b = body(); expect('}'); branches.push({ cond: c, body: b });
      for (;;) {
        if (!word('else')) break;
        i += 4;
        if (word('if')) { i += 2; const c2 = cond(); expect('{'); const b2 = body(); expect('}'); branches.push({ cond: c2, body: b2 }); }
        else { expect('{'); const b3 = body(); expect('}'); branches.push({ cond: null, body: b3 }); break; }
      }
      return { k: 'if', branches, line };
    }
    const name = bare(); ws();
    if (s[i] !== '{') fail(`« { » attendu après « ${name} »`);
    return Object.assign({ k: 'plugin' }, pluginBody(name));
  }
  function cond() { return orC(); }
  function orC() { let l = andC(); for (;;) { if (word('or')) { i += 2; l = { op: 'or', l, r: andC() }; } else if (word('xor')) { i += 3; l = { op: 'xor', l, r: andC() }; } else break; } return l; }
  function andC() { let l = notC(); for (;;) { if (word('and')) { i += 3; l = { op: 'and', l, r: notC() }; } else if (word('nand')) { i += 4; l = { op: 'nand', l, r: notC() }; } else break; } return l; }
  function notC() {
    ws();
    if (s[i] === '!' && s[i + 1] !== '=' && s[i + 1] !== '~') { i++; return { op: 'not', e: notC() }; }
    if (word('not')) { i += 3; return { op: 'not', e: notC() }; }
    if (s[i] === '(') { i++; const e = orC(); expect(')'); return e; }
    return comparison();
  }
  function comparison() {
    const l = rvalue(); ws();
    for (const op of ['==', '!=', '<=', '>=', '=~', '!~', '<', '>']) {
      if (s.startsWith(op, i)) {
        i += op.length;
        if (op === '=~' || op === '!~') return { op: 'regex', l, r: rvalue(), neg: op === '!~' };
        return { op: 'cmp', cmp: op, l, r: rvalue() };
      }
    }
    if (word('in')) { i += 2; return { op: 'in', l, r: rvalue(), neg: false }; }
    if (word('not')) { const save = i; i += 3; if (word('in')) { i += 2; return { op: 'in', l, r: rvalue(), neg: true }; } i = save; }
    return { op: 'truthy', v: l };
  }
  function rvalue() {
    ws(); const c = s[i];
    if (c === '"' || c === "'") return { t: 'str', v: str() };
    if (c === '/') { i++; let v = ''; while (i < n && s[i] !== '/') { if (s[i] === '\\' && s[i + 1] === '/') { v += '/'; i += 2; } else if (s[i] === '\\') { v += s[i] + (s[i + 1] || ''); i += 2; } else v += s[i++]; } i++; return { t: 're', v }; }
    if (c === '[') {
      let j = i + 1; while (s[j] === ' ') j++;
      if (s[j] === '"' || s[j] === "'" || s[j] === ']' || /[-\d]/.test(s[j])) return value();
      const segs = [];
      while (s[i] === '[') { const e = s.indexOf(']', i); if (e < 0) fail('« ] » attendu'); segs.push(s.slice(i + 1, e).trim()); i = e + 1; }
      return { t: 'field', v: segs };
    }
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (m) { i += m[0].length; return { t: 'num', v: +m[0] }; }
    return { t: 'bare', v: bare() };
  }
  const out = { input: [], filter: [], output: [] };
  for (;;) {
    ws(); if (i >= n) break;
    const sec = bare();
    if (!out[sec]) fail(`section inconnue « ${sec} » (input, filter ou output attendu)`);
    expect('{'); out[sec].push(...body()); expect('}');
  }
  return out;
}
function lsJs(v) {
  if (!v) return undefined;
  switch (v.t) {
    case 'str': case 'num': case 'bool': case 'bare': return v.v;
    case 'arr': return v.v.map(lsJs);
    case 'hash': { const o = {}; v.v.forEach(([k, x]) => (o[k] = lsJs(x))); return o; }
    case 'plugin': return Object.assign({ __plugin: v.v.name }, lsSettings(v.v));
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
  if (Array.isArray(v)) { const out = []; for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]); return out; }
  return [];
}
const lsList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
function fieldSegs(ref) {
  ref = String(ref).trim();
  if (ref.startsWith('[')) { const segs = []; ref.replace(/\[([^\]]+)\]/g, (m, x) => segs.push(x.trim())); return segs; }
  return [ref];
}
const segName = x => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(x) ? x : JSON.stringify(x));
const KAFKA_META = { topic: 'topic', partition: 'partition', offset: 'offset', key: 'message_key', timestamp: 'timestamp', headers: 'headers', consumer_group: 'consumer_group' };
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
const vq = s => JSON.stringify(String(s)).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
const vraw = (s, pre) => `${pre}'${String(s).replace(/\\'/g, "\\\\'").replace(/'/g, "\\'")}'`;
function joda2strf(f) {
  let out = ''; let i = 0;
  const tok = (c, run) => {
    switch (c) {
      case 'y': case 'Y': case 'u': return run === 2 ? '%y' : '%Y';
      case 'M': return run >= 4 ? '%B' : run === 3 ? '%b' : '%m';
      case 'd': return '%d'; case 'D': return '%j';
      case 'H': case 'k': return '%H'; case 'h': case 'K': return '%I';
      case 'm': return '%M'; case 's': return '%S';
      case 'S': return run >= 9 ? '%9f' : run >= 6 ? '%6f' : '%3f';
      case 'Z': return run === 1 ? '%z' : run === 2 ? '%:z' : '%Z';
      case 'X': case 'x': return run === 1 ? '%z' : '%:z';
      case 'z': return '%Z';
      case 'a': return '%p';
      case 'E': return run >= 4 ? '%A' : '%a';
      case 'e': return '%u';
      default: return c.repeat(run);
    }
  };
  while (i < f.length) {
    const c = f[i];
    if (c === "'") { const j = f.indexOf("'", i + 1); const lit = j < 0 ? f.slice(i + 1) : f.slice(i + 1, j); out += lit === '' ? "'" : lit.replace(/%/g, '%%'); i = j < 0 ? f.length : j + 1; continue; }
    if (/[A-Za-z]/.test(c)) { let j = i; while (f[j] === c) j++; out += tok(c, j - i); i = j; continue; }
    out += c === '%' ? '%%' : c; i++;
  }
  return out;
}
function compName(s) { return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'etape'; }

class VrlGen {
  constructor(v) { this.v = v; this.lines = []; this.ind = 0; this.types = new Map(v.ns ? [] : [['.', 'obj']]); this.usedAbort = false; this.plugins = []; this.todo = false; this.depth = 0; }
  root() { return this.types.get('.') === 'obj' ? '.' : 'object!(.)'; }
  mergeRoot(x) { this.emit(`. = merge(${this.root()}, ${x})`); this.treset(); this.types.set('.', 'obj'); }
  emit(s) { this.lines.push('  '.repeat(this.ind) + s); }
  comment(s) { this.emit('# ' + s); }
  open(s) { this.emit(s + ' {'); this.ind++; }
  close(s) { this.ind--; this.emit(s || '}'); }
  code() { return this.lines.join('\n').trim() + '\n'; }
  hasCode() { return this.lines.some(l => l.trim() && !l.trim().startsWith('#')); }
  path(ref) { return vPathOf(fieldSegs(ref), this.v.ns); }
  tget(p) { return this.types.get(p) || 'any'; }
  tset(p, t) { for (const k of [...this.types.keys()]) if (k !== '.' && (k === p || k.startsWith(p + '.'))) this.types.delete(k); if (t && t !== 'any') this.types.set(p, t); }
  treset() { const r = this.types.get('.'); this.types.clear(); if (r) this.types.set('.', r); }
  asStr(p) { const t = this.tget(p); if (t === 'str') return p; if (t === 'null') return '""'; if (t === 'arr') return `(join(${p}, ",") ?? "")`; return `(to_string(${p}) ?? "")`; }
  sprintf(s) {
    s = String(s);
    const parts = []; let last = 0; const re = /%\{([^}]+)\}/g; let m; let dyn = false;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(vq(s.slice(last, m.index)));
      const ref = m[1]; dyn = true;
      if (ref.startsWith('+')) parts.push(`(format_timestamp(timestamp(."@timestamp") ?? parse_timestamp(."@timestamp", "%+") ?? now(), format: ${vq(joda2strf(ref.slice(1)))}) ?? "")`);
      else parts.push(this.asStr(this.path(ref)));
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(vq(s.slice(last)));
    if (!parts.length) return '""';
    return parts.join(' + ');
  }
  sprintfValue(v) { return Array.isArray(v) ? `[${v.map(x => this.sprintf(x)).join(', ')}]` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : this.sprintf(v); }
  assign(p, expr, t) { this.emit(`${p} = ${expr}`); this.tset(p, t || 'any'); }
  addTags(tags) { if (!tags.length) return; this.emit(`.tags = compact(flatten([.tags, ${tags.map(t => this.sprintf(t)).join(', ')}]))`); this.tset('.tags', 'arr'); }
  removeTags(tags) {
    const src = this.tget('.tags') === 'arr' ? '.tags' : '(array(.tags) ?? [])';
    this.emit(`.tags = filter(${src}) -> |_index, tag| { !includes([${tags.map(vq).join(', ')}], tag) }`); this.tset('.tags', 'arr');
  }
  delField(f) { const p = this.path(f); this.emit(`del(${p})`); this.tset(p, 'null'); }
  common(s) {
    for (const [k, v] of lsPairs(s.add_field)) {
      if (/%\{/.test(k)) { this.v.note('warn', 'Nom de champ dynamique', `add_field « ${k} » : un nom calculé n’est pas pris en charge, champ ignoré.`); continue; }
      this.assign(this.path(k), this.sprintfValue(v), typeof v === 'string' ? 'str' : 'any');
    }
    lsList(s.remove_field).forEach(f => this.delField(f));
    if (s.add_tag) this.addTags(lsList(s.add_tag));
    if (s.remove_tag) this.removeTags(lsList(s.remove_tag));
  }
  failTags(tags) { if (tags.length) this.addTags(tags); }
  ok() { this.v.stats.ok++; }
  approx(title, detail) { this.v.stats.approx++; this.v.note('warn', title, detail); }
  ko(p, detail, code) {
    this.v.stats.ko++; this.todo = true;
    this.v.note('err', `Filtre ${p.name} non traduit (ligne ${p.line})`, detail, code);
    this.comment(`À TRADUIRE : filtre ${p.name}, ligne ${p.line} du pipeline Logstash`);
    if (code) code.split('\n').forEach(l => this.comment('  ' + l));
  }
  /* ----- structure ----- */
  stmt(st) { if (st.k === 'if') this.ifChain(st.branches); else this.plugin(st); }
  ifChain(branches) {
    const saved = new Map(this.types); const results = [];
    this.depth++;
    branches.forEach((b, idx) => {
      const head = b.cond ? `${idx === 0 ? 'if' : '} else if'} ${this.cond(b.cond)} {` : '} else {';
      if (idx > 0) this.ind--;
      this.emit(head); this.ind++;
      this.types = new Map(saved);
      const before = this.lines.length;
      b.body.forEach(x => this.stmt(x));
      if (!this.lines.slice(before).some(l => l.trim() && !l.trim().startsWith('#'))) this.emit('noop = true');
      results.push(this.types);
    });
    this.ind--; this.emit('}');
    this.depth--;
    if (!branches.some(b => !b.cond)) results.push(saved);
    const merged = new Map();
    const keys = new Set(results.flatMap(m => [...m.keys()]));
    for (const k of keys) { const vals = results.map(m => m.get(k) || 'any'); if (vals.every(x => x === vals[0]) && vals[0] !== 'any') merged.set(k, vals[0]); }
    this.types = merged;
  }
  rv(x) {
    if (x.t === 'field') return vPathOf(x.v, this.v.ns);
    if (x.t === 'str') return vq(x.v);
    if (x.t === 'num') return String(x.v);
    if (x.t === 'arr') return `[${x.v.map(i => (i.t === 'num' ? String(i.v) : vq(lsJs(i)))).join(', ')}]`;
    if (x.t === 'bare') return x.v === 'true' || x.v === 'false' || x.v === 'nil' ? (x.v === 'nil' ? 'null' : x.v) : vq(x.v);
    if (x.t === 're') return vraw(x.v, 'r');
    return 'null';
  }
  numOf(x) { if (x.t !== 'field') return this.rv(x); const p = this.rv(x); const t = this.tget(p); return t === 'null' ? '0.0' : `(to_float(${p}) ?? 0.0)`; }
  cw(c) { const s = this.cond(c); return c.op === 'or' || c.op === 'xor' ? `(${s})` : s; }
  cond(c) {
    switch (c.op) {
      case 'and': return `${this.cw(c.l)} && ${this.cw(c.r)}`;
      case 'or': return `${this.cond(c.l)} || ${this.cond(c.r)}`;
      case 'xor': return `(${this.cond(c.l)}) != (${this.cond(c.r)})`;
      case 'nand': return `!(${this.cond(c.l)} && ${this.cond(c.r)})`;
      case 'not': return `!(${this.cond(c.e)})`;
      case 'truthy': { if (c.v.t !== 'field') return this.rv(c.v); const p = this.rv(c.v); return `(${p} != null && ${p} != false)`; }
      case 'cmp': {
        if (c.cmp === '==' || c.cmp === '!=') return `${this.rv(c.l)} ${c.cmp} ${this.rv(c.r)}`;
        const numeric = c.l.t === 'num' || c.r.t === 'num';
        if (numeric) return `${this.numOf(c.l)} ${c.cmp} ${this.numOf(c.r)}`;
        const st = x => (x.t === 'field' ? this.asStr(this.rv(x)) : this.rv(x));
        return `${st(c.l)} ${c.cmp} ${st(c.r)}`;
      }
      case 'regex': {
        const re = c.r.t === 're' ? c.r.v : String(c.r.v);
        if (/\(\?<?[=!]/.test(re)) this.v.note('warn', 'Assertion regex', `L’expression /${re}/ utilise une assertion (lookahead/lookbehind) non prise en charge par le moteur regex de Vector.`);
        const p = this.rv(c.l); const t = this.tget(p);
        const m = t === 'str' ? `match(${p}, ${vraw(re, 'r')})` : t === 'null' ? 'false' : `(match(${p}, ${vraw(re, 'r')}) ?? false)`;
        return c.neg ? `!${m}` : m;
      }
      case 'in': {
        const l = this.rv(c.l); let e;
        if (c.r.t === 'arr') e = `includes(${this.rv(c.r)}, ${l})`;
        else if (c.r.t === 'field') {
          const p = this.rv(c.r); const t = this.tget(p);
          if (t === 'arr') e = `includes(${p}, ${l})`;
          else if (t === 'str') e = `contains(${p}, ${c.l.t === 'field' ? this.asStr(l) : l})`;
          else e = `(includes(array(${p}) ?? [], ${l}) || contains(string(${p}) ?? "", ${c.l.t === 'field' ? this.asStr(l) : l}))`;
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
    if (!fn) return this.ko(p, KO_HINTS[p.name] || `Le filtre « ${p.name} » n’a pas d’équivalent automatique.`, p.name === 'ruby' ? String(s.code || '') : '');
    fn.call(this, s, p);
  }
  /* ----- filtres ----- */
  f_grok(s, p) {
    const custom = Object.assign({}, s.pattern_definitions || {});
    if (s.patterns_dir) this.v.note('warn', 'patterns_dir', 'Les motifs grok personnalisés stockés dans des fichiers doivent être recopiés dans pattern_definitions pour être intégrés au programme VRL.');
    const failTags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_grokparsefailure'];
    let matches = isObj(s.match) ? Object.entries(s.match) : lsPairs(s.match);
    if (!matches.length) return this.ko(p, 'grok sans option match.');
    for (const [field, pats0] of matches) {
      const conv = []; const moves = [];
      const pats = lsList(pats0).map(pat => {
        let x = String(pat);
        for (const [name, def] of Object.entries(custom)) x = x.replace(new RegExp(`%\\{${name}(?::([^:}]+))?(?::(int|float))?\\}`, 'g'), (m, f) => (f ? `(?<${f}>${def})` : `(?:${def})`));
        x = x.replace(/%\{(\w+):([^:}]+):(int|float)\}/g, (m, pn, f, t) => { conv.push([f, t]); return `%{${pn}:${f}}`; });
        x = x.replace(/%\{(\w+):(\[[^}]+\])\}/g, (m, pn, f) => { const tmp = 'ls__' + fieldSegs(f).map(z => z.replace(/\W/g, '_')).join('__'); moves.push([tmp, f]); return `%{${pn}:${tmp}}`; });
        return x;
      });
      const src = this.path(field);
      if (pats.length === 1) { this.emit(`parsed, err = parse_grok(${src}, ${vraw(pats[0], 's')})`); this.open('if err == null'); this.mergeRoot('parsed'); }
      else { this.emit(`parsed = ${pats.map(x => `parse_grok(${src}, ${vraw(x, 's')})`).join(' ?? ')} ?? null`); this.open('if parsed != null'); this.mergeRoot('object!(parsed)'); }
      for (const [tmp, f] of moves) this.assign(this.path(f), `del(.${tmp})`);
      for (const [f, t] of conv) { const fp = this.path(f); this.assign(fp, `${t === 'int' ? 'to_int' : 'to_float'}(${fp}) ?? ${fp}`); }
      if (s.target) this.v.note('info', 'grok target', 'Les captures sont fusionnées à la racine ; déplacez-les si vous utilisiez target.');
      this.common(s);
      if (failTags.length) { this.close('} else {'); this.ind++; this.failTags(failTags); }
      this.close();
    }
    if (moves_note(matches)) this.v.note('info', 'Captures grok imbriquées', 'Les noms [a][b] sont capturés sous un nom temporaire puis déplacés, car parse_grok produit des clés plates.');
    this.ok();
  }
  f_date(s, p) {
    const m = lsList(s.match);
    if (m.length < 2) return this.ko(p, 'date sans option match complète.');
    const src = this.path(m[0]); const tgt = this.path(s.target || '@timestamp');
    const tz = s.timezone ? `, timezone: ${vq(s.timezone)}` : '';
    const lines = [];
    for (const f of m.slice(1)) {
      if (f === 'ISO8601') ['%+', '%Y-%m-%dT%H:%M:%S%.f', '%Y-%m-%d %H:%M:%S%.f'].forEach(x => lines.push(`ts = parse_timestamp(${src}, ${vq(x)}${tz}) ?? null`));
      else if (f === 'UNIX' || f === 'UNIX_MS') { lines.push({ unix: f }); }
      else if (f === 'TAI64N') { this.approx('Format TAI64N', 'Non pris en charge par parse_timestamp : format ignoré.'); }
      else {
        const sf = joda2strf(f);
        if (!/%[Yy]/.test(sf)) this.v.note('warn', 'Date sans année', `Le format « ${f} » n’a pas d’année : Logstash la devine, parse_timestamp échouera. Ajoutez l’année (par ex. via format_timestamp(now(), "%Y")) avant l’analyse.`);
        lines.push(`ts = parse_timestamp(${src}, ${vq(sf)}${tz}) ?? null`);
      }
    }
    this.emit('ts = null');
    lines.forEach(l => {
      this.open('if ts == null');
      if (typeof l === 'string') this.emit(l);
      else { this.emit(`n = to_int(${src}) ?? null`); this.open('if n != null'); this.emit(l.unix === 'UNIX' ? 'ts = from_unix_timestamp!(n)' : 'ts = from_unix_timestamp!(n, unit: "milliseconds")'); this.close(); }
      this.close();
    });
    this.open('if ts != null'); this.assign(tgt, 'ts'); this.common(s);
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_dateparsefailure'];
    if (tags.length) { this.close('} else {'); this.ind++; this.failTags(tags); }
    this.close();
    if (m.slice(1).some(f => f === 'UNIX')) this.v.note('info', 'Date UNIX', 'Les secondes décimales (1700000000.123) ne sont pas reconnues par to_int : utilisez to_float puis from_unix_timestamp en millisecondes si besoin.');
    this.ok();
  }
  f_mutate(s, p) {
    const order = ['coerce', 'rename', 'update', 'replace', 'convert', 'gsub', 'uppercase', 'capitalize', 'lowercase', 'strip', 'remove', 'split', 'join', 'merge', 'copy'];
    const unary = (fields, fn) => lsList(fields).forEach(f => { const x = this.path(f); const t = this.tget(x); if (t === 'null') return; this.assign(x, t === 'str' ? `${fn}(${x})` : `${fn}(${x}) ?? ${x}`, t === 'str' ? 'str' : 'any'); });
    for (const op of order) {
      const v = s[op]; if (v === undefined) continue;
      switch (op) {
        case 'coerce': lsPairs(v).forEach(([f, d]) => { const x = this.path(f); this.open(`if ${x} == null`); this.assign(x, this.sprintf(d), 'str'); this.close(); this.tset(x, 'any'); }); break;
        case 'rename': lsPairs(v).forEach(([a, b]) => { const pa = this.path(a), pb = this.path(b); this.open(`if exists(${pa})`); this.assign(pb, `del(${pa})`); this.close(); this.tset(pa, 'any'); this.tset(pb, 'any'); }); break;
        case 'update': lsPairs(v).forEach(([f, val]) => { const x = this.path(f); this.open(`if exists(${x})`); this.assign(x, this.sprintfValue(val)); this.close(); this.tset(x, 'any'); }); break;
        case 'replace': lsPairs(v).forEach(([f, val]) => this.assign(this.path(f), this.sprintfValue(val), 'str')); break;
        case 'convert': lsPairs(v).forEach(([f, ty]) => {
          const x = this.path(f); if (this.tget(x) === 'null') return;
          const fn = { integer: 'to_int', float: 'to_float', string: 'to_string', boolean: 'to_bool', integer_eu: 'to_int', float_eu: 'to_float' }[ty];
          if (!fn) return this.v.note('warn', 'convert', `Type « ${ty} » inconnu pour ${f}.`);
          if (/_eu$/.test(ty)) this.v.note('warn', `convert ${ty}`, 'Le format numérique européen (virgule décimale) n’est pas géré : remplacez la virgule avant la conversion.');
          if (fn === 'to_string' && this.tget(x) === 'str') return;
          this.assign(x, `${fn}(${x}) ?? ${x}`);
        }); break;
        case 'gsub': { const a = lsList(v); for (let i = 0; i + 2 < a.length; i += 3) { const x = this.path(a[i]); const t = this.tget(x); if (t === 'null') continue; const rep = String(a[i + 2]).replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$${$1}'); this.assign(x, t === 'str' ? `replace(${x}, ${vraw(a[i + 1], 'r')}, ${vq(rep)})` : `replace(${x}, ${vraw(a[i + 1], 'r')}, ${vq(rep)}) ?? ${x}`, t === 'str' ? 'str' : 'any'); } break; }
        case 'uppercase': unary(v, 'upcase'); break;
        case 'lowercase': unary(v, 'downcase'); break;
        case 'strip': unary(v, 'strip_whitespace'); break;
        case 'capitalize': lsList(v).forEach(f => { const x = this.path(f); const t = this.tget(x); if (t === 'null') return; this.assign(x, t === 'str' ? `upcase(slice(${x}, 0, 1) ?? "") + downcase(slice(${x}, 1) ?? "")` : `(upcase(slice(${x}, 0, 1) ?? "") ?? "") + (downcase(slice(${x}, 1) ?? "") ?? "")`, 'str'); }); break;
        case 'remove': lsList(v).forEach(f => this.delField(f)); break;
        case 'split': lsPairs(v).forEach(([f, sep]) => { const x = this.path(f); const t = this.tget(x); if (t === 'null') return; this.assign(x, t === 'str' ? `split(${x}, ${vq(sep)})` : `split(${x}, ${vq(sep)}) ?? ${x}`, t === 'str' ? 'arr' : 'any'); }); break;
        case 'join': lsPairs(v).forEach(([f, sep]) => { const x = this.path(f); this.assign(x, `join(${x}, ${vq(sep)}) ?? ${x}`); }); break;
        case 'merge': lsPairs(v).forEach(([dst, src]) => { const d = this.path(dst), sp = this.path(src); this.assign(d, `compact(flatten([${d}, ${sp}]))`, 'arr'); }); break;
        case 'copy': lsPairs(v).forEach(([src, dst]) => this.assign(this.path(dst), this.path(src), this.tget(this.path(src)))); break;
      }
    }
    this.common(s);
    this.ok();
  }
  f_json(s) {
    const src = this.path(s.source || 'message');
    this.emit(`parsed, err = parse_json(${src})`);
    this.open('if err == null');
    if (s.target) this.assign(this.path(s.target), 'parsed');
    else { this.open('if is_object(parsed)'); this.mergeRoot('object!(parsed)'); this.close(); this.treset(); }
    this.common(s);
    const tags = s.skip_on_invalid_json ? [] : s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_jsonparsefailure'];
    if (tags.length) { this.close('} else {'); this.ind++; this.failTags(tags); }
    this.close(); this.ok();
  }
  f_kv(s) {
    const src = this.path(s.source || 'message');
    const vd = String(s.value_split !== undefined ? s.value_split : '='); const fd = String(s.field_split !== undefined ? s.field_split : ' ');
    if (fd.length > 1 || vd.length > 1) this.v.note('warn', 'kv : séparateurs multiples', `Logstash traite « ${fd.length > 1 ? fd : vd} » comme un ensemble de caractères ; seul le premier est utilisé par parse_key_value.`);
    if (s.field_split_pattern || s.value_split_pattern) this.v.note('warn', 'kv : séparateurs regex', 'field_split_pattern / value_split_pattern ne sont pas repris.');
    this.emit(`kv, err = parse_key_value(${src}, key_value_delimiter: ${vq(vd[0] || '=')}, field_delimiter: ${vq(fd[0] || ' ')})`);
    this.open('if err == null');
    if (s.include_keys) this.emit(`kv = filter(kv) -> |key, _value| { includes([${lsList(s.include_keys).map(vq).join(', ')}], key) }`);
    if (s.exclude_keys) this.emit(`kv = filter(kv) -> |key, _value| { !includes([${lsList(s.exclude_keys).map(vq).join(', ')}], key) }`);
    if (s.prefix) this.emit(`kv = map_keys(kv) -> |key| { ${vq(s.prefix)} + key }`);
    if (s.target) this.assign(this.path(s.target), 'kv');
    else this.mergeRoot('kv');
    this.common(s);
    this.close(); this.ok();
  }
  f_dissect(s, p) {
    const maps = lsPairs(s.mapping);
    if (!maps.length) return this.ko(p, 'dissect sans mapping.');
    for (const [field, pattern] of maps) {
      const d = dissectRegex(pattern, null, true);
      d.warnings.forEach(w => this.approx('dissect', w));
      this.emit(`parsed, err = parse_regex(${this.path(field)}, ${vraw(d.regex, 'r')})`);
      this.open('if err == null');
      d.fields.forEach(f => this.assign(this.path(f.field), `parsed.${f.group}`));
      for (const [f, t] of lsPairs(s.convert_datatype)) { const x = this.path(f); this.assign(x, `${t === 'int' ? 'to_int' : 'to_float'}(${x}) ?? ${x}`); }
      this.common(s);
      const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_dissectfailure'];
      if (tags.length) { this.close('} else {'); this.ind++; this.failTags(tags); }
      this.close();
    }
    this.v.note('info', 'dissect → parse_regex', 'Le motif dissect est converti en expression régulière ancrée avec groupes nommés.');
    this.ok();
  }
  f_drop(s) {
    if (s.percentage !== undefined) this.approx('drop percentage', 'L’échantillonnage aléatoire n’est pas repris : utilisez le transform sample de Vector.');
    this.emit('abort'); this.usedAbort = true; this.ok();
  }
  f_useragent(s) {
    const src = this.path(s.source || 'message'); const tgt = this.path(s.target || 'user_agent');
    if (this.tget(src) === 'str') this.assign(tgt, `parse_user_agent(${src})`);
    else { this.emit(`ua, err = parse_user_agent(${src})`); this.open('if err == null'); this.assign(tgt, 'ua'); this.common(s); this.close(); }
    this.v.note('warn', 'useragent → parse_user_agent', 'La structure produite diffère (browser.family, os.family, device.category) : adaptez les consommateurs ou remappez les champs.');
    this.v.stats.approx++;
  }
  f_geoip(s) {
    const src = this.path(s.source || 'message'); const tgt = this.path(s.target || 'geoip');
    this.v.enrich.geoip = { type: 'geoip', path: s.database || '/etc/vector/GeoLite2-City.mmdb' };
    this.emit(`geo, err = get_enrichment_table_record("geoip", { "ip": ${src} })`);
    this.open('if err == null'); this.assign(tgt, 'geo'); this.common(s);
    const tags = s.tag_on_failure !== undefined ? lsList(s.tag_on_failure) : ['_geoip_lookup_failure'];
    if (tags.length) { this.close('} else {'); this.ind++; this.failTags(tags); }
    this.close();
    this.v.note('info', 'geoip → table d’enrichissement', 'Une table geoip (base MaxMind .mmdb) est déclarée dans enrichment_tables : montez le fichier dans le conteneur Vector. Les noms de champs suivent le format MaxMind (city_name, country_code…).');
    this.ok();
  }
  f_translate(s, p) {
    const src = this.path(s.source || s.field || 'message'); const tgt = this.path(s.target || s.destination || 'translation');
    if (s.regex) this.approx('translate regex', 'Les clés regex ne sont pas reprises : correspondance exacte uniquement.');
    this.emit(`key = ${this.asStr(src)}`);
    if (s.dictionary_path) {
      const name = compName('dict_' + String(s.dictionary_path).split('/').pop().replace(/\.\w+$/, ''));
      const csvPath = String(s.dictionary_path).replace(/\.(ya?ml|json)$/i, '.csv');
      this.v.enrich[name] = { type: 'file', file: { path: csvPath, encoding: { type: 'csv', include_headers: true } }, schema: { key: 'string', value: 'string' } };
      this.emit(`row, err = get_enrichment_table_record(${vq(name)}, { "key": key })`);
      this.open('if err == null'); this.assign(tgt, 'row.value');
      if (s.fallback !== undefined) { this.close('} else {'); this.ind++; this.assign(tgt, this.sprintf(s.fallback), 'str'); }
      this.close(); this.tset(tgt, 'any');
      this.v.note('warn', 'Dictionnaire externe', `${s.dictionary_path} doit être converti en ${csvPath}, un CSV avec l’en-tête key,value, pour la table d’enrichissement « ${name} ».`);
    } else {
      const entries = lsPairs(s.dictionary);
      if (!entries.length) return this.ko(p, 'translate sans dictionnaire.');
      entries.forEach(([k, v], i) => { this.emit(`${i === 0 ? 'if' : '} else if'} key == ${vq(k)} {`); this.ind++; this.emit(`${tgt} = ${this.sprintfValue(v)}`); this.ind--; });
      if (s.fallback !== undefined) { this.emit('} else {'); this.ind++; this.emit(`${tgt} = ${this.sprintf(s.fallback)}`); this.ind--; }
      this.emit('}');
      this.tset(tgt, s.fallback !== undefined ? 'str' : 'any');
      if (entries.length > 50) this.v.note('opt', 'Grand dictionnaire', 'Au-delà de quelques dizaines d’entrées, une table d’enrichissement CSV est plus lisible et plus rapide qu’une cascade de if.');
    }
    this.common(s); this.ok();
  }
  f_fingerprint(s) {
    const srcs = lsList(s.source || 'message'); const tgt = this.path(s.target || 'fingerprint');
    const method = String(s.method || 'SHA1').toUpperCase();
    const val = srcs.length > 1 || s.concatenate_sources ? srcs.map(f => this.asStr(this.path(f))).join(' + "|" + ') : this.asStr(this.path(srcs[0]));
    if (srcs.length > 1) this.approx('fingerprint : concaténation', 'Logstash sérialise les sources au format |clé|valeur| ; ici les valeurs sont jointes par « | ». Les empreintes diffèrent.');
    let e;
    if (s.key) {
      e = `encode_base16(hmac(${val}, get_env_var!("FINGERPRINT_KEY"), algorithm: ${vq(method.replace(/^SHA(\d)/, 'SHA-$1').replace('SHA-1', 'SHA1'))}))`;
      this.v.note('opt', 'Clé HMAC hors configuration', 'La clé de fingerprint est lue dans la variable d’environnement FINGERPRINT_KEY plutôt que stockée en clair dans la configuration.');
      this.v.env.add('FINGERPRINT_KEY');
    } else e = { SHA1: `sha1(${val})`, SHA256: `sha2(${val}, variant: "SHA-256")`, SHA384: `sha2(${val}, variant: "SHA-384")`, SHA512: `sha2(${val}, variant: "SHA-512")`, MD5: `md5(${val})`, UUID: 'uuid_v4()', MURMUR3: `to_string(seahash(${val}))` }[method];
    if (method === 'MURMUR3') this.approx('fingerprint MURMUR3', 'MurmurHash3 n’existe pas en VRL : seahash le remplace, les valeurs diffèrent.');
    this.assign(tgt, e || `sha1(${val})`, 'str');
    this.common(s); this.ok();
  }
  f_uuid(s) {
    const tgt = this.path(s.target || 'uuid');
    if (s.overwrite) this.assign(tgt, 'uuid_v4()', 'str'); else { this.open(`if !exists(${tgt})`); this.assign(tgt, 'uuid_v4()'); this.close(); this.tset(tgt, 'any'); }
    this.common(s); this.ok();
  }
  f_urldecode(s) {
    const x = this.path(s.field || 'message'); const t = this.tget(x);
    if (s.all_fields) this.approx('urldecode all_fields', 'Seul le champ indiqué est décodé.');
    if (t !== 'null') this.assign(x, t === 'str' ? `decode_percent(${x})` : `decode_percent(${x}) ?? ${x}`, t === 'str' ? 'str' : 'any');
    this.common(s); this.ok();
  }
  f_split(s) {
    const x = this.path(s.field || 'message'); const term = s.terminator !== undefined ? s.terminator : '\n';
    if (this.tget(x) === 'str') this.assign(x, `split(${x}, ${vq(term)})`, 'arr');
    else { this.open(`if is_string(${x})`); this.assign(x, `split(string!(${x}), ${vq(term)})`); this.close(); this.tset(x, 'any'); }
    if (s.target) this.approx('split target', 'L’option target n’est pas reprise : chaque élément remplace le champ d’origine.');
    this.common(s);
    this.emit(`. = unnest(${x}) ?? [.]`);
    this.treset(); this.types.delete('.'); this.splitDone = true;
    if (this.depth > 0) this.v.note('warn', 'split dans une condition', 'Après unnest, la racine de l’événement devient un tableau : placez les filtres suivants dans une étape séparée.');
    this.v.note('info', 'split → unnest', 'unnest() crée un événement par élément du tableau, comme le filtre split.');
    this.ok();
  }
  f_truncate(s) {
    const n = s.length_bytes || 1000;
    lsList(s.fields).forEach(f => { const x = this.path(f); if (this.tget(x) !== 'null') this.assign(x, this.tget(x) === 'str' ? `truncate(${x}, ${n})` : `truncate(${x}, ${n}) ?? ${x}`); });
    this.v.note('info', 'truncate', 'Vector tronque en caractères, Logstash en octets : léger écart possible sur les textes non ASCII.');
    this.common(s); this.ok();
  }
  f_csv(s) {
    const src = this.path(s.source || 'message');
    this.emit(`row, err = parse_csv(${src}, delimiter: ${vq(s.separator || ',')})`);
    this.open('if err == null');
    const cols = lsList(s.columns);
    if (cols.length) cols.forEach((c, i) => this.assign(this.path(c), `row[${i}]`));
    else { this.assign(s.target ? this.path(s.target) : '.csv', 'row'); this.v.note('warn', 'csv sans columns', 'Logstash nomme les colonnes column1, column2… : ici la ligne est stockée telle quelle dans un tableau.'); }
    for (const [f, t] of lsPairs(s.convert)) { const x = this.path(f); this.assign(x, `${{ integer: 'to_int', float: 'to_float', boolean: 'to_bool' }[t] || 'to_string'}(${x}) ?? ${x}`); }
    this.common(s); this.close(); this.ok();
  }
  f_cidr(s) {
    const addrs = lsList(s.address).map(a => { const m = /^%\{([^}]+)\}$/.exec(String(a)); return m ? this.path(m[1]) : vq(a); });
    const nets = lsList(s.network);
    const c = addrs.flatMap(a => nets.map(nw => `(ip_cidr_contains(${vq(nw)}, ${a}) ?? false)`)).join(' || ');
    this.open(`if ${c}`); this.common(s); if (!(s.add_field || s.add_tag || s.remove_field || s.remove_tag)) this.emit('noop = true'); this.close(); this.ok();
  }
  f_xml(s) {
    const src = this.path(s.source || 'message');
    this.emit(`parsed, err = parse_xml(${src})`);
    this.open('if err == null'); this.assign(this.path(s.target || 'xml'), 'parsed'); this.common(s);
    this.close('} else {'); this.ind++; this.failTags(['_xmlparsefailure']); this.close(); this.ok();
    if (s.xpath) this.approx('xml xpath', 'Les expressions XPath ne sont pas reprises : naviguez dans l’objet parsé.');
  }
}
function moves_note(matches) { return matches.some(([, pats]) => lsList(pats).some(x => /%\{\w+:\[/.test(String(x)))); }
const KO_HINTS = {
  ruby: 'Le code Ruby doit être réécrit en VRL (fonctions intégrées, closures for_each / map_values). Le code d’origine est recopié en commentaire.',
  aggregate: 'L’agrégation d’événements corrélés se fait avec le transform reduce de Vector (group_by, merge_strategies, ends_when).',
  clone: 'Pour dupliquer un flux, branchez plusieurs transforms sur la même entrée dans la topologie Vector.',
  throttle: 'Utilisez le transform throttle de Vector (threshold, window_secs, key_field).',
  metrics: 'Utilisez le transform log_to_metric de Vector.',
  elasticsearch: 'Les requêtes vers Elasticsearch pendant le traitement n’ont pas d’équivalent ; préférez une table d’enrichissement.',
  jdbc_streaming: 'Préférez une table d’enrichissement (fichier CSV mis à jour périodiquement) aux requêtes SQL par événement.',
  jdbc_static: 'Exportez la table de référence en CSV et déclarez-la comme table d’enrichissement.',
  http: 'Les appels HTTP par événement n’ont pas d’équivalent dans un transform Vector.',
  prune: 'Utilisez filter/for_each sur l’objet racine en VRL pour ne garder que certaines clés.',
  de_dot: 'Parcourez les clés avec map_keys(., recursive: true) pour remplacer les points.',
  syslog_pri: 'Décodez la priorité avec parse_syslog ou un calcul facility = pri / 8, severity = pri % 8.',
  memcached: 'Pas d’équivalent : préférez une table d’enrichissement.',
  sleep: 'Pas d’équivalent : inutile dans Vector.'
};

/* ---------- Sources, sinks, topologie ---------- */
function kafkaSecurity(v, s, cfg, obj) {
  const k = cfg.kafka;
  const proto = String(k.security_protocol || s.security_protocol || '').toUpperCase();
  if (/SASL/.test(proto)) {
    const mech = k.sasl_mechanism || s.sasl_mechanism || 'PLAIN';
    obj.sasl = { enabled: true, mechanism: mech, username: k.username || '${KAFKA_USERNAME}', password: k.password || '${KAFKA_PASSWORD}' };
    ['KAFKA_USERNAME', 'KAFKA_PASSWORD'].forEach(e => v.env.add(e));
    if (s.sasl_jaas_config) v.note('opt', 'Secrets Kafka hors configuration', 'Les identifiants présents dans sasl_jaas_config ne sont pas recopiés : ils sont lus depuis des variables d’environnement (${KAFKA_USERNAME}, ${KAFKA_PASSWORD}).');
  }
  if (/SSL/.test(proto)) {
    obj.tls = { enabled: true };
    const ca = k.ca_file || (s.ssl_truststore_location ? '/etc/vector/certs/ca.pem' : '');
    if (ca) obj.tls.ca_file = ca;
    if (s.ssl_truststore_location) v.note('warn', 'Truststore Java', `${s.ssl_truststore_location} (JKS) doit être converti en PEM pour Vector : keytool -exportcert -rfc.`);
  }
}
function codecOf(c) { if (!c) return null; if (typeof c === 'string') return c; if (isObj(c)) return c.__plugin; return null; }
function buildSource(v, st, cfg, idx, used) {
  const s = lsSettings(st); const name = uniq(used, compName(s.id || (st.name === 'kafka' ? 'kafka_in' : st.name + '_in')));
  let src;
  if (st.name === 'kafka') {
    src = { type: 'kafka' };
    src.bootstrap_servers = cfg.kafka.bootstrap_servers || s.bootstrap_servers || 'localhost:9092';
    let group = cfg.kafka.consumer_group || s.group_id || 'logstash';
    if (cfg.vector.shadow_mode) group += '-shadow';
    src.group_id = group;
    const topics = cfg.kafka.input_topics && cfg.kafka.input_topics.length ? cfg.kafka.input_topics : s.topics_pattern ? ['^' + String(s.topics_pattern).replace(/^\^/, '')] : lsList(s.topics || 'logstash');
    src.topics = topics;
    if (s.auto_offset_reset) src.auto_offset_reset = s.auto_offset_reset;
    if (s.session_timeout_ms) src.session_timeout_ms = +s.session_timeout_ms;
    const lr = {};
    if (s.client_id) lr['client.id'] = String(s.client_id);
    if (s.max_poll_records) v.note('info', 'max_poll_records', 'Pas d’équivalent direct : le débit se règle via fetch_wait_max_ms et librdkafka_options.');
    if (Object.keys(lr).length) src.librdkafka_options = lr;
    kafkaSecurity(v, s, cfg, src);
    const codec = codecOf(s.codec) || 'plain';
    src.decoding = { codec: /json/.test(codec) ? 'json' : 'bytes' };
    if (v.ns) src.log_namespace = true;
    else Object.assign(src, { topic_key: '_kafka_topic', partition_key: '_kafka_partition', offset_key: '_kafka_offset', key_field: '_kafka_message_key', headers_key: '_kafka_headers' });
    if (s.consumer_threads && +s.consumer_threads > 1) v.note('info', 'consumer_threads', `Logstash lisait avec ${s.consumer_threads} threads : avec Vector, le parallélisme vient du nombre de réplicas du même groupe (au plus une par partition).`);
    if (s.decorate_events) v.note('info', 'decorate_events', v.ns ? 'Les métadonnées Kafka sont disponibles sous %kafka.topic, %kafka.partition, %kafka.offset, sans polluer l’événement.' : 'Les métadonnées Kafka sont copiées dans des champs _kafka_* supprimés avant l’écriture.');
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
    if (!map[st.name]) { v.stats.ko++; v.note('err', `Entrée ${st.name} non traduite (ligne ${st.line})`, 'Aucune source Vector équivalente n’a été choisie automatiquement.'); return null; }
    src = map[st.name](); src.__label = st.name; src.__detail = src.type; src.__plain = !/json/.test(codecOf(s.codec) || '');
    if (/json/.test(codecOf(s.codec) || '')) src.decoding = { codec: 'json' };
    v.stats.ok++;
    v.note('info', `Entrée ${st.name}`, `Traduite en source ${src.type}. Le sujet de la migration étant Kafka, vérifiez les options réseau.`);
  }
  return { name, src, s };
}
function uniq(used, base) { let n = base, i = 2; while (used.has(n)) n = `${base}_${i++}`; used.add(n); return n; }
function buildSink(v, st, cfg, used, singleKafka) {
  const s = lsSettings(st);
  const tplOf = t => String(t).replace(/%\{([^}]+)\}/g, (m, ref) => {
    if (ref.startsWith('+')) return joda2strf(ref.slice(1));
    const p = vPathOf(fieldSegs(ref), v.ns);
    if (p.startsWith('%')) v.note('warn', 'Métadonnée dans un modèle', `« ${ref} » : copiez la valeur dans un champ de l’événement pour l’utiliser dans le nom du topic.`);
    return `{{ ${p.replace(/^\./, '')} }}`;
  });
  let sink;
  if (st.name === 'kafka') {
    const name = uniq(used, compName(s.id || 'kafka_out'));
    let topic = singleKafka && cfg.kafka.output_topic ? cfg.kafka.output_topic : tplOf(s.topic_id || 'logstash');
    if (cfg.vector.shadow_mode) topic += '-shadow';
    sink = { type: 'kafka', inputs: [], bootstrap_servers: cfg.kafka.bootstrap_servers || s.bootstrap_servers || 'localhost:9092', topic };
    if (s.message_key) { const m = /^%\{([^}]+)\}$/.exec(String(s.message_key)); if (m) sink.key_field = vPathOf(fieldSegs(m[1]), v.ns).replace(/^\./, ''); else v.note('warn', 'message_key', 'Une clé mixte (texte + champ) n’est pas reprise : Vector utilise un champ comme clé.'); }
    const codec = codecOf(s.codec);
    if (!codec) v.note('warn', 'Codec de sortie absent', 'Logstash utilise le codec plain par défaut ; Vector écrit ici en JSON, format le plus courant pour Kafka → Kafka.');
    sink.encoding = { codec: codec && /plain|line/.test(codec) ? 'text' : 'json' };
    if (s.compression_type && s.compression_type !== 'none') sink.compression = s.compression_type;
    const lr = {};
    if (s.acks !== undefined) lr.acks = String(s.acks);
    if (s.linger_ms !== undefined) lr['linger.ms'] = String(s.linger_ms);
    if (s.batch_size !== undefined) lr['batch.size'] = String(s.batch_size);
    if (Object.keys(lr).length) sink.librdkafka_options = lr;
    kafkaSecurity(v, s, cfg, sink);
    if (cfg.vector.acknowledgements) sink.acknowledgements = { enabled: true };
    sink.__label = topic; v.stats.ok++;
    return { name, sink };
  }
  const name = uniq(used, compName(s.id || st.name + '_out'));
  const others = {
    elasticsearch: () => ({ type: 'elasticsearch', inputs: [], endpoints: lsList(s.hosts || 'http://localhost:9200'), bulk: { index: tplOf(s.index || 'logstash-%{+yyyy.MM.dd}') } }),
    stdout: () => ({ type: 'console', inputs: [], encoding: { codec: 'json' } }),
    file: () => ({ type: 'file', inputs: [], path: tplOf(s.path || '/tmp/out.log'), encoding: { codec: 'json' } }),
    http: () => ({ type: 'http', inputs: [], uri: s.url || 'http://localhost', encoding: { codec: 'json' } }),
    null: () => ({ type: 'blackhole', inputs: [] })
  };
  if (!others[st.name]) { v.stats.ko++; v.note('err', `Sortie ${st.name} non traduite (ligne ${st.line})`, 'Aucun sink Vector équivalent n’a été choisi automatiquement.'); return null; }
  sink = others[st.name](); sink.__label = st.name; v.stats.ok++;
  return { name, sink };
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
function translateLogstash(src, cfg) {
  const notes = makeNotes();
  const v = { ns: cfg.vector.log_namespace !== false, stats: { ok: 0, approx: 0, ko: 0 }, enrich: {}, env: new Set(), note: (l, t, d, c) => notes.add(l, t, d, c) };
  let ast;
  try { ast = parseLogstash(src); }
  catch (e) { return { error: e.message }; }
  if (!ast.input.length && !ast.filter.length && !ast.output.length) return { empty: true };
  const used = new Set(); const sources = {}; const transforms = {}; const sinks = {};
  const graph = { nodes: [], edges: [] };
  const srcList = [];
  ast.input.forEach((st, i) => {
    if (st.k !== 'plugin') { v.note('warn', 'Condition dans input', 'Les conditions de la section input sont ignorées.'); return; }
    const r = buildSource(v, st, cfg, i, used); if (r) srcList.push(r);
  });
  if (!srcList.length) { const r = { name: uniq(used, 'kafka_in'), src: { type: 'kafka', bootstrap_servers: cfg.kafka.bootstrap_servers || 'localhost:9092', group_id: cfg.kafka.consumer_group || 'vector', topics: cfg.kafka.input_topics.length ? cfg.kafka.input_topics : ['logs'], decoding: { codec: 'json' }, __label: 'logs', __detail: 'source par défaut' }, s: {} }; if (v.ns) r.src.log_namespace = true; srcList.push(r); v.note('warn', 'Aucune entrée', 'Une source Kafka par défaut a été ajoutée.'); }
  let prev = [];
  for (const r of srcList) {
    const clean = Object.fromEntries(Object.entries(r.src).filter(([k]) => !k.startsWith('__')));
    sources[r.name] = clean;
    graph.nodes.push({ id: r.name, kind: 'source', type: r.src.type, label: r.src.__label, detail: r.src.__detail });
    // Étape d’initialisation propre à chaque source
    const g = new VrlGen(v);
    if (v.ns && r.src.__plain) { g.comment('Codec plain : le message brut devient le champ message, comme dans Logstash'); g.emit('. = { "message": . }'); }
    else if (v.ns) { g.comment('Garantit un objet à la racine (un JSON scalaire est rangé dans message)'); g.emit('. = object(.) ?? { "message": . }'); }
    if (cfg.vector.logstash_compat) {
      g.comment('Compatibilité Logstash : @timestamp et @version présents sur chaque événement');
      g.open('if !exists(."@timestamp")'); g.emit('."@timestamp" = now()'); g.close();
      g.open('if !exists(."@version")'); g.emit('."@version" = "1"'); g.close();
    }
    if (r.s.type) g.assign('.type', vq(r.s.type), 'str');
    g.common({ add_field: r.s.add_field, add_tag: r.s.tags });
    if (g.hasCode()) {
      const tn = uniq(used, `${r.name}_init`);
      transforms[tn] = { type: 'remap', inputs: [r.name], source: g.code() };
      graph.nodes.push({ id: tn, kind: 'transform', type: 'remap', label: 'Préparation', detail: 'compatibilité Logstash' });
      graph.edges.push([r.name, tn]); prev.push(tn);
    } else prev.push(r.name);
  }
  // Filtres
  let pending = [];
  ast.filter.forEach((st, idx) => {
    const g = new VrlGen(v);
    pending.forEach(l => g.lines.push(l)); pending = [];
    g.stmt(st);
    const s = st.k === 'plugin' ? lsSettings(st) : {};
    if (!g.hasCode()) { pending = g.lines.slice(); return; }
    const base = st.k === 'plugin' ? (s.id || st.name) : `condition_${idx + 1}`;
    const tn = uniq(used, compName(base));
    const t = { type: 'remap', inputs: prev.slice(), source: g.code() };
    if (g.usedAbort) t.drop_on_abort = true;
    transforms[tn] = t;
    const plugins = [...new Set(g.plugins)];
    graph.nodes.push({ id: tn, kind: 'transform', type: 'remap', label: st.k === 'plugin' ? st.name : 'si … alors', detail: st.k === 'plugin' ? (s.id || '') : plugins.join(', '), todo: g.todo, drop: g.usedAbort });
    prev.forEach(p => graph.edges.push([p, tn]));
    prev = [tn];
  });
  // Finalisation
  const fin = new VrlGen(v);
  pending.forEach(l => fin.lines.push(l));
  if (cfg.vector.logstash_compat) {
    fin.comment('Format de date identique à Logstash (millisecondes, UTC)');
    fin.open('if is_timestamp(."@timestamp")'); fin.emit('."@timestamp" = format_timestamp!(."@timestamp", format: "%Y-%m-%dT%H:%M:%S%.3fZ")'); fin.close();
  }
  if (!v.ns) { fin.comment('Retire les champs techniques ajoutés par la source Kafka'); fin.emit('del(.source_type)'); ['_kafka_topic', '_kafka_partition', '_kafka_offset', '_kafka_message_key', '_kafka_headers'].forEach(f => fin.emit(`del(.${f})`)); v.note('warn', 'Champ timestamp', 'Sans namespace de logs, Vector ajoute un champ timestamp (horodatage Kafka) qui peut écraser un champ du même nom. Activez log_namespace pour l’éviter.'); }
  if (fin.hasCode()) {
    const tn = uniq(used, 'logstash_finalize');
    transforms[tn] = { type: 'remap', inputs: prev.slice(), source: fin.code() };
    graph.nodes.push({ id: tn, kind: 'transform', type: 'remap', label: 'Finalisation', detail: 'format de sortie' });
    prev.forEach(p => graph.edges.push([p, tn])); prev = [tn];
  }
  // Sorties
  const outs = flatOutputs(ast.output, [], []);
  const kafkaOuts = outs.filter(o => o.plugin.name === 'kafka').length;
  const routes = {}; let routeName = null; const condCache = new Map();
  const condStr = conds => { const g = new VrlGen(v); return conds.map(x => (x.neg ? `!(${g.cond(x.c)})` : g.cw(x.c))).join(' && '); };
  const hasConds = outs.some(o => o.conds.length);
  if (hasConds) routeName = uniq(used, 'routage');
  let ri = 0;
  for (const o of outs) {
    const r = buildSink(v, o.plugin, cfg, used, kafkaOuts === 1);
    if (!r) continue;
    let input = prev.slice();
    if (o.conds.length) {
      const key = condStr(o.conds);
      let rn = condCache.get(key);
      if (!rn) { rn = compName(r.sink.__label || `route_${++ri}`).slice(0, 40) || `route_${++ri}`; while (routes[rn]) rn += '_b'; routes[rn] = key; condCache.set(key, rn); }
      input = [`${routeName}.${rn}`];
    }
    r.sink.inputs = input;
    const label = r.sink.__label; delete r.sink.__label;
    sinks[r.name] = r.sink;
    graph.nodes.push({ id: r.name, kind: 'sink', type: r.sink.type, label, detail: o.conds.length ? 'sous condition' : '' });
    input.forEach(i => graph.edges.push([i.split('.')[0], r.name]));
  }
  if (routeName) {
    transforms[routeName] = { type: 'route', inputs: prev.slice(), reroute_unmatched: false, route: routes };
    graph.nodes.push({ id: routeName, kind: 'transform', type: 'route', label: 'Routage', detail: `${Object.keys(routes).length} règle${Object.keys(routes).length > 1 ? 's' : ''}` });
    prev.forEach(p => graph.edges.push([p, routeName]));
    v.note('info', 'Conditions de sortie → route', 'Les if/else de la section output deviennent un transform route ; chaque branche est une condition VRL exclusive.');
  }
  if (!Object.keys(sinks).length) v.note('err', 'Aucune sortie', 'Le pipeline n’a pas de sortie traduisible.');
  // Vector interpole ${VAR} et $VAR dans tout le fichier : les $ du code VRL sont doublés
  let dollar = false;
  const esc = x => { if (x.includes('$')) { dollar = true; return x.replace(/\$/g, '$$$$'); } return x; };
  for (const t of Object.values(transforms)) {
    if (t.source) t.source = esc(t.source);
    if (t.route) for (const k of Object.keys(t.route)) t.route[k] = esc(t.route[k]);
  }
  if (dollar) v.note('info', 'Symbole $ doublé', 'Vector remplace $VAR et ${VAR} par des variables d’environnement dans tout le fichier : les $ du code VRL sont écrits $$ pour rester littéraux.');
  const config = { data_dir: '/var/lib/vector', api: { enabled: true, address: '0.0.0.0:8686' } };
  if (Object.keys(v.enrich).length) config.enrichment_tables = v.enrich;
  config.sources = sources; config.transforms = transforms; config.sinks = sinks;
  if (!Object.keys(transforms).length) delete config.transforms;
  if (cfg.vector.acknowledgements) v.note('opt', 'Accusés de réception de bout en bout', 'Les offsets Kafka ne sont validés qu’après l’écriture dans le topic de sortie : aucun message perdu en cas d’arrêt brutal.');
  if (cfg.vector.shadow_mode) v.note('info', 'Mode shadow', 'Le groupe de consommateurs et les topics de sortie sont suffixés par -shadow : Vector tourne en parallèle de Logstash sans lui prendre de partitions.');
  if (v.ns) v.note('info', 'Namespace de logs', 'log_namespace isole les métadonnées Kafka (topic, offset, clé) de la charge utile : les messages écrits restent identiques à ceux de Logstash.');
  const header = `Configuration Vector générée par Passerelle depuis un pipeline Logstash\nVérification complète (VRL compilé) : vector validate --skip-healthchecks <fichier>${v.env.size ? `\nVariables d’environnement attendues : ${[...v.env].join(', ')}` : ''}`;
  const yaml = header.split('\n').map(l => '# ' + l).join('\n') + '\n\n' + toYAML(config) + '\n';
  const toml = header.split('\n').map(l => '# ' + l).join('\n') + '\n\n' + toTOML(config) + '\n';
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  notes.list.sort((a, b) => order[a.level] - order[b.level]);
  const inTopics = srcList.map(r => r.src.__label).join(', ');
  const outLabels = graph.nodes.filter(nd => nd.kind === 'sink').map(nd => nd.label);
  const steps = graph.nodes.filter(nd => nd.kind === 'transform' && nd.type === 'remap' && !['Préparation', 'Finalisation'].includes(nd.label));
  const group = srcList[0] && srcList[0].src.group_id;
  const sentenceTxt = `Lit ${inTopics}${group ? ` (groupe ${group})` : ''}, applique ${steps.length} étape${steps.length > 1 ? 's' : ''}${steps.length ? ` (${[...new Set(steps.map(x => x.label))].join(', ')})` : ''}, puis écrit ${outLabels.length > 1 ? `selon des conditions vers ${outLabels.slice(0, -1).join(', ')} ou ${outLabels[outLabels.length - 1]}` : `vers ${outLabels[0] || '—'}`}.`;
  const first = Object.keys(transforms)[0]; const last = prev[0];
  return { config, yaml, toml, notes: notes.list, stats: v.stats, graph, sentence: sentenceTxt, env: [...v.env], firstTransform: first, lastTransform: last };
}

/* ---------- Sérialisation ---------- */
function yq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function yamlKey(k) { return /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(k) ? k : yq(k); }
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' || /^\s|\s$/.test(s) || /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /: |\s#/.test(s) || /^(true|false|yes|no|null|on|off|~)$/i.test(s) || /^[-+]?(\d|\.\d)/.test(s) || /[{}\[\],]/.test(s) || s.includes('${')) return yq(s);
  return s;
}
function toYAML(obj, ind) {
  ind = ind || 0; const pad = ' '.repeat(ind); const L = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = pad + yamlKey(k) + ':';
    if (isObj(v)) { if (!Object.keys(v).length) L.push(key + ' {}'); else { L.push(key); L.push(toYAML(v, ind + 2)); } }
    else if (Array.isArray(v)) {
      if (!v.length) L.push(key + ' []');
      else if (v.every(x => !isObj(x) && !Array.isArray(x)) && v.map(yamlScalar).join(', ').length < 70) L.push(`${key} [${v.map(yamlScalar).join(', ')}]`);
      else { L.push(key); v.forEach(x => { if (isObj(x)) { const inner = toYAML(x, ind + 4).split('\n'); L.push(pad + '  - ' + inner[0].trim()); inner.slice(1).forEach(l => L.push(l)); } else L.push(pad + '  - ' + yamlScalar(x)); }); }
    } else if (typeof v === 'string' && v.includes('\n')) { L.push(key + ' |'); v.replace(/\n+$/, '').split('\n').forEach(l => L.push(l ? pad + '  ' + l : '')); }
    else L.push(key + ' ' + yamlScalar(v));
  }
  return L.join('\n');
}
function tomlKey(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k); }
function tomlVal(v) {
  if (typeof v === 'string') {
    if (v.includes('\n')) return v.includes("'''") ? '"""\n' + v.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""') + '"""' : "'''\n" + v.replace(/\n+$/, '') + "\n'''";
    return JSON.stringify(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(tomlVal).join(', ') + ']';
  if (isObj(v)) return '{ ' + Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlVal(x)}`).join(', ') + ' }';
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
  const lines = String(text).split('\n').map(l => l.replace(/\s+#.*$/, '').replace(/^#.*$/, '')).filter(l => l.trim());
  const scalar = s => {
    s = s.trim();
    if (s === '' ) return '';
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(s)) return JSON.parse(s);
    if (/^\[.*\]$/.test(s)) { const inner = s.slice(1, -1).trim(); return inner ? inner.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(scalar) : []; }
    if (s === '{}') return {};
    if (/^(true|false)$/.test(s)) return s === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  let pos = 0;
  function block(indentLvl) {
    let obj = null;
    while (pos < lines.length) {
      const line = lines[pos]; const ind = line.match(/^ */)[0].length;
      if (ind < indentLvl) break;
      const t = line.trim();
      if (t.startsWith('- ')) { if (!obj) obj = []; obj.push(scalar(t.slice(2))); pos++; continue; }
      const m = /^('[^']*'|"[^"]*"|[^:]+):(\s+(.*))?$/.exec(t);
      if (!m) { pos++; continue; }
      if (!obj) obj = {};
      const k = scalar(m[1]); pos++;
      if (m[3] !== undefined && m[3] !== '') obj[k] = scalar(m[3]);
      else { const nextInd = pos < lines.length ? lines[pos].match(/^ */)[0].length : 0; obj[k] = nextInd > ind ? block(nextInd) : ''; }
    }
    return obj || {};
  }
  return block(0);
}
function configToYAML(cfg) {
  const head = '# Configuration Passerelle — à versionner avec vos pipelines (infrastructure as code)\n# Les secrets restent des variables d’environnement ${…}, résolues au déploiement.\n\n';
  return head + toYAML({ version: 1, clickhouse: cfg.clickhouse, kafka: cfg.kafka, vector: cfg.vector }) + '\n';
}
/* Archive ZIP sans compression (stored), pour regrouper les fichiers générés */
function makeZip(files) {
  const enc = new TextEncoder();
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunks = []; const central = []; let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255]; const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name); const data = enc.encode(f.content); const crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    chunks.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = chunks.concat(central, [end]); const total = all.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total); let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

