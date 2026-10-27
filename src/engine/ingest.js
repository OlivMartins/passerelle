/* Passerelle — moteur partie 5 : ingest pipelines Elasticsearch → VRL */

/*
 * YAML des paquets d’intégration Elastic (elasticsearch/ingest_pipeline/default.yml) : tables et listes en blocs,
 * listes « - clé: valeur », scalaires simples ou entre guillemets, blocs | et >, collections [a, b] et {a: b},
 * commentaires. Ancres, alias et balises ne sont pas lus : le texte les garde tels quels.
 */
function yamlLoad(text) {
  const src = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').replace(/\t/g, '  ').split('\n');
  const L = src.map((t, i) => ({ n: i + 1, raw: t }));
  let i = 0;
  const fail = (n, m) => { throw new Error(`YAML, ligne ${n} : ${m}`); };
  const indentOf = s => s.length - s.replace(/^ +/, '').length;
  // Fin de la partie utile : un # précédé d’un blanc, hors guillemets
  const code = s => {
    let q = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === q) { if (q === "'" && s[k + 1] === "'") k++; else q = null; } else if (q === '"' && c === '\\') k++; }
      else if ((c === '"' || c === "'") && (k === 0 || /[\s:\-\[,{]/.test(s[k - 1]))) q = c;
      else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).replace(/\s+$/, '');
    }
    return s.replace(/\s+$/, '');
  };
  const blank = k => k >= L.length || code(L[k].raw).trim() === '' || /^\s*---\s*$/.test(L[k].raw) || /^\s*\.\.\.\s*$/.test(L[k].raw);
  const skip = () => { while (i < L.length && blank(i)) i++; };
  function dq(s, n) {
    return s.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g, (m, x, u, U, e) => {
      if (x || u || U) return String.fromCodePoint(parseInt(x || u || U, 16));
      const map = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', ' ': ' ', e: '\x1b', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
      if (map[e] === undefined) fail(n, `séquence d’échappement inconnue \\${e}`);
      return map[e];
    });
  }
  function plain(v) {
    if (/^(~|null|Null|NULL)$/.test(v)) return null;
    if (/^(true|True|TRUE)$/.test(v)) return true;
    if (/^(false|False|FALSE)$/.test(v)) return false;
    if (/^[-+]?\d+$/.test(v)) return Number(v);
    if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v, 16);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
    return v;
  }
  // Collection [ … ] ou { … }, éventuellement sur plusieurs lignes
  function flow(s, n) {
    let k = 0;
    const ws = () => { while (k < s.length && /\s/.test(s[k])) k++; };
    const item = stop => {
      ws();
      if (s[k] === '[') { k++; const out = []; ws(); while (s[k] !== ']') { if (k >= s.length) fail(n, '« ] » attendu'); out.push(item(',]')); ws(); if (s[k] === ',') k++; ws(); } k++; return out; }
      if (s[k] === '{') {
        k++; const out = {}; ws();
        while (s[k] !== '}') {
          if (k >= s.length) fail(n, '« } » attendu');
          const key = item(':,}'); ws(); let val = null;
          if (s[k] === ':') { k++; val = item(',}'); }
          out[String(key)] = val; ws(); if (s[k] === ',') k++; ws();
        }
        k++; return out;
      }
      if (s[k] === '"') { let j = k + 1; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; } const v = dq(s.slice(k + 1, j), n); k = j + 1; return v; }
      if (s[k] === "'") { let j = k + 1; while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) { if (s[j] === "'") j++; j++; } const v = s.slice(k + 1, j).replace(/''/g, "'"); k = j + 1; return v; }
      let j = k; while (j < s.length && !stop.includes(s[j]) && !(s[j] === ':' && /\s/.test(s[j + 1] || ' ') && stop.includes(':'))) j++;
      const v = s.slice(k, j).trim(); k = j; return plain(v);
    };
    const v = item(''); ws();
    if (k < s.length) fail(n, `texte inattendu après la collection : « ${s.slice(k)} »`);
    return v;
  }
  // Valeur écrite sur la ligne d’une clé (ou d’un tiret), avec ses lignes de continuation
  function inline(v, n, parentIndent) {
    v = v.trim();
    if (/^[|>][-+0-9]*$/.test(v)) return block(v, parentIndent);
    if (v[0] === '[' || v[0] === '{') {
      let s = v; const open = v[0]; const close = open === '[' ? ']' : '}';
      const depth = t => { let d = 0; let q = null; for (const c of t) { if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '[' || c === '{') d++; else if (c === ']' || c === '}') d--; } return d; };
      while (depth(s) > 0 && i < L.length) { s += ' ' + code(L[i].raw).trim(); i++; }
      if (depth(s) !== 0) fail(n, `« ${close} » attendu`);
      return flow(s, n);
    }
    if (v[0] === '"') {
      let s = v;
      while (!/^"(?:[^"\\]|\\.)*"$/.test(s) && i < L.length) { const t = L[i].raw.trim(); s = s.endsWith('\\') ? s.slice(0, -1) + t : s + (t === '' ? '\n' : ' ' + t); i++; }
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
      if (!m) fail(n, 'chaîne entre guillemets non terminée');
      return dq(m[1], n);
    }
    if (v[0] === "'") {
      let s = v;
      while (!/^'(?:[^']|'')*'$/.test(s) && i < L.length) { const t = L[i].raw.trim(); s += t === '' ? '\n' : ' ' + t; i++; }
      const m = /^'((?:[^']|'')*)'$/.exec(s);
      if (!m) fail(n, 'chaîne entre apostrophes non terminée');
      return m[1].replace(/''/g, "'");
    }
    if (v[0] === '&' || v[0] === '*' || v[0] === '!') fail(n, `ancres, alias et balises YAML (${v[0]}) ne sont pas pris en charge`);
    // Scalaire simple sur plusieurs lignes : les lignes plus indentées le prolongent
    // Toute ligne plus indentée que la clé (ou que le tiret) prolonge le scalaire ; une ligne vide y fait un saut de ligne
    let s = v;
    while (i < L.length) {
      const raw = L[i].raw;
      if (raw.trim() === '') {
        let j = i; while (j < L.length && L[j].raw.trim() === '') j++;
        if (j < L.length && indentOf(L[j].raw) > parentIndent && code(L[j].raw).trim() !== '') { s += '\n'.repeat(j - i); i = j; continue; }
        break;
      }
      if (indentOf(raw) <= parentIndent || code(raw).trim() === '') break;
      s += (s.endsWith('\n') ? '' : ' ') + code(raw).trim(); i++;
    }
    return plain(s);
  }
  function block(ind, keyIndent) {
    const body = []; let base = null;
    while (i < L.length) {
      const l = L[i].raw;
      if (l.trim() === '') { body.push(''); i++; continue; }
      const k = indentOf(l);
      if (k <= keyIndent) break;
      if (base === null) base = k;
      body.push(l.slice(Math.min(base, k)));
      i++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    const chomp = ind.includes('-') ? 'strip' : ind.includes('+') ? 'keep' : 'clip';
    let out;
    if (ind[0] === '>') {
      out = '';
      body.forEach((l, k) => {
        if (l === '') out += '\n';
        else if (k && body[k - 1] !== '' && !/^\s/.test(l) && !/^\s/.test(body[k - 1])) out += ' ' + l;
        else out += (k && body[k - 1] !== '' ? '\n' : '') + l;
      });
    } else out = body.join('\n');
    return chomp === 'strip' ? out : out + '\n';
  }
  const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,\[\]{}][^#]*?|-[^\s#][^#]*?)\s*:(?:\s+(.*)|$)/;
  function node(indent) {
    skip();
    if (i >= L.length) return null;
    const l = code(L[i].raw); const k = indentOf(l);
    if (k < indent) return null;
    if (/^\s*-(\s|$)/.test(l)) return seq(k);
    if (KEY.test(l.trim())) return map(k);
    const n = L[i].n; i++;
    return inline(l.trim(), n, k - 1);
  }
  function seq(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= L.length) break;
      const l = code(L[i].raw); const k = indentOf(l);
      if (k !== indent || !/^\s*-(\s|$)/.test(l)) break;
      const n = L[i].n; const rest = l.slice(k + 1).replace(/^ +/, '');
      const at = k + 1 + (l.slice(k + 1).length - l.slice(k + 1).replace(/^ +/, '').length);
      i++;
      if (rest === '') out.push(node(indent + 1));
      else if (KEY.test(rest) && !/^["'[{]/.test(rest)) out.push(map(at, { text: rest, n }));
      else if (/^-(\s|$)/.test(rest)) { L.splice(i, 0, { n, raw: ' '.repeat(at) + rest }); out.push(seq(at)); }
      else out.push(inline(rest, n, k));
    }
    return out;
  }
  function map(indent, first) {
    const out = {};
    const entry = (text, n) => {
      const m = KEY.exec(text);
      if (!m) fail(n, `« clé: valeur » attendu, trouvé « ${text} »`);
      let key = m[1];
      if (key[0] === '"') key = dq(key.slice(1, -1), n); else if (key[0] === "'") key = key.slice(1, -1).replace(/''/g, "'"); else key = key.trim();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(n, `clé « ${key} » en double`);
      const val = (m[2] || '').trim();
      if (val === '') {
        skip();
        if (i < L.length) {
          const nl = code(L[i].raw); const k = indentOf(nl);
          if (k > indent || (k === indent && /^\s*-(\s|$)/.test(nl))) { out[key] = node(k === indent ? indent : indent + 1); return; }
        }
        out[key] = null;
      } else out[key] = inline(val, n, indent);
    };
    if (first) entry(first.text, first.n);
    for (;;) {
      skip();
      if (i >= L.length) break;
      const l = code(L[i].raw); const k = indentOf(l);
      if (k < indent) break;
      if (k > indent) fail(L[i].n, 'indentation inattendue');
      if (/^\s*-(\s|$)/.test(l)) break;
      const n = L[i].n; i++;
      entry(l.trim(), n);
    }
    return out;
  }
  const v = node(0);
  skip();
  if (i < L.length) fail(L[i].n, 'contenu inattendu après le document');
  return v;
}

/*
 * Lecture des pipelines : corps JSON d’un PUT _ingest/pipeline/<nom> (console Kibana, plusieurs requêtes à la suite),
 * réponse de GET _ingest/pipeline ({ nom: définition }), définition seule ({ processors: […] }), requête
 * _simulate ({ pipeline: … }) ou YAML d’un paquet d’intégration.
 *   name : nom par défaut d’une définition seule (le nom du fichier)
 */
function ingestRead(text, name) {
  const out = []; const errors = [];
  const s = String(text).replace(/^\uFEFF/, '');
  const add = (n, def, origin) => {
    if (!isObj(def)) { errors.push(`${origin} : définition de pipeline attendue`); return; }
    if (!Array.isArray(def.processors)) { errors.push(`${origin} : liste processors absente`); return; }
    out.push({ name: n, def, origin });
  };
  const fromObject = (o, origin) => {
    if (!isObj(o)) { errors.push(`${origin} : objet JSON attendu`); return; }
    if (Array.isArray(o.processors)) return add(o.name || name || 'pipeline', o, origin);
    if (isObj(o.pipeline) && Array.isArray(o.pipeline.processors)) return add(name || 'simulation', o.pipeline, origin);
    const entries = Object.entries(o);
    if (entries.length && entries.every(([, d]) => isObj(d) && Array.isArray(d.processors))) { entries.forEach(([n, d]) => add(n, d, `${origin}, pipeline ${n}`)); return; }
    errors.push(`${origin} : ni processors, ni pipelines nommés`);
  };
  // Console : « PUT _ingest/pipeline/nom » suivi de son corps JSON
  if (/^\s*(PUT|POST)\s+\/?_ingest\/pipeline\//m.test(s)) {
    const re = /^[ \t]*(GET|PUT|POST|DELETE|HEAD)[ \t]+(\S+)[^\n]*$/gm; const reqs = []; let m;
    while ((m = re.exec(s))) reqs.push({ verb: m[1], path: m[2], at: m.index, end: re.lastIndex, line: s.slice(0, m.index).split('\n').length });
    reqs.forEach((r, k) => {
      const body = s.slice(r.end, k + 1 < reqs.length ? reqs[k + 1].at : s.length).trim();
      const pm = /^\/?_ingest\/pipeline\/([^/?\s]+)(?:\/_simulate)?/.exec(r.path);
      if (!pm || r.verb === 'GET' || r.verb === 'DELETE' || r.verb === 'HEAD') return;
      if (/\/_simulate/.test(r.path)) return;
      let o; try { o = JSON.parse(body); } catch (e) { errors.push(`ligne ${r.line} : corps JSON illisible (${e.message})`); return; }
      add(decodeURIComponent(pm[1]), o, `ligne ${r.line}`);
    });
    return { pipelines: out, errors };
  }
  if (/^\s*[{[]/.test(s)) {
    let o; try { o = JSON.parse(s); } catch (e) { errors.push(`JSON illisible : ${e.message}`); return { pipelines: out, errors }; }
    if (Array.isArray(o)) o.forEach((d, k) => fromObject(d, `élément ${k + 1}`)); else fromObject(o, name || 'document');
    return { pipelines: out, errors };
  }
  let y; try { y = yamlLoad(s); } catch (e) { errors.push(e.message); return { pipelines: out, errors }; }
  if (y === null || y === undefined) errors.push('document vide'); else fromObject(y, name || 'document');
  return { pipelines: out, errors };
}

/*
 * Expression régulière Java (gsub, split, kv, Painless) → moteur regex de VRL (Rust). \w, \d et \s ne prennent
 * que l’ASCII en Java comme en Ruby ; \h désigne les blancs horizontaux ; \p{Alpha} et ses voisines sont ASCII.
 * ^ et $ gardent leur sens (sans (?m), le début et la fin du texte).
 */
const JAVA_POSIX = { Lower: 'a-z', Upper: 'A-Z', ASCII: '\\x00-\\x7F', Alpha: 'a-zA-Z', Digit: '0-9', Alnum: 'a-zA-Z0-9', Punct: '!-/:-@\\[-`{-~', Graph: '!-~', Print: ' -~', Blank: ' \\t', Cntrl: '\\x00-\\x1F\\x7F', XDigit: '0-9a-fA-F', Space: ' \\t\\n\\x0B\\f\\r' };
const JAVA_CLASSES = { w: '0-9A-Za-z_', d: '0-9', s: ' \\t\\n\\x0B\\f\\r', h: ' \\t\\xA0\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}' };
// Construction que la traduction ne sait pas rendre : le processeur n’est pas traduit, avec cette raison
class IngestUnsupported extends Error {}
// Ce que le moteur d’expressions de VRL (crate regex de Rust, sans retour arrière) n’accepte pas
function javaReUnsupported(re, i, c, n, depth) {
  if (c === '(' && !depth && re[i + 1] === '?') {
    if (re[i + 2] === '=' || re[i + 2] === '!') return 'anticipation (?=…) ou (?!…)';
    if (re[i + 2] === '<' && (re[i + 3] === '=' || re[i + 3] === '!')) return 'rétrospection (?<=…) ou (?<!…)';
    if (re[i + 2] === '>') return 'groupe atomique (?>…)';
  }
  if (c === '\\' && /[1-9]/.test(n || '')) return `référence arrière \\${n}`;
  if (c === '\\' && n === 'k' && re[i + 2] === '<') return 'référence arrière nommée \\k<…>';
  if (!depth && (c === '+') && i > 0 && /[*+?}]/.test(re[i - 1]) && re[i - 2] !== '\\') return 'quantificateur possessif';
  return null;
}
function javaRe(re) {
  re = String(re);
  let out = ''; let depth = 0;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    const bad = javaReUnsupported(re, i, c, re[i + 1], depth);
    if (bad) throw new IngestUnsupported(`l’expression régulière « ${re.length > 70 ? re.slice(0, 70) + '…' : re} » utilise une ${bad}, que le moteur d’expressions de VRL (Rust) n’accepte pas : à reprendre à la main`);
    if (c === '\\') {
      const n = re[i + 1]; i++;
      if (n === undefined) { out += '\\\\'; break; }
      if (n === 'Q') { const e = re.indexOf('\\E', i + 1); const lit = re.slice(i + 1, e < 0 ? re.length : e); out += lit.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&'); i = e < 0 ? re.length : e + 1; continue; }
      const k = n.toLowerCase();
      if (JAVA_CLASSES[k]) {
        const set = JAVA_CLASSES[k]; const neg = n !== k;
        out += depth ? (neg ? `[^${set}]` : set) : `[${neg ? '^' : ''}${set}]`;
        continue;
      }
      if ((n === 'p' || n === 'P') && re[i + 1] === '{') {
        const e = re.indexOf('}', i + 2); const nm = re.slice(i + 2, e).replace(/^Is/, '');
        if (JAVA_POSIX[nm]) { const neg = n === 'P'; out += depth ? (neg ? `[^${JAVA_POSIX[nm]}]` : JAVA_POSIX[nm]) : `[${neg ? '^' : ''}${JAVA_POSIX[nm]}]`; i = e; continue; }
        out += '\\' + n + re.slice(i + 1, e + 1); i = e; continue;
      }
      out += '\\' + n; continue;
    }
    if (depth) { if (c === '[') depth++; else if (c === ']') depth--; else if (c === '&' && re[i + 1] === '&') { out += '&&'; i++; continue; } out += c; continue; }
    if (c === '[') { depth = 1; out += c; if (re[i + 1] === '^') { out += '^'; i++; } if (re[i + 1] === ']') { out += '\\]'; i++; } continue; }
    out += c;
  }
  return out;
}
// Remplacement de Matcher.replaceAll (Java) → replace de VRL : $1 et ${nom} gardés, \x littéral, $ seul doublé
function javaReplacement(r) {
  let out = ''; r = String(r);
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === '\\' && i + 1 < r.length) { const n = r[++i]; out += n === '$' ? '$$' : n; continue; }
    if (c === '$') {
      const g = /^\$(\d+)|^\$\{([A-Za-z][A-Za-z0-9]*)\}/.exec(r.slice(i));
      if (g) { out += `\${${g[1] !== undefined ? g[1] : g[2]}}`; i += g[0].length - 1; continue; }
      out += '$$'; continue;
    }
    out += c;
  }
  return out;
}

/*
 * Modèles Mustache des processeurs ({{champ}}, {{{champ}}}) → expression VRL de type chaîne. Comme dans
 * Elasticsearch, {{x}} échappe la valeur à la manière d’une chaîne JSON, {{{x}}} la recopie ; une valeur absente
 * donne une chaîne vide.
 */
function mustacheParts(t) {
  const parts = []; const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([&]?)\s*([^}]+?)\s*\}\}/g; let last = 0; let m;
  t = String(t);
  while ((m = re.exec(t))) {
    if (m.index > last) parts.push({ lit: t.slice(last, m.index) });
    const raw = m[1] !== undefined || m[2] === '&';
    const name = (m[1] !== undefined ? m[1] : m[3]).trim();
    parts.push({ ref: name, raw, tag: m[0] });
    last = re.lastIndex;
  }
  if (last < t.length) parts.push({ lit: t.slice(last) });
  return parts;
}
const hasMustache = t => typeof t === 'string' && t.includes('{{');
// Nom de pipeline d’un paquet d’intégration : « {{ IngestPipeline "nom" }} », résolu à l’installation vers le fichier nom.yml voisin
const ingestPipelineRef = n => { const m = /^\s*\{\{\s*IngestPipeline\s+"([^"]+)"\s*\}\}\s*$/.exec(String(n)); return m ? m[1] : null; };

/*
 * Painless des conditions (if) et des scripts : analyse d’un sous-ensemble — instructions, affectations de champs,
 * if/else, boucles for (x : liste), return ; expressions, appels de méthodes courants, littéraux de listes et de
 * tables. Le reste (lambdas, try, while, classes) est refusé avec la raison.
 */
function ingPainless(src) {
  const toks = ptokens(String(src)); let p = 0;
  const peek = k => toks[p + (k || 0)];
  const is = (v, k) => { const t = toks[p + (k || 0)]; return !!t && t.t !== 'str' && t.t !== 'num' && t.v === v; };
  const next = () => toks[p++];
  const expect = v => { if (!is(v)) throw new Error(`« ${v} » attendu${peek() ? `, trouvé « ${peek().v} »` : ''}`); p++; };
  const BIN = { '||': 2, '&&': 3, '==': 7, '!=': 7, '===': 7, '!==': 7, '<': 8, '>': 8, '<=': 8, '>=': 8, '=~': 8, '==~': 8, instanceof: 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  const fns = new Map();
  function block() { const out = []; while (p < toks.length && !is('}')) out.push(stmt()); return out; }
  const endStmt = () => { if (is(';')) p++; };
  const isType = (k) => { const t = peek(k); return t && t.t === 'id' && (P_TYPES.has(t.v) || /^[A-Z]\w*$/.test(t.v)); };
  function stmt() {
    if (is('{')) { next(); const b = block(); expect('}'); return { k: 'block', body: b }; }
    if (is(';')) { next(); return { k: 'nop' }; }
    const t = peek();
    if (t.t === 'id' && t.v === 'if') {
      next(); expect('('); const c = expr(0); expect(')');
      const th = stmt(); let el = null;
      if (peek() && peek().t === 'id' && peek().v === 'else') { next(); el = stmt(); }
      return { k: 'if', c, th, el };
    }
    if (t.t === 'id' && t.v === 'for') {
      next(); expect('(');
      // for (int i = 0; i < liste.size(); i++) : un parcours par indice
      if (isType(0) && peek(1) && peek(1).t === 'id' && is('=', 2)) {
        next(); const name = next().v; next(); const init = expr(0); expect(';');
        const c = expr(0); expect(';');
        const u1 = next(); const u2 = peek();
        const okUpd = (u1.v === name && u2 && (u2.v === '++' || (u2.v === '+=' && peek(1) && peek(1).t === 'num' && peek(1).v === '1'))) || (u1.v === '++' && u2 && u2.v === name);
        if (!okUpd) throw new Error('boucle for à compteur : seul « i++ » est pris en charge');
        next(); if (u2.v === '+=') next();
        expect(')');
        const bound = c.k === 'bin' && c.op === '<' && c.l.k === 'id' && c.l.v === name ? c.r : null;
        const list = bound && ((bound.k === 'mcall' && (bound.name === 'size' || bound.name === 'length') && !bound.args.length) ? bound.obj : (bound.k === 'member' && bound.name === 'length') ? bound.obj : null);
        if (!list || init.k !== 'num' || Number(init.v) !== 0) throw new Error('boucle for à compteur : seul « for (int i = 0; i < liste.size(); i++) » est pris en charge');
        return { k: 'forIdx', name, list, body: stmt() };
      }
      // for (def x : liste) ou for (x in liste)
      let name;
      if (isType(0) && peek(1) && peek(1).t === 'id') { next(); name = next().v; }
      else name = next().v;
      if (is(':')) next(); else if (peek() && peek().t === 'id' && peek().v === 'in') next(); else throw new Error('boucle for à compteur non prise en charge (seule « for (x : liste) » l’est)');
      const list = expr(0); expect(')');
      return { k: 'for', name, list, body: stmt() };
    }
    if (t.t === 'id' && t.v === 'return') {
      next();
      if (!peek() || is(';') || is('}')) { endStmt(); return { k: 'ret' }; }
      const v = expr(0); endStmt(); return { k: 'ret', v };
    }
    if (t.t === 'id' && t.v === 'try') {
      next(); expect('{'); const body = block(); expect('}');
      let fin = [];
      while (peek() && peek().t === 'id' && peek().v === 'catch') { next(); expect('('); while (!is(')')) next(); expect(')'); expect('{'); block(); expect('}'); }
      if (peek() && peek().t === 'id' && peek().v === 'finally') { next(); expect('{'); fin = block(); expect('}'); }
      return { k: 'try', body, fin };
    }
    if (t.t === 'id' && (t.v === 'break' || t.v === 'continue')) { next(); endStmt(); return { k: t.v }; }
    if (t.t === 'id' && ['while', 'do', 'throw', 'switch'].includes(t.v)) throw new Error(`instruction « ${t.v} » non prise en charge`);
    // Fonction déclarée dans le script : « type nom(…) { … } »
    if ((isType(0) || (peek() && peek().t === 'id' && peek().v === 'void')) && peek(1) && peek(1).t === 'id' && is('(', 2)) {
      let k = 3; let d = 1; while (p + k < toks.length && d > 0) { if (is('(', k)) d++; else if (is(')', k)) d--; k++; }
      if (is('{', k)) {
        next(); const name = next().v; expect('(');
        const params = []; let cur = null; let ang = 0;
        while (!is(')') || ang > 0) {
          if (p >= toks.length) throw new Error(`fonction « ${name} » : parenthèse fermante absente`);
          if (is('<')) ang++; else if (is('>')) ang--;
          else if (is(',') && ang === 0) { if (cur) params.push(cur); cur = null; next(); continue; }
          const t = next(); if (t.t === 'id') cur = t.v;
        }
        if (cur) params.push(cur);
        expect(')'); expect('{'); const body = block(); expect('}');
        if (fns.has(name)) throw new Error(`fonction « ${name} » déclarée deux fois (surcharge non prise en charge)`);
        fns.set(name, { params, body });
        return { k: 'nop' };
      }
    }
    // Déclaration : type (générique compris) puis nom
    if (isType(0)) {
      let k = 1;
      if (is('<', 1)) { let d = 0; do { if (is('<', k)) d++; else if (is('>', k)) d--; k++; } while (d > 0 && p + k < toks.length); }
      while (is('[', k) && is(']', k + 1)) k += 2;
      const nt = peek(k);
      if (nt && nt.t === 'id' && (is('=', k + 1) || is(';', k + 1))) {
        p += k; const name = next().v; let v = null;
        if (is('=')) { next(); v = expr(0); }
        endStmt(); return { k: 'let', name, v };
      }
    }
    const e = expr(0);
    if (is('=') || is('+=') || is('-=') || is('*=') || is('/=')) {
      const op = next().v; const r = expr(0); endStmt();
      if (!['id', 'member', 'index'].includes(e.k)) throw new Error('affectation à une expression qui n’est pas un champ ou une variable');
      return { k: 'set', target: e, v: op === '=' ? r : { k: 'bin', op: op[0], l: e, r } };
    }
    endStmt(); return { k: 'expr', e };
  }
  function expr(min) {
    let l = unary();
    for (;;) {
      const t = peek(); if (!t || t.t === 'str' || t.t === 'num' || t.t === 're') break;
      if (t.v === '?' && min <= 1) { next(); const a = expr(0); expect(':'); const b = expr(1); l = { k: 'tern', c: l, a, b }; continue; }
      if (t.v === '?:' && min <= 1) { next(); const b = expr(1); l = { k: 'elvis', a: l, b }; continue; }
      const pr = BIN[t.v]; if (!pr || pr <= min) break;
      next();
      if (t.v === 'instanceof') { const ty = next(); l = { k: 'inst', e: l, type: ty.v }; continue; }
      const r = expr(pr); l = { k: 'bin', op: t.v, l, r };
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t && t.t === 'op' && ['!', '-', '+'].includes(t.v)) { next(); return { k: 'un', op: t.v, e: unary() }; }
    if (t && t.t === 'op' && t.v === '(' && peek(1) && peek(1).t === 'id' && P_TYPES.has(peek(1).v) && is(')', 2)) {
      const type = peek(1).v; p += 3; return { k: 'cast', type, e: unary() };
    }
    return postfix(primary());
  }
  function args() { const a = []; while (!is(')')) { if (is('->', 1) || is('->', 3)) throw new Error('lambda non prise en charge'); a.push(expr(0)); if (is(',')) next(); else break; } expect(')'); return a; }
  function primary() {
    const t = next();
    if (!t) throw new Error('expression incomplète');
    if (t.t === 'num') return { k: 'num', v: t.v, int: t.int };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 're') return { k: 're', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = expr(0); expect(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      if (is(':')) { next(); expect(']'); return { k: 'map', items: [] }; }
      const items = []; let pairs = null;
      while (!is(']')) {
        const a = expr(0);
        if (is(':')) { next(); const b = expr(0); (pairs = pairs || []).push([a, b]); } else items.push(a);
        if (is(',')) next(); else break;
      }
      expect(']');
      if (pairs && items.length) throw new Error('littéral mêlant liste et table');
      return pairs ? { k: 'map', items: pairs } : { k: 'list', items };
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'null' };
      if (t.v === 'new') {
        const ty = next(); if (!ty || ty.t !== 'id') throw new Error('type attendu après new');
        if (is('<')) { let d = 0; do { if (is('<')) d++; else if (is('>')) d--; next(); } while (d > 0 && p < toks.length); }
        expect('('); const a = args();
        if (/^(ArrayList|LinkedList|List)$/.test(ty.v)) return { k: 'list', items: [], from: a[0] || null };
        if (/^(HashMap|LinkedHashMap|TreeMap|Map)$/.test(ty.v)) return { k: 'map', items: [], from: a[0] || null };
        throw new Error(`« new ${ty.v} » non pris en charge`);
      }
      if (is('(')) { next(); return { k: 'call', name: t.v, args: args() }; }
      return { k: 'id', v: t.v };
    }
    throw new Error(`symbole inattendu « ${t.v} »`);
  }
  function postfix(e) {
    for (;;) {
      if (is('.') || is('?.')) {
        const safe = next().v === '?.'; const nm = next();
        if (!nm || nm.t !== 'id') throw new Error('nom de membre attendu');
        if (is('(')) { next(); e = { k: 'mcall', obj: e, name: nm.v, args: args(), safe }; }
        else e = { k: 'member', obj: e, name: nm.v, safe };
        continue;
      }
      if (is('[')) { next(); const idx = expr(0); expect(']'); e = { k: 'index', obj: e, idx }; continue; }
      if (is('++') || is('--')) throw new Error('++ et -- non pris en charge');
      if (is('->') || is('::')) throw new Error('lambda non prise en charge');
      break;
    }
    return e;
  }
  const prog = block();
  if (p < toks.length) throw new Error(`symbole inattendu « ${toks[p].v} »`);
  prog.fns = fns;
  return prog;
}

/* ---------- Génération du programme VRL ---------- */
// Métadonnées du document (ctx._index…) : rangées dans les métadonnées de l’événement Vector
const INGEST_META = ['_index', '_id', '_routing', '_version', '_version_type', '_if_seq_no', '_if_primary_term', '_op_type', '_dynamic_templates'];
// Métadonnées d’ingestion lisibles dans les modèles et les scripts : variables du programme
const INGEST_VARS = {
  timestamp: 'ingest_timestamp', on_failure_message: 'ingest_on_failure_message', on_failure_processor_type: 'ingest_on_failure_processor_type',
  on_failure_processor_tag: 'ingest_on_failure_processor_tag', on_failure_pipeline: 'ingest_on_failure_pipeline', pipeline: 'ingest_pipeline',
  _grok_match_index: 'ingest_grok_match_index'
};
// Marque d’un échec d’accès dont le message reste à établir (voir pathFailure) : un caractère nul ne vient d’aucun message
const PATH_FAIL = '"\\u{0}chemin"';
// Élément de chemin qu’Elasticsearch lit comme un index quand le parent est une liste (Integer.parseInt)
const isIndexSeg = s => /^[+-]?\d+$/.test(s);
// Texte d’une valeur, comme Object.toString de Java pour les cas courants, sans opération faillible (E651)
const jstrOf = x => `if is_string(${x}) { string!(${x}) } else if is_timestamp(${x}) { format_timestamp!(timestamp!(${x}), format: "%Y-%m-%dT%H:%M:%S%.3fZ") } else { encode_json(${x}) }`;
/*
 * Coût de compilation de VRL : le compilateur recalcule le typage d’un bloc à chaque niveau d’imbrication qui le
 * contient, et chaque calcul copie la connaissance accumulée sur l’événement. Une chaîne « else if » de n branches
 * coûte donc n fois plus qu’une suite de n « if » au même niveau : les diagnostics sont écrits à plat, et ceux des
 * chemins sont établis une fois, à la fin du processeur, au lieu de l’être au plus profond de chaque accès.
 */
class IngestGen {
  constructor(t, pipeline) {
    this.t = t; this.pipeline = pipeline;
    this.lines = []; this.ind = 0;
    this.value = null; this.key = null;   // _ingest._value et _ingest._key dans un foreach
    this.diags = [];                       // processeurs en cours : diagnostic de chemin différé (w_d)
    this.marks = [];                       // lignes où un transform peut finir et le suivant commencer
  }
  // Classe Java de x dans la variable v, en instructions à plat (scalar : x n’est ni une table ni une liste)
  jtype(v, x, scalar) {
    this.emit(`${v} = "null"`);
    this.emit(`if is_string(${x}) { ${v} = "java.lang.String" }`);
    this.emit(`if is_boolean(${x}) { ${v} = "java.lang.Boolean" }`);
    this.emit(`if is_float(${x}) { ${v} = "java.lang.Double" }`);
    this.emit(`if is_integer(${x}) { ${v} = if int!(${x}) > 2147483647 || int!(${x}) < -2147483648 { "java.lang.Long" } else { "java.lang.Integer" } }`);
    this.emit(`if is_timestamp(${x}) { ${v} = "java.time.ZonedDateTime" }`);
    if (!scalar) { this.emit(`if is_array(${x}) { ${v} = "java.util.ArrayList" }`); this.emit(`if is_object(${x}) { ${v} = "java.util.HashMap" }`); }
  }
  emit(l) { this.lines.push('  '.repeat(this.ind) + l); }
  open(l) { this.emit(l + ' {'); this.ind++; }
  // Un bloc vide est refusé par VRL : null y tient lieu d’instruction
  close(l) {
    let k = this.lines.length - 1; while (k >= 0 && /^\s*(#|$)/.test(this.lines[k])) k--;
    if (k >= 0 && this.lines[k].trim().endsWith('{')) this.emit('null');
    this.ind--; this.emit(l || '}');
  }
  comment(c) { String(c).split('\n').forEach(l => this.emit('# ' + l)); }
  tmp(base) { return `${base}_${++this.t.k}`; }
  note(level, title, detail) { this.t.notes.add(level, title, detail); }
  approx(title, detail) { this.t.stats.approx++; this.note('warn', title, detail); }
  ko(where, why) { this.t.stats.ko++; this.t.todo = true; this.note('err', `${where} non traduit`, why); this.comment(`À REPRENDRE : ${why}`); }

  /* Référence de champ (« a.b.c », « _ingest._value », « _index », « {{nom}} ») */
  ref(name) {
    let n = String(name === undefined || name === null ? '' : name);
    if (hasMustache(n)) return { kind: 'dyn', expr: this.tpl(n), path: n };
    const full = n;
    if (n.startsWith('_source.')) n = n.slice(8);
    if (n === '') return { kind: 'bad', why: 'nom de champ vide' };
    // String.split de Java : les éléments vides de fin disparaissent, un élément vide ailleurs rend le chemin invalide
    const split = x => { const a = x.split('.'); while (a.length && a[a.length - 1] === '') a.pop(); return a; };
    const invalid = { kind: 'bad', why: `chemin « ${full} » invalide : Elasticsearch échoue (path [${full}] is not valid)` };
    if (n.startsWith('_ingest.')) {
      const k = n.slice(8);
      if (k === '_value' || k.startsWith('_value.')) {
        if (!this.value) return { kind: 'bad', why: '_ingest._value hors d’un foreach' };
        const rest = k === '_value' ? [] : split(k.slice(7));
        if (rest.some(x => x === '')) return invalid;
        return rest.length ? { kind: 'sub', base: this.value, segs: rest, path: full, num: rest.some(isIndexSeg) } : { kind: 'var', vrl: this.value, path: full };
      }
      if (k === '_key') return this.key ? { kind: 'var', vrl: this.key, path: full, key: true } : { kind: 'bad', why: '_ingest._key hors d’un foreach sur une table' };
      if (INGEST_VARS[k]) { if (k === 'timestamp') this.t.uses.timestamp = true; return { kind: 'var', vrl: INGEST_VARS[k], path: full, readonly: true }; }
      return { kind: 'bad', why: `métadonnée d’ingestion « ${full} » inconnue` };
    }
    if (INGEST_META.includes(n)) { this.t.uses.meta = true; return { kind: 'meta', vrl: `%${n}`, path: full }; }
    const segs = split(n);
    if (!segs.length || segs.some(x => x === '')) return invalid;
    return { kind: 'field', segs, path: full, num: segs.some(isIndexSeg) };
  }
  // Chemin VRL : un nombre JavaScript est un index de liste (Painless : l[0]), une chaîne toujours une clé
  vpath(segs, base) {
    let out = base || '';
    segs.forEach(s => { out += typeof s === 'number' ? `[${s}]` : '.' + segName(s); });
    return out || '.';
  }
  arr(segs) { return `[${segs.map(s => (typeof s === 'number' ? String(s) : vq(s))).join(', ')}]`; }
  /*
   * Parcours d’un chemin comme le fait IngestDocument : une table est lue par clé, une liste par index (« a.0.b »),
   * avec les messages d’erreur d’Elasticsearch. Le chemin d’accès VRL (clés et index) est reconstruit au passage.
   *   read   : resolve() de getFieldValue et hasField ; rend la valeur, ou l’erreur
   *   remove : resolve() jusqu’au parent, puis les règles de removeField pour la feuille
   *   set    : setFieldValue ; les tables manquantes seront créées, un index doit exister
   * Rend les noms des variables : err (message ou null), val (lecture), rp (chemin VRL).
   */
  walk(mode, r) {
    const id = ++this.t.k;
    const W = { err: `w_err_${id}`, val: `w_val_${id}`, rp: `w_rp_${id}` };
    const P = r.kind === 'dyn' ? 'w_path' : vq(r.path);
    if (r.kind === 'dyn') { this.emit(`w_path = ${r.expr}`); this.emit('w_sp = split(w_path, ".")'); }
    else this.emit(`w_sp = [${r.segs.map(vq).join(', ')}]`);
    this.emit(`w_cur = ${r.kind === 'sub' ? `get!(${r.base}, [])` : 'get!(., [])'}`);   // type inconnu, voir pathFailure
    this.emit(`${W.err} = null`);
    this.emit(`${W.rp} = []`);
    if (mode === 'set') this.emit('w_libre = false');
    const S = '" + seg + "';
    const leaf = 'i == length(w_sp) - 1';
    this.open('for_each(w_sp) -> |i, seg|');
    this.open(`if ${W.err} == null`);
    if (mode === 'set') { this.emit(`if w_libre { ${W.rp} = push(${W.rp}, seg) } else if is_object(w_cur) {`); this.ind++; }
    else this.open('if is_object(w_cur)');
    if (mode === 'set') {
      this.emit(`${W.rp} = push(${W.rp}, seg)`);
      this.emit(`if !(${leaf}) { if includes(keys(object!(w_cur)), seg) { w_cur = get!(w_cur, [seg]) } else { w_libre = true } }`);
    } else {
      this.emit(`if includes(keys(object!(w_cur)), seg) { w_cur = get!(w_cur, [seg]); ${W.rp} = push(${W.rp}, seg) } else { ${W.err} = "field [${S}] not present as part of path [" + ${P} + "]" }`);
    }
    this.close('} else if is_array(w_cur) {'); this.ind++;
    // Integer.parseInt : un signe est accepté, la valeur doit tenir sur 32 bits
    this.emit('w_ix = if match(seg, r\'^[+-]?[0-9]+$\') { to_int(seg) ?? null } else { null }');
    this.emit('if w_ix != null && (int!(w_ix) > 2147483647 || int!(w_ix) < -2147483648) { w_ix = null }');
    this.open('if w_ix == null');
    this.emit(`${W.err} = "[${S}] is not an integer, cannot be used as an index as part of path [" + ${P} + "]"`);
    this.close('} else if int!(w_ix) < 0 || int!(w_ix) >= length(array!(w_cur)) {'); this.ind++;
    this.emit(`${W.err} = "[" + to_string(int!(w_ix)) + "] is out of bounds for array with length [" + to_string(length(array!(w_cur))) + "] as part of path [" + ${P} + "]"`);
    this.close('} else {'); this.ind++;
    this.emit(`${W.rp} = push(${W.rp}, int!(w_ix))`);
    this.emit('w_cur = get!(w_cur, [int!(w_ix)])');
    this.close();
    this.close('} else {'); this.ind++;
    this.diagnose(W.err, 'w_cur', 'seg', mode === 'read' ? false : leaf, mode, P, false);
    this.close();
    this.close();
    this.close();
    if (mode === 'read') this.emit(`${W.val} = if ${W.err} == null { w_cur } else { null }`);
    return W;
  }
  /*
   * Message d’Elasticsearch pour un parent de chemin (cur) qui n’est pas une table : liste (index attendu), valeur
   * nulle ou scalaire (classe Java). seg : élément refusé ; leaf : ce parent est celui de la feuille (set et remove,
   * condition VRL ou booléen connu) ; mode : "set", "remove" ou "read" (texte connu, ou expression VRL si dynamic).
   */
  diagnose(target, cur, seg, leaf, mode, P, dynamic) {
    this.jtype('w_of', cur, true);
    this.emit('if w_of != "null" { w_of = "object of type [" + w_of + "]" }');
    const S = `" + ${seg} + "`;
    const isMode = m => (dynamic ? `${mode} == "${m}"` : (mode === m ? 'true' : 'false'));
    const when = (m, extra) => {
      if (!dynamic && mode !== m) return null;
      const c = [leaf === true ? null : leaf, dynamic ? isMode(m) : null, extra].filter(Boolean);
      if (leaf === false) return null;
      return c.length ? c.join(' && ') : 'true';
    };
    this.emit(`${target} = "cannot resolve [${S}] from " + w_of`);
    const set1 = when('set'); const set0 = when('set', 'w_of == "null"'); const rm = when('remove');
    if (set1) this.emit(set1 === 'true' ? `${target} = "cannot set [${S}] with parent " + w_of` : `if ${set1} { ${target} = "cannot set [${S}] with parent " + w_of }`);
    if (set0) this.emit(`if ${set0} { ${target} = "cannot set [${S}] with null parent" }`);
    if (rm) this.emit(rm === 'true' ? `${target} = "cannot remove [${S}] from " + w_of` : `if ${rm} { ${target} = "cannot remove [${S}] from " + w_of }`);
    this.emit(`if is_array(${cur}) { ${target} = "[${S}] is not an integer, cannot be used as an index" }`);
    this.emit(`${target} = ${target} + " as part of path [" + ${P} + "]"`);
  }
  /*
   * Échec d’accès à un chemin fait de clés seulement (le cas courant). Le message d’Elasticsearch dépend du premier
   * parent qui n’est pas une table et de sa classe Java : l’établir ici coûterait une vingtaine d’instructions au plus
   * profond de chaque accès, que VRL type et retype à chaque niveau d’imbrication. L’accès ne note donc que le chemin
   * (w_d) et marque l’échec (PATH_FAIL) ; le message est établi là où il devient lisible : avant les on_failure d’un
   * processeur ou d’un pipeline, et en fin de programme (materialize). D’ici là le document ne change pas, puisqu’un
   * échec arrête le pipeline. Sous ignore_failure, le message n’est jamais lu.
   */
  pathFailure(mode, r) {
    const ctx = this.diags[this.diags.length - 1];
    if (ctx && ctx.quiet) { this.emit(`fail = ${vq(`cannot access [${r.path}]`)}`); return; }
    if (r.kind === 'sub') { this.pathFailureNow(mode, r); return; }
    this.t.sites = (this.t.sites || 0) + 1;
    this.emit(`fail = ${PATH_FAIL}`);
    this.emit(`w_d = { "m": ${vq(mode)}, "p": ${vq(r.path)}, "s": ${this.arr(r.segs)} }`);
  }
  // Variante immédiate, pour un chemin sous _ingest._value (dans un foreach, la valeur n’est pas dans le document)
  pathFailureNow(mode, r) {
    const segs = r.segs, n = segs.length, base = r.base;
    this.emit(`fail = ${vq(mode === 'set' ? `cannot set [${r.path}]` : `field [${segs[n - 1]}] not present as part of path [${r.path}]`)}`);
    this.emit('w_s = false');
    this.emit('w_cur = null');
    this.emit('w_k = 0');
    for (let j = 1; j < n; j++) {
      const P = this.vpath(segs.slice(0, j), base);
      const d = `w_s = true; w_k = ${j}; w_cur = get(${base}, ${this.arr(segs.slice(0, j))}) ?? null`;
      if (mode === 'set') this.emit(`if !w_s && exists(${P}) && !is_object(${P}) { ${d} }`);
      else {
        this.emit(`if !w_s && !exists(${P}) { w_s = true; fail = ${vq(`field [${segs[j - 1]}] not present as part of path [${r.path}]`)} }`);
        this.emit(`if !w_s && !is_object(${P}) { ${d} }`);
      }
    }
    this.open('if w_k > 0');
    this.emit(`w_seg = string!(get!([${segs.slice(1).map(vq).join(', ')}], [w_k - 1]))`);
    this.diagnose('fail', 'w_cur', 'w_seg', `w_k == ${n - 1}`, mode, vq(r.path), false);
    this.close();
  }
  /*
   * Message d’un échec d’accès noté par pathFailure, rendu dans chacune des variables qui portent encore la marque.
   * Le chemin est parcouru comme le fait IngestDocument (resolve, puis la feuille selon set, remove ou lecture).
   */
  materialize(vars) {
    if (!this.t.sites) return;
    this.open(`if w_d != null && (${vars.map(v => `${v} == ${PATH_FAIL}`).join(' || ')})`);
    this.emit('w_m = string!(w_d.m)');
    this.emit('w_p = string!(w_d.p)');
    this.emit('w_sp = array!(w_d.s)');
    this.emit('w_cur = get!(., [])');
    this.emit('w_msg = null');
    this.emit('w_libre = false');
    this.open('for_each(w_sp) -> |i, seg|');
    this.open('if w_msg == null && !w_libre');
    this.emit('w_seg = string!(seg)');
    this.emit('w_leaf = i == length(w_sp) - 1');
    this.open('if is_object(w_cur)');
    this.emit('w_has = includes(keys(object!(w_cur)), w_seg)');
    this.emit('if !w_has && w_m == "set" { w_libre = true }');
    this.emit('if !w_has && w_m != "set" { w_msg = "field [" + w_seg + "] not present as part of path [" + w_p + "]" }');
    this.emit('if w_has { w_cur = get!(w_cur, [w_seg]) }');
    this.close('} else {'); this.ind++;
    this.diagnose('w_msg', 'w_cur', 'w_seg', 'w_leaf', 'w_m', 'w_p', true);
    this.close();
    this.close();
    this.close();
    this.emit('if w_msg == null { w_msg = if w_m == "set" { "cannot set [" + w_p + "]" } else { "field [" + w_p + "] not present as part of path [" + w_p + "]" } }');
    vars.forEach(v => this.emit(`if ${v} == ${PATH_FAIL} { ${v} = w_msg }`));
    this.emit('w_d = null');
    this.close();
  }
  // Valeur lue (type inconnu pour VRL, ce qui évite les erreurs E651 quand une étape précédente l’a écrite)
  get(r) {
    if (r.num || r.kind === 'dyn') return this.walk('read', r).val;
    switch (r.kind) {
      case 'field': return `get!(., ${this.arr(r.segs)})`;
      case 'sub': return `get(${r.base}, ${this.arr(r.segs)}) ?? null`;
      case 'meta': case 'var': return r.vrl;
    }
    return 'null';
  }
  has(r) {
    if (r.num || r.kind === 'dyn') return `${this.walk('read', r).err} == null`;
    switch (r.kind) {
      case 'field': return `exists(${this.vpath(r.segs)})`;
      case 'sub': return `exists(${this.vpath(r.segs, r.base)})`;
      case 'meta': return `exists(${r.vrl})`;
      case 'var': return `${r.vrl} != null`;
    }
    return 'false';
  }
  // Lecture d’un champ obligatoire : sa valeur dans une variable, le message d’Elasticsearch sinon
  read(r, v, ignoreMissing) {
    if (r.num || r.kind === 'dyn') {
      const W = this.walk('read', r);
      this.emit(`${v} = ${W.val}`);
      if (!ignoreMissing) this.emit(`if ${W.err} != null { fail = ${W.err} }`);
      return;
    }
    this.emit(`${v} = ${this.get(r)}`);
    if (ignoreMissing) return;
    this.open(`if !(${this.has(r)})`);
    this.notPresent(r);
    this.close();
  }
  // Champ introuvable : une seule clé ne peut qu’être absente ; au-delà, le parcours donne la cause exacte
  notPresent(r) {
    if (r.num || r.kind === 'dyn') { const W = this.walk('read', r); this.emit(`fail = if ${W.err} == null { ${vq(`field [${r.path}] not present as part of path [${r.path}]`)} } else { ${W.err} }`); return; }
    if ((r.kind === 'field' || r.kind === 'sub') && r.segs.length > 1) { this.pathFailure('read', r); return; }
    const leaf = r.segs ? r.segs[r.segs.length - 1] : r.path;
    this.emit(`fail = ${vq(`field [${leaf}] not present as part of path [${r.path}]`)}`);
  }
  failCast(v, path, target) {
    this.jtype('jt', v);
    this.emit(`fail = "field [" + ${vq(path)} + "] of type [" + jt + "] cannot be cast to [${target}]"`);
  }
  // Écriture : les parents manquants sont créés ; un parent qui n’est pas un objet fait échouer, comme dans Elasticsearch
  set(r, expr) {
    if (r.kind === 'var') {
      if (r.readonly) { this.emit(`fail = ${vq(`cannot set [${r.path}]`)}`); return; }
      this.emit(`${r.vrl} = ${expr}`); return;
    }
    if (r.kind === 'meta') { this.emit(`${r.vrl} = ${expr}`); return; }
    if (r.kind !== 'field' && r.kind !== 'sub' && r.kind !== 'dyn') { this.emit(`fail = ${vq(r.why || 'champ invalide')}`); return; }
    const root = r.kind === 'sub' ? r.base : '.';
    const write = () => {
      const W = this.walk('set', r);
      this.emit(`if ${W.err} == null { ${root} = set!(${root}, ${W.rp}, ${expr}) } else { fail = ${W.err} }`);
    };
    if (r.num || r.kind === 'dyn') { write(); return; }
    const segs = r.segs;
    if (segs.length === 1) { this.emit(`${this.vpath(segs, r.kind === 'sub' ? r.base : '')} = ${expr}`); return; }
    // Chemin de clés : écriture directe si chaque parent est absent ou une table, parcours d’Elasticsearch sinon
    const guard = segs.slice(0, -1).map((s, j) => {
      const p = this.vpath(segs.slice(0, j + 1), r.kind === 'sub' ? r.base : '');
      return `(!exists(${p}) || is_object(${p}))`;
    }).join(' && ');
    this.open(`if ${guard}`);
    this.emit(`${this.vpath(segs, r.kind === 'sub' ? r.base : '')} = ${expr}`);
    this.close('} else {'); this.ind++;
    this.pathFailure('set', r);
    this.close();
  }
  del(r, ignoreMissing) {
    if (r.kind === 'meta') { this.emit(`del(${r.vrl})`); return; }
    if (r.kind === 'field' || r.kind === 'sub' || r.kind === 'dyn') {
      const root = r.kind === 'sub' ? r.base : '.';
      const walked = () => {
        const W = this.walk('remove', r);
        this.emit(`if ${W.err} == null { ${root} = remove!(${root}, ${W.rp}) }${ignoreMissing ? '' : ` else { fail = ${W.err} }`}`);
      };
      if (r.num || r.kind === 'dyn') { walked(); return; }
      const p = this.vpath(r.segs, r.kind === 'sub' ? r.base : '');
      if (ignoreMissing) { this.emit(`del(${p})`); return; }
      this.open(`if exists(${p})`); this.emit(`del(${p})`);
      this.close('} else {'); this.ind++;
      if (r.segs.length === 1) this.emit(`fail = ${vq(`field [${r.segs[0]}] not present as part of path [${r.path}]`)}`); else this.pathFailure('remove', r);
      this.close();
      return;
    }
    this.emit(`fail = ${vq(`cannot remove [${r.path}]`)}`);
  }

  /* Modèle Mustache → expression chaîne */
  tpl(t) {
    if (/\{\{\s*[#^]/.test(String(t))) return this.tplSections(String(t));
    const parts = mustacheParts(t); const out = [];
    for (const p of parts) {
      if (p.lit !== undefined) { if (p.lit) out.push(vq(p.lit)); continue; }
      if (/^[#^/!>=]/.test(p.ref)) { this.ko('Modèle Mustache', `la section ${p.tag} n’est pas prise en charge (seules les valeurs {{champ}} le sont)`); out.push('""'); continue; }
      const r = this.ref(p.ref);
      if (r.kind === 'bad' || r.kind === 'dyn') { out.push('""'); continue; }
      const v = this.tmp('t');
      // Texte de la valeur : une chaîne telle quelle, un nombre ou un booléen en texte, une liste ou une table en JSON
      this.emit(`${v} = ${this.get(r)}`);
      this.emit(`${v} = if ${v} == null { "" } else { ${jstrOf(v)} }`);
      if (!p.raw) this.emit(`${v} = slice!(encode_json(${v}), 1, -1)`);
      out.push(v);
    }
    if (parts.some(p => p.ref && !/^_ingest\.on_failure|^_ingest\.timestamp|^_ingest\.pipeline/.test(p.ref))) this.t.uses.template = true;
    return out.length ? out.join(' + ') : '""';
  }
  // Texte d’une référence Mustache, échappé à la manière d’une chaîne JSON sauf {{{x}}}
  tplValue(ref, raw) {
    const r = this.ref(ref);
    if (r.kind === 'bad' || r.kind === 'dyn') return '""';
    const v = this.tmp('t');
    this.emit(`${v} = ${this.get(r)}`);
    this.emit(`${v} = if ${v} == null { "" } else { ${jstrOf(v)} }`);
    if (!raw) this.emit(`${v} = slice!(encode_json(${v}), 1, -1)`);
    return v;
  }
  /*
   * Sections {{#x}}…{{/x}} (rendue si x n’est ni absent, ni faux, ni vide) et {{^x}}…{{/x}} (l’inverse) : le texte
   * est assemblé dans une variable, instruction par instruction.
   */
  tplSections(t) {
    const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#^/&]?)\s*([^}]+?)\s*\}\}/g;
    const root = { children: [] }; const stack = [root]; let last = 0; let m;
    while ((m = re.exec(t))) {
      const top = stack[stack.length - 1];
      if (m.index > last) top.children.push({ lit: t.slice(last, m.index) });
      last = re.lastIndex;
      if (m[1] !== undefined) { top.children.push({ ref: m[1].trim(), raw: true }); continue; }
      const sig = m[2]; const name = m[3].trim();
      if (sig === '#' || sig === '^') { const sec = { section: name, inverted: sig === '^', children: [] }; top.children.push(sec); stack.push(sec); continue; }
      if (sig === '/') {
        if (stack.length < 2 || top.section !== name) { this.ko('Modèle Mustache', `section {{/${name}}} sans ouverture correspondante`); return '""'; }
        stack.pop(); continue;
      }
      top.children.push({ ref: name, raw: sig === '&' });
    }
    if (last < t.length) stack[stack.length - 1].children.push({ lit: t.slice(last) });
    if (stack.length > 1) { this.ko('Modèle Mustache', `section {{#${stack[stack.length - 1].section}}} non fermée`); return '""'; }
    const acc = this.tmp('texte');
    this.emit(`${acc} = ""`);
    const walk = nodes => nodes.forEach(n => {
      if (n.lit !== undefined) { if (n.lit) this.emit(`${acc} = ${acc} + ${vq(n.lit)}`); return; }
      if (n.ref !== undefined) { const v = this.tplValue(n.ref, n.raw); this.emit(`${acc} = ${acc} + ${v}`); return; }
      const r = this.ref(n.section);
      const sv = this.tmp('section');
      this.emit(`${sv} = ${r.kind === 'bad' || r.kind === 'dyn' ? 'null' : this.get(r)}`);
      const truthy = `(${sv} != null && ${sv} != false && ${sv} != "" && ${sv} != [])`;
      this.open(`if ${n.inverted ? `!${truthy}` : truthy}`);
      walk(n.children);
      this.close();
    });
    walk(root.children);
    return acc;
  }
  // Valeur d’un processeur (set, append) : littéral, avec les modèles résolus dans les chaînes, à toute profondeur
  valueSource(v) {
    if (typeof v === 'string') return hasMustache(v) ? this.tpl(v) : vq(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (String(v).includes('.') || /e/i.test(String(v)) ? String(v) : String(v) + '.0');
    if (typeof v === 'boolean') return String(v);
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return `[${v.map(x => this.valueSource(x)).join(', ')}]`;
    return `{ ${Object.entries(v).map(([k, x]) => `${vq(k)}: ${this.valueSource(x)}`).join(', ')} }`;
  }
}

/*
 * Painless → VRL. Une expression compilée est { c: code, t: type } avec t parmi bool, str, int, num, null, list,
 * map ou any (inconnu). Le type évite les erreurs de compilation de VRL : une opération faillible sur une valeur
 * de type inconnu reçoit son « ?? », jamais une opération qui ne peut pas échouer (E651).
 */
const PL_INST = { double: 'is_float', float: 'is_float', long: 'is_integer', int: 'is_integer', short: 'is_integer', boolean: 'is_boolean', String: 'is_string', CharSequence: 'is_string', Map: 'is_object', HashMap: 'is_object', LinkedHashMap: 'is_object', List: 'is_array', ArrayList: 'is_array', Collection: 'is_array', Integer: 'is_integer', Long: 'is_integer', Short: 'is_integer', Double: 'is_float', Float: 'is_float', Boolean: 'is_boolean' };
Object.assign(IngestGen.prototype, {
  plStr(e) { return e.t === 'str' ? e.c : e.t === 'null' ? '""' : ['int', 'num', 'bool'].includes(e.t) ? `to_string(${e.c})` : `(to_string(${e.c}) ?? "")`; },
  plBool(e) { return e.t === 'bool' ? e.c : `(${e.c} == true)`; },
  plTmp(code, t) { const v = this.tmp('p'); this.emit(`${v} = ${code}`); return { c: v, t: t || 'any' }; },
  // Chemin de ctx : ctx.a.b, ctx['a.b'], ctx.a?.b ; null si l’expression n’en est pas un
  plPath(e) {
    const segs = []; let x = e; let unsafe = false;
    while (x.k === 'member' || x.k === 'index') {
      if (x.k === 'member') segs.unshift(x.name);
      else if (x.idx.k === 'str') segs.unshift(x.idx.v);
      else if (x.idx.k === 'num' && x.idx.int) segs.unshift(Number(x.idx.v));   // index de liste
      else return null;
      if (x.k === 'member' && !x.safe && (x.obj.k === 'member' || x.obj.k === 'index')) unsafe = true;
      x = x.obj;
    }
    if (x.k !== 'id' || x.v !== 'ctx') return null;
    return { segs, unsafe };
  },
  plRef(segs) { return segs.length === 1 && INGEST_META.includes(segs[0]) ? (this.t.uses.meta = true, { kind: 'meta', vrl: `%${segs[0]}`, path: segs[0] }) : { kind: 'field', segs, path: segs.join('.') }; },
  plExpr(e, env) {
    const self = this;
    const X = n => self.plExpr(n, env);
    switch (e.k) {
      case 'num': return { c: e.int ? String(Number(e.v)) : (/[.eE]/.test(e.v) ? (/^\d/.test(e.v) ? e.v : '0' + e.v) : e.v + '.0'), t: e.int ? 'int' : 'num' };
      case 'str': return { c: vq(e.v), t: 'str' };
      case 'bool': return { c: String(e.v), t: 'bool' };
      case 'null': return { c: 'null', t: 'null' };
      case 'list': {
        if (e.from) { const f = X(e.from); return { c: f.t === 'list' ? f.c : `(array(${f.c}) ?? [])`, t: 'list' }; }
        return { c: `[${e.items.map(i => X(i).c).join(', ')}]`, t: 'list' };
      }
      case 'map': {
        if (e.from) { const f = X(e.from); return { c: f.t === 'map' ? f.c : `(object(${f.c}) ?? {})`, t: 'map' }; }
        return { c: `{ ${e.items.map(([k, v]) => { if (k.k !== 'str') throw new Error('clé de table non littérale'); return `${vq(k.v)}: ${X(v).c}`; }).join(', ')} }`, t: 'map' };
      }
      case 'id': {
        if (e.v === 'ctx') return { c: '.', t: 'map' };
        if (env.locals.has(e.v)) return { c: `p_${e.v}`, t: env.locals.get(e.v) || 'any' };
        if (e.v === 'params') { env.usesParams = true; return { c: 'p_params', t: 'map' }; }
        throw new Error(`variable inconnue « ${e.v} »`);
      }
      case 'member': case 'index': {
        const path = this.plPath(e);
        if (path) {
          if (path.unsafe) env.unsafe = true;
          return { c: this.get(this.plRef(path.segs)), t: 'any' };
        }
        const o = X(e.obj);
        if (e.k === 'member' && e.name === 'length') return { c: `(length(${o.c}) ?? null)`, t: 'any' };
        const key = e.k === 'member' ? vq(e.name) : (() => { const i = X(e.idx); return i.t === 'int' ? i.c : i.t === 'str' ? i.c : `${i.c}`; })();
        return { c: `(get(${o.c}, [${key}]) ?? null)`, t: 'any' };
      }
      case 'un': {
        const a = X(e.e);
        if (e.op === '!') return { c: a.t === 'bool' ? `!${a.c}` : `!(${a.c} == true)`, t: 'bool' };
        if (e.op === '-') return a.t === 'int' || a.t === 'num' ? { c: `-${a.c}`, t: a.t } : { c: `((0 - ${a.c}) ?? null)`, t: 'any' };
        return a;
      }
      case 'inst': {
        const a = X(e.e); const fn = PL_INST[e.type];
        if (e.type === 'Number') return { c: `(is_integer(${a.c}) || is_float(${a.c}))`, t: 'bool' };
        if (e.type === 'Object' || e.type === 'def') return { c: `(${a.c} != null)`, t: 'bool' };
        if (!fn) throw new Error(`instanceof ${e.type} non pris en charge`);
        return { c: `${fn}(${a.c})`, t: 'bool' };
      }
      case 'cast': {
        const a = X(e.e);
        if (['int', 'long', 'short', 'byte', 'Integer', 'Long'].includes(e.type)) return a.t === 'int' ? a : { c: `(to_int(${a.c}) ?? null)`, t: 'any' };
        if (['double', 'float', 'Double', 'Float'].includes(e.type)) return a.t === 'num' ? a : { c: `(to_float(${a.c}) ?? null)`, t: 'any' };
        return a;
      }
      case 'tern': {
        const c = X(e.c); const a = X(e.a); const b = X(e.b);
        return this.plTmp(`if ${this.plBool(c)} { ${a.c} } else { ${b.c} }`, a.t === b.t ? a.t : 'any');
      }
      case 'elvis': { const a = X(e.a); const b = X(e.b); return this.plTmp(`if ${a.c} != null { ${a.c} } else { ${b.c} }`); }
      case 'bin': return this.plBin(e, env);
      case 'mcall': return this.plCall(e, env);
      case 'call': return this.plInline(e, env);
      case 're': throw new Error('expression régulière hors d’un =~');
    }
    throw new Error(`expression « ${e.k} » non prise en charge`);
  },
  plBin(e, env) {
    const op = e.op;
    if (op === '&&' || op === '||') { const a = this.plExpr(e.l, env); const b = this.plExpr(e.r, env); return { c: `(${this.plBool(a)} ${op} ${this.plBool(b)})`, t: 'bool' }; }
    if (op === '=~' || op === '==~') {
      const a = this.plExpr(e.l, env);
      if (e.r.k !== 're' && e.r.k !== 'str') throw new Error('=~ attend une expression régulière littérale');
      env.regex = true;
      const re = javaRe(e.r.v); const full = op === '==~' ? `^(?:${re})$` : re;
      return { c: a.t === 'str' ? `match(${a.c}, ${vraw(full, 'r')})` : `(is_string(${a.c}) && match(string!(${a.c}), ${vraw(full, 'r')}))`, t: 'bool' };
    }
    const a = this.plExpr(e.l, env); const b = this.plExpr(e.r, env);
    if (op === '==' || op === '===') return { c: `(${a.c} == ${b.c})`, t: 'bool' };
    if (op === '!=' || op === '!==') return { c: `(${a.c} != ${b.c})`, t: 'bool' };
    const num = x => x.t === 'int' || x.t === 'num';
    const known = num(a) && num(b);
    if (['<', '>', '<=', '>='].includes(op)) {
      env.compare = true;
      return { c: known ? `(${a.c} ${op} ${b.c})` : `((${a.c} ${op} ${b.c}) ?? false)`, t: 'bool' };
    }
    if (op === '+') {
      if (a.t === 'str' || b.t === 'str') return { c: `(${this.plStr(a)} + ${this.plStr(b)})`, t: 'str' };
      if (known) return { c: `(${a.c} + ${b.c})`, t: a.t === 'int' && b.t === 'int' ? 'int' : 'num' };
      return this.plTmp(`if is_string(${a.c}) || is_string(${b.c}) { ${this.plStr(a)} + ${this.plStr(b)} } else { (${a.c} + ${b.c}) ?? null }`);
    }
    if (['-', '*', '/', '%'].includes(op)) {
      if (op === '/') env.division = true;
      return known && op !== '/' && op !== '%' ? { c: `(${a.c} ${op} ${b.c})`, t: a.t === 'int' && b.t === 'int' ? 'int' : 'num' } : { c: `((${a.c} ${op} ${b.c}) ?? null)`, t: 'any' };
    }
    throw new Error(`opérateur « ${op} » non pris en charge`);
  },
  plCall(e, env) {
    const name = e.name; const args = () => e.args.map(a => this.plExpr(a, env));
    // Méthodes statiques courantes
    if (e.obj.k === 'id' && !env.locals.has(e.obj.v) && e.obj.v !== 'ctx' && e.obj.v !== 'params') {
      const cls = e.obj.v; const a = args();
      if ((cls === 'Integer' && name === 'parseInt') || (cls === 'Long' && name === 'parseLong')) return { c: `(to_int(${this.plStr(a[0])}) ?? null)`, t: 'any' };
      if ((cls === 'Double' && name === 'parseDouble') || (cls === 'Float' && name === 'parseFloat')) return { c: `(to_float(${this.plStr(a[0])}) ?? null)`, t: 'any' };
      if (cls === 'String' && name === 'valueOf') return { c: this.plStr(a[0]), t: 'str' };
      if (cls === 'Math' && ['abs', 'floor', 'ceil', 'round'].includes(name)) return { c: `(${name === 'round' ? 'round' : name}(${a[0].c}) ?? null)`, t: 'any' };
      if (cls === 'Math' && (name === 'max' || name === 'min')) return this.plTmp(`if ((${a[0].c} ${name === 'max' ? '>=' : '<='} ${a[1].c}) ?? false) { ${a[0].c} } else { ${a[1].c} }`);
      if (cls === 'Objects' && name === 'isNull') return { c: `(${a[0].c} == null)`, t: 'bool' };
      if (cls === 'Objects' && name === 'nonNull') return { c: `(${a[0].c} != null)`, t: 'bool' };
      throw new Error(`méthode ${cls}.${name} non prise en charge`);
    }
    // ctx.containsKey('a'), ctx.a.containsKey('b')
    const path = this.plPath(e.obj);
    const isRoot = e.obj.k === 'id' && e.obj.v === 'ctx';
    if ((isRoot || path) && name === 'containsKey' && e.args[0] && e.args[0].k === 'str') {
      const segs = (path ? path.segs : []).concat(e.args[0].v);
      return { c: `exists(${this.vpath(segs)})`, t: 'bool' };
    }
    if (name === 'getClass' || name === 'hashCode') throw new Error(`méthode ${name} non prise en charge`);
    const r = this.plExpr(e.obj, env); const a = args();
    const str = this.plStr(r);
    if (e.safe && path) env.safeCall = true;
    switch (name) {
      case 'contains':
        if (r.t === 'str') return { c: `contains(${r.c}, ${this.plStr(a[0])})`, t: 'bool' };
        if (r.t === 'list') return { c: `includes(${r.c}, ${a[0].c})`, t: 'bool' };
        return { c: `((is_array(${r.c}) && includes(array!(${r.c}), ${a[0].c})) || (is_string(${r.c}) && contains(string!(${r.c}), ${this.plStr(a[0])})))`, t: 'bool' };
      case 'startsWith': case 'endsWith': {
        const fn = name === 'startsWith' ? 'starts_with' : 'ends_with';
        return { c: r.t === 'str' ? `${fn}(${r.c}, ${this.plStr(a[0])})` : `(is_string(${r.c}) && ${fn}(string!(${r.c}), ${this.plStr(a[0])}))`, t: 'bool' };
      }
      case 'equals': return { c: `(${r.c} == ${a[0].c})`, t: 'bool' };
      case 'equalsIgnoreCase': return { c: `(is_string(${r.c}) && is_string(${a[0].c}) && downcase(string!(${r.c})) == downcase(string!(${a[0].c})))`, t: 'bool' };
      case 'isEmpty': return { c: `((is_string(${r.c}) && string!(${r.c}) == "") || (is_array(${r.c}) && length(array!(${r.c})) == 0) || (is_object(${r.c}) && length(object!(${r.c})) == 0))`, t: 'bool' };
      case 'size': return ['list', 'map'].includes(r.t) ? { c: `length(${r.c})`, t: 'int' } : { c: `(length(${r.c}) ?? null)`, t: 'any' };
      case 'length': return { c: r.t === 'str' ? `strlen(${r.c})` : `strlen(string(${r.c}) ?? "")`, t: 'int' };
      case 'toLowerCase': return { c: `downcase(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`})`, t: 'str' };
      case 'toUpperCase': return { c: `upcase(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`})`, t: 'str' };
      case 'trim': return { c: `replace(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, r'^[\\x00-\\x20]+|[\\x00-\\x20]+$', "")`, t: 'str' };
      case 'toString': return { c: str, t: 'str' };
      case 'substring': return { c: `(slice(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${a.map(x => x.c).join(', ')}) ?? null)`, t: 'any' };
      case 'indexOf': return { c: `find(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${this.plStr(a[0])})`, t: 'int' };
      case 'replace': return { c: `replace(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${this.plStr(a[0])}, ${this.plStr(a[1])})`, t: 'str' };
      case 'split': env.regex = true; return { c: `split(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${a[0].t === 'str' && e.args[0].k === 'str' ? vraw(javaRe(e.args[0].v), 'r') : a[0].c})`, t: 'list' };
      case 'get': return { c: `(get(${r.c}, [${a[0].c}]) ?? null)`, t: 'any' };
      case 'keySet': return { c: r.t === 'map' ? `keys(${r.c})` : `keys(object(${r.c}) ?? {})`, t: 'list' };
      case 'values': return { c: r.t === 'map' ? `values(${r.c})` : `values(object(${r.c}) ?? {})`, t: 'list' };
      case 'containsKey': return { c: `(is_object(${r.c}) && includes(keys(object!(${r.c})), ${a[0].c}))`, t: 'bool' };
      case 'entrySet': {
        const v = this.tmp('p'); this.emit(`${v} = []`);
        this.open(`for_each(object(${r.c}) ?? {}) -> |_k, _v|`);
        this.emit(`${v} = push(${v}, { "key": _k, "value": _v })`);
        this.close();
        return { c: v, t: 'list' };
      }
      case 'getKey': return { c: `(get(${r.c}, ["key"]) ?? null)`, t: 'any' };
      case 'getValue': return { c: `(get(${r.c}, ["value"]) ?? null)`, t: 'any' };
      case 'splitOnToken': return { c: `split(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${this.plStr(a[0])})`, t: 'list' };
      case 'lastIndexOf': {
        const sv = this.plTmp(r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`, 'str'); const xv = this.plTmp(this.plStr(a[0]), 'str');
        const parts = this.plTmp(`split(${sv.c}, ${xv.c})`, 'list');
        return this.plTmp(`if length(${parts.c}) > 1 { strlen(${sv.c}) - strlen(${xv.c}) - strlen(string(${parts.c}[-1]) ?? "") } else { -1 }`, 'any');
      }
      case 'charAt': return { c: `(slice(${r.t === 'str' ? r.c : `(string(${r.c}) ?? "")`}, ${a[0].c}, ${a[0].c} + 1) ?? null)`, t: 'any' };
      case 'intValue': case 'longValue': return { c: `(to_int(${r.c}) ?? null)`, t: 'any' };
      case 'getOrDefault': return this.plTmp(`if (get(${r.c}, [${a[0].c}]) ?? null) != null { get(${r.c}, [${a[0].c}]) ?? null } else { ${a[1].c} }`);
    }
    throw new Error(`méthode « ${name} » non prise en charge`);
  },

  /* Instructions d’un script */
  plStmts(list, env) { for (const s of list) this.plStmt(s, env); },
  // Après un return, un break ou un continue possibles, les instructions suivantes sont gardées par leur drapeau
  plStmt(s, env) {
    const g = [];
    if (env.retVar && env.retPossible) g.push(`!${env.retVar}`);
    const loop = env.loops && env.loops[env.loops.length - 1];
    if (loop && loop.brkPossible) g.push(`!${loop.brk}`);
    if (loop && loop.cntPossible) g.push(`!${loop.cnt}`);
    if (g.length && s.k !== 'nop') { this.open(`if ${g.join(' && ')}`); this.plStmtInner(s, env); this.close(); }
    else this.plStmtInner(s, env);
  },
  plLoop(s, env, listCode, idx) {
    env.loops = env.loops || [];
    const loop = { brk: this.tmp('brk'), cnt: this.tmp('cnt') };
    const prev = env.locals.get(s.name);
    env.locals.set(s.name, idx ? 'int' : 'any');
    this.emit(`${loop.brk} = false`);
    this.open(`for_each(${listCode}) -> |${idx ? `p_${s.name}, _v` : `_i, p_${s.name}`}|`);
    this.emit(`${loop.cnt} = false`);
    env.loops.push(loop);
    this.open(`if !${loop.brk}`);
    this.plStmt(s.body, env);
    this.close();
    env.loops.pop();
    this.close();
    if (prev === undefined) env.locals.delete(s.name); else env.locals.set(s.name, prev);
  },
  plStmtInner(s, env) {
    switch (s.k) {
      case 'nop': return;
      case 'block': return this.plStmts(s.body, env);
      case 'let': { const v = s.v ? this.plExpr(s.v, env) : { c: 'null', t: 'null' }; env.locals.set(s.name, v.t === 'null' ? 'any' : v.t); this.emit(`p_${s.name} = ${v.c}`); return; }
      case 'set': return this.plAssign(s.target, this.plExpr(s.v, env), env);
      case 'if': {
        const c = this.plExpr(s.c, env);
        this.open(`if ${this.plBool(c)}`);
        const before = env.retPossible;
        this.plStmt(s.th, env);
        if (s.el) { this.close('} else {'); this.ind++; this.plStmt(s.el, env); }
        this.close();
        if (env.retPossible && !before) env.retPossible = true;
        return;
      }
      case 'for': case 'forIdx': {
        const l = this.plExpr(s.list, env);
        // Une table parcourue (map.values(), keySet()) l’est comme une liste ; un ctx.a qui n’est pas une liste : aucun tour
        return this.plLoop(s, env, l.t === 'list' ? l.c : `array(${l.c}) ?? []`, s.k === 'forIdx');
      }
      case 'try': {
        this.approx('Painless : try/catch', 'Le bloc try est traduit, pas le catch : là où Painless lèverait une exception (conversion impossible, valeur nulle), la traduction donne une valeur nulle et continue.');
        this.plStmts(s.body, env); this.plStmts(s.fin, env); return;
      }
      case 'break': case 'continue': {
        const loop = env.loops && env.loops[env.loops.length - 1];
        if (!loop) throw new Error(`${s.k} hors d’une boucle`);
        this.emit(`${s.k === 'break' ? loop.brk : loop.cnt} = true`);
        if (s.k === 'break') loop.brkPossible = true; else loop.cntPossible = true;
        return;
      }
      case 'ret': {
        if (env.res || env.cond) { const v = s.v ? this.plExpr(s.v, env) : { c: 'null', t: 'null' }; this.emit(`${env.res || env.cond} = ${v.c}`); }
        this.emit(`${env.retVar} = true`); env.retPossible = true;
        // Un return dans une boucle l’arrête, ainsi que les boucles qui l’entourent
        for (const loop of env.loops || []) { this.emit(`${loop.brk} = true`); loop.brkPossible = true; }
        return;
      }
      case 'expr': {
        const e = s.e;
        if (e.k === 'mcall' && ['add', 'put', 'remove', 'addAll', 'clear', 'putAll'].includes(e.name)) return this.plMutate(e, env);
        if (env.cond && !env.res) { const v = this.plExpr(e, env); this.emit(`${env.cond} = ${v.c}`); return; }
        // Une expression sans effet (appel de méthode qui ne modifie rien) : évaluée pour rien en Painless
        this.plExpr(e, env); return;
      }
    }
    throw new Error(`instruction « ${s.k} » non prise en charge`);
  },
  plAssign(target, v, env) {
    const path = this.plPath(target);
    if (path) { if (path.unsafe) env.unsafe = true; return this.set(this.plRef(path.segs), v.c); }
    if (target.k === 'id') {
      if (target.v === 'ctx') throw new Error('ctx ne peut pas être remplacé');
      if (!env.locals.has(target.v)) env.locals.set(target.v, v.t);
      this.emit(`p_${target.v} = ${v.c}`); return;
    }
    // Variable locale de type table ou liste : m.k = v, m['k'] = v, l[0] = v
    let x = target; const segs = [];
    while (x.k === 'member' || x.k === 'index') { segs.unshift(x.k === 'member' ? vq(x.name) : this.plExpr(x.idx, env).c); x = x.obj; }
    if (x.k === 'id' && env.noMutate && env.noMutate.has(x.v)) throw new Error('fonction qui modifie un de ses arguments (passage par référence non pris en charge)');
    if (x.k === 'id' && env.locals.has(x.v)) { this.emit(`p_${x.v} = set!(p_${x.v}, [${segs.join(', ')}], ${v.c})`); return; }
    throw new Error('affectation non prise en charge');
  },
  // Appel d’une fonction déclarée dans le script : son corps est recopié sur place, variables renommées
  plInline(e, env) {
    const fn = env.fns && env.fns.get(e.name);
    if (!fn) throw new Error(`fonction « ${e.name} » non prise en charge`);
    if ((env.stack || []).includes(e.name)) throw new Error(`fonction « ${e.name} » récursive : non prise en charge`);
    if (e.args.length !== fn.params.length) throw new Error(`fonction « ${e.name} » appelée avec ${e.args.length} argument(s) pour ${fn.params.length} attendu(s)`);
    const args = e.args.map(a => this.plExpr(a, env));
    const n = ++this.t.k; const names = new Set(fn.params);
    const collect = x => { if (Array.isArray(x)) x.forEach(collect); else if (x && typeof x === 'object') { if ((x.k === 'let' || x.k === 'for' || x.k === 'forIdx') && x.name) names.add(x.name); Object.values(x).forEach(collect); } };
    collect(fn.body);
    const ren = x => Array.isArray(x) ? x.map(ren) : x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, (k === 'v' && x.k === 'id' && names.has(v)) || (k === 'name' && ['let', 'for', 'forIdx'].includes(x.k) && names.has(v)) ? `${v}_f${n}` : ren(v)]))
      : x;
    const body = ren(fn.body);
    const env2 = { locals: new Map(), retVar: this.tmp('ret'), res: this.tmp('res'), fns: env.fns, stack: (env.stack || []).concat(e.name), loops: [], noMutate: new Set(fn.params.map(x => `${x}_f${n}`)) };
    fn.params.forEach((x, i) => { env2.locals.set(`${x}_f${n}`, args[i].t === 'null' ? 'any' : args[i].t); this.emit(`p_${x}_f${n} = ${args[i].c}`); });
    this.emit(`${env2.res} = null`); this.emit(`${env2.retVar} = false`);
    this.plStmts(body, env2);
    if (env2.usesParams) env.usesParams = true;
    if (env2.unsafe) env.unsafe = true;
    return { c: env2.res, t: 'any' };
  },
  plMutate(e, env) {
    if (e.obj.k === 'id' && env.noMutate && env.noMutate.has(e.obj.v)) throw new Error('fonction qui modifie un de ses arguments (passage par référence non pris en charge)');
    const a = e.args.map(x => this.plExpr(x, env));
    const path = this.plPath(e.obj);
    const isRoot = e.obj.k === 'id' && e.obj.v === 'ctx';
    const local = e.obj.k === 'id' && env.locals.has(e.obj.v) ? `p_${e.obj.v}` : null;
    if (!path && !isRoot && !local) throw new Error(`${e.name} sur une expression qui n’est ni un champ ni une variable`);
    const segs = path ? path.segs : [];
    const target = local || (isRoot ? '.' : this.vpath(segs));
    switch (e.name) {
      case 'add': { if (isRoot) break; const cur = this.plTmp(local || this.get(this.plRef(segs))); const arr = this.tmp('p'); this.emit(`${arr} = if is_array(${cur.c}) { array!(${cur.c}) } else { [] }`); this.emit(`${target} = push(${arr}, ${a[0].c})`); return; }
      case 'addAll': { if (isRoot) break; const cur = this.plTmp(local || this.get(this.plRef(segs))); const arr = this.tmp('p'); const add = this.tmp('p'); this.emit(`${arr} = if is_array(${cur.c}) { array!(${cur.c}) } else { [] }`); this.emit(`${add} = if is_array(${a[0].c}) { array!(${a[0].c}) } else { [] }`); this.emit(`${target} = append(${arr}, ${add})`); return; }
      case 'clear': if (isRoot) break; this.emit(`${target} = if is_array(${target}) { [] } else { {} }`); return;
      case 'put': {
        if (local) { this.emit(`${local} = set!(${local}, [${this.plStr(a[0])}], ${a[1].c})`); return; }
        if (e.args[0].k !== 'str') throw new Error('put avec une clé calculée non pris en charge');
        return this.set(this.plRef(segs.concat(e.args[0].v)), a[1].c);
      }
      case 'putAll': if (local) { this.emit(`${local} = merge(${local}, object(${a[0].c}) ?? {})`); return; } this.emit(`${target} = merge(object(${this.get(this.plRef(segs))}) ?? {}, object(${a[0].c}) ?? {})`); return;
      case 'remove': {
        if (local) { this.emit(`${local} = remove!(${local}, [${a[0].c}])`); return; }
        if (e.args[0].k !== 'str') throw new Error('remove avec une clé calculée non pris en charge');
        this.emit(`del(${this.vpath(segs.concat(e.args[0].v))})`); return;
      }
    }
    throw new Error(`${e.name} sur ctx non pris en charge`);
  },
  // Condition « if » d’un processeur : expression ou script, rendue dans une variable booléenne
  plCondition(src) {
    const prog = ingPainless(src);
    const env = { locals: new Map(), cond: this.tmp('cond'), retVar: this.tmp('ret'), fns: prog.fns };
    const single = prog.length === 1 && prog[0].k === 'expr' ? prog[0].e : prog.length === 1 && prog[0].k === 'ret' && prog[0].v ? prog[0].v : null;
    if (single) {
      const v = this.plExpr(single, env);
      // Une condition qui rend null (appel ?. sur une valeur absente) fait échouer le processeur dans Elasticsearch
      this.emit(`${env.cond} = ${v.c}`);
      return { v: env.cond, env, nullable: !!(single.k === 'mcall' && single.safe && v.t === 'bool') ? single : null };
    }
    this.emit(`${env.cond} = null`); this.emit(`${env.retVar} = false`);
    this.plStmts(prog, env);
    return { v: env.cond, env };
  }
});

/* ---------- Processeurs ---------- */
// Options communes à tous les processeurs, lues par la séquence
const INGEST_COMMON = ['if', 'ignore_failure', 'on_failure', 'tag', 'description'];
Object.assign(IngestGen.prototype, {
  /*
   * Une suite de processeurs. ok dit si le pipeline continue ; sur un échec non rattrapé, ok passe à false et
   * failVar reçoit le message. Chaque processeur écrit son échec éventuel dans fail.
   */
  seq(list, where, okVar, failVar) {
    (list || []).forEach((p, k) => this.processor(p, `${where}[${k}]`, okVar, failVar));
  },
  processor(p, where, okVar, failVar) {
    if (!isObj(p) || Object.keys(p).length !== 1) { this.ko(where, 'un processeur est un objet à une seule clé, son type'); return; }
    const [type, o0] = Object.entries(p)[0];
    const o = isObj(o0) ? o0 : {};
    const tag = o.tag !== undefined ? String(o.tag) : null;
    const label = `${where} ${type}${tag ? ` (${tag})` : ''}`;
    this.t.processors++;
    if (this.ind === 0) this.marks.push(this.lines.length);   // point de coupure possible entre deux transforms
    this.emit('');
    this.comment(`${label}${o.description ? ` — ${String(o.description).split('\n')[0]}` : ''}`);
    // Appel de pipeline au niveau de la suite principale : ses processeurs sont écrits à plat, à la suite, pour
    // pouvoir être répartis sur plusieurs transforms ; la garde est portée par ok_N (faux tant que l’appel n’a pas lieu)
    const flat = type === 'pipeline' && this.ind === 0 ? this.flatPipelineInfo(o) : null;
    if (flat) { this.emit(`${flat.ok} = false`); this.emit(`${flat.ech} = null`); }
    this.open(`if ${okVar}`);
    this.emit('fail = null');
    const ctx = { quiet: o.ignore_failure === true || o.ignore_failure === 'true' };
    this.diags.push(ctx);
    // Condition : une erreur du script ou un résultat nul font échouer le processeur, comme dans Elasticsearch
    let condOpen = false;
    if (o.if !== undefined && o.if !== null) {
      const src = isObj(o.if) ? o.if.source : o.if;
      if (isObj(o.if) && o.if.lang && o.if.lang !== 'painless') { this.ko(label, `condition en langage ${o.if.lang}`); this.diags.pop(); this.close(); return; }
      if (isObj(o.if) && isObj(o.if.params)) this.emit(`p_params = ${this.valueSource(o.if.params)}`);
      let c; const at = this.lines.length;
      try { c = this.plCondition(String(src)); }
      catch (e) { this.ko(label, `condition Painless « ${String(src).slice(0, 120)} » : ${e.message}`); this.diags.pop(); this.close(); return; }
      this.condNotes(c.env);
      if (c.env.usesParams && !(isObj(o.if) && isObj(o.if.params))) this.lines.splice(at, 0, '  '.repeat(this.ind) + 'p_params = {}');
      if (c.nullable) {
        const recv = this.plPath(c.nullable.obj);
        if (recv) this.emit(`if ${this.get(this.plRef(recv.segs))} == null { fail = ${vq(`cannot convert null to boolean (condition « ${String(src)} »)`)} }`);
      }
      this.open(`if fail == null && ${c.v} == true`);
      condOpen = true;
    }
    const before = this.t.stats.ko;
    if (flat) this.pipelineEnter(flat); else this.dispatch(type, o, label, okVar, failVar);
    if (condOpen) this.close();
    this.diags.pop();
    if (flat) {
      this.close();
      this.pipelineFlat(flat);
      this.open(`if ${okVar}`);
      this.emit(`ingest_pipeline = ${vq(this.pipeline)}`);
      this.emit(`fail = ${flat.ech}`);
    }
    const translated = this.t.stats.ko === before;
    // Échec : ignoré, rattrapé par on_failure, ou remonté au pipeline
    if (translated) {
      this.open('if fail != null');
      if (o.ignore_failure === true || o.ignore_failure === 'true') this.emit('fail = null');
      else {
        this.emit('ingest_on_failure_message = fail');
        this.emit(`ingest_on_failure_processor_type = ${vq(type)}`);
        this.emit(`ingest_on_failure_processor_tag = ${tag === null ? 'null' : vq(tag)}`);
        this.emit(`ingest_on_failure_pipeline = ${vq(this.pipeline)}`);
        if (Array.isArray(o.on_failure) && o.on_failure.length) {
          this.materialize(['fail']);
          this.emit('ingest_on_failure_message = fail');
          const ok2 = this.tmp('ok'); const f2 = this.tmp('echec');
          this.emit(`${ok2} = true`); this.emit(`${f2} = null`);
          this.seq(o.on_failure, `${where}.on_failure`, ok2, f2);
          this.emit(`if !${ok2} { ${okVar} = false; ${failVar} = ${f2} }`);
        } else { this.emit(`${okVar} = false`); this.emit(`${failVar} = fail`); }
      }
      this.close();
    }
    this.close();
  },
  // Appel de pipeline traduisible à plat : le pipeline est connu et ne s’appelle pas lui-même
  flatPipelineInfo(o) {
    if (o.name === undefined) return null;
    const pkgRef = ingestPipelineRef(o.name);
    if (!pkgRef && hasMustache(o.name)) return null;
    const name = pkgRef || String(o.name);
    const def = this.t.defs.get(name);
    if (!def || this.t.stack.includes(name)) return null;
    const ok = this.tmp('ok'); const ech = this.tmp('echec');
    (this.t.carry = this.t.carry || []).push({ v: ok, kind: 'bool' }, { v: ech, kind: 'str' });
    return { name, def, ok, ech };
  },
  pipelineEnter(f) {
    this.comment(`début du pipeline ${f.name}`);
    this.emit(`${f.ok} = true`); this.emit(`${f.ech} = null`);
    this.emit(`ingest_pipeline = ${vq(f.name)}`);
  },
  pipelineFlat(f) {
    this.t.called.add(f.name); this.t.stack.push(f.name);
    const prev = this.pipeline; this.pipeline = f.name;
    this.seq(f.def.processors, `${f.name}.processors`, f.ok, f.ech);
    this.pipelineFailure(f.def, f.name, f.ok, f.ech, 'fail');
    this.comment(`fin du pipeline ${f.name}`);
    this.pipeline = prev; this.t.stack.pop();
    this.t.stats.ok++;
  },
  condNotes(env) {
    if (env.unsafe) this.approx('Painless : accès sans ?.', 'Une condition ou un script lit ctx.a.b sans l’opérateur ?. : Painless échoue si ctx.a est absent (le document part en on_failure), la traduction tient la valeur pour nulle et continue.');
    if (env.compare) this.note('info', 'Painless : comparaisons', 'Une comparaison <, >, <= ou >= entre valeurs qui ne sont pas des nombres fait échouer Painless ; la traduction la tient pour fausse.');
    if (env.division) this.approx('Painless : division', 'Une division entre deux entiers donne un entier en Painless, un nombre décimal en VRL.');
  },
  dispatch(type, o, label, okVar, failVar) {
    const fn = this[`p_${type}`];
    if (!fn) { this.ko(label, INGEST_UNSUPPORTED[type] || `processeur ${type} inconnu de la traduction`); return; }
    const known = INGEST_OPTIONS[type];
    if (known) {
      const extra = Object.keys(o).filter(k => !INGEST_COMMON.includes(k) && !known.includes(k));
      if (extra.length) this.approx(`${type} : option${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`, `${label} : ${extra.join(', ')} ${extra.length > 1 ? 'ne sont pas reprises' : 'n’est pas reprise'} par la traduction.`);
    }
    // Une construction non rendable lève IngestUnsupported : ce qui a été écrit pour ce processeur est retiré
    const at = this.lines.length; const saved = { ind: this.ind, diags: this.diags.length, stack: this.t.stack.length, value: this.value, key: this.key, pipeline: this.pipeline, marks: this.marks.length };
    try { fn.call(this, o, label, okVar, failVar); }
    catch (e) {
      if (!(e instanceof IngestUnsupported)) throw e;
      this.lines.length = at; this.ind = saved.ind; this.diags.length = saved.diags; this.t.stack.length = saved.stack;
      this.value = saved.value; this.key = saved.key; this.pipeline = saved.pipeline; this.marks.length = saved.marks;
      this.ko(label, e.message);
    }
  }
});
// Options lues par chaque processeur traduit (les autres sont signalées)
const INGEST_OPTIONS = {
  set: ['field', 'value', 'copy_from', 'override', 'ignore_empty_value', 'media_type'],
  remove: ['field', 'keep', 'ignore_missing'],
  rename: ['field', 'target_field', 'ignore_missing', 'override'],
  append: ['field', 'value', 'copy_from', 'allow_duplicates', 'ignore_empty_values', 'media_type'],
  convert: ['field', 'type', 'target_field', 'ignore_missing'],
  lowercase: ['field', 'target_field', 'ignore_missing'], uppercase: ['field', 'target_field', 'ignore_missing'], trim: ['field', 'target_field', 'ignore_missing'],
  urldecode: ['field', 'target_field', 'ignore_missing'], html_strip: ['field', 'target_field', 'ignore_missing'],
  split: ['field', 'separator', 'target_field', 'ignore_missing', 'preserve_trailing'],
  gsub: ['field', 'pattern', 'replacement', 'target_field', 'ignore_missing'],
  join: ['field', 'separator', 'target_field'],
  json: ['field', 'target_field', 'add_to_root', 'add_to_root_conflict_strategy', 'allow_duplicate_keys', 'strict_json_parsing'],
  date: ['field', 'target_field', 'formats', 'timezone', 'locale', 'output_format'],
  grok: ['field', 'patterns', 'pattern_definitions', 'ignore_missing', 'trace_match', 'ecs_compatibility'],
  dissect: ['field', 'pattern', 'append_separator', 'ignore_missing'],
  kv: ['field', 'field_split', 'value_split', 'target_field', 'include_keys', 'exclude_keys', 'ignore_missing', 'prefix', 'trim_key', 'trim_value', 'strip_brackets'],
  dot_expander: ['field', 'path', 'override'],
  drop: [], fail: ['message'], terminate: [],
  pipeline: ['name', 'ignore_missing_pipeline'],
  foreach: ['field', 'processor', 'ignore_missing'],
  bytes: ['field', 'target_field', 'ignore_missing'],
  script: ['source', 'lang', 'params', 'id'],
  uri_parts: ['field', 'target_field', 'keep_original', 'remove_if_successful', 'ignore_missing'],
  registered_domain: ['field', 'target_field', 'ignore_missing'],
  community_id: ['source_ip', 'source_port', 'destination_ip', 'destination_port', 'iana_number', 'icmp_type', 'icmp_code', 'transport', 'target_field', 'seed', 'ignore_missing'],
  user_agent: ['field', 'target_field', 'properties', 'ignore_missing', 'extract_device_type', 'regex_file'],
  geoip: ['field', 'target_field', 'database_file', 'properties', 'ignore_missing', 'first_only', 'download_database_on_pipeline_creation'],
  csv: ['field', 'target_fields', 'separator', 'quote', 'trim', 'empty_value', 'ignore_missing'],
  reroute: ['destination', 'dataset', 'namespace'],
  fingerprint: ['fields', 'target_field', 'method', 'salt', 'ignore_missing']
};
// Processeurs sans traduction : la raison donnée au rapport
const INGEST_UNSUPPORTED = {
  enrich: 'enrich interroge un index d’enrichissement d’Elasticsearch : à remplacer par une table d’enrichissement Vector (CSV, MaxMind) ou un dictionnaire ClickHouse.',
  inference: 'inference appelle un modèle de machine learning d’Elasticsearch : aucun équivalent dans Vector.',
  attachment: 'attachment extrait le texte de documents (Tika) : aucun équivalent dans Vector.',
  set_security_user: 'set_security_user lit l’utilisateur authentifié par Elasticsearch : sans objet hors d’Elasticsearch.',
  circle: 'circle convertit des formes géographiques : aucun équivalent dans Vector.',
  geo_grid: 'geo_grid calcule des cellules géographiques : aucun équivalent dans Vector.',
  sort: 'sort trie une liste : VRL n’a pas de fonction de tri.',
  network_direction: 'network_direction classe les adresses selon des réseaux nommés : à reprendre avec ip_cidr_contains.',
  redact: 'redact masque des motifs grok : à reprendre avec redact ou replace en VRL.',
  cef: 'cef lit le format Common Event Format : à reprendre avec parse_cef.',
  date_index_name: 'date_index_name calcule le nom d’index : sans objet avec ClickHouse, la table est fixée par la configuration.',
  ip_location: 'ip_location : à reprendre avec une table d’enrichissement geoip de Vector.',
  normalize_for_stream: 'normalize_for_stream réécrit le document au format OpenTelemetry : à reprendre.',
  recover_failure_document: 'recover_failure_document reprend un document du failure store : sans objet.',
  terminate: null
};
Object.assign(IngestGen.prototype, {
  field(o, label, name) {
    const n = name || 'field';
    if (o[n] === undefined || o[n] === null || o[n] === '') { this.ko(label, `option ${n} absente : Elasticsearch refuse le processeur`); return null; }
    const r = this.ref(o[n]);
    if (r.kind === 'bad') { this.ko(label, r.why); return null; }
    return r;
  },
  bool(v, dflt) { return v === undefined || v === null ? dflt : v === true || v === 'true'; },

  p_set(o, label) {
    const r = this.field(o, label); if (!r) return;
    const override = this.bool(o.override, true); const ignoreEmpty = this.bool(o.ignore_empty_value, false);
    if (o.copy_from === undefined && o.value === undefined) return this.ko(label, 'ni value ni copy_from');
    const write = () => {
      if (o.copy_from !== undefined) {
        // getFieldValue(copy_from, Object.class, ignore_empty_value) : un champ absent ne fait échouer que sans ignore_empty_value
        this.read(this.ref(o.copy_from), 'v', ignoreEmpty);
        this.open(ignoreEmpty ? 'if fail == null && v != null && v != ""' : 'if fail == null');
        this.set(r, 'v'); this.close();
      } else {
        const templated = hasMustache(JSON.stringify(o.value));
        const expr = this.valueSource(o.value);
        if (ignoreEmpty && templated) { this.emit(`v = ${expr}`); this.open('if v != null && v != ""'); this.set(r, 'v'); this.close(); }
        else this.set(r, expr);
      }
    };
    if (override) write();
    else { this.open(`if !(${this.has(r)}) || ${this.get(r)} == null`); write(); this.close(); }
    this.t.stats.ok++;
  },
  p_remove(o, label) {
    if (o.keep !== undefined) {
      const keep = lsList(o.keep).map(String);
      // keep : tout champ qui n’est ni gardé ni sur le chemin d’un champ gardé est retiré
      this.emit(`kept = {}`);
      for (const k of keep) { const r = this.ref(k); if (r.kind !== 'field') return this.ko(label, `keep « ${k} »`); this.emit(`if ${this.has(r)} { kept = set!(kept, ${this.arr(r.segs)}, ${this.get(r)}) }`); }
      this.emit('. = kept');
      this.t.stats.ok++; return;
    }
    const fields = lsList(o.field);
    if (!fields.length) return this.ko(label, 'option field absente');
    const ignore = this.bool(o.ignore_missing, false);
    for (const f of fields) {
      const r = this.ref(f);
      if (r.kind === 'bad') return this.ko(label, r.why);
      if (fields.length > 1 && !ignore) { this.open('if fail == null'); this.del(r, ignore); this.close(); } else this.del(r, ignore);
    }
    this.t.stats.ok++;
  },
  p_rename(o, label) {
    const r = this.field(o, label); if (!r) return;
    const tr = this.field(o, label, 'target_field'); if (!tr) return;
    const ignore = this.bool(o.ignore_missing, false); const override = this.bool(o.override, false);
    this.open(`if !(${this.has(r)})`);
    if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] doesn't exist`)}`);
    this.close(`} else if ${override ? 'false' : this.has(tr)} {`); this.ind++;
    this.emit(`fail = ${vq(`field [${tr.path}] already exists`)}`);
    this.close('} else {'); this.ind++;
    this.emit(`v = ${this.get(r)}`);
    this.del(r, true);
    this.set(tr, 'v');
    // Écriture impossible : la valeur retourne à sa place, comme dans Elasticsearch
    this.open('if fail != null'); this.set(r, 'v'); this.close();
    this.close();
    this.t.stats.ok++;
  },
  p_append(o, label) {
    const r = this.field(o, label); if (!r) return;
    const dup = this.bool(o.allow_duplicates, true); const ignoreEmpty = this.bool(o.ignore_empty_values, false);
    if (o.copy_from !== undefined) { const src = this.ref(o.copy_from); this.read(src, 'add'); }
    else if (o.value === undefined) return this.ko(label, 'ni value ni copy_from');
    else this.emit(`add = ${this.valueSource(o.value)}`);
    this.open('if fail == null');
    this.emit('adds = if is_array(add) { array!(add) } else { [add] }');
    this.emit(`old = ${this.get(r)}`);
    this.emit(`had = ${this.has(r)}`);
    this.emit('list = if had { if is_array(old) { array!(old) } else { [old] } } else { [] }');
    this.emit('n = length(list)');
    this.open('for_each(adds) -> |_i, x|');
    this.emit(`if ${dup ? 'true' : '!includes(list, x)'} && ${ignoreEmpty ? '(x != null && x != "")' : 'true'} { list = push(list, x) }`);
    this.close();
    // Rien d’ajouté (doublons, valeurs vides) : le champ reste tel quel
    this.open('if length(list) != n'); this.set(r, 'list'); this.close();
    this.close();
    this.t.stats.ok++;
  },
  // Lecture commune des processeurs « une valeur, chaîne ou liste de chaînes »
  strProc(o, label, fn) {
    const r = this.field(o, label); if (!r) return;
    const tr = o.target_field !== undefined ? this.ref(o.target_field) : r;
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.emit('out = null');
    this.open('if v == null');
    if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot process it.`)}`);
    this.close('} else if is_string(v) {'); this.ind++;
    this.emit(`out = ${fn('string!(v)')}`);
    this.close('} else if is_array(v) {'); this.ind++;
    this.emit('out = []');
    this.open('for_each(array!(v)) -> |_i, x|');
    this.open('if fail == null');
    this.open('if is_string(x)'); this.emit(`one = ${fn('string!(x)')}`); this.emit('if fail == null { out = push(out, one) }');
    this.close('} else {'); this.ind++;
    this.jtype('jt', 'x');
    this.emit(`xs = ${jstrOf('x')}`);
    this.emit(`fail = "value [" + xs + "] of type [" + jt + "] in list field [" + ${vq(r.path)} + "] cannot be cast to [java.lang.String]"`);
    this.close(); this.close(); this.close();
    this.close('} else {'); this.ind++;
    this.failCast('v', r.path, 'java.lang.String');
    this.close();
    this.emit('if fail == null && v != null {'); this.ind++; this.set(tr, 'out'); this.close();
    this.close();
  },
  p_lowercase(o, label) { this.strProc(o, label, x => `downcase(${x})`); this.t.stats.ok++; },
  p_uppercase(o, label) { this.strProc(o, label, x => `upcase(${x})`); this.t.stats.ok++; },
  // String.trim de Java : retire les caractères de code inférieur ou égal à l’espace
  p_trim(o, label) { this.strProc(o, label, x => `replace(${x}, r'^[\\x00-\\x20]+|[\\x00-\\x20]+$', "")`); this.t.stats.ok++; },
  p_urldecode(o, label) {
    this.strProc(o, label, x => `decode_percent(replace(${x}, "+", " "))`);
    this.note('info', 'urldecode → decode_percent', 'URLDecoder de Java lit + comme une espace, ce que fait la traduction ; une séquence %xx invalide fait échouer Elasticsearch, VRL la garde.');
    this.t.stats.ok++;
  },
  p_html_strip(o, label) {
    this.strProc(o, label, x => `replace(${x}, r'<[^>]*>', "")`);
    this.approx('html_strip', 'Les balises sont retirées par une expression régulière : Elasticsearch décode aussi les entités (&amp;…) et retire le contenu des <script> et <style>.');
  },
  // ByteSizeValue : un nombre suivi d’une unité (b, kb, mb, gb, tb, pb ou leur initiale), puissances de 1024 ;
  // 0 et -1 s’écrivent sans unité. Une valeur décimale est tronquée, comme le fait Elasticsearch.
  p_bytes(o, label) {
    this.strProc(o, label, x => {
      this.emit(`bm = parse_regex(downcase(strip_whitespace(${x})), r'^(?P<n>-?\d+(?:\.\d+)?)\s*(?P<u>b|kb|k|mb|m|gb|g|tb|t|pb|p)?$') ?? null`);
      this.emit(`bn = null`);
      this.open('if bm == null || (bm.u == null && bm.n != "0" && bm.n != "-1")');
      this.emit(`fail = "failed to parse setting [Ingest Field] with value [" + ${x} + "] as a size in bytes: unit is missing or unrecognized"`);
      this.close('} else {'); this.ind++;
      this.emit('mult = if bm.u == null { 1 } else { get!({ "b": 1, "k": 1024, "kb": 1024, "m": 1048576, "mb": 1048576, "g": 1073741824, "gb": 1073741824, "t": 1099511627776, "tb": 1099511627776, "p": 1125899906842624, "pb": 1125899906842624 }, [bm.u]) }');
      this.emit('bn = to_int((to_float(bm.n) ?? 0.0) * (to_float(mult) ?? 1.0))');
      this.close();
      return 'bn';
    });
    this.note('info', 'bytes', 'Une valeur décimale (1.5kb) est acceptée par Elasticsearch avec un avertissement de dépréciation, et tronquée à l’octet : la traduction fait de même.');
    this.t.stats.ok++;
  },
  p_convert(o, label) {
    const r = this.field(o, label); if (!r) return;
    const type = String(o.type || '');
    if (!['integer', 'long', 'float', 'double', 'string', 'boolean', 'ip', 'auto'].includes(type)) return this.ko(label, `type « ${type} » inconnu`);
    const tr = o.target_field !== undefined ? this.ref(o.target_field) : r;
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.emit('res = null');
    this.open('if v == null');
    if (!ignore) this.emit(`fail = ${vq(`Field [${r.path}] is null, cannot be converted to type [${type}]`)}`);
    this.close('} else {'); this.ind++;
    // Conversion d’une valeur (x) vers y ; un échec écrit fail
    const one = (x, y) => {
      // Texte de la valeur comme Object.toString de Java (un flottant entier s’écrit « 1.0 »)
      this.emit(`s = ${jstrOf(x)}`);
      const intConv = (max, word) => {
        this.emit(`n = if starts_with(s, "0x") || starts_with(s, "-0x") { parse_int(replace(s, "0x", ""), base: 16) ?? null } else if match(s, r'^[+-]?[0-9]+$') { to_int(s) ?? null } else { null }`);
        // Les entiers de VRL ont 64 bits : la borne d’un long est celle de to_int
        this.emit(max ? `if n == null { fail = "unable to convert [" + s + "] to ${word}" } else if int!(n) > ${max} || int!(n) < ${-max - 1} { fail = "unable to convert [" + s + "] to ${word}" } else { ${y} = n }` : `if n == null { fail = "unable to convert [" + s + "] to ${word}" } else { ${y} = n }`);
      };
      switch (type) {
        case 'integer': intConv(2147483647, 'integer'); break;
        case 'long': intConv(0, 'long'); break;
        case 'float': case 'double':
          // Double.parseDouble : blancs de bord tolérés, suffixe f ou d accepté
          this.emit(`n = to_float(replace(strip_whitespace(s), r'[fFdD]$', "")) ?? null`);
          this.emit(`if n == null { fail = "unable to convert [" + s + "] to ${type}" } else { ${y} = n }`);
          break;
        case 'boolean': this.emit(`if downcase(s) == "true" { ${y} = true } else if downcase(s) == "false" { ${y} = false } else { fail = "[" + s + "] is not a boolean value, cannot convert to boolean" }`); break;
        case 'string': this.emit(`${y} = s`); break;
        case 'ip': this.emit(`if is_string(${x}) && (is_ipv4(s) || is_ipv6(s)) { ${y} = ${x} } else { fail = "'" + s + "' is not an IP string literal." }`); break;
        case 'auto':
          this.open(`if !is_string(${x})`); this.emit(`${y} = ${x}`);
          this.close(`} else if downcase(s) == "true" || downcase(s) == "false" {`); this.ind++; this.emit(`${y} = downcase(s) == "true"`);
          this.close(`} else if match(s, r'^[+-]?[0-9]+$') && (to_int(s) ?? null) != null {`); this.ind++; this.emit(`${y} = to_int!(s)`);
          this.close(`} else if (to_float(replace(strip_whitespace(s), r'[fFdD]$', "")) ?? null) != null {`); this.ind++; this.emit(`${y} = to_float!(replace(strip_whitespace(s), r'[fFdD]$', ""))`);
          this.close('} else {'); this.ind++; this.emit(`${y} = ${x}`); this.close();
          break;
      }
    };
    this.open('if is_array(v)');
    this.emit('outs = []');
    this.open('for_each(array!(v)) -> |_i, x|');
    this.open('if fail == null'); this.emit('y = null'); one('x', 'y'); this.emit('outs = push(outs, y)'); this.close();
    this.close();
    this.emit('res = outs');
    this.close('} else {'); this.ind++;
    this.emit('y = null'); one('v', 'y');
    this.emit('res = y');
    this.close();
    this.close();
    this.emit('if fail == null && v != null {'); this.ind++; this.set(tr, 'res'); this.close();
    this.close();
    if (type === 'float') this.note('info', 'convert float', 'Elasticsearch convertit en float (32 bits) : la traduction garde la précision d’un double, l’écart n’apparaît qu’au-delà de sept chiffres significatifs.');
    this.t.stats.ok++;
  },
  p_split(o, label) {
    const r = this.field(o, label); if (!r) return;
    if (o.separator === undefined) return this.ko(label, 'option separator absente');
    const tr = o.target_field !== undefined ? this.ref(o.target_field) : r;
    const ignore = this.bool(o.ignore_missing, false); const keepTrail = this.bool(o.preserve_trailing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.open('if v == null'); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot split.`)}`);
    this.close('} else if !is_string(v) {'); this.ind++; this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit(`parts = split(string!(v), ${vraw(javaRe(o.separator), 'r')})`);
    if (!keepTrail) {
      // String.split de Java : les éléments vides de fin sont retirés (une chaîne vide donne [""])
      this.emit('last = -1');
      this.emit('for_each(parts) -> |i, x| { if x != "" { last = i } }');
      this.emit('if string!(v) != "" { parts = slice!(parts, 0, last + 1) }');
    }
    this.set(tr, 'parts');
    this.close(); this.close();
    this.t.stats.ok++;
  },
  p_gsub(o, label) {
    if (o.pattern === undefined || o.replacement === undefined) return this.ko(label, 'options pattern et replacement obligatoires');
    const rep = javaReplacement(o.replacement);
    this.strProc(o, label, x => `replace(${x}, ${vraw(javaRe(o.pattern), 'r')}, ${vq(rep)})`);
    this.t.stats.ok++;
  },
  p_join(o, label) {
    const r = this.field(o, label); if (!r) return;
    if (o.separator === undefined) return this.ko(label, 'option separator absente');
    const tr = o.target_field !== undefined ? this.ref(o.target_field) : r;
    this.read(r, 'v');
    this.open('if fail == null');
    this.open('if v == null'); this.emit(`fail = ${vq(`field [${r.path}] is null, cannot join.`)}`);
    this.close('} else if !is_array(v) {'); this.ind++; this.failCast('v', r.path, 'java.util.List');
    this.close('} else {'); this.ind++;
    this.emit(`out = join!(map_values(array!(v)) -> |x| { ${jstrOf('x')} }, ${vq(o.separator)})`);
    this.set(tr, 'out');
    this.close(); this.close();
    this.t.stats.ok++;
  },
  p_json(o, label) {
    const r = this.field(o, label); if (!r) return;
    const root = this.bool(o.add_to_root, false);
    if (root && o.target_field !== undefined) return this.ko(label, 'add_to_root et target_field ensemble : Elasticsearch refuse le processeur');
    const tr = o.target_field !== undefined ? this.ref(o.target_field) : r;
    const strict = this.bool(o.strict_json_parsing, true);
    const merge = String(o.add_to_root_conflict_strategy || 'replace') === 'merge';
    this.read(r, 'v');
    this.open('if fail == null');
    this.emit(`s = if v == null { "null" } else { ${jstrOf('v')} }`);
    if (strict) this.emit('parsed, err = parse_json(s)');
    else this.emit('parsed, err = parse_json(s, lossy: true)');
    this.open('if err != null');
    this.emit(strict ? 'fail = "The input " + s + " is not valid JSON and the strict_json_parsing parameter is true"' : 'fail = "Unrecognized token in [" + s + "]"');
    this.close(root ? '} else if !is_object(parsed) {' : '} else {'); this.ind++;
    if (root) {
      this.emit('fail = "cannot add non-map fields to root of document"');
      this.close('} else {'); this.ind++;
      this.emit(merge ? '. = merge(object!(.), object!(parsed), deep: true)' : '. = merge(object!(.), object!(parsed))');
    } else this.set(tr, 'parsed');
    this.close(); this.close();
    if (!strict) this.approx('json strict_json_parsing: false', 'Elasticsearch ne lit que la première valeur et ignore la suite ; parse_json de VRL refuse un texte qui n’est pas entièrement du JSON.');
    if (o.allow_duplicate_keys !== true) this.note('info', 'json : clés en double', 'Elasticsearch refuse un objet dont une clé apparaît deux fois (allow_duplicate_keys: false) ; parse_json garde la dernière.');
    this.t.stats.ok++;
  }
});
Object.assign(IngestGen.prototype, {
  /*
   * date : formats essayés dans l’ordre (ISO8601, UNIX, UNIX_MS, TAI64N, motifs Java), fuseau UTC par défaut ;
   * le résultat est écrit en texte, au format output_format, avec le décalage du fuseau (Z pour UTC).
   */
  p_date(o, label) {
    const r = this.field(o, label); if (!r) return;
    const formats = lsList(o.formats).map(String);
    if (!formats.length) return this.ko(label, 'option formats absente');
    const tr = this.ref(o.target_field !== undefined ? o.target_field : '@timestamp');
    // Fuseau : littéral, ou modèle ({{event.timezone}}) calculé pour chaque document
    let tz = '"UTC"';
    if (o.timezone !== undefined) {
      tz = hasMustache(o.timezone) ? this.tpl(String(o.timezone)) : vq(String(o.timezone));
      this.emit(`tz = ${tz}`); tz = 'tz';
      if (hasMustache(o.timezone)) this.emit('if tz == "" { tz = "UTC" }');
    }
    if (o.locale !== undefined && !/^(en|ENGLISH|ROOT)/i.test(String(o.locale)) && formats.some(f => /MMM|EEE/.test(f))) this.approx('date locale', `Les noms de mois et de jours en « ${o.locale} » ne sont pas reconnus : parse_timestamp ne lit que l’anglais.`);
    this.read(r, 'v');
    this.open('if fail == null');
    this.emit(`s = if v == null { null } else { ${jstrOf('v')} }`);
    this.emit('ts = null');
    this.open('if s != null');
    for (const f of formats) {
      this.open('if ts == null');
      if (f === 'ISO8601') {
        this.emit('iso = replace(string!(s), ",", ".")');
        this.emit(`ts = ${isoParse('iso', `, timezone: ${tz}`)}`);
      } else if (f === 'UNIX') {
        // Double.parseDouble × 1000, tronqué à la milliseconde
        this.emit('n = to_float(strip_whitespace(string!(s))) ?? null');
        this.emit('if n != null { ts = from_unix_timestamp(to_int(float!(n) * 1000.0), unit: "milliseconds") ?? null }');
      } else if (f === 'UNIX_MS') {
        this.emit('n = if match(string!(s), r\'^[+-]?[0-9]+$\') { to_int(string!(s)) ?? null } else { null }');
        this.emit('if n != null { ts = from_unix_timestamp(int!(n), unit: "milliseconds") ?? null }');
      } else if (f === 'TAI64N') {
        this.emit('t64 = replace(string!(s), r\'^@\', "")');
        this.open('if strlen(t64) >= 24');
        this.emit('hi = parse_int(slice!(t64, 1, 16), base: 16) ?? null');
        this.emit('lo = parse_int(slice!(t64, 16, 24), base: 16) ?? null');
        this.emit('if hi != null && lo != null { ts = from_unix_timestamp(int!(hi) * 1000 - 10000 + to_int(floor(int!(lo) / 1000000)), unit: "milliseconds") ?? null }');
        this.close();
      } else {
        const pat = f.replace(/^8/, '');
        const sf = joda2strf(pat);
        if (!/%[Yy]/.test(sf)) {
          // Sans année : l’année en cours (UTC), sans correction autour du 1er janvier
          this.emit(`ts = parse_timestamp(format_timestamp!(now(), format: "%Y", timezone: "UTC") + " " + string!(s), ${vq('%Y ' + sf)}, timezone: ${tz}) ?? null`);
          this.note('info', 'Date sans année', `Le format « ${f} » n’a pas d’année : comme Elasticsearch, la traduction prend l’année en cours.`);
        } else this.emit(`ts = parse_timestamp(string!(s), ${vq(sf)}, timezone: ${tz}) ?? null`);
      }
      this.close();
    }
    this.close();
    this.open('if ts == null');
    this.emit('sd = if s == null { "null" } else { string!(s) }');
    this.emit('fail = "unable to parse date [" + sd + "]"');
    this.close('} else {'); this.ind++;
    const out = o.output_format !== undefined ? joda2strf(String(o.output_format)) : '%Y-%m-%dT%H:%M:%S%.3f%:z';
    this.emit(`out = format_timestamp!(ts, format: ${vq(out)}, timezone: ${tz})`);
    // Le motif XXX de Java écrit Z pour un décalage nul
    if (/%:z/.test(out)) this.emit('out = replace(out, r\'\\+00:00$\', "Z")');
    this.set(tr, 'out');
    this.close(); this.close();
    this.t.stats.ok++;
  },
  p_grok(o, label) {
    const r = this.field(o, label); if (!r) return;
    const pats = lsList(o.patterns).map(String);
    if (!pats.length) return this.ko(label, 'option patterns absente');
    const custom = isObj(o.pattern_definitions) ? o.pattern_definitions : {};
    if (o.ecs_compatibility === 'v1') this.approx('grok ecs_compatibility: v1', 'Les motifs ECS d’Elasticsearch (v1) diffèrent des motifs historiques de VRL pour quelques noms de champs (SYSLOGBASE, HTTPD…).');
    const types = [];
    // Motifs personnalisés : remplacés par leur définition (qui peut en appeler d’autres) ; types :int, :long… relevés
    const expand = (x, depth) => {
      if (depth > 20) throw new Error('motifs personnalisés en boucle');
      return x.replace(/%\{(\w+)(?::([^:}]+))?(?::(\w+))?\}/g, (m, name, f, t) => {
        if (t) types.push([f, t]);
        if (Object.prototype.hasOwnProperty.call(custom, name)) {
          const def = expand(String(custom[name]), depth + 1);
          return f ? `(?<${f}>${def})` : `(?:${def})`;
        }
        return f ? `%{${name}:${f}}` : `%{${name}}`;
      });
    };
    let compiled;
    try { compiled = pats.map(x => expand(x, 0)); } catch (e) { return this.ko(label, e.message); }
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.open('if v == null'); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot process it.`)}`);
    this.close('} else if !is_string(v) {'); this.ind++; this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit('m = null'); this.emit('gi = null');
    compiled.forEach((x, k) => {
      this.open(k ? 'if m == null' : 'if true');
      // Un motif vide correspond à tout texte, sans capture
      if (x === '') this.emit(`m = {}`), this.emit(`gi = ${vq(String(k))}`);
      else {
        this.emit(`m, err = parse_grok(string!(v), ${vraw(x, 's')})`);
        this.emit(`if err == null { gi = ${vq(String(k))} } else { m = null }`);
      }
      this.close();
    });
    this.open('if m == null');
    this.emit('fail = "Provided Grok expressions do not match field value: [" + string!(v) + "]"');
    this.close('} else {'); this.ind++;
    // Captures : posées à leur chemin (les points font des objets), converties selon leur type, les absentes ignorées
    const conv = { int: 'to_int', long: 'to_int', float: 'to_float', double: 'to_float' };
    this.open('for_each(object!(m)) -> |k, val|');
    this.open('if val != null && fail == null');
    this.emit('cv = val');
    for (const [f, t] of types) {
      if (t === 'boolean') this.emit(`if k == ${vq(f)} { cv = downcase(string!(val)) == "true" }`);
      else if (conv[t]) this.emit(`if k == ${vq(f)} { n = ${conv[t]}(string!(val)) ?? null; if n == null { fail = "For input string: \\"" + string!(val) + "\\"" } else { cv = n } }`);
    }
    this.emit('if fail == null { . = set!(., split(k, "."), cv) }');
    this.close(); this.close();
    if (this.bool(o.trace_match, false)) this.emit(`ingest_grok_match_index = gi`);
    this.close(); this.close(); this.close();
    if (pats.length > 1 && pats.some(x => !/^\^/.test(x))) this.note('info', 'grok : plusieurs motifs', 'Elasticsearch réunit les motifs en une seule alternative et garde la correspondance la plus à gauche du texte ; la traduction essaie les motifs dans l’ordre. Les résultats ne diffèrent que si un motif suivant correspond plus tôt dans le texte.');
    this.t.stats.ok++;
  },
  p_dissect(o, label) {
    const r = this.field(o, label); if (!r) return;
    if (!o.pattern) return this.ko(label, 'option pattern absente');
    const d = dissectRegex(String(o.pattern), null, true);
    if (d.warnings.length) return this.ko(label, d.warnings.join(' ; '));
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.open('if v == null'); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot process it.`)}`);
    this.close('} else if !is_string(v) {'); this.ind++; this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit(`m, err = parse_regex(string!(v), ${vraw(d.regex, 'r')})`);
    this.open('if err != null');
    this.emit(`fail = "Unable to find match for dissect pattern: " + ${vq(o.pattern)} + " against source: " + string!(v)`);
    this.close('} else {'); this.ind++;
    d.fields.forEach(f => this.set(this.ref(f.field), `m.${f.group}`));
    this.close(); this.close(); this.close();
    this.note('info', 'dissect → parse_regex', 'Le motif dissect est converti en expression régulière ancrée avec groupes nommés.');
    this.t.stats.ok++;
  },
  p_kv(o, label) {
    const r = this.field(o, label); if (!r) return;
    if (o.field_split === undefined || o.value_split === undefined) return this.ko(label, 'options field_split et value_split obligatoires');
    const ignore = this.bool(o.ignore_missing, false);
    const prefix = (o.target_field ? `${o.target_field}.` : '') + (o.prefix || '');
    const inc = o.include_keys !== undefined ? lsList(o.include_keys).map(String) : null;
    const exc = o.exclude_keys !== undefined ? lsList(o.exclude_keys).map(String) : null;
    const trim = c => (c ? `replace(KEY, r'^[${javaRe(c)}]+|[${javaRe(c)}]+$', "")` : 'KEY');
    this.open(`if !(${this.has(r)})`);
    if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] doesn't exist`)}`);
    this.close('} else {'); this.ind++;
    this.emit(`v = ${this.get(r)}`);
    this.open('if v == null'); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot extract key-value pairs.`)}`);
    this.close('} else if !is_string(v) {'); this.ind++; this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit(`parts = split(string!(v), ${vraw(javaRe(o.field_split), 'r')})`);
    // String.split : éléments vides de fin retirés
    this.emit('last = -1');
    this.emit('for_each(parts) -> |i, x| { if x != "" { last = i } }');
    this.emit('if string!(v) != "" { parts = slice!(parts, 0, last + 1) }');
    this.open('for_each(parts) -> |_i, part|');
    this.open('if fail == null');
    this.emit(`kv = split(part, ${vraw(javaRe(o.value_split), 'r')}, limit: 2)`);
    this.open('if length(kv) != 2');
    this.emit(`fail = ${vq(`field [${r.path}] does not contain value_split [${o.value_split}]`)}`);
    this.close('} else {'); this.ind++;
    this.emit(`key = ${trim(o.trim_key).replace('KEY', () => 'string!(kv[0])')}`);
    let val = 'string!(kv[1])';
    if (this.bool(o.strip_brackets, false)) val = `replace(${val}, r'^[\\(\\[<"\\']|[\\]\\)>"\\']$', "")`;
    this.emit(`val = ${trim(o.trim_value).replace('KEY', () => val)}`);   // () => : un « $' » du texte n’est pas un motif de remplacement
    const keep = [inc ? `includes([${inc.map(vq).join(', ')}], key)` : '', exc ? `!includes([${exc.map(vq).join(', ')}], key)` : ''].filter(Boolean).join(' && ') || 'true';
    this.open(`if ${keep}`);
    this.emit(`path = split(${vq(prefix)} + key, ".")`);
    this.emit('old = get!(., path)');
    this.emit('oldl = if is_array(old) { array!(old) } else { [old] }');
    this.emit('. = if old == null { set!(., path, val) } else { set!(., path, push(oldl, val)) }');
    this.close(); this.close(); this.close(); this.close();
    this.close(); this.close();
    this.t.stats.ok++;
  },
  p_dot_expander(o, label) {
    if (o.field === undefined) return this.ko(label, 'option field absente');
    const base = o.path ? o.path.split('.') : [];
    const override = this.bool(o.override, false);
    const expandOne = (keyExpr, segsExpr) => {
      this.emit(`segs = ${segsExpr}`);
      this.emit(`cur = get!(., segs)`);
      this.open('if cur != null');
      this.emit(`x = get!(., ${this.arr(base)} + [${keyExpr}])`);
      this.emit(`. = remove!(., ${this.arr(base)} + [${keyExpr}])`);
      this.emit('curl = if is_array(cur) { array!(cur) } else { [cur] }');
      this.emit('xl = if is_array(x) { array!(x) } else { [x] }');
      this.emit(override ? '. = set!(., segs, x)' : '. = set!(., segs, append(curl, xl))');
      this.close('} else {'); this.ind++;
      // Un élément du chemin qui existe sans être un objet empêche l’expansion
      this.emit('acc = []');
      this.emit(`for_each(slice!(segs, 0, length(segs) - 1)) -> |_i, sg| { acc = push(acc, sg); p = get!(., acc); if fail == null && p != null && !is_object(p) { fail = "cannot expand [" + join!(segs, ".") + "], because [" + join!(acc, ".") + "] is not an object field, but a value field" } }`);
      this.open('if fail == null');
      this.emit(`x = get!(., ${this.arr(base)} + [${keyExpr}])`);
      this.emit(`. = remove!(., ${this.arr(base)} + [${keyExpr}])`);
      this.emit('. = set!(., segs, x)');
      this.close(); this.close();
    };
    if (base.length) { this.emit(`basev = get!(., ${this.arr(base)})`); this.emit(`if !is_object(basev) { fail = ${vq(`field [${o.path}] not present as part of path [${o.path}]`)} }`); }
    if (String(o.field) === '*') {
      this.emit(`src = ${base.length ? 'object(basev) ?? {}' : '.'}`);
      this.open('for_each(keys(object!(src))) -> |_i, k|');
      this.open('if fail == null && contains(k, ".") && !starts_with(k, ".")');
      expandOne('k', `${this.arr(base)} + split(k, ".")`);
      this.close(); this.close();
    } else {
      const f = String(o.field);
      this.open(`if fail == null && (get!(., ${this.arr(base)} + [${vq(f)}]) != null || exists(${this.vpath(base.concat([f]).map(x => x))}))`);
      expandOne(vq(f), `${this.arr(base)} + [${f.split('.').map(vq).join(', ')}]`);
      this.close();
    }
    this.t.stats.ok++;
  },
  p_drop(o, label) {
    if (this.inLoop) return this.ko(label, 'drop dans un foreach');
    this.t.uses.drop = true; this.emit('abort'); this.t.stats.ok++;
  },
  p_fail(o, label) {
    if (o.message === undefined) return this.ko(label, 'option message absente');
    this.emit(`fail = ${hasMustache(o.message) ? this.tpl(String(o.message)) : vq(o.message)}`);
    this.t.stats.ok++;
  },
  p_terminate(o, label, okVar) { this.emit(`${okVar} = false`); this.t.stats.ok++; },
  p_pipeline(o, label) {
    if (o.name === undefined) return this.ko(label, 'option name absente');
    const pkgRef = ingestPipelineRef(o.name);
    if (!pkgRef && hasMustache(o.name)) return this.ko(label, `pipeline dont le nom est calculé (${o.name}) : le pipeline appelé n’est connu qu’à l’exécution`);
    const name = pkgRef || String(o.name);
    const def = this.t.defs.get(name);
    if (!def) {
      if (this.bool(o.ignore_missing_pipeline, false)) { this.comment(`pipeline ${name} absent, ignoré (ignore_missing_pipeline)`); this.t.stats.ok++; return; }
      return this.ko(label, `le pipeline « ${name} » n’est pas dans les fichiers fournis : ajoutez sa définition pour qu’il soit traduit en place`);
    }
    if (this.t.stack.includes(name)) return this.ko(label, `appel circulaire de pipelines (${this.t.stack.concat(name).join(' → ')}) : Elasticsearch le refuse`);
    this.t.called.add(name);
    this.t.stack.push(name);
    const prevPipe = this.pipeline; this.pipeline = name;
    const ok = this.tmp('ok'); const ech = this.tmp('echec');
    this.comment(`début du pipeline ${name}`);
    this.emit(`${ok} = true`); this.emit(`${ech} = null`);
    this.emit(`ingest_pipeline = ${vq(name)}`);
    this.seq(def.processors, `${name}.processors`, ok, ech);
    this.pipelineFailure(def, name, ok, ech, 'fail');
    this.emit(`ingest_pipeline = ${vq(prevPipe)}`);
    this.comment(`fin du pipeline ${name}`);
    // L’échec du pipeline appelé, rattrapé ou non par son on_failure, devient celui du processeur pipeline
    this.emit(`fail = ${ech}`);
    this.pipeline = prevPipe; this.t.stack.pop();
    this.t.stats.ok++;
  },
  // Fin d’un pipeline : on_failure du pipeline s’il y en a un ; sinon l’échec part dans out (le message)
  pipelineFailure(def, name, ok, ech, out) {
    if (Array.isArray(def.on_failure) && def.on_failure.length) {
      this.open(`if !${ok} && ${ech} != null`);
      this.materialize([ech, 'ingest_on_failure_message']);
      const ok2 = this.tmp('ok'); const f2 = this.tmp('echec');
      this.emit(`${ok2} = true`); this.emit(`${f2} = null`);
      this.seq(def.on_failure, `${name}.on_failure`, ok2, f2);
      this.emit(`${ech} = ${f2}`);
      this.close();
    }
    if (out !== 'fail') this.emit(`${out} = ${ech}`);
  },
  p_foreach(o, label) {
    const r = this.field(o, label); if (!r) return;
    if (!isObj(o.processor)) return this.ko(label, 'option processor absente');
    const ignore = this.bool(o.ignore_missing, false);
    const fv = this.tmp('liste'); const outs = this.tmp('sortie');
    this.read(r, fv, ignore);
    this.open('if fail == null');
    this.open(`if ${fv} == null`); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot loop over its elements.`)}`);
    const item = this.tmp('valeur'); const key = this.tmp('cle');
    const ok = this.tmp('ok'); const ech = this.tmp('echec');
    const inner = mapMode => {
      const prev = [this.value, this.key, this.inLoop]; this.value = item; this.key = mapMode ? key : null; this.inLoop = true;
      this.emit(`${ok} = true`); this.emit(`${ech} = null`);
      this.processor(o.processor, `${label} → processor`, ok, ech);
      this.emit(`if !${ok} { fail = ${ech} }`);
      [this.value, this.key, this.inLoop] = prev;
    };
    const ix = this.tmp('i'); const kx = this.tmp('k'); const vx = this.tmp('x');
    this.close(`} else if is_array(${fv}) {`); this.ind++;
    this.emit(`${outs} = []`);
    this.open(`for_each(array!(${fv})) -> |_${ix}, ${vx}|`);
    this.open('if fail == null');
    this.emit(`${item} = ${vx}`);
    inner(false);
    this.emit(`${outs} = push(${outs}, ${item})`);
    this.close(); this.close();
    this.emit('if fail == null {'); this.ind++; this.set(r, outs); this.close();
    this.close(`} else if is_object(${fv}) {`); this.ind++;
    this.emit(`${outs} = {}`);
    this.open(`for_each(object!(${fv})) -> |${kx}, ${vx}|`);
    this.open('if fail == null');
    this.emit(`${item} = ${vx}`); this.emit(`${key} = ${kx}`);
    inner(true);
    this.emit(`${outs} = set!(${outs}, [string!(${key})], ${item})`);
    this.close(); this.close();
    this.emit('if fail == null {'); this.ind++; this.set(r, outs); this.close();
    this.close('} else {'); this.ind++;
    this.jtype('jt', fv);
    this.emit(`fail = "field [" + ${vq(r.path)} + "] of type [" + jt + "] cannot be cast to a list or map"`);
    this.close(); this.close();
    this.t.stats.ok++;
  },
  p_script(o, label) {
    if (o.id !== undefined) return this.ko(label, `script enregistré « ${o.id} » : copiez sa source dans le processeur pour qu’il soit traduit`);
    if (o.lang && o.lang !== 'painless') return this.ko(label, `script en langage ${o.lang}`);
    if (typeof o.source !== 'string') return this.ko(label, 'option source absente');
    const idiom = ingestPruneIdiom(o.source);
    if (idiom && this.pruneIdiom(idiom, label)) { this.t.stats.ok++; return; }
    const env = { locals: new Map(), retVar: this.tmp('ret') };
    const start = this.lines.length; const ind = this.ind;
    try {
      const prog = ingPainless(o.source); env.fns = prog.fns;
      if (isObj(o.params)) this.emit(`p_params = ${this.valueSource(o.params)}`);
      this.emit(`${env.retVar} = false`);
      this.plStmts(prog, env);
    } catch (e) {
      this.lines.length = start; this.ind = ind;
      return this.ko(label, `script Painless : ${e.message}`);
    }
    // params lus sans être déclarés : une table vide, comme dans Painless
    if (env.usesParams && !isObj(o.params)) this.lines.splice(start, 0, '  '.repeat(ind) + 'p_params = {}');
    this.condNotes(env);
    this.t.stats.ok++;
  }
});
Object.assign(IngestGen.prototype, {
  // uri_parts : découpage RFC 3986, parties décodées comme le fait java.net.URI
  p_uri_parts(o, label) {
    const r = this.field(o, label); if (!r) return;
    const tr = this.ref(o.target_field !== undefined ? o.target_field : 'url');
    const ignore = this.bool(o.ignore_missing, false); const keep = this.bool(o.keep_original, true); const rm = this.bool(o.remove_if_successful, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null && v != null');
    this.open('if !is_string(v)'); this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit(`m = parse_regex(string!(v), r'^(?:(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*):)?(?://(?P<authority>[^/?#]*))?(?P<path>[^?#]*)(?:\\?(?P<query>[^#]*))?(?:#(?P<fragment>.*))?$') ?? null`);
    this.open('if m == null || match(string!(v), r\'\\s\')');
    this.emit('fail = "unable to parse URI [" + string!(v) + "]"');
    this.close('} else {'); this.ind++;
    this.emit('u = {}');
    this.emit('a = parse_regex(string(m.authority) ?? "", r\'^(?:(?P<ui>[^@]*)@)?(?P<host>\\[[^\\]]*\\]|[^:]*)(?::(?P<port>\\d*))?$\') ?? {}');
    this.emit('if a.host != null && a.host != "" { u.domain = a.host }');
    this.emit('if m.fragment != null { u.fragment = decode_percent(string!(m.fragment)) }');
    this.emit('p = decode_percent(string(m.path) ?? "")');
    this.emit('if m.authority != null || p != "" { u.path = p }');
    this.emit('last = replace(p, r\'^.*/\', "")');
    this.emit('if contains(p, "/") && contains(last, ".") { u.extension = replace(last, r\'^.*\\.\', "") }');
    this.emit('if a.port != null && a.port != "" { u.port = to_int(a.port) ?? null }');
    this.emit('if m.query != null { u.query = decode_percent(string!(m.query)) }');
    this.emit('if m.scheme != null { u.scheme = m.scheme }');
    this.open('if a.ui != null');
    this.emit('ui = decode_percent(string!(a.ui))'); this.emit('u.user_info = ui');
    this.emit('if contains(ui, ":") { parts = split(ui, ":", limit: 2); u.username = parts[0]; u.password = parts[1] }');
    this.close();
    if (keep) this.emit('u.original = v');
    if (rm && o.target_field !== undefined && o.target_field !== o.field) this.del(r, true);
    this.set(tr, 'u');
    this.close(); this.close(); this.close();
    this.approx('uri_parts', 'Le découpage suit la RFC 3986 et décode les parties comme java.net.URI ; une adresse que java.net.URI refuse mais que java.net.URL accepte peut donner un résultat différent.');
  },
  p_registered_domain(o, label) {
    const r = this.field(o, label); if (!r) return;
    const pre = o.target_field ? `${o.target_field}.` : '';
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.emit('d = if is_string(v) { string!(v) } else { "" }');
    this.emit('e = if d != "" { parse_etld(d, plus_parts: 1) ?? null } else { null }');
    this.open('if e == null || e.etld_plus == e.etld');
    if (!ignore) this.emit('fail = "unable to set domain information for document"');
    this.close('} else {'); this.ind++;
    this.set(this.ref(`${pre}domain`), 'd');
    this.set(this.ref(`${pre}registered_domain`), 'e.etld_plus');
    this.set(this.ref(`${pre}top_level_domain`), 'e.etld');
    this.emit('sub = if ends_with(d, "." + string!(e.etld_plus)) { slice!(d, 0, strlen(d) - strlen(string!(e.etld_plus)) - 1) } else { "" }');
    this.emit('if sub != "" {'); this.ind++; this.set(this.ref(`${pre}subdomain`), 'sub'); this.close();
    this.close(); this.close();
    this.note('info', 'registered_domain → parse_etld', 'La liste des suffixes publics de VRL peut différer de celle d’Elasticsearch selon les versions : un suffixe récent peut être classé autrement.');
    this.t.stats.ok++;
  },
  p_community_id(o, label) {
    const f = (k, d) => this.ref(o[k] !== undefined ? o[k] : d);
    const tr = f('target_field', 'network.community_id');
    const ignore = this.bool(o.ignore_missing, true);
    const g = (k, d) => this.get(f(k, d));
    this.emit(`sip = ${g('source_ip', 'source.ip')}`); this.emit(`dip = ${g('destination_ip', 'destination.ip')}`);
    this.emit(`sp = ${g('source_port', 'source.port')}`); this.emit(`dp = ${g('destination_port', 'destination.port')}`);
    this.emit(`iana = ${g('iana_number', 'network.iana_number')}`); this.emit(`tr = ${g('transport', 'network.transport')}`);
    this.emit(`it = ${g('icmp_type', 'icmp.type')}`); this.emit(`ic = ${g('icmp_code', 'icmp.code')}`);
    // Protocole : iana_number, sinon le nom du transport
    this.emit('proto = if iana != null { to_int(iana) ?? null } else { get({ "icmp": 1, "igmp": 2, "tcp": 6, "udp": 17, "gre": 47, "ipv6-icmp": 58, "icmpv6": 58, "eigrp": 88, "ospf": 89, "pim": 103, "sctp": 132 }, [downcase(to_string(tr) ?? "")]) ?? null }');
    this.open('if sip == null || dip == null || proto == null');
    if (!ignore) this.emit('fail = "missing fields for community_id"');
    this.close('} else {'); this.ind++;
    this.emit('a = if proto == 1 || proto == 58 { to_int(it) ?? null } else { to_int(sp) ?? null }');
    this.emit('b = if proto == 1 || proto == 58 { to_int(ic) ?? null } else { to_int(dp) ?? null }');
    this.emit(`cid = community_id(source_ip: to_string(sip) ?? "", destination_ip: to_string(dip) ?? "", protocol: int!(proto), source_port: a, destination_port: b${o.seed !== undefined ? `, seed: ${Number(o.seed)}` : ''}) ?? null`);
    this.open('if cid == null');
    if (!ignore) this.emit('fail = "unable to compute community_id"');
    this.close('} else {'); this.ind++;
    this.set(tr, 'cid');
    this.close(); this.close();
    this.approx('community_id', 'Le calcul suit la spécification Community ID v1 (fonction community_id de VRL) ; pour l’ICMP, Elasticsearch apparie les types requête/réponse avant le calcul, ce que la traduction ne fait pas.');
  },
  // user_agent : parse_user_agent (mode enriched, base uap-core comme Elasticsearch), champs renommés à la manière d’ECS
  p_user_agent(o, label) {
    const r = this.field(o, label); if (!r) return;
    const tr = this.ref(o.target_field !== undefined ? o.target_field : 'user_agent');
    const ignore = this.bool(o.ignore_missing, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null && v != null');
    this.open('if !is_string(v)'); this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit('ua = parse_user_agent(string!(v), mode: "enriched")');
    this.emit('out = { "original": v, "os": {}, "device": {} }');
    this.emit('ver = [ua.browser.major, ua.browser.minor, ua.browser.patch]');
    this.emit('out.name = if ua.browser.family == null { "Other" } else { ua.browser.family }');
    this.emit('vs = filter(ver) -> |_i, x| { x != null }');
    this.emit('if length(vs) > 0 { out.version = join!(vs, ".") }');
    this.emit('if ua.os.family != null { out.os.name = ua.os.family }');
    this.emit('ov = filter([ua.os.major, ua.os.minor, ua.os.patch]) -> |_i, x| { x != null }');
    this.emit('if length(ov) > 0 { out.os.version = join!(ov, "."); out.os.full = string!(ua.os.family) + " " + join!(ov, ".") }');
    this.emit('out.device.name = if ua.device.family == null { "Other" } else { ua.device.family }');
    if (this.bool(o.extract_device_type, false)) this.emit('if ua.device.category != null { out.device.type = ua.device.category }');
    this.emit('if length(out.os) == 0 { del(out.os) }');
    this.set(tr, 'out');
    this.close(); this.close();
    this.approx('user_agent → parse_user_agent', 'Les deux s’appuient sur les expressions d’uap-core, mais dans des versions qui peuvent différer : vérifiez les navigateurs récents. properties et regex_file ne sont pas repris.');
  },
  p_geoip(o, label) {
    const r = this.field(o, label); if (!r) return;
    const tr = this.ref(o.target_field !== undefined ? o.target_field : 'geoip');
    const ignore = this.bool(o.ignore_missing, false);
    const db = String(o.database_file || 'GeoLite2-City.mmdb');
    const table = compName('geoip_' + db.replace(/\.mmdb$/i, ''));
    this.t.enrich[table] = { type: 'geoip', path: `/etc/vector/${db}` };
    this.read(r, 'v', ignore);
    this.open('if fail == null && v != null');
    this.emit(`ip = if is_array(v) { array!(v)[0] } else { v }`);
    this.open('if !is_string(ip) || !(is_ipv4(string!(ip)) || is_ipv6(string!(ip)))');
    this.emit(`ips = ${jstrOf('ip')}`);
    this.emit(`fail = "'" + ips + "' is not an IP string literal."`);
    this.close('} else {'); this.ind++;
    this.emit(`g = get_enrichment_table_record(${vq(table)}, { "ip": ip }) ?? null`);
    // Champs MaxMind de Vector → champs d’Elasticsearch ; une adresse absente de la base ne pose rien
    this.open('if g != null');
    this.emit('out = {}');
    if (/asn/i.test(db)) {
      this.emit('if g.autonomous_system_number != null { out.asn = g.autonomous_system_number }');
      this.emit('if g.autonomous_system_organization != null { out.organization_name = g.autonomous_system_organization }');
    }
    this.emit('if g.continent_code != null { out.continent_code = g.continent_code }');
    this.emit('if g.country_name != null { out.country_name = g.country_name }');
    this.emit('if g.country_code != null { out.country_iso_code = g.country_code }');
    this.emit('if g.region_name != null { out.region_name = g.region_name }');
    this.emit('if g.country_code != null && g.region_code != null { out.region_iso_code = string!(g.country_code) + "-" + string!(g.region_code) }');
    this.emit('if g.city_name != null { out.city_name = g.city_name }');
    this.emit('if g.latitude != null && g.longitude != null { out.location = { "lat": g.latitude, "lon": g.longitude } }');
    this.emit('if g.timezone != null { out.timezone = g.timezone }');
    this.emit('if g.postal_code != null { out.postal_code = g.postal_code }');
    this.emit('if length(out) > 0 {'); this.ind++; this.set(tr, 'out'); this.close();
    this.close(); this.close(); this.close();
    this.approx('geoip → table d’enrichissement', `Une table geoip (${db}) est déclarée dans enrichment_tables : montez la base MaxMind dans le conteneur Vector. continent_name n’est pas fourni par Vector (continent_code l’est), et properties n’est pas repris.`);
  },
  p_csv(o, label) {
    const r = this.field(o, label); if (!r) return;
    const cols = lsList(o.target_fields).map(String);
    if (!cols.length) return this.ko(label, 'option target_fields absente');
    const sep = String(o.separator === undefined ? ',' : o.separator);
    if (o.quote !== undefined && String(o.quote) !== '"') return this.ko(label, `caractère de citation « ${o.quote} » : parse_csv de VRL ne connaît que "`);
    const ignore = this.bool(o.ignore_missing, false); const trim = this.bool(o.trim, false);
    this.read(r, 'v', ignore);
    this.open('if fail == null');
    this.open('if v == null'); if (!ignore) this.emit(`fail = ${vq(`field [${r.path}] is null, cannot process it.`)}`);
    this.close('} else if !is_string(v) {'); this.ind++; this.failCast('v', r.path, 'java.lang.String');
    this.close('} else {'); this.ind++;
    this.emit(`row, err = parse_csv(string!(v), delimiter: ${vq(sep)})`);
    this.open('if err != null');
    this.emit('fail = "Unmatched quote"');
    this.close('} else {'); this.ind++;
    cols.forEach((c, k) => {
      this.emit(`cell = row[${k}]`);
      if (trim) this.emit('if cell != null { cell = strip_whitespace(string!(cell)) }');
      // Une cellule vide n’est pas écrite, sauf empty_value
      this.open(o.empty_value !== undefined ? 'if cell != null' : 'if cell != null && cell != ""');
      this.set(this.ref(c), o.empty_value !== undefined ? `if cell == "" { ${this.valueSource(o.empty_value)} } else { cell }` : 'cell');
      this.close();
    });
    this.close(); this.close(); this.close();
    this.approx('csv → parse_csv', 'parse_csv de VRL suit le format CSV standard ; Elasticsearch tolère moins les guillemets au milieu d’une cellule.');
  },
  p_reroute(o, label, okVar) {
    // Le document change de destination et le pipeline s’arrête ; le pipeline par défaut de la destination n’est pas joué
    if (o.destination !== undefined) { this.t.uses.meta = true; this.emit(`%_index = ${hasMustache(o.destination) ? this.tpl(String(o.destination)) : vq(o.destination)}`); }
    else {
      // Premier candidat non vide de dataset et de namespace, nettoyé comme le fait Elasticsearch
      const pick = (k, d, dflt, bad) => {
        this.emit(`${k} = null`);
        for (const x of lsList(o[k] !== undefined ? o[k] : d).map(String)) {
          this.open(`if ${k} == null`);
          this.emit(`c = ${hasMustache(x) ? this.tpl(x) : vq(x)}`);
          this.emit(`if c != "" { ${k} = replace(downcase(c), r'${bad}', "_") }`);
          this.close();
        }
        this.emit(`if ${k} == null { ${k} = ${vq(dflt)} }`);
      };
      pick('dataset', '{{data_stream.dataset}}', 'generic', '[\\\\/*?"<>| ,#:-]');
      pick('namespace', '{{data_stream.namespace}}', 'default', '[\\\\/*?"<>| ,#:]');
      this.emit('.data_stream.dataset = dataset'); this.emit('.data_stream.namespace = namespace');
      this.emit('.event.dataset = dataset');
      this.t.uses.meta = true;
      this.emit('%_index = (string(.data_stream.type) ?? "logs") + "-" + dataset + "-" + namespace');
    }
    this.emit(`${okVar} = false`);
    this.approx('reroute', 'Le document change de destination (%_index, data_stream.*) et le pipeline s’arrête ; Elasticsearch jouerait ensuite le pipeline par défaut de la nouvelle destination, ce que la traduction ne fait pas.');
  },
  /*
   * fingerprint : l’empreinte d’Elasticsearch, octet pour octet. Le sel, puis pour chaque valeur un octet nul et ses
   * octets : texte en UTF-8, entier sur 4 octets (8 au-delà de 32 bits) petit-boutiste, booléen 1 ou 2 ; les listes
   * dans l’ordre, les tables par clé triée (clé puis valeur). Un nombre décimal ou une profondeur au-delà de deux
   * niveaux sont approchés (texte JSON), l’empreinte peut alors différer.
   */
  p_fingerprint(o, label) {
    const fields = lsList(o.fields).map(String).sort();
    if (!fields.length) return this.ko(label, 'option fields absente');
    const method = String(o.method || 'SHA-1').toUpperCase();
    const hash = { 'SHA-1': 'sha1(fp)', MD5: 'md5(fp)', 'SHA-256': 'sha2(fp, variant: "SHA-256")', 'SHA-512': 'sha2(fp, variant: "SHA-512")' }[method];
    if (!hash) return this.ko(label, `méthode ${o.method} : VRL n’a pas de MurmurHash3`);
    const tr = this.ref(o.target_field !== undefined ? o.target_field : 'fingerprint');
    const ignore = this.bool(o.ignore_missing, false);
    // Valeur de départ lue par get : VRL évaluerait sinon sha1(fp) à la compilation, avec la valeur initiale
    // (les ajouts faits dans les boucles for_each ne sont pas suivis par sa propagation des constantes)
    this.emit(`fp = string!(get!({ "sel": ${vq(o.salt ? String(o.salt) : '')} }, ["sel"]))`);
    this.emit('fpv = []');
    for (const f of fields) {
      const r = this.ref(f);
      this.emit(`x = ${this.get(r)}`);
      this.emit(`if x == null { ${ignore ? 'null' : `fail = ${vq(`missing field [${f}] when calculating fingerprint`)}`} } else { fpv = push(fpv, x) }`);
    }
    const scalar = (x, w) => {
      // Octets d’une valeur simple, ajoutés à fp
      this.open(`if is_string(${x})`); this.emit(`fp = fp + "\\u{0}" + string!(${x})`);
      this.close(`} else if is_boolean(${x}) {`); this.ind++; this.emit(`fp = if bool!(${x}) { fp + "\\u{0}\\u{1}" } else { fp + "\\u{0}\\u{2}" }`);
      this.close(`} else if ${x} == null {`); this.ind++; this.emit('fp = fp + "\\u{0}"');
      this.close(`} else if is_integer(${x}) && int!(${x}) >= -2147483648 && int!(${x}) <= 2147483647 {`); this.ind++;
      this.emit(`u = int!(${x}); if u < 0 { u = u + 4294967296 }`);
      this.emit('h = "00000000" + format_int!(u, base: 16); h = slice!(h, strlen(h) - 8)');
      this.emit('fp = fp + "\\u{0}" + decode_base16!(slice!(h, 6, 8) + slice!(h, 4, 6) + slice!(h, 2, 4) + slice!(h, 0, 2))');
      this.close(`} else if is_integer(${x}) && int!(${x}) >= 0 {`); this.ind++;
      this.emit(`h = "0000000000000000" + format_int!(int!(${x}), base: 16); h = slice!(h, strlen(h) - 16)`);
      this.emit('fp = fp + "\\u{0}" + decode_base16!(slice!(h, 14, 16) + slice!(h, 12, 14) + slice!(h, 10, 12) + slice!(h, 8, 10) + slice!(h, 6, 8) + slice!(h, 4, 6) + slice!(h, 2, 4) + slice!(h, 0, 2))');
      this.close('} else {'); this.ind++;
      this.emit(`fp = fp + "\\u{0}" + encode_json(${x})`); this.emit(`${w} = true`);
      this.close();
    };
    this.emit('approche = false');
    this.open('if fail == null && length(fpv) > 0');
    this.open('for_each(fpv) -> |_i, x1|');
    this.open('if is_array(x1)');
    this.open('for_each(array!(x1)) -> |_j, x2|'); this.emit('if is_array(x2) || is_object(x2) { fp = fp + "\\u{0}" + encode_json(x2); approche = true } else {'); this.ind++; scalar('x2', 'approche'); this.close(); this.close();
    this.close('} else if is_object(x1) {'); this.ind++;
    this.open('for_each(keys(object!(x1))) -> |_j, k2|');
    this.emit('fp = fp + "\\u{0}" + k2');
    this.emit('x2 = get!(x1, [k2])');
    this.emit('if is_array(x2) || is_object(x2) { fp = fp + "\\u{0}" + encode_json(x2); approche = true } else {'); this.ind++; scalar('x2', 'approche'); this.close();
    this.close();
    this.close('} else {'); this.ind++; scalar('x1', 'approche'); this.close();
    this.close();
    this.emit(`out = encode_base64(decode_base16!(${hash}))`);
    this.set(tr, 'out');
    this.close();
    this.note('info', 'fingerprint', 'L’empreinte est calculée comme par Elasticsearch pour le texte, les entiers, les booléens et les listes ou tables de premier niveau ; un nombre décimal, une date ou une imbrication plus profonde donnent une empreinte différente (mais stable).');
    if (tr.kind === 'meta') this.note('info', 'fingerprint → _id', 'L’empreinte servait d’identifiant de document (_id) à Elasticsearch : elle est rangée dans %_id, que la table ClickHouse ne reçoit pas ; une table ReplacingMergeTree peut s’en servir pour dédoublonner si vous l’écrivez dans une colonne.');
    this.t.stats.ok++;
  }
});

/* ---------- Ensemble de pipelines d’ingestion → configuration Vector ---------- */
// Pipelines appelés par un processeur pipeline (à toute profondeur) : ils sont traduits en place chez l’appelant
function ingestCalls(def) {
  const out = new Set();
  (function walk(list) {
    for (const p of list || []) {
      if (!isObj(p)) continue;
      for (const [type, o] of Object.entries(p)) {
        if (!isObj(o)) continue;
        if (type === 'pipeline' && typeof o.name === 'string') { const n = ingestPipelineRef(o.name) || (hasMustache(o.name) ? null : o.name); if (n) out.add(n); }
        if (type === 'foreach' && isObj(o.processor)) walk([o.processor]);
        walk(o.on_failure);
      }
    }
  })((def.processors || []).concat(def.on_failure || []));
  return out;
}
/*
 * Un pipeline → programme VRL. Les métadonnées d’échec sont des variables ; un échec que ni on_failure ni
 * ignore_failure ne rattrape rend le document d’origine, marqué %ingest_failure (message, processeur, pipeline),
 * comme le failure store d’Elasticsearch.
 */
/*
 * Variables qui traversent les processeurs de premier niveau : quand un pipeline est coupé en plusieurs transforms
 * remap, elles passent de l’un à l’autre par les métadonnées de l’événement (%ingest_etat). Les autres variables
 * sont locales à un processeur. Le type de chacune est rétabli à la lecture (VRL type %… comme « any »).
 */
const INGEST_STATE = [
  ['doc0', 'object!(%ingest_etat.doc0)'], ['ok', 'bool!(%ingest_etat.ok)'],
  ['echec', 'if %ingest_etat.echec == null { null } else { string!(%ingest_etat.echec) }'],
  ['fail', 'if %ingest_etat.fail == null { null } else { string!(%ingest_etat.fail) }'],
  ['ingest_on_failure_message', 'if %ingest_etat.message == null { null } else { string!(%ingest_etat.message) }'],
  ['ingest_on_failure_processor_type', 'if %ingest_etat.type == null { null } else { string!(%ingest_etat.type) }'],
  ['ingest_on_failure_processor_tag', 'if %ingest_etat.tag == null { null } else { string!(%ingest_etat.tag) }'],
  ['ingest_on_failure_pipeline', 'if %ingest_etat.pipeline == null { null } else { string!(%ingest_etat.pipeline) }'],
  ['ingest_pipeline', 'string!(%ingest_etat.nom)'],
  ['w_d', 'if %ingest_etat.diag == null { null } else { object!(%ingest_etat.diag) }'],
  ['ingest_timestamp', 'timestamp!(%ingest_etat.horodatage)'],
  ['ingest_grok_match_index', 'if %ingest_etat.grok == null { null } else { int!(%ingest_etat.grok) }']
];
const INGEST_STATE_KEY = { doc0: 'doc0', ok: 'ok', echec: 'echec', fail: 'fail', ingest_on_failure_message: 'message', ingest_on_failure_processor_type: 'type', ingest_on_failure_processor_tag: 'tag', ingest_on_failure_pipeline: 'pipeline', ingest_pipeline: 'nom', w_d: 'diag', ingest_timestamp: 'horodatage', ingest_grok_match_index: 'grok' };
// Taille visée d’un transform : le compilateur de VRL retype chaque bloc à chaque niveau d’imbrication, et le coût
// croît comme le carré du nombre de champs écrits ; des transforms d’une trentaine de Ko compilent en quelques secondes.
const INGEST_CHUNK = 30000;

// Rend les programmes VRL du pipeline : un seul si court, sinon une suite de transforms qui se passent l’état
function ingestProgram(name, def, t) {
  const g = new IngestGen(t, name);
  g.comment(`Pipeline d’ingestion ${name}${def.description ? ` — ${String(def.description).split('\n')[0]}` : ''}`);
  g.emit('doc0 = .');
  g.emit('ok = true'); g.emit('echec = null'); g.emit('fail = null');
  ['message', 'processor_type', 'processor_tag', 'pipeline'].forEach(k => g.emit(`ingest_on_failure_${k} = null`));
  g.emit(`ingest_pipeline = ${vq(name)}`);
  g.emit('w_d = null');
  const body = new IngestGen(t, name);
  body.ind = g.ind;
  t.stack = [name];
  body.seq(def.processors, 'processors', 'ok', 'echec');
  body.pipelineFailure(def, name, 'ok', 'echec', 'echec');
  if (t.uses.timestamp) g.emit('ingest_timestamp = now()');
  if (t.uses.grok) g.emit('ingest_grok_match_index = null');
  if (body.lines.some(l => /ingest_grok_match_index/.test(l))) g.emit('ingest_grok_match_index = null');
  const head = g.lines.slice();
  g.lines = [];
  g.comment('Échec non rattrapé : Elasticsearch refuse le document ; il est rendu tel qu’il est arrivé, avec la cause');
  g.open('if echec != null');
  g.materialize(['echec', 'ingest_on_failure_message']);
  g.emit('. = doc0');
  g.emit('%ingest_failure = { "message": echec, "processor_type": ingest_on_failure_processor_type, "processor_tag": ingest_on_failure_processor_tag, "pipeline": ingest_on_failure_pipeline }');
  g.close();
  const tail = g.lines;
  const tidy = ls => ls.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const total = head.join('\n').length + body.lines.join('\n').length + tail.join('\n').length;
  if (total <= INGEST_CHUNK) return [tidy([...head, ...body.lines, '', ...tail])];

  // Coupure aux points de coupure de la suite principale (processeurs de premier niveau, appels de pipeline à plat)
  const marks = new Set(body.marks);
  const groups = []; let cur = []; let size = 0;
  body.lines.forEach((l, i) => {
    if (marks.has(i) && size >= INGEST_CHUNK) { groups.push(cur); cur = []; size = 0; }
    cur.push(l); size += l.length + 1;
  });
  groups.push(cur);
  if (groups.length === 1) return [tidy([...head, ...body.lines, '', ...tail])];
  const mentions = (ls, v) => { const re = new RegExp(`(^|[^A-Za-z0-9_])${v}([^A-Za-z0-9_]|$)`); return ls.some(l => re.test(l)); };
  // Variables portées d’un transform à l’autre : celles du pipeline, et celles des appels de pipeline à plat
  const statics = INGEST_STATE.filter(([v]) => mentions([...head, ...body.lines, ...tail], v));
  const dynamic = (t.carry || []).map(c => [c.v, c.kind === 'bool' ? `bool!(%ingest_etat.${c.v})` : `if %ingest_etat.${c.v} == null { null } else { string!(%ingest_etat.${c.v}) }`]);
  const keyOf = v => INGEST_STATE_KEY[v] || v;
  const load = vars => vars.map(([v, e]) => `${v} = ${e}`);
  const store = vars => `%ingest_etat = { ${vars.map(([v]) => `${vq(keyOf(v))}: ${v}`).join(', ')} }`;
  // Une variable dynamique n’est portée qu’une fois déclarée : elle est écrite par le transform où elle apparaît
  const seen = new Set();
  const out = [];
  groups.forEach((ls, k) => {
    const last = k === groups.length - 1;
    const before = statics.concat(dynamic.filter(([v]) => seen.has(v)));
    dynamic.forEach(([v]) => { if (mentions(ls, v)) seen.add(v); });
    const after = statics.concat(dynamic.filter(([v]) => seen.has(v)));
    const parts = [];
    if (k === 0) parts.push(...head); else parts.push(...load(last ? before.filter(([v]) => mentions([...ls, ...tail], v)) : before));
    parts.push(...ls);
    if (last) { parts.push('', ...tail, 'del(%ingest_etat)'); } else parts.push('', store(after));
    out.push(tidy(parts));
  });
  return out;
}
/*
 * inputs : [{ text, name }]. Chaque pipeline lu devient un programme VRL ; ceux qu’aucun autre n’appelle reçoivent
 * leur transform remap, aiguillé selon data_stream (Elastic Agent) ou @metadata.pipeline (modules Beats).
 */
function translateIngest(inputs, cfg, opts) {
  opts = opts || {};
  const notes = makeNotes();
  const defs = new Map(); const errors = [];
  for (const inp of [].concat(inputs)) {
    const r = ingestRead(inp.text, inp.name);
    r.errors.forEach(e => errors.push(`${inp.name || 'entrée'} : ${e}`));
    for (const p of r.pipelines) {
      if (defs.has(p.name)) notes.add('warn', `Pipeline « ${p.name} » défini deux fois`, 'La dernière définition lue est gardée, comme le ferait un second PUT.');
      defs.set(p.name, p.def);
    }
  }
  errors.forEach(e => notes.add('err', 'Lecture impossible', e));
  if (!defs.size) return { error: errors[0] || 'aucun pipeline d’ingestion lisible', notes: notes.list };
  const called = new Set(); for (const d of defs.values()) ingestCalls(d).forEach(n => called.add(n));
  let tops = [...defs.keys()].filter(n => !called.has(n));
  if (!tops.length) tops = [...defs.keys()];
  const pipelines = []; const programs = {}; const enrich = {};
  const stats = { ok: 0, approx: 0, ko: 0 };
  const used = new Set(['agent_in', 'aiguillage', 'bilan', 'sortie', 'echecs']);
  for (const name of tops) {
    const pn = makeNotes();
    const t = { notes: pn, stats: { ok: 0, approx: 0, ko: 0 }, defs, stack: [], called: new Set(), k: 0, uses: {}, enrich, processors: 0 };
    let vrls;
    try { vrls = ingestProgram(name, defs.get(name), t); }
    catch (e) { if (e instanceof RangeError) { pn.add('err', 'Pipeline trop imbriqué', 'La traduction a dépassé la profondeur permise.'); vrls = ['']; } else throw e; }
    const vrl = vrls.join('\n# ---- transform suivant ----\n');
    if (t.uses.meta) pn.add('info', 'Métadonnées _index, _id…', 'Les métadonnées du document (ctx._index…) sont rangées dans celles de l’événement Vector (%_index…), sans être écrites dans la table.');
    if (t.uses.drop) pn.add('info', 'drop → abort', 'Un document supprimé par drop n’est pas écrit : le programme s’arrête (abort) et Vector écarte l’événement.');
    const r = { notes: pn.list, stats: t.stats };
    for (const k of Object.keys(stats)) stats[k] += t.stats[k];
    for (const n of pn.list) notes.add(n.level, tops.length > 1 ? `[${name}] ${n.title}` : n.title, n.detail);
    const tn = uniq(used, compName(`ingest_${name}`));
    // Un pipeline long devient une suite de transforms : tn en tête, puis tn_2, tn_3… (le dernier alimente le bilan)
    const chain = [tn]; for (let k = 2; k <= vrls.length; k++) chain.push(uniq(used, `${tn}_${k}`));
    pipelines.push({ name, transform: tn, chain, verdict: verdictOf(r), stats: t.stats, notes: pn.list.length, processors: t.processors, calls: [...t.called], vrl, vrls });
  }
  const unused = [...defs.keys()].filter(n => !tops.includes(n) && !pipelines.some(p => p.calls.includes(n)));
  if (unused.length) notes.add('info', 'Pipelines appelés seulement', `${unused.join(', ')} : appelé${unused.length > 1 ? 's' : ''} par un pipeline qui n’est pas traduit.`);
  // Configuration Vector : Elastic Agent (sortie Logstash) ou Beats, puis les pipelines, puis le bilan des échecs
  const sources = { agent_in: { type: 'logstash', address: '0.0.0.0:5044' } };
  if (cfg.vector.log_namespace !== false) sources.agent_in.log_namespace = true;
  const transforms = {};
  const graph = { nodes: [{ id: 'agent_in', kind: 'source', type: 'logstash', label: 'Elastic Agent, Beats', detail: '0.0.0.0:5044' }], edges: [] };
  let feeds = ['agent_in'];
  if (pipelines.length > 1) {
    // Aiguillage : data_stream.type-data_stream.dataset (Elastic Agent) ou @metadata.pipeline (Beats vers Logstash)
    const route = {};
    for (const p of pipelines) {
      const m = /^(logs|metrics|traces|synthetics|profiling)-(.+?)-\d+\.\d+\.\d+(?:-.+)?$/.exec(p.name);
      const byMeta = `."@metadata".pipeline == ${vq(p.name)}`;
      route[p.transform] = m ? `(.data_stream.type == ${vq(m[1])} && .data_stream.dataset == ${vq(m[2])}) || ${byMeta}` : byMeta;
      if (!m) notes.add('warn', `Aiguillage de « ${p.name} »`, `Ce nom ne suit pas la convention des intégrations (logs-<dataset>-<version>) : seuls les événements dont @metadata.pipeline vaut « ${p.name} » y passent. Elastic Agent choisit le pipeline par le modèle d’index du data stream : adaptez la condition au besoin.`);
    }
    transforms.aiguillage = { type: 'route', inputs: ['agent_in'], reroute_unmatched: true, route };
    graph.nodes.push({ id: 'aiguillage', kind: 'transform', type: 'route', label: 'Aiguillage', detail: `${pipelines.length} pipelines` });
    graph.edges.push(['agent_in', 'aiguillage']);
    feeds = null;
  }
  for (const p of pipelines) {
    const inputs = feeds || [`aiguillage.${p.transform}`];
    p.chain.forEach((id, k) => { transforms[id] = { type: 'remap', inputs: k ? [p.chain[k - 1]] : inputs, drop_on_abort: true, source: p.vrls[k] }; });
    graph.nodes.push({ id: p.transform, kind: 'transform', type: 'remap', label: p.name, detail: `${p.processors} processeur${p.processors > 1 ? 's' : ''}${p.chain.length > 1 ? `, ${p.chain.length} transforms` : ''}`, todo: p.verdict === 'todo' });
    graph.edges.push([inputs[0].split('.')[0], p.transform]);
  }
  // Bilan : les documents en échec partent à part (failure store), les autres vers la sortie
  const bilanIn = pipelines.map(p => p.chain[p.chain.length - 1]).concat(pipelines.length > 1 ? ['aiguillage._unmatched'] : []);
  transforms.bilan = { type: 'route', inputs: bilanIn, reroute_unmatched: true, route: { echecs: 'exists(%ingest_failure)' } };
  graph.nodes.push({ id: 'bilan', kind: 'transform', type: 'route', label: 'Bilan', detail: 'échecs à part' });
  pipelines.forEach(p => graph.edges.push([p.transform, 'bilan']));
  if (pipelines.length > 1) graph.edges.push(['aiguillage', 'bilan']);
  const sinks = opts.sinks ? opts.sinks(cfg, ['bilan._unmatched'], notes) : { sortie: { type: 'console', inputs: ['bilan._unmatched'], encoding: { codec: 'json' } } };
  sinks.echecs = { type: 'file', inputs: ['bilan.echecs'], path: '/var/lib/vector/ingest-echecs-%Y-%m-%d.ndjson', encoding: { codec: 'json' } };
  for (const [n, k] of Object.entries(sinks)) { graph.nodes.push({ id: n, kind: 'sink', type: k.type, label: n === 'echecs' ? 'Documents en échec' : 'Sortie', detail: k.type }); graph.edges.push([k.inputs[0].split('.')[0], n]); }
  notes.add('info', 'Documents en échec', 'Un document qu’Elasticsearch aurait refusé est écrit dans /var/lib/vector/ingest-echecs-*.ndjson tel qu’il est arrivé, avec la cause dans les métadonnées (%ingest_failure) : remplacez cette sortie par la vôtre.');
  if (!opts.sinks) notes.add('info', 'Sortie console', 'Les documents traités sont écrits sur la sortie standard : remplacez le sink « sortie » par la destination voulue, ou choisissez vector.elasticsearch_output: clickhouse pour écrire dans ClickHouse.');
  const v = { ns: cfg.vector.log_namespace !== false, env: new Set(), note: (l, t2, d) => notes.add(l, t2, d) };
  const doc = vectorDocument(v, { sources, transforms, sinks, enrich }, cfg, `depuis ${defs.size} pipeline${defs.size > 1 ? 's' : ''} d’ingestion Elasticsearch`);
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  notes.list.sort((a, b) => order[a.level] - order[b.level]);
  const result = { config: doc.config, yaml: doc.yaml, toml: doc.toml, notes: notes.list, stats, graph, pipelines, env: [], sentence: `${pipelines.length} pipeline${pipelines.length > 1 ? 's' : ''} traduit${pipelines.length > 1 ? 's' : ''} en VRL${defs.size > pipelines.length ? `, ${defs.size - pipelines.length} appelé${defs.size - pipelines.length > 1 ? 's' : ''} en place` : ''}.` };
  return result;
}

/*
 * Scripts Painless reconnus à leur forme : le nettoyage récursif des valeurs vides, que la plupart des intégrations
 * Elastic recopient sous une variante (drop, dropEmptyFields, handleMap/handleList). Le script est lu jeton par
 * jeton : il ne doit contenir que des fonctions qui retirent des valeurs (removeIf), leur appel sur ctx, et des
 * comparaisons à null, à la chaîne vide ou à des chaînes fixes.
 */
const PRUNE_WORDS = new Set(['void', 'boolean', 'def', 'Object', 'Map', 'List', 'if', 'else', 'return', 'true', 'false', 'null', 'instanceof', 'removeIf', 'values', 'size', 'length', 'isEmpty', 'for', 'ctx']);
function ingestPruneIdiom(src) {
  let toks;
  try { toks = ptokens(String(src)); } catch (e) { return null; }
  if (!toks.some(t => t.t === 'id' && t.v === 'removeIf')) return null;
  const names = new Set();
  // Fonctions déclarées : « type nom(type param) { »
  for (let k = 0; k + 2 < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'id' && ['void', 'boolean', 'def', 'Object'].includes(t.v) && toks[k + 1].t === 'id' && toks[k + 2].v === '(') names.add(toks[k + 1].v);
  }
  if (!names.size) return null;
  const sentinels = new Set(); let nulls = false; let containers = false; let lists = false;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'str') {
      const prev = toks[k - 1];
      if (!prev || (prev.v !== '==')) return null;
      sentinels.add(t.v); continue;
    }
    if (t.t === 'num') { if (t.v !== '0') return null; continue; }
    if (t.t === 'id') {
      if (t.v === 'null') { if (toks[k - 1] && toks[k - 1].v === '==') nulls = true; continue; }
      if (t.v === 'size' || t.v === 'isEmpty' || (t.v === 'length' && toks[k - 1] && toks[k - 1].v === '.')) containers = true;
      if (t.v === 'removeIf' && toks[k - 1].v === '.' && !(toks[k - 4] && toks[k - 4].v === 'values')) lists = true;
      continue;
    }
    if (t.t === 'op' && !['(', ')', '{', '}', ';', ',', '.', '==', '||', '&&', '->', ':', '!'].includes(t.v)) return null;
    if (t.t === 're') return null;
  }
  // Seuls des mots du nettoyage et des noms locaux (fonctions, paramètres) : aucune autre méthode, aucune affectation
  const locals = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'id' || PRUNE_WORDS.has(t.v) || names.has(t.v)) continue;
    const prev = toks[k - 1]; const next = toks[k + 1];
    // Paramètre de fonction, de lambda, ou variable de boucle
    if ((prev && prev.t === 'id' && ['Object', 'Map', 'List', 'def'].includes(prev.v)) || (next && next.v === '->') || (prev && prev.v === '(' && next && next.v === '->')) { locals.add(t.v); continue; }
    if (!locals.has(t.v)) return null;
  }
  if (!toks.some((t, k) => t.t === 'id' && names.has(t.v) && toks[k + 1] && toks[k + 1].v === '(' && toks[k + 2] && toks[k + 2].v === 'ctx')) return null;
  // Chaînes comparées dans chaque fonction : des listes différentes d’une fonction à l’autre ne sont pas reproduites
  const per = new Map(); let fn = null; let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (depth === 0 && t.t === 'id' && names.has(t.v) && toks[k + 1] && toks[k + 1].v === '(' && toks[k - 1] && toks[k - 1].t === 'id') { fn = t.v; per.set(fn, new Set()); }
    if (t.v === '{' && t.t === 'op') depth++;
    if (t.v === '}' && t.t === 'op') { depth--; if (depth === 0) fn = null; }
    if (fn && t.t === 'str') per.get(fn).add(t.v);
  }
  const sets = [...per.values()].filter(x => x.size).map(x => [...x].sort().join('\u0000'));
  return { sentinels: [...sentinels], nulls, empty: sentinels.has(''), containers, lists, uneven: new Set(sets).size > 1 };
}
Object.assign(IngestGen.prototype, {
  pruneIdiom(idiom, label) {
    const others = idiom.sentinels.filter(x => x !== '');
    if (!idiom.nulls && (others.length || idiom.empty)) return false;
    this.comment('Script reconnu : valeurs vides retirées à toute profondeur');
    if (others.length) this.emit(`. = map_values(object!(.), recursive: true) -> |pv| { if includes([${others.map(vq).join(', ')}], pv) { null } else { pv } }`);
    this.emit(`. = compact(object!(.), recursive: true, null: true, string: ${idiom.empty}, object: ${idiom.containers}, array: ${idiom.containers}, nullish: false)`);
    if (idiom.uneven) this.approx('Script de nettoyage', `${label} : les valeurs retirées diffèrent entre objets et listes ; la traduction retire les mêmes partout.`);
    else if (!idiom.lists) this.approx('Script de nettoyage', `${label} : le script ne retire les valeurs que des objets ; compact de VRL les retire aussi des listes (un null dans une liste disparaît).`);
    else this.note('info', 'Script de nettoyage reconnu', 'Le script Painless qui retire les valeurs vides à toute profondeur devient compact (et map_values pour les valeurs sentinelles) en VRL.');
    return true;
  }
});
