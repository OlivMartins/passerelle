/* Passerelle — moteur partie 8 : analyseurs personnalisés d’Elasticsearch (aperçu et plan ClickHouse) */

/*
 * Un champ text est découpé en mots par son analyseur : caractères filtrés (char_filter), découpage (tokenizer),
 * puis une suite de filtres. Le standard est couvert par esTokens() ; ce fichier traite les analyseurs déclarés dans
 * les réglages d’un index (settings.analysis) :
 *
 *   anAnalyze()  l’aperçu : les mots qu’Elasticsearch produirait pour un texte, étape par étape (comme _analyze)
 *   anPlan()     le plan : l’expression ClickHouse qui produit les mêmes mots (Array(String)), la colonne et l’index
 *                à créer, et ce qui ne se traduit pas exactement
 *
 * Seul ce que l’on sait reproduire fidèlement est traduit : le reste est « à reprendre » avec sa raison, jamais
 * approché en silence. Les stemmers et les listes de mots vides des langues n’ont pas d’aperçu (pas de copie
 * de Lucene ici) ; leur plan, quand il existe, passe par stem() de ClickHouse.
 */

const AN_STOP = {
  _english_: ['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with'],
  _none_: []
};
// Caractères blancs au sens de Character.isWhitespace de Java (pas l’espace insécable)
const AN_WS = '\\t\\n\\u000B\\f\\r\\u001C-\\u001F \\u1680\\u2000-\\u2006\\u2008-\\u200A\\u2028\\u2029\\u205F\\u3000';
// La même classe en syntaxe RE2 (ClickHouse), qui note les points de code \x{…}
const AN_WS2 = AN_WS.replace(/\\u([0-9A-F]{4})/g, '\\x{$1}');
// Lettres latines accentuées → ASCII, et les lettres que la décomposition Unicode ne ramène pas à l’ASCII
const AN_FOLD = [['Æ', 'AE'], ['æ', 'ae'], ['Œ', 'OE'], ['œ', 'oe'], ['ß', 'ss'], ['Ø', 'O'], ['ø', 'o'], ['Đ', 'D'], ['đ', 'd'], ['Ł', 'L'], ['ł', 'l'], ['Þ', 'TH'], ['þ', 'th'], ['Ð', 'D'], ['ð', 'd'], ['ı', 'i']];
const AN_ELISION = ['l', 'm', 't', 'qu', 'n', 's', 'j', 'd', 'c', 'jusqu', 'quoiqu', 'lorsqu', 'puisqu'];

const anNum = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
const anList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/*
 * Chaîne d’un analyseur : { chars: [composant], tokenizer: composant, filters: [composant] }, chaque composant
 * { type, name, …paramètres }. spec : le nom d’un analyseur prédéfini, ou { name, type, tokenizer, filter,
 * char_filter, definitions: { filter, char_filter, tokenizer } } tel que schema.js le range dans le profil.
 */
function anChain(spec) {
  if (typeof spec === 'string') spec = { name: spec, type: spec };
  const defs = spec.definitions || {};
  const type = spec.type || 'custom';
  const comp = (kind, ref) => {
    if (ref && typeof ref === 'object') return Object.assign({ name: ref.type }, ref);
    const d = defs[kind] && defs[kind][ref];
    return d ? Object.assign({ name: String(ref) }, d) : { type: String(ref), name: String(ref) };
  };
  let chars = []; let tokenizer; let filters = [];
  const stop = () => {
    const w = spec.stopwords !== undefined ? spec.stopwords : null;
    return w === null || w === '_none_' ? null : { type: 'stop', name: 'stopwords', stopwords: w };
  };
  switch (type) {
    case 'custom':
      if (!spec.tokenizer) throw new Error('analyseur custom sans tokenizer');
      chars = anList(spec.char_filter).map(r => comp('char_filter', r));
      tokenizer = comp('tokenizer', spec.tokenizer);
      filters = anList(spec.filter).map(r => comp('filter', r));
      break;
    case 'standard': tokenizer = { type: 'standard', name: 'standard' }; filters = [{ type: 'lowercase', name: 'lowercase' }]; if (stop()) filters.push(stop()); break;
    case 'simple': tokenizer = { type: 'lowercase', name: 'lowercase' }; break;
    case 'whitespace': tokenizer = { type: 'whitespace', name: 'whitespace' }; break;
    case 'keyword': tokenizer = { type: 'keyword', name: 'keyword' }; break;
    case 'stop': tokenizer = { type: 'lowercase', name: 'lowercase' }; filters = [{ type: 'stop', name: 'stopwords', stopwords: spec.stopwords !== undefined ? spec.stopwords : '_english_' }]; break;
    case 'pattern':
      tokenizer = { type: 'pattern', name: 'pattern', pattern: spec.pattern !== undefined ? spec.pattern : '\\W+', flags: spec.flags };
      if (spec.lowercase === undefined || spec.lowercase === true || spec.lowercase === 'true') filters.push({ type: 'lowercase', name: 'lowercase' });
      if (stop()) filters.push(stop());
      break;
    default: throw new Error(`analyseur prédéfini « ${type} » : non pris en charge (langues, fingerprint…)`);
  }
  return { chars, tokenizer, filters };
}

/* ---------- Aperçu : ce qu’Elasticsearch produirait ---------- */
// Expression Java → JavaScript ; ce que JavaScript ne sait pas faire de la même façon est refusé
function anRegex(pattern, flags, what) {
  const p = String(pattern);
  if (/\(\?<?[=!]|\\[1-9]|\(\?>|[*+?}]\+/.test(p)) throw new Error(`${what} : « ${p} » utilise une construction (anticipation, rétroréférence, quantificateur possessif) non reproduite`);
  const f = anList(String(flags || '').split('|')).map(x => x.trim()).filter(Boolean);
  const bad = f.filter(x => !['CASE_INSENSITIVE', 'MULTILINE', 'DOTALL', 'UNICODE_CASE'].includes(x));
  if (bad.length) throw new Error(`${what} : drapeau ${bad[0]} non reproduit`);
  let js = '';
  if (f.includes('CASE_INSENSITIVE')) js += 'i'; if (f.includes('MULTILINE')) js += 'm'; if (f.includes('DOTALL')) js += 's';
  try { return new RegExp(p, 'g' + js + 'u'); } catch (e) { throw new Error(`${what} : « ${p} » : ${e.message}`); }
}
// Remplacement Java ($1, ${nom}) → JavaScript
const anRepl = r => String(r === undefined ? '' : r).replace(/\$\{(\w+)\}/g, '$<$1>');
const anLower = s => [...s].map(c => { const l = c.toLowerCase(); return [...l].length === 1 ? l : c; }).join('');
const anUpper = s => [...s].map(c => { const u = c.toUpperCase(); return [...u].length === 1 ? u : c; }).join('');
const anStopSet = (spec, what) => {
  const list = anList(spec);
  const out = [];
  for (const w of list) {
    if (typeof w === 'string' && /^_\w+_$/.test(w)) { if (!AN_STOP[w]) throw new Error(`${what} : liste « ${w} » non reproduite (seules _english_ et _none_ le sont ; donnez la liste des mots)`); out.push(...AN_STOP[w]); }
    else out.push(String(w));
  }
  return out;
};
const anFold = s => {
  let out = s.normalize('NFD').replace(/\p{M}/gu, '');
  for (const [a, b] of AN_FOLD) out = out.split(a).join(b);
  return out;
};

// Caractères d’un groupe token_chars (ngram, edge_ngram) ou tokenize_on_chars (char_group)
const AN_CLASS = { letter: '\\p{L}', digit: '\\p{Nd}', whitespace: AN_WS, punctuation: '\\p{P}', symbol: '\\p{S}' };
function anClass(items, what) {
  const parts = [];
  for (const it of anList(items)) {
    const s = String(it);
    if (AN_CLASS[s]) parts.push(AN_CLASS[s]);
    else if (s === 'custom') continue;
    else if ([...s].length === 1) parts.push(s.replace(/[\]\\^-]/g, '\\$&'));
    else if (/^\\[nrt]$/.test(s)) parts.push(s);
    else throw new Error(`${what} : « ${s} » n’est ni une classe ni un caractère`);
  }
  return parts.join('');
}

function anTokenize(tk, text, notes) {
  const T = tk.type;
  const wrap = list => list.map((t, i) => ({ t, pos: i }));
  switch (T) {
    case 'standard': {
      const max = anNum(tk.max_token_length, 255);
      if (/[぀-ヿ㐀-鿿豈-﫿]/.test(text)) notes.push('Le texte contient des caractères chinois, japonais ou coréens : le découpage UAX#29 d’Elasticsearch (un mot par idéogramme) n’est pas reproduit.');
      const out = [];
      for (const w of esTokens(text, true)) { const cs = [...w]; for (let i = 0; i < cs.length; i += max) out.push(cs.slice(i, i + max).join('')); }
      return wrap(out);
    }
    case 'whitespace': return wrap(text.split(new RegExp(`[${AN_WS}]+`, 'u')).filter(Boolean));
    case 'letter': return wrap(text.match(/\p{L}+/gu) || []);
    case 'lowercase': return wrap((text.match(/\p{L}+/gu) || []).map(anLower));
    case 'keyword': return wrap([text]);
    case 'pattern': {
      const re = anRegex(tk.pattern !== undefined ? tk.pattern : '\\W+', tk.flags, 'tokenizer pattern');
      const g = anNum(tk.group, -1);
      if (g < 0) return wrap(text.split(re).filter(x => x !== undefined && x !== ''));
      const out = []; for (const m of text.matchAll(re)) if (m[g] !== undefined && m[g] !== '') out.push(m[g]);
      return wrap(out);
    }
    case 'char_group': {
      const cls = anClass(tk.tokenize_on_chars, 'tokenizer char_group');
      if (!cls) return wrap(text ? [text] : []);
      return wrap(text.split(new RegExp(`[${cls}]+`, 'u')).filter(Boolean));
    }
    case 'ngram': case 'edge_ngram': {
      const min = anNum(tk.min_gram, 1); const max = anNum(tk.max_gram, T === 'ngram' ? 2 : 2);
      if (!(min >= 1 && max >= min)) throw new Error(`tokenizer ${T} : min_gram et max_gram incohérents`);
      if (T === 'ngram' && max - min > 1) notes.push('index.max_ngram_diff vaut 1 par défaut : Elasticsearch refuse cet analyseur sauf si le réglage est relevé.');
      const cls = anClass(tk.token_chars, `tokenizer ${T}`);
      const parts = cls ? (text.match(new RegExp(`[${cls}]+`, 'gu')) || []) : (text ? [text] : []);
      const out = [];
      for (const w of parts) {
        const cs = [...w];
        if (T === 'ngram') { for (let i = 0; i < cs.length; i++) for (let n = min; n <= max && i + n <= cs.length; n++) out.push(cs.slice(i, i + n).join('')); }
        else for (let n = min; n <= max && n <= cs.length; n++) out.push(cs.slice(0, n).join(''));
      }
      return wrap(out);
    }
    case 'path_hierarchy': {
      const d = tk.delimiter !== undefined ? String(tk.delimiter) : '/';
      if (tk.reverse === true || tk.reverse === 'true' || tk.replacement !== undefined || tk.skip) throw new Error('tokenizer path_hierarchy : reverse, replacement et skip non reproduits');
      // « /a/b » donne « /a » et « /a/b » : le premier élément vide devient le délimiteur de tête ; chaque préfixe est un mot
      let parts = text.split(d); let lead = '';
      if (parts[0] === '') { lead = d; parts = parts.slice(1); }
      const out = parts.map((_, i) => lead + parts.slice(0, i + 1).join(d));
      return wrap(out);
    }
  }
  throw new Error(`tokenizer « ${T} » non pris en charge`);
}

function anFilter(f, tokens, notes) {
  const T = f.type; const map = fn => tokens.map(x => Object.assign({}, x, { t: fn(x.t) }));
  switch (T) {
    case 'lowercase': if (f.language && !/^(english|)$/i.test(f.language)) throw new Error('filtre lowercase : langue spécifique non reproduite'); return map(anLower);
    case 'uppercase': return map(anUpper);
    case 'asciifolding':
      if (f.preserve_original === true || f.preserve_original === 'true') throw new Error('filtre asciifolding : preserve_original non reproduit');
      notes.push('asciifolding : la table de Lucene compte plus d’un millier de remplacements ; sont reproduits ici les lettres accentuées (décomposition Unicode) et æ œ ß ø đ ł þ ð ı.');
      return map(anFold);
    case 'trim': return map(s => s.replace(new RegExp(`^[${AN_WS}]+|[${AN_WS}]+$`, 'gu'), ''));
    case 'unique': { const seen = new Set(); return tokens.filter(x => { const k = f.only_on_same_position ? `${x.pos}\u0000${x.t}` : x.t; if (seen.has(k)) return false; seen.add(k); return true; }); }
    case 'reverse': return map(s => [...s].reverse().join(''));
    case 'truncate': { const n = anNum(f.length, 10); return map(s => s.slice(0, n)); }
    case 'length': { const lo = anNum(f.min, 0); const hi = anNum(f.max, 2147483647); return tokens.filter(x => x.t.length >= lo && x.t.length <= hi); }
    case 'stop': {
      const words = anStopSet(f.stopwords !== undefined ? f.stopwords : '_english_', 'filtre stop');
      const ic = f.ignore_case === true || f.ignore_case === 'true';
      const set = new Set(ic ? words.map(anLower) : words);
      return tokens.filter(x => !set.has(ic ? anLower(x.t) : x.t));
    }
    case 'ngram': case 'edge_ngram': {
      const min = anNum(f.min_gram, 1); const max = anNum(f.max_gram, 2);
      const keep = f.preserve_original === true || f.preserve_original === 'true';
      if (f.side && f.side !== 'front') throw new Error('filtre edge_ngram : side: back non reproduit');
      const out = [];
      for (const x of tokens) {
        const cs = [...x.t];
        if (keep) out.push(x);
        if (T === 'ngram') { for (let i = 0; i < cs.length; i++) for (let n = min; n <= max && i + n <= cs.length; n++) out.push({ t: cs.slice(i, i + n).join(''), pos: x.pos }); }
        else for (let n = min; n <= max && n <= cs.length; n++) out.push({ t: cs.slice(0, n).join(''), pos: x.pos });
      }
      return out;
    }
    case 'pattern_replace': {
      const re = anRegex(f.pattern, f.flags, 'filtre pattern_replace');
      const all = f.all === undefined || f.all === true || f.all === 'true';
      const re2 = all ? re : new RegExp(re.source, re.flags.replace('g', ''));
      return map(s => s.replace(re2, anRepl(f.replacement)));
    }
    case 'elision': {
      const arts = f.articles !== undefined ? anList(f.articles).map(String) : AN_ELISION;
      const ic = f.articles_case === true || f.articles_case === 'true';
      const re = new RegExp(`^(?:${arts.map(escRe).join('|')})['’]`, ic ? 'u' : 'iu');
      return map(s => s.replace(re, ''));
    }
    case 'synonym': case 'synonym_graph': {
      const rules = anList(f.synonyms);
      if (f.synonyms_path || f.synonyms_set) throw new Error('filtre synonym : fichier ou ensemble de synonymes non lu');
      if (f.expand === false || f.expand === 'false') { /* règles « a, b » : tout devient le premier terme */ }
      const eq = []; const ex = new Map();
      for (const rr of rules) {
        const r = String(rr);
        if (/\s/.test(r.replace(/\s*(=>|,)\s*/g, '$1').trim())) throw new Error('filtre synonym : synonyme de plusieurs mots non reproduit');
        if (r.includes('=>')) { const [l, rt] = r.split('=>'); const outs = rt.split(',').map(x => x.trim()); l.split(',').map(x => x.trim()).forEach(k => ex.set(k, outs)); }
        else { const g = r.split(',').map(x => x.trim()).filter(Boolean); if (f.expand === false || f.expand === 'false') g.forEach(k => ex.set(k, [g[0]])); else eq.push(g); }
      }
      const out = [];
      for (const x of tokens) {
        if (ex.has(x.t)) { ex.get(x.t).forEach(t => out.push({ t, pos: x.pos })); continue; }
        const g = eq.find(g2 => g2.includes(x.t));
        if (g) { out.push(x); g.filter(t => t !== x.t).forEach(t => out.push({ t, pos: x.pos })); } else out.push(x);
      }
      return out;
    }
  }
  const STEM = ['stemmer', 'porter_stem', 'kstem', 'snowball', 'stemmer_override', 'hunspell', 'word_delimiter', 'word_delimiter_graph', 'shingle', 'phonetic', 'icu_folding', 'icu_normalizer', 'cjk_width', 'cjk_bigram', 'common_grams', 'keep', 'keep_types', 'limit', 'remove_duplicates', 'classic', 'apostrophe'];
  throw new Error(`filtre « ${T} »${STEM.includes(T) ? ' : pas d’aperçu (Lucene non reproduit ici)' : ' non pris en charge'}`);
}

function anCharFilter(c, text, notes) {
  switch (c.type) {
    case 'html_strip': {
      notes.push('html_strip : balises retirées et entités courantes décodées ; le traitement de Lucene (scripts, commentaires, retours à la ligne des blocs) est plus complet.');
      return text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n]));
    }
    case 'mapping': {
      const pairs = anList(c.mappings).map(m => { const k = String(m).split('=>'); if (k.length !== 2) throw new Error(`char_filter mapping : « ${m} » n’est pas « a => b »`); return [k[0].trim(), k[1].trim()]; });
      if (anList(c.mappings_path).length || c.mappings_path) throw new Error('char_filter mapping : fichier non lu');
      pairs.sort((a, b) => b[0].length - a[0].length);
      let out = ''; let i = 0;
      while (i < text.length) { const hit = pairs.find(([k]) => k && text.startsWith(k, i)); if (hit) { out += hit[1]; i += hit[0].length; } else out += text[i++]; }
      return out;
    }
    case 'pattern_replace': return text.replace(anRegex(c.pattern, c.flags, 'char_filter pattern_replace'), anRepl(c.replacement));
  }
  throw new Error(`char_filter « ${c.type} » non pris en charge`);
}

/*
 * Aperçu : { tokens: [{ t, pos }], stages: [{ stage, text|tokens }], notes, error }. Sur un composant que l’on ne
 * reproduit pas, error dit lequel : aucun mot n’est inventé.
 */
function anAnalyze(spec, text) {
  const notes = []; const stages = [];
  try {
    const ch = anChain(spec);
    let s = String(text);
    for (const c of ch.chars) { s = anCharFilter(c, s, notes); stages.push({ stage: `char_filter ${c.name}`, text: s }); }
    let tokens = anTokenize(ch.tokenizer, s, notes);
    stages.push({ stage: `tokenizer ${ch.tokenizer.name}`, tokens: tokens.map(x => x.t) });
    for (const f of ch.filters) { tokens = anFilter(f, tokens, notes); stages.push({ stage: `filtre ${f.name}`, tokens: tokens.map(x => x.t) }); }
    return { tokens, stages, notes: [...new Set(notes)] };
  } catch (e) { return { tokens: null, stages, notes: [...new Set(notes)], error: e.message }; }
}

/* ---------- Plan : l’expression ClickHouse ---------- */
// Expression Java → RE2 (ClickHouse) ; le remplacement $1 devient \1
function anRe2(pattern, what) {
  const p = String(pattern);
  if (/\(\?<?[=!]|\\[1-9]|\(\?>|[*+?}]\+/.test(p)) throw new Error(`${what} : « ${p} » utilise une construction (anticipation, rétroréférence, quantificateur possessif) que RE2 n’a pas`);
  return p;
}
const anSqlRepl = r => String(r === undefined ? '' : r).replace(/\\/g, '\\\\').replace(/\$(\d)/g, '\\$1');

/*
 * Rend { expr, steps, notes, verdict } : expr est une expression SQL de type Array(String) à partir de col (une
 * expression de type String). Chaque étape dit si elle est exacte (même résultat qu’Elasticsearch) ou à vérifier.
 */
function anPlan(spec, col) {
  const steps = []; const notes = [];
  const note = (level, title, detail) => notes.push({ level, title, detail });
  let ch;
  try { ch = anChain(spec); } catch (e) { return { expr: null, steps, notes: [{ level: 'err', title: 'Analyseur non traduit', detail: e.message }], verdict: 'todo' }; }
  let x = col; let verdict = 'ready';
  const worse = v => { if (v === 'todo' || (v === 'review' && verdict === 'ready')) verdict = v; };
  const step = (label, exact, detail) => { steps.push({ label, exact, detail: detail || null }); if (!exact) worse('review'); };
  const fail = (label, e) => { steps.push({ label, exact: false, detail: e.message, error: true }); note('err', `${label} non traduit`, e.message); worse('todo'); };
  // Caractères
  for (const c of ch.chars) {
    try {
      if (c.type === 'pattern_replace') { x = `replaceRegexpAll(${x}, ${chStr(anRe2(c.pattern, 'char_filter pattern_replace'))}, ${chStr(anSqlRepl(c.replacement))})`; step(`char_filter ${c.name}`, !c.flags, c.flags ? 'drapeaux de l’expression non repris' : null); }
      else if (c.type === 'mapping') {
        const pairs = anList(c.mappings).map(m => String(m).split('=>').map(z => z.trim()));
        if (pairs.some(p => p.length !== 2) || c.mappings_path) throw new Error('mappings illisibles ou dans un fichier');
        // Lucene prend la plus longue clé à chaque position, une seule fois : des remplacements successifs n’y sont équivalents que si aucun résultat ne contient une autre clé
        const keys = pairs.map(p => p[0]); const clash = pairs.some(([k, v]) => keys.some(k2 => k2 && k2 !== k && v.includes(k2))) || keys.some(k => keys.some(k2 => k2 !== k && k.includes(k2)));
        for (const [k, v] of pairs) x = `replaceAll(${x}, ${chStr(k)}, ${chStr(v)})`;
        step(`char_filter ${c.name}`, !clash, clash ? 'des clés se recouvrent : Lucene applique la plus longue en une passe, les remplacements se suivent ici' : null);
      } else if (c.type === 'html_strip') {
        x = `replaceAll(replaceAll(replaceAll(replaceAll(replaceRegexpAll(${x}, '<[^>]*>', ''), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&')`;
        step(`char_filter ${c.name}`, false, 'html_strip de Lucene gère aussi scripts, commentaires et entités numériques');
      } else throw new Error(`char_filter « ${c.type} » non pris en charge`);
    } catch (e) { fail(`char_filter ${c.name}`, e); return { expr: null, steps, notes, verdict }; }
  }
  // Découpage
  const tk = ch.tokenizer; let toks;
  try {
    const nonEmpty = a => `arrayFilter(w -> w != '', ${a})`;
    switch (tk.type) {
      case 'standard': {
        // UAX#29 par expression : lettres, chiffres et _ ; un . ou ' entre deux lettres, un . ou , entre deux chiffres ne coupent pas
        const W = '[\\p{L}\\p{N}_]+(?:(?:[.\'’][\\p{L}]|[.,][\\p{N}])[\\p{L}\\p{N}_]*)*';
        toks = `extractAll(${x}, ${chStr(W)})`;
        step('tokenizer standard', false, 'découpage UAX#29 approché par une expression : « a1.b » reste un mot ici, deux en Elasticsearch ; les idéogrammes ne sont pas séparés');
        if (anNum(tk.max_token_length, 255) !== 255) note('warn', 'max_token_length', 'max_token_length n’est pas appliqué par le plan.');
        break;
      }
      case 'whitespace': toks = nonEmpty(`splitByRegexp(${chStr(`[${AN_WS2}]+`)}, ${x})`); step('tokenizer whitespace', true); break;
      case 'letter': toks = `extractAll(${x}, '\\\\p{L}+')`; step('tokenizer letter', true); break;
      case 'lowercase': toks = `arrayMap(w -> lowerUTF8(w), extractAll(${x}, '\\\\p{L}+'))`; step('tokenizer lowercase', true); break;
      case 'keyword': toks = `[${x}]`; step('tokenizer keyword', true); break;
      case 'pattern': {
        const re = anRe2(tk.pattern !== undefined ? tk.pattern : '\\W+', 'tokenizer pattern'); const g = anNum(tk.group, -1);
        if (tk.flags) throw new Error('drapeaux de l’expression non repris');
        toks = g < 0 ? nonEmpty(`splitByRegexp(${chStr(re)}, ${x})`) : g === 0 ? nonEmpty(`extractAll(${x}, ${chStr(re)})`) : `arrayFilter(w -> w != '', arrayMap(m -> m[${g}], extractAllGroupsVertical(${x}, ${chStr(re)})))`;
        step('tokenizer pattern', true); break;
      }
      case 'char_group': { const cls = anClass(tk.tokenize_on_chars, 'tokenizer char_group').replace(/\\u([0-9A-F]{4})/g, '\\x{$1}'); toks = cls ? nonEmpty(`splitByRegexp(${chStr(`[${cls}]+`)}, ${x})`) : `if(${x} = '', [], [${x}])`; step('tokenizer char_group', true); break; }
      case 'ngram': case 'edge_ngram': {
        const min = anNum(tk.min_gram, 1); const max = anNum(tk.max_gram, 2);
        const cls = anClass(tk.token_chars, `tokenizer ${tk.type}`).replace(/\\u([0-9A-F]{4})/g, '\\x{$1}');
        const parts = cls ? `extractAll(${x}, ${chStr(`[${cls}]+`)})` : `if(${x} = '', [], [${x}])`;
        const one = tk.type === 'ngram'
          ? `arrayFlatten(arrayMap(i -> arrayMap(n -> substringUTF8(w, i, n), arrayFilter(n -> i + n - 1 <= lengthUTF8(w), range(${min}, ${max + 1}))), range(1, lengthUTF8(w) + 1)))`
          : `arrayMap(n -> substringUTF8(w, 1, n), arrayFilter(n -> n <= lengthUTF8(w), range(${min}, ${max + 1})))`;
        toks = `arrayFlatten(arrayMap(w -> ${one}, ${parts}))`; step(`tokenizer ${tk.type}`, true); break;
      }
      case 'path_hierarchy': {
        const d = tk.delimiter !== undefined ? String(tk.delimiter) : '/';
        if (tk.reverse || tk.replacement !== undefined || tk.skip) throw new Error('reverse, replacement et skip non repris');
        // Même découpage que l’aperçu : un premier élément vide devient le délimiteur de tête, chaque préfixe est un mot
        toks = `arrayMap(P -> arrayMap(i -> concat(if(P[1] = '', ${chStr(d)}, ''), arrayStringConcat(arraySlice(if(P[1] = '', arraySlice(P, 2), P), 1, i), ${chStr(d)})), range(1, length(if(P[1] = '', arraySlice(P, 2), P)) + 1)), [splitByString(${chStr(d)}, ${x})])[1]`;
        step('tokenizer path_hierarchy', false, 'délimiteur final et chemins vides : comportement de Lucene non vérifié ici'); break;
      }
      default: throw new Error(`tokenizer « ${tk.type} » non pris en charge`);
    }
  } catch (e) { fail(`tokenizer ${tk.name}`, e); return { expr: null, steps, notes, verdict }; }
  x = toks;
  // Filtres
  const map = fn => { x = `arrayMap(t -> ${fn}, ${x})`; };
  const keep = pred => { x = `arrayFilter(t -> ${pred}, ${x})`; };
  for (const f of ch.filters) {
    try {
      switch (f.type) {
        case 'lowercase': if (f.language) throw new Error('langue spécifique non reprise'); map('lowerUTF8(t)'); step(`filtre ${f.name}`, true); break;
        case 'uppercase': map('upperUTF8(t)'); step(`filtre ${f.name}`, false, 'upperUTF8 applique les correspondances multi-lettres (ß → SS) que Lucene ignore : seuls les mots avec ß ou ligatures diffèrent'); break;
        case 'asciifolding': {
          if (f.preserve_original === true || f.preserve_original === 'true') throw new Error('preserve_original non repris');
          let e = 'replaceRegexpAll(normalizeUTF8NFD(t), \'\\\\p{M}\', \'\')';
          for (const [a, b] of AN_FOLD) e = `replaceAll(${e}, ${chStr(a)}, ${chStr(b)})`;
          map(e); step(`filtre ${f.name}`, false, 'accents et æ œ ß ø đ ł þ ð ı ; la table de Lucene est plus large'); break;
        }
        case 'trim': map(`replaceRegexpAll(t, ${chStr(`^[${AN_WS2}]+|[${AN_WS2}]+$`)}, '')`); step(`filtre ${f.name}`, true); break;
        case 'unique': if (f.only_on_same_position) throw new Error('only_on_same_position non repris'); x = `arrayDistinct(${x})`; step(`filtre ${f.name}`, true); break;
        case 'reverse': map('reverseUTF8(t)'); step(`filtre ${f.name}`, true); break;
        case 'truncate': map(`substringUTF8(t, 1, ${anNum(f.length, 10)})`); step(`filtre ${f.name}`, true, 'longueur comptée en caractères (Elasticsearch : unités UTF-16, identique hors caractères hors plan de base)'); break;
        case 'length': keep(`lengthUTF8(t) BETWEEN ${anNum(f.min, 0)} AND ${anNum(f.max, 2147483647)}`); step(`filtre ${f.name}`, true, 'longueur comptée en caractères (Elasticsearch : unités UTF-16, identique hors caractères hors plan de base)'); break;
        case 'stop': {
          const words = anStopSet(f.stopwords !== undefined ? f.stopwords : '_english_', 'filtre stop');
          const ic = f.ignore_case === true || f.ignore_case === 'true';
          if (words.length) keep(`NOT has([${words.map(w => chStr(ic ? anLower(w) : w)).join(', ')}], ${ic ? 'lowerUTF8(t)' : 't'})`);
          step(`filtre ${f.name}`, true, 'les positions des mots retirés ne sont pas conservées (match_phrase : voir les notes)'); break;
        }
        case 'ngram': case 'edge_ngram': {
          const min = anNum(f.min_gram, 1); const max = anNum(f.max_gram, 2);
          if (f.preserve_original === true || f.preserve_original === 'true') throw new Error('preserve_original non repris');
          if (f.side && f.side !== 'front') throw new Error('side: back non repris');
          const one = f.type === 'ngram'
            ? `arrayFlatten(arrayMap(i -> arrayMap(n -> substringUTF8(t, i, n), arrayFilter(n -> i + n - 1 <= lengthUTF8(t), range(${min}, ${max + 1}))), range(1, lengthUTF8(t) + 1)))`
            : `arrayMap(n -> substringUTF8(t, 1, n), arrayFilter(n -> n <= lengthUTF8(t), range(${min}, ${max + 1})))`;
          x = `arrayFlatten(arrayMap(t -> ${one}, ${x}))`; step(`filtre ${f.name}`, true); break;
        }
        case 'pattern_replace': {
          const re = anRe2(f.pattern, 'filtre pattern_replace');
          const all = f.all === undefined || f.all === true || f.all === 'true';
          map(`${all ? 'replaceRegexpAll' : 'replaceRegexpOne'}(t, ${chStr(re)}, ${chStr(anSqlRepl(f.replacement))})`); step(`filtre ${f.name}`, !f.flags, f.flags ? 'drapeaux non repris' : null); break;
        }
        case 'elision': {
          const arts = f.articles !== undefined ? anList(f.articles).map(String) : AN_ELISION;
          map(`replaceRegexpOne(t, ${chStr(`^(?i:${arts.map(escRe).join('|')})['’]`)}, '')`); step(`filtre ${f.name}`, !(f.articles_case === true), f.articles_case === true ? 'articles_case non repris' : null); break;
        }
        case 'synonym': case 'synonym_graph': {
          if (f.synonyms_path || f.synonyms_set) throw new Error('fichier ou ensemble de synonymes non lu');
          const rules = anList(f.synonyms).map(String);
          if (rules.some(r => r.split(/=>|,/).some(z => /\s/.test(z.trim())))) throw new Error('synonyme de plusieurs mots non traduit');
          // Les deux côtés (index et recherche) ramenés à un terme canonique : mêmes correspondances qu’avec les synonymes d’Elasticsearch, pour des mots simples
          const from = []; const to = [];
          for (const r of rules) {
            if (r.includes('=>')) { const [l, rt] = r.split('=>'); const outs = rt.split(',').map(z => z.trim()); if (outs.length > 1) throw new Error('règle « a => b, c » non traduite (un mot devient plusieurs)'); l.split(',').map(z => z.trim()).forEach(k => { from.push(k); to.push(outs[0]); }); }
            else { const g = r.split(',').map(z => z.trim()).filter(Boolean); g.slice(1).forEach(k => { from.push(k); to.push(g[0]); }); }
          }
          if (from.length) map(`transform(t, [${from.map(chStr).join(', ')}], [${to.map(chStr).join(', ')}], t)`);
          step(`filtre ${f.name}`, false, 'les mots sont ramenés à un terme canonique, à l’indexation comme à la recherche : mêmes résultats, mais les mots indexés ne sont pas ceux d’Elasticsearch');
          break;
        }
        case 'stemmer': case 'snowball': case 'porter_stem': {
          const lang = String(f.type === 'porter_stem' ? 'porter' : (f.language || f.name_ || 'english')).toLowerCase();
          const L = { english: 'en', porter: 'en', porter2: 'en', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', russian: 'ru', romanian: 'ro', turkish: 'tr', hungarian: 'hu' }[lang];
          if (!L) throw new Error(`stemmer « ${lang} » sans équivalent dans stem() de ClickHouse (Snowball)`);
          map(`stem(t, '${L}')`);
          step(`filtre ${f.name}`, false, `stem(mot, '${L}') suit Snowball (Porter2 pour l’anglais) ; le stemmer « ${lang} » d’Elasticsearch peut en différer sur certains mots : comparez sur vos données. Demande allow_experimental_nlp_functions = 1`);
          break;
        }
        default: throw new Error(`filtre « ${f.type} » non pris en charge`);
      }
    } catch (e) { fail(`filtre ${f.name}`, e); return { expr: null, steps, notes, verdict }; }
  }
  if (ch.filters.some(f => f.type === 'stop')) note('info', 'Positions', 'Les mots vides retirés laissent un trou dans les positions d’Elasticsearch ; dans la colonne de mots, un match_phrase par hasSubstr() ne les saute pas : une phrase contenant un mot vide doit être cherchée sans lui.');
  return { expr: x, steps, notes, verdict };
}

// Identifiant ClickHouse : nu s’il est simple, entre apostrophes inverses sinon (les champs aplatis contiennent des points)
const anId = n => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? chIdent(n) : '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`');

/*
 * Plan de table pour un champ : colonne de mots (MATERIALIZED), index de texte sur cette colonne, et la requête
 * qui retrouve les mêmes lignes que match / match_phrase. sample : un texte d’exemple pour la requête ; src : la
 * colonne qui porte le texte et son type (un sous-champ « titre.debut » est calculé depuis la colonne « titre »).
 */
function anFieldPlan(table, field, spec, sample, src) {
  const column = src && src.column ? src.column : field;
  const type = src && src.type ? String(src.type) : 'String';
  const base = String(column);
  const tname = `${String(field).replace(/\W+/g, '_')}_mots`; const tcol = anId(tname);
  const array = /^Array\(/.test(type); const nullable = /^Nullable\(/.test(type);
  const plan = anPlan(spec, array ? 'v' : nullable ? `ifNull(${anId(base)}, '')` : anId(base));
  const out = { table, field, column: base, name: typeof spec === 'string' ? spec : spec.name || spec.type, verdict: plan.verdict, steps: plan.steps, notes: plan.notes, expr: plan.expr };
  if (!plan.expr) return out;
  // Valeur multiple : chaque valeur est analysée à part (Elasticsearch les sépare d’un trou de positions) ; valeur absente : aucun mot
  if (array) out.expr = `arrayFlatten(arrayMap(v -> ${plan.expr}, ${anId(base)}))`;
  else if (nullable) out.expr = `if(isNull(${anId(base)}), [], ${plan.expr})`;
  if (field !== base) plan.notes.push({ level: 'info', title: 'Sous-champ', detail: `« ${field} » est un sous-champ de « ${base} » dans le mapping : il n’a pas de colonne, ses mots sont calculés depuis « ${base} ».` });
  const tbl = chIdent(table); const idx = anId(`idx_${tname}`);
  out.ddl = [
    `ALTER TABLE ${tbl} ADD COLUMN ${tcol} Array(String) MATERIALIZED ${out.expr};`,
    `ALTER TABLE ${tbl} ADD INDEX ${idx} ${tcol} TYPE text(tokenizer = 'array') GRANULARITY 1;`,
    `ALTER TABLE ${tbl} MATERIALIZE COLUMN ${tcol};`,
    `ALTER TABLE ${tbl} MATERIALIZE INDEX ${idx};`
  ];
  out.wordsColumn = tname;
  if (sample !== undefined) {
    const a = anAnalyze(spec, sample);
    if (a.tokens) {
      const w = [...new Set(a.tokens.map(x => x.t))];
      out.query = { sample, tokens: a.tokens.map(x => x.t), match_and: `hasAll(${tcol}, [${w.map(chStr).join(', ')}])`, match_or: `hasAny(${tcol}, [${w.map(chStr).join(', ')}])`, match_phrase: `hasSubstr(${tcol}, [${a.tokens.map(x => chStr(x.t)).join(', ')}])` };
    } else out.query = { sample, error: a.error };
  }
  return out;
}

/*
 * Plans de tous les analyseurs des tables d’un résultat de schemaFromElastic() : { plans, markdown, verdict }.
 * sample : un texte d’exemple dont l’aperçu et la requête sont donnés pour chaque champ ; only : un seul champ.
 */
function anReport(tables, sample, only) {
  const plans = [];
  for (const t of tables) {
    for (const [field, spec] of Object.entries((t.profile && t.profile.analyzers) || {})) {
      if (only && field !== only) continue;
      // Colonne qui porte le texte : celle du champ, sinon celle de son champ parent (sous-champ d’un multi-field)
      const cols = (t.profile && t.profile.columns) || {};
      let column = field; while (column && cols[column] === undefined && column.includes('.')) column = column.slice(0, column.lastIndexOf('.'));
      plans.push({ plan: anFieldPlan(t.table, field, spec, sample, cols[column] !== undefined ? { column, type: cols[column] } : null), preview: sample !== undefined ? anAnalyze(spec, sample) : null });
    }
  }
  const rank = { ready: 0, review: 1, todo: 2 };
  const verdict = plans.reduce((v, p) => (rank[p.plan.verdict] > rank[v] ? p.plan.verdict : v), 'ready');
  const L = ['# Analyseurs personnalisés : plan ClickHouse', ''];
  if (!plans.length) L.push('Aucun analyseur personnalisé trouvé : les champs text suivent l’analyseur standard, que la traduction des requêtes reproduit déjà.', '');
  for (const { plan: p, preview } of plans) {
    const mark = { ready: 'prêt', review: 'à vérifier', todo: 'à reprendre' }[p.verdict];
    L.push(`## ${p.table} · ${p.field} · analyseur « ${p.name} » — ${mark}`, '');
    for (const st of p.steps) L.push(`- ${st.error ? '✗' : st.exact ? '✓' : '≈'} ${st.label}${st.detail ? ` — ${st.detail}` : ''}`);
    for (const n of p.notes) L.push(`- ${n.level === 'err' ? '✗' : 'ℹ'} ${n.title} — ${n.detail}`);
    L.push('');
    if (preview) {
      if (preview.error) L.push(`Aperçu de « ${sample} » : impossible — ${preview.error}`, '');
      else {
        L.push(`Aperçu de « ${sample} » (ce qu’Elasticsearch indexerait) :`, '');
        for (const st of preview.stages) L.push(`- ${st.stage} : ${st.tokens ? st.tokens.map(x => `[${x}]`).join(' ') || '(aucun mot)' : JSON.stringify(st.text)}`);
        for (const n of preview.notes) L.push(`- ℹ ${n}`);
        L.push('');
      }
    }
    if (p.ddl) {
      L.push('```sql', ...p.ddl, '```', '');
      if (p.query && !p.query.error) L.push('Recherche de la même phrase :', '', '```sql', `-- match (tous les mots)\n${p.query.match_and}`, `-- match (un des mots)\n${p.query.match_or}`, `-- match_phrase\n${p.query.match_phrase}`, '```', '');
    }
  }
  return { plans, markdown: L.join('\n'), verdict };
}
