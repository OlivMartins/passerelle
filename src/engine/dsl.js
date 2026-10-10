/* Passerelle — moteur partie 2 : DSL Elasticsearch → SQL ClickHouse */
const DM_UNIT = { y: 'YEAR', M: 'MONTH', w: 'WEEK', d: 'DAY', h: 'HOUR', H: 'HOUR', m: 'MINUTE', s: 'SECOND' };
const DM_ROUND = { y: 'toStartOfYear', M: 'toStartOfMonth', w: 'toMonday', d: 'toStartOfDay', h: 'toStartOfHour', H: 'toStartOfHour', m: 'toStartOfMinute' };
const FR_UNIT = { y: ['année', 'années', 'f'], M: ['mois', 'mois', 'm'], w: ['semaine', 'semaines', 'f'], d: ['jour', 'jours', 'm'], h: ['heure', 'heures', 'f'], H: ['heure', 'heures', 'f'], m: ['minute', 'minutes', 'f'], s: ['seconde', 'secondes', 'f'] };
const ISO_RE = /^\d{4}-\d{2}(-\d{2})?([T ][\d:.,]+)?(Z|[+-]\d{2}:?\d{2})?$/;

function parseDateMath(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, '');
  let base, rest;
  if (s.startsWith('now')) { base = { now: true }; rest = s.slice(3); }
  else {
    const k = s.indexOf('||');
    if (k < 0) return ISO_RE.test(s) ? { abs: s, steps: [], ops: [], round: null } : null;
    base = { abs: s.slice(0, k) }; rest = s.slice(k + 2);
  }
  // Suite d’opérations appliquées dans l’ordre : décalages (+1d, -2M) et arrondis (/d), l’arrondi pouvant être suivi d’un décalage
  if (!/^(?:[+-]\d+[yMwdhHms]|\/[yMwdhHms])*$/.test(rest)) return null;
  const steps = [...rest.matchAll(/([+-])(\d+)([yMwdhHms])|\/([yMwdhHms])/g)].map(x => (x[4] ? { round: x[4] } : { sign: x[1], n: +x[2], unit: x[3] }));
  const rounds = steps.filter(x => x.round);
  // ops : les décalages seuls ; round : unité du dernier arrondi (null s’il n’y en a pas)
  return Object.assign(base, { steps, ops: steps.filter(x => !x.round), round: rounds.length ? rounds[rounds.length - 1].round : null });
}
/*
 * Expression SQL d’une date « date math » d’Elasticsearch (now-7d/d, 2026-03-10||+1M/M…).
 * Décalages calendaires et arrondis se calculent dans le fuseau de la requête, UTC par défaut (voir zoneOf).
 * Le fuseau est porté par la valeur de départ, now('UTC') ou date analysée en UTC : les fonctions d’arrondi le reprennent.
 */
function dateMathSQL(ctx, dm, tz, roundUp) {
  const zone = zoneOf(ctx.cfg, tz);
  const calendar = !!dm.round || dm.ops.some(op => 'yMwd'.includes(op.unit));
  let e;
  if (dm.now) e = zone && calendar ? `now(${chStr(zone)})` : 'now()';
  else e = `parseDateTime64BestEffort(${chStr(dm.abs)}, 3${zone ? `, ${chStr(zone)}` : ''})`;
  for (const step of dm.steps || dm.ops) {
    if (!step.round) { e = `${e} ${step.sign} INTERVAL ${step.n} ${DM_UNIT[step.unit]}`; continue; }
    if (!DM_ROUND[step.round]) continue;
    e = `${DM_ROUND[step.round]}(${e})`;
    // Semaine, mois et année s’arrondissent en Date, que ClickHouse relirait ensuite dans le fuseau du serveur
    if (zone && 'yMw'.includes(step.round)) e = `toDateTime(${e}, ${chStr(zone)})`;
    // Borne haute : Elasticsearch va jusqu’à la fin de l’unité ; ici son début plus une unité, comparé strictement
    if (roundUp) e += ` + INTERVAL 1 ${DM_UNIT[step.round]}`;
  }
  return e;
}
// Le champ est-il une date ? Faute de schéma : colonne temporelle de la configuration, champ runtime de type date, ou nom évocateur
function isDateField(ctx, field) {
  const base = String(field).replace(/\.keyword$/, '');
  if (ctx.runtime[base]) return ctx.runtime[base].type === 'date';
  const type = fieldType(ctx, field);
  if (type) return type.kind === 'date';
  return fieldColumn(ctx, field) === ctx.cfg.clickhouse.time_field || guessType(ctx, base) === 'date';
}
// Instant donné en epoch millis (le format par défaut d’un champ date accepte un nombre)
const isEpoch = v => typeof v === 'number' || /^\d{5,}$/.test(String(v));
const epochMillisSQL = v => `fromUnixTimestamp64Milli(toInt64(${chNum(v, 'date en epoch millis')}))`;
// Borne de date d’une agrégation (hard_bounds, date_range…) : epoch millis, date math ou date écrite en clair
function dateBoundSQL(ctx, v, tz) {
  if (isEpoch(v)) return epochMillisSQL(v);
  return dateMathSQL(ctx, parseDateMath(String(v)) || { abs: String(v), steps: [], ops: [], round: null }, tz);
}
// Valeur de curseur d’une clé de regroupement : la clé d’un date_histogram arrive d’Elasticsearch en epoch millis
function cursorValueSQL(key, v) {
  if (!key.date || !isEpoch(v)) return chVal(v);
  return key.date.asDate ? `toDate(${epochMillisSQL(v)}${key.date.zone ? `, ${chStr(key.date.zone)}` : ''})` : epochMillisSQL(v);
}
function humanSince(dm) {
  if (!dm || !dm.now || dm.ops.length !== 1 || dm.ops[0].sign !== '-') return null;
  const { n, unit } = dm.ops[0]; const [sg, pl, g] = FR_UNIT[unit];
  if (n === 1) return g === 'f' ? `la dernière ${sg}` : `le dernier ${sg}`;
  return g === 'f' ? `les ${n} dernières ${pl}` : `les ${n} derniers ${pl}`;
}
function humanDate(v) {
  const dm = parseDateMath(v);
  if (dm && dm.now && !dm.ops.length) return 'maintenant';
  if (dm && dm.now) { const o = dm.ops[0]; return `il y a ${o.n} ${o.n > 1 ? FR_UNIT[o.unit][1] : FR_UNIT[o.unit][0]}`; }
  return String(v);
}

function makeDslCtx(cfg) {
  const notes = makeNotes();
  const ctx = {
    cfg, notes, stats: { ok: 0, approx: 0, ko: 0 },
    runtime: {}, human: { period: null, filters: [], excludes: [], text: [], groups: [], metrics: [], hits: null, runtime: [] },
    cap: [], humanOff: 0, dateFields: new Set(), textCols: new Set(), groupCols: new Set(), leadingWildcard: false,
    // Schéma des colonnes : table en cours, colonnes Nullable rencontrées, et constructions dont la justesse en dépend
    table: null, schema: hasSchema(cfg), nullableCols: new Set(), schemaGaps: new Set(),
    // Listes de valeurs sorties du SQL (clickhouse.lists.threshold), par nom
    lists: new Map()
  };
  ctx.mapField = f => mapField(ctx, f);
  ctx.kindOf = f => { const t = fieldType(ctx, f); return t ? t.kind : null; };
  return ctx;
}
// Colonne ClickHouse d’un champ Elasticsearch : sous-champ .keyword retiré, puis field_mapping
function fieldColumn(ctx, field) {
  const base = String(field).replace(/\.keyword$/, '');
  const fm = ctx.cfg.clickhouse.field_mapping || {};
  return Object.prototype.hasOwnProperty.call(fm, base) && fm[base] ? fm[base] : base;
}
// Type de la colonne d’après clickhouse.columns ; null pour un champ runtime ou une colonne que le schéma ne décrit pas
function fieldType(ctx, field) {
  if (ctx.runtime[String(field).replace(/\.keyword$/, '')]) return null;
  return columnType(ctx.cfg, ctx.table, fieldColumn(ctx, field));
}
const isArrayField = (ctx, field) => { const t = fieldType(ctx, field); return !!t && t.array; };
/*
 * « Le champ n’a pas de valeur » et son contraire, selon le type de la colonne :
 * tableau vide, chaîne vide quand elle représente l’absence (empty_as_missing), NULL sinon.
 */
function absentSQL(ctx, field) {
  const f = mapField(ctx, field); const t = fieldType(ctx, field);
  if (t && t.array) return `empty(${f})`;
  return emptyIsMissing(ctx, t) ? `${f} = ''` : `isNull(${f})`;
}
function presentSQL(ctx, field) {
  const f = mapField(ctx, field); const t = fieldType(ctx, field);
  if (t && t.array) return `notEmpty(${f})`;
  return emptyIsMissing(ctx, t) ? `${f} != ''` : `isNotNull(${f})`;
}
/*
 * Applique un prédicat aux valeurs d’un champ. Un champ multivalué d’Elasticsearch est une colonne Array :
 * le document correspond dès qu’une de ses valeurs satisfait le prédicat.
 */
function onValues(ctx, field, predicate) {
  const f = mapField(ctx, field);
  return isArrayField(ctx, field) ? `arrayExists(x -> ${predicate('x')}, ${f})` : predicate(f);
}
// Une chaîne vide représente-t-elle un champ absent dans cette colonne ? (convention clickhouse.empty_as_missing)
const emptyIsMissing = (ctx, t) => !!t && !t.nullable && !t.array && t.kind === 'string' && !!ctx.cfg.clickhouse.empty_as_missing;
function H(ctx, kind, text) {
  if (ctx.humanOff) return;
  if (ctx.cap.length) { ctx.cap[ctx.cap.length - 1].push(text); return; }
  if (kind === 'period') { ctx.human.period = text; return; }
  ctx.human[kind].push(text);
}
function mapField(ctx, field) {
  let name = String(field);
  if (name.endsWith('.keyword')) {
    const base = name.slice(0, -8);
    ctx.notes.add('info', 'Suffixe .keyword retiré', `« ${name} » devient « ${base} » : ClickHouse stocke la valeur brute, sans sous-champ analysé.`);
    name = base;
  }
  if (ctx.runtime[name] && !ctx.runtime[name].busy) {
    ctx.columns.add(ctx.runtime[name].alias);
    // Lu depuis une clause de requête : le champ runtime sert de filtre
    if (ctx.filtering) ctx.runtime[name].filtered = true;
    return ctx.runtime[name].alias;
  }
  const fm = ctx.cfg.clickhouse.field_mapping || {};
  if (Object.prototype.hasOwnProperty.call(fm, name) && fm[name]) name = fm[name];
  if (name === '_id') ctx.notes.add('warn', 'Champ _id', 'Elasticsearch génère _id ; dans ClickHouse il faut une colonne équivalente (par ex. un UUID ou un identifiant métier).');
  ctx.columns.add(name);
  const type = columnType(ctx.cfg, ctx.table, name);
  if (type && type.nullable) ctx.nullableCols.add(chIdent(name));
  return chIdent(name);
}
function isTextField(ctx, field) {
  const base = String(field).replace(/\.keyword$/, '');
  if (String(field).endsWith('.keyword')) return false;
  return (ctx.cfg.clickhouse.text_fields || []).includes(base);
}
function tokensOf(s) { return String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function textIndexNote(ctx, col) {
  ctx.textCols.add(col);
}
function hasTok(f, t) { return `hasTokenCaseInsensitive(${f}, ${chStr(t)})`; }
function todo(ctx, what, detail) {
  ctx.stats.ko++;
  ctx.notes.add('err', `${what} non traduit`, detail);
  // Une clause non traduite ne doit pas laisser un SQL qui s’exécute et renvoie un résultat faux
  // (dans un must_not, l’ancien « 1 » écartait toutes les lignes) : throwIf arrête la requête
  // avec un message explicite, y compris sous EXPLAIN.
  return `throwIf(1, ${chStr(`Passerelle : ${what} à traduire`)})`;
}
function fieldEntry(body) {
  const k = Object.keys(body).find(x => !['boost', '_name', 'queryName'].includes(x));
  return [k, body[k]];
}
function msmCount(msm, n) {
  if (msm === undefined || msm === null) return null;
  if (typeof msm === 'number') return msm < 0 ? Math.max(n + msm, 0) : Math.min(msm, n);
  const s = String(msm).trim();
  let m = /^(-?)(\d+)%$/.exec(s);
  if (m) { const k = Math.floor(n * (+m[2]) / 100); return m[1] ? n - k : k; }
  if (/^-?\d+$/.test(s)) { const k = +s; return k < 0 ? Math.max(n + k, 0) : Math.min(k, n); }
  return null;
}
function likeEscape(v) { return String(v).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_'); }
function globToRe(g) { return '^' + String(g).split('*').map(escRe).join('.*') + '$'; }
function textFieldsOr(ctx, fields) { const tf = ctx.cfg.clickhouse.text_fields || []; return fields && fields.length ? fields : (tf.length ? tf : ['message']); }

/* ---------- Clauses de requête ---------- */
function splitTopAnd(s) {
  if (isWrapped(s) || /\bBETWEEN\b/.test(s) || topHas(s, /^ OR /)) return [s];
  const out = []; let last = 0;
  scanTop(s, i => { if (s.startsWith(' AND ', i)) { out.push(s.slice(last, i)); last = i + 5; } });
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}
/*
 * Le prédicat peut-il valoir NULL ? Oui s’il lit une colonne Nullable (d’après clickhouse.columns) ailleurs
 * que dans un test de nullité. Dans WHERE, NULL vaut faux, ce qui convient à un filtre positif. Mais
 * NOT NULL reste NULL : la ligne est écartée, alors qu’Elasticsearch garde un document qui n’a pas le champ.
 */
function mayBeNull(ctx, s) {
  if (!ctx.nullableCols.size) return false;
  const bare = String(s).replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const col of ctx.nullableCols) {
    const c = escRe(col);
    const uses = bare.match(new RegExp(`(?<![A-Za-z0-9_.\`])${c}(?![A-Za-z0-9_.\`(])`, 'g')) || [];
    const guarded = bare.match(new RegExp(`\\b(?:isNull|isNotNull)\\(${c}\\)|\\bifNull\\(${c},|(?<![A-Za-z0-9_.\`])${c} IS (?:NOT )?NULL`, 'g')) || [];
    if (uses.length > guarded.length) return true;
  }
  return false;
}
const OPPOSITE = { isNull: 'isNotNull', isNotNull: 'isNull', empty: 'notEmpty', notEmpty: 'empty' };
/* Négation d’un prédicat, fidèle à must_not : un document qui n’a pas le champ ne correspond pas à la clause, donc il est gardé */
function negate(ctx, s) { return negateWith(s, mayBeNull(ctx, s)); }
function negateWith(s, nullable) {
  if (!topHas(s, /^ (AND|OR) /) && !/^NOT /.test(s)) {
    const test = /^(isNull|isNotNull|empty|notEmpty)\((.*)\)$/.exec(s);
    if (test && isWrapped(`(${test[2]})`)) return `${OPPOSITE[test[1]]}(${test[2]})`;
    let eq = -1, cnt = 0, inn = -1;
    scanTop(s, i => { if (s.startsWith(' = ', i)) { eq = i; cnt++; } if (s.startsWith(' IN (', i)) inn = i; });
    if (cnt === 1 && inn < 0) {
      const lhs = s.slice(0, eq); const neg = `${lhs} != ${s.slice(eq + 3)}`;
      return nullable ? `(${neg} OR ${lhs} IS NULL)` : neg;
    }
    if (inn > 0 && cnt === 0) {
      const lhs = s.slice(0, inn); const neg = `${lhs} NOT IN (${s.slice(inn + 5)}`;
      return nullable ? `(${neg} OR ${lhs} IS NULL)` : neg;
    }
    let ne = -1, neCount = 0;
    scanTop(s, i => { if (s.startsWith(' != ', i)) { ne = i; neCount++; } });
    if (!nullable && cnt === 0 && inn < 0 && neCount === 1) return `${s.slice(0, ne)} = ${s.slice(ne + 4)}`;
    // Comparaison seule : a >= b devient a < b, plus lisible que NOT (a >= b)
    const FLIP = { ' >= ': ' < ', ' <= ': ' > ', ' > ': ' <= ', ' < ': ' >= ' };
    let at = -1, found = null, comparisons = 0;
    scanTop(s, i => { const op = Object.keys(FLIP).find(o => s.startsWith(o, i)); if (op) { at = i; found = op; comparisons++; } });
    if (comparisons === 1 && cnt === 0 && inn < 0 && neCount === 0) {
      const lhs = s.slice(0, at); const neg = `${lhs}${FLIP[found]}${s.slice(at + found.length)}`;
      return nullable ? `(${neg} OR ${lhs} IS NULL)` : neg;
    }
  }
  if (nullable) return `NOT ifNull(${isWrapped(s) ? s.slice(1, -1) : s}, 0)`;
  // Un appel de fonction seul n’a pas besoin de parenthèses : NOT startsWith(host, 'db')
  const call = /^[A-Za-z_]\w*\(/.test(s) && isWrapped(s.slice(s.indexOf('(')));
  return `NOT ${isWrapped(s) || call ? s : '(' + s + ')'}`;
}
// Condition comptée dans une somme (minimum_should_match) : NULL ferait de toute la somme un NULL
const countable = (ctx, c) => (mayBeNull(ctx, c) ? `ifNull(${c}, 0)` : `(${c})`);
/* ---------- Filtre sur un champ runtime ---------- */
/*
 * Un champ runtime de classification émet une constante par branche :
 *     if (latence < 100) emit('rapide'); else if (latence < 1000) emit('normal'); else emit('lent');
 * Filtrer sur sa valeur (classe = 'lent') oblige ClickHouse à le calculer pour chaque ligne. Le filtre est
 * donc remonté aux colonnes sources (latence >= 1000) : même résultat, mais la clé de tri et les index
 * redeviennent utilisables. Renvoie undefined quand le script ne s’y prête pas (le filtre porte alors sur
 * l’alias), et null quand toutes les valeurs émises sont recherchées (il n’y a alors rien à filtrer).
 */
function runtimeFilter(ctx, field, values) {
  const rt = ctx.runtime[String(field).replace(/\.keyword$/, '')];
  if (!rt || rt.busy || !rt.tree) return undefined;
  const wanted = new Set(values.map(String));
  const constant = v => (v.lit !== undefined ? v.lit : v.ty === 'num' && /^-?\d+(\.\d+)?$/.test(v.sql) ? Number(v.sql) : undefined);
  // Expressions booléennes : true, false, une condition SQL, { and: [...] } ou { or: [...] }
  const both = (op, a, b) => ({ [op]: [a, b].flatMap(x => (isObj(x) && x[op] ? x[op] : [x])) });
  const and = (a, b) => (a === false || b === false ? false : a === true ? b : b === true ? a : both('and', a, b));
  const or = (a, b) => (a === true || b === true ? true : a === false ? b : b === false ? a : both('or', a, b));
  let leaves = 0; let invertible = true;
  // Condition sous laquelle la branche émet une valeur recherchée. Les simplifications suivent l’arbre :
  // « c OU (NON c ET suite) » se réduit à « c OU suite », comme le fait un lecteur du script.
  const match = (function walk(node) {
    if (node.k === 'none') return false; // branche qui n’émet rien : aucune valeur ne lui correspond
    if (node.k === 'val') {
      const value = constant(node.v);
      if (value === undefined) invertible = false;
      leaves++;
      return wanted.has(String(value));
    }
    const then = walk(node.t); const otherwise = walk(node.e);
    if (then === true && otherwise === true) return true;
    if (then === true) return or(node.c, otherwise);
    if (otherwise === true) return or(negate(ctx, node.c), then);
    return or(and(node.c, then), and(negate(ctx, node.c), otherwise));
  })(rt.tree);
  if (!invertible || leaves < 2) return undefined;
  if (match === false) return 'false';
  if (match === true) return null; // toutes les branches émettent une valeur recherchée : rien à filtrer
  // Rendu en SQL ; null signifie « toujours vrai »
  const conds = e => (isObj(e) && e.and ? tightenBounds(e.and.map(sqlOf).filter(x => x !== null)) : [sqlOf(e)]);
  function sqlOf(e) {
    if (typeof e === 'string') return e;
    if (e.and) return andJoin(conds(e));
    const lists = e.or.map(conds);
    if (lists.some(l => !l.length || l.includes(null))) return null;
    const branches = mergeIntervals(lists);
    return branches === null ? null : branches.length === 1 ? andJoin(branches[0]) : orJoin(branches.map(b => andJoin(b)));
  }
  const sql = sqlOf(match);
  if (sql === null) return null;
  if (sql.length > 400) return undefined;
  ctx.notes.add('opt', `Filtre sur « ${rt.name} » remonté aux colonnes`, `Le champ runtime « ${rt.name} » classe les lignes selon des conditions simples. Le filtre sur sa valeur est réécrit avec ces conditions : ClickHouse n’a plus à calculer le champ pour chaque ligne, et peut s’appuyer sur la clé de tri et les index des colonnes sources.`);
  return sql;
}
const BOUND = /^(.+) (>=|>|<=|<) (-?\d+(?:\.\d+)?)$/;
// Parmi les comparaisons d’une même expression à des nombres, garde la borne basse et la borne haute les plus strictes
function tightenBounds(conds) {
  const out = []; const bounds = new Map();
  for (const c of conds) {
    const m = topHas(c, /^ (AND|OR) /) ? null : BOUND.exec(c);
    if (!m) { out.push(c); continue; }
    const lhs = m[1]; const lower = m[2][0] === '>'; const strict = m[2].length === 1; const n = Number(m[3]);
    if (!bounds.has(lhs)) { bounds.set(lhs, { lo: null, hi: null }); out.push({ lhs }); }
    const side = lower ? 'lo' : 'hi'; const cur = bounds.get(lhs)[side];
    const tighter = !cur || (lower ? n > cur.n : n < cur.n) || (n === cur.n && strict);
    if (tighter) bounds.get(lhs)[side] = { n, strict, sql: c };
  }
  return out.flatMap(x => (typeof x === 'string' ? [x] : [bounds.get(x.lhs).lo, bounds.get(x.lhs).hi].filter(Boolean).map(b => b.sql)));
}
// Réunit les branches qui sont des intervalles contigus d’une même expression : [100, 1000[ et [1000, +∞[ donnent [100, +∞[.
// Renvoie null si la réunion couvre toutes les valeurs : il n’y a alors rien à écrire de sûr.
function mergeIntervals(branches) {
  const interval = conds => {
    const ms = conds.map(c => BOUND.exec(c));
    if (!conds.length || conds.length > 2 || ms.some(m => !m) || new Set(ms.map(m => m[1])).size !== 1) return null;
    const iv = { lhs: ms[0][1], lo: null, hi: null };
    for (const m of ms) {
      const side = m[2][0] === '>' ? 'lo' : 'hi';
      if (iv[side]) return null;
      iv[side] = { n: Number(m[3]), strict: m[2].length === 1 };
    }
    return iv;
  };
  const items = branches.map(conds => ({ conds, iv: interval(conds) }));
  for (let changed = true; changed;) {
    changed = false;
    search: for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        const a = items[i].iv; const b = items[j].iv;
        // a finit là où b commence, et une seule des deux bornes inclut ce point
        if (i === j || !a || !b || a.lhs !== b.lhs || !a.hi || !b.lo || a.hi.n !== b.lo.n || a.hi.strict === b.lo.strict) continue;
        items[i] = { iv: { lhs: a.lhs, lo: a.lo, hi: b.hi } };
        items.splice(j, 1);
        changed = true;
        break search;
      }
    }
  }
  const render = iv => [iv.lo && `${iv.lhs} ${iv.lo.strict ? '>' : '>='} ${iv.lo.n}`, iv.hi && `${iv.lhs} ${iv.hi.strict ? '<' : '<='} ${iv.hi.n}`].filter(Boolean);
  const out = items.map(x => (x.iv ? render(x.iv) : x.conds));
  return out.some(conds => !conds.length) ? null : out;
}

/* ---------- Listes de valeurs ---------- */
/*
 * Une liste noire ou blanche arrive de trois façons : un terms, une suite de should sur le même champ
 * (ce qu’écrit le filtre « est l’un de » de Kibana), ou des OR dans une query_string.
 * Elles sont réunies en un seul IN. Au-delà de clickhouse.lists.threshold valeurs, la liste quitte le SQL
 * pour une table : la requête la désigne par un nom tiré de l’empreinte de son contenu, si bien qu’une même
 * liste présente dans cent requêtes n’existe qu’une fois, et que le SQL reste lisible.
 */
const SQL_LITERAL = /^(?:'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)$/;
// Découpe « 'a', 'b,c', 3 » en littéraux SQL ; null si un élément n’en est pas un
function literalList(text) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      cur += c;
      if (c === '\\') cur += text[++i] || ''; else if (c === "'") quoted = false;
    } else if (c === "'") { quoted = true; cur += c; }
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out.every(x => SQL_LITERAL.test(x)) ? out : null;
}
// « col = 'a' » ou « col IN ('a', 'b') » : renvoie { lhs, values } ; null pour toute autre forme
function equalityOf(s) {
  if (typeof s !== 'string' || topHas(s, /^ (AND|OR) /) || /^NOT /.test(s)) return null;
  let eq = -1, eqs = 0, inn = -1;
  scanTop(s, i => { if (s.startsWith(' = ', i)) { eq = i; eqs++; } if (s.startsWith(' IN (', i)) inn = i; });
  if (eqs === 1 && inn < 0) {
    const rhs = s.slice(eq + 3);
    return SQL_LITERAL.test(rhs) ? { lhs: s.slice(0, eq), values: [rhs] } : null;
  }
  if (eqs === 0 && inn > 0 && s.endsWith(')')) {
    const values = literalList(s.slice(inn + 5, -1));
    return values ? { lhs: s.slice(0, inn), values } : null;
  }
  return null;
}
// Empreinte d’une liste, indépendante de l’ordre des valeurs (deux FNV-1a de 32 bits, 12 chiffres hexadécimaux)
function listFingerprint(values) {
  const text = [...values].sort().join('\n');
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}
// « lhs IN (…) » : valeurs en clair, ou liste nommée au-delà du seuil. « values » sont des littéraux SQL.
function inList(ctx, lhs, values) {
  const unique = [...new Set(values)];
  if (unique.length === 1) return `${lhs} = ${unique[0]}`;
  const lists = ctx.cfg.clickhouse.lists || {};
  const threshold = Number(lists.threshold) || 0;
  const strings = unique.every(v => v[0] === "'"); const integers = unique.every(v => /^-?\d+$/.test(v));
  if (!threshold || unique.length <= threshold || !(strings || integers)) return `${lhs} IN (${unique.join(', ')})`;
  const fingerprint = listFingerprint(unique);
  const name = (isObj(lists.names) && lists.names[fingerprint]) || `l_${fingerprint}`;
  const table = lists.table || `${ctx.cfg.clickhouse.database || 'default'}.passerelle_lists`;
  if (!ctx.lists.has(name)) ctx.lists.set(name, { name, fingerprint, table, integers, values: unique });
  return `${lhs} IN (SELECT ${integers ? 'toInt64(value)' : 'value'} FROM ${table} WHERE name = ${chStr(name)})`;
}
// OU entre des conditions, en réunissant dans un même IN celles qui comparent une même colonne à des constantes
function anyOf(ctx, list) {
  if (!list.length || list.some(x => x === null || x === '1' || x === 'true')) return orJoin(list);
  const out = []; const groups = new Map();
  for (const s of list) {
    const e = equalityOf(s);
    if (!e) { out.push(s); continue; }
    if (!groups.has(e.lhs)) { groups.set(e.lhs, { lhs: e.lhs, values: [] }); out.push(groups.get(e.lhs)); }
    groups.get(e.lhs).values.push(...e.values);
  }
  return orJoin(out.map(x => (typeof x === 'string' ? x : inList(ctx, x.lhs, x.values))));
}
/*
 * Liste de motifs « *texte* » sur un même champ non analysé : une seule recherche multiple
 * (multiSearchAny) au lieu d’une suite de LIKE. Renvoie null si les clauses ne s’y prêtent pas.
 */
function containsAnyOf(ctx, clauses) {
  if (clauses.length < 2) return null;
  let field = null; let insensitive = null; const needles = [];
  for (const c of clauses) {
    if (!isObj(c) || Object.keys(c)[0] !== 'wildcard') return null;
    const [f, raw] = fieldEntry(c.wildcard);
    const pattern = String(isObj(raw) ? (raw.value !== undefined ? raw.value : raw.wildcard) : raw);
    const ci = isObj(raw) && !!raw.case_insensitive;
    const m = /^\*([^*?\\]+)\*$/.exec(pattern);
    if (!m || (field !== null && (f !== field || ci !== insensitive)) || isTextField(ctx, f) || isArrayField(ctx, f)) return null;
    field = f; insensitive = ci; needles.push(m[1]);
  }
  ctx.stats.ok += clauses.length;
  H(ctx, 'filters', `${field} contient l’un de ${needles.length} motifs`);
  ctx.notes.add('opt', 'Liste de motifs → multiSearchAny', 'Les motifs *texte* sur un même champ sont cherchés en une passe par multiSearchAny, plutôt que par une suite de LIKE.');
  return `multiSearchAny${insensitive ? 'CaseInsensitive' : ''}(${mapField(ctx, field)}, [${[...new Set(needles)].map(chStr).join(', ')}])`;
}
function conjunctsOf(ctx, q) {
  if (isObj(q) && Object.keys(q)[0] === 'bool') return boolParts(ctx, q.bool).flatMap(splitTopAnd);
  const s = tq(ctx, q); return s === null ? [] : splitTopAnd(s);
}
function boolParts(ctx, b) {
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const must = arr(b.must), filter = arr(b.filter), not = arr(b.must_not), should = arr(b.should);
  const parts = [];
  for (const c of must.concat(filter)) parts.push(...conjunctsOf(ctx, c));
  if (not.length) {
    ctx.cap.push([]);
    const ns = not.map(c => tq(ctx, c));
    const caught = ctx.cap.pop();
    if (!ctx.humanOff) caught.forEach(x => (ctx.cap.length ? ctx.cap[ctx.cap.length - 1].push('pas ' + x) : ctx.human.excludes.push(x)));
    // Chaque clause est niée séparément : (a != x) AND (b != y) se lit mieux que NOT (a = x OR b = y)
    if (ns.some(n => n === null)) parts.push('false');
    else parts.push(...[...new Set(ns)].map(n => negate(ctx, n)));
    ctx.schemaGaps.add('must_not');
  }
  if (should.length) {
    let k = msmCount(b.minimum_should_match, should.length);
    if (k === null) k = must.length || filter.length ? 0 : 1;
    if (k === 0) ctx.notes.add('info', 'Clauses should ignorées', 'À côté de must/filter, les clauses should ne font que moduler le score de pertinence, qui n’existe pas en SQL.');
    else {
      const searches = k === 1 ? containsAnyOf(ctx, should) : null;
      if (searches) { parts.push(searches); return parts; }
      ctx.cap.push([]);
      const cs = should.map(c => tq(ctx, c));
      const caught = ctx.cap.pop();
      if (caught.length) H(ctx, 'filters', k === 1 ? (caught.length > 6 ? `l’une de ${caught.length} conditions` : caught.join(' ou ')) : `au moins ${k} parmi : ${caught.join(', ')}`);
      if (k === 1) { const o = anyOf(ctx, cs); if (o !== null) parts.push(o); }
      else if (k >= cs.length) parts.push(...cs.filter(x => x !== null));
      else parts.push(`${cs.map(c => (c === null ? '1' : countable(ctx, c))).join(' + ')} >= ${k}`);
    }
  }
  return parts;
}
function rangeClause(ctx, field, spec0) {
  const spec = Object.assign({}, spec0);
  if ('from' in spec || 'to' in spec) {
    if (spec.from !== undefined && spec.from !== null) spec[spec.include_lower === false ? 'gt' : 'gte'] = spec.from;
    if (spec.to !== undefined && spec.to !== null) spec[spec.include_upper === false ? 'lt' : 'lte'] = spec.to;
  }
  const f = mapField(ctx, field);
  const tz = spec.time_zone; const fmt = spec.format || '';
  // Champ multivalué : il suffit qu’une valeur soit dans la plage
  const multi = isArrayField(ctx, field);
  const parts = []; let isDate = false; let lower = null, upper = null; const hum = [];
  const OPS = [['gte', '>=', '≥'], ['gt', '>', '>'], ['lte', '<=', '≤'], ['lt', '<', '<']];
  // Champ date : connu comme tel, ou comparé à une date. Un nombre y est alors un instant en epoch millis.
  const dateField = isDateField(ctx, field) || !!fmt || OPS.some(([op]) => typeof spec[op] === 'string' && parseDateMath(spec[op]) !== null);
  for (const [op, sym, hs] of OPS) {
    const v = spec[op];
    if (v === undefined || v === null) continue;
    let sql, s = sym, date = false;
    const dm = parseDateMath(v);
    if (dm) {
      // Bornes « gt » et « lte » : Elasticsearch arrondit vers le haut, jusqu’à la fin de l’unité arrondie (now/d)
      // ou jusqu’à la fin du jour quand la date est écrite sans heure (2026-03-10).
      const upper2 = op === 'gt' || op === 'lte';
      const dayOnly = !dm.round && !!dm.abs && /^\d{4}-\d{2}(-\d{2})?$/.test(dm.abs);
      sql = dateMathSQL(ctx, dm, tz, upper2 && !!dm.round);
      if (upper2 && dayOnly) sql += ' + INTERVAL 1 DAY';
      if (upper2 && (dm.round || dayOnly)) s = op === 'gt' ? '>=' : '<';
      date = true;
      if (op[0] === 'g') lower = { dm, v }; else upper = { dm, v };
    } else if (dateField && isEpoch(v)) {
      sql = /epoch_second/.test(fmt) && !/epoch_millis/.test(fmt) ? `toDateTime(${chNum(v, 'date en epoch secondes')})` : epochMillisSQL(v);
      date = true;
    } else if (typeof v === 'string' && /^now|\|\|/.test(v.trim())) {
      // Elasticsearch refuse aussi une expression de date qu’il ne sait pas lire
      throw new Error(`expression de date non reconnue pour ${field} : ${v}`);
    } else sql = chVal(v);
    if (date) isDate = true;
    parts.push(`${multi ? 'x' : f} ${s} ${sql}`);
    hum.push(`${hs} ${date ? humanDate(v) : v}`);
  }
  if (isDate) {
    ctx.dateFields.add(f);
    const since = lower && humanSince(lower.dm);
    if (since && (!upper || (upper.dm.now && !upper.dm.ops.length))) H(ctx, 'period', since);
    else H(ctx, 'period', `${field} ${hum.join(' et ')}`);
  } else H(ctx, 'filters', `${field} ${hum.join(' et ')}`);
  ctx.stats.ok++;
  if (multi) return `arrayExists(x -> ${parts.join(' AND ')}, ${f})`;
  if (parts.length === 2 && spec.gte !== undefined && spec.lte !== undefined && !isDate) return `${f} BETWEEN ${chVal(spec.gte)} AND ${chVal(spec.lte)}`;
  return andJoin(parts);
}
function matchClause(ctx, field, o, type) {
  const q = o.query;
  if (field === '*' || field === '_all') return orJoin(textFieldsOr(ctx).map(tf => matchClause(ctx, tf, o, type)));
  const f = mapField(ctx, field);
  if (!isTextField(ctx, field)) {
    ctx.stats.ok++;
    if (/prefix/.test(type)) { H(ctx, 'filters', `${field} commence par « ${q} »`); return `startsWith(${f}, ${chStr(q)})`; }
    H(ctx, 'filters', `${field} = ${q}`);
    return `${f} = ${chVal(q)}`;
  }
  textIndexNote(ctx, f);
  const toks = [...new Set(tokensOf(q))];
  if (!toks.length) { ctx.stats.ok++; return null; }
  if (type === 'match') {
    if (o.fuzziness !== undefined && String(o.fuzziness) !== '0') {
      ctx.stats.approx++;
      ctx.notes.add('warn', 'Fuzziness ignorée', `La tolérance aux fautes de frappe sur « ${field} » est ignorée : recherche exacte par token. Voir ngramDistance() si nécessaire.`);
    } else ctx.stats.ok++;
    const conds = toks.map(t => hasTok(f, t));
    const op = String(o.operator || 'or').toLowerCase();
    H(ctx, 'text', `${field} contient ${toks.map(t => `« ${t} »`).join(op === 'and' ? ' et ' : ' ou ')}`);
    if (op === 'and') return andJoin(conds);
    const k = msmCount(o.minimum_should_match, conds.length);
    if (k && k > 1) return k >= conds.length ? andJoin(conds) : `${conds.map(c => countable(ctx, c)).join(' + ')} >= ${k}`;
    return orJoin(conds);
  }
  if (type === 'match_phrase') {
    ctx.stats.ok++;
    H(ctx, 'text', `${field} contient « ${String(q).trim()} »`);
    if (toks.length === 1 && String(q).trim().toLowerCase() === toks[0]) return hasTok(f, toks[0]);
    return andJoin(toks.map(t => hasTok(f, t)).concat([`positionCaseInsensitiveUTF8(${f}, ${chStr(String(q).trim())}) > 0`]));
  }
  ctx.stats.approx++;
  ctx.notes.add('warn', `${type} approximé`, 'Le préfixe du dernier mot est recherché par ILIKE, sans analyse de tokens.');
  H(ctx, 'text', `${field} contient « ${String(q).trim()}… »`);
  return `${f} ILIKE ${chStr('%' + likeEscape(String(q).trim()) + '%')}`;
}
function tq(ctx, q) {
  // « filtering » signale à mapField qu’un champ est lu depuis une clause de requête
  ctx.filtering = (ctx.filtering || 0) + 1;
  try { return clauseSQL(ctx, q); }
  finally { ctx.filtering--; }
}
function clauseSQL(ctx, q) {
  if (!isObj(q) || !Object.keys(q).length) return null;
  const type = Object.keys(q)[0]; const body = q[type];
  switch (type) {
    case 'match_all': ctx.stats.ok++; return null;
    case 'match_none': ctx.stats.ok++; return 'false';
    case 'bool': return andJoin(boolParts(ctx, body));
    case 'term': {
      const [field, raw] = fieldEntry(body);
      let v = raw, ci = false;
      if (isObj(raw)) { v = raw.value; ci = !!raw.case_insensitive; }
      H(ctx, 'filters', `${field} = ${v}`);
      const sources = ci ? undefined : runtimeFilter(ctx, field, [v]);
      if (sources !== undefined) { ctx.stats.ok++; return sources; }
      const f = mapField(ctx, field); ctx.stats.ok++;
      if (ci) return onValues(ctx, field, x => `lower(${x}) = ${chStr(String(v).toLowerCase())}`);
      return isArrayField(ctx, field) ? `has(${f}, ${chVal(v)})` : `${f} = ${chVal(v)}`;
    }
    case 'terms': {
      const [field, vals] = fieldEntry(body);
      if (!Array.isArray(vals)) return todo(ctx, 'terms lookup', 'La recherche de termes dans un autre index demande une sous-requête ClickHouse (IN (SELECT …)) écrite à la main.');
      H(ctx, 'filters', `${field} ∈ {${vals.slice(0, 4).join(', ')}${vals.length > 4 ? '…' : ''}}`);
      const sources = runtimeFilter(ctx, field, vals);
      if (sources !== undefined) { ctx.stats.ok++; return sources; }
      const f = mapField(ctx, field); ctx.stats.ok++;
      if (isArrayField(ctx, field)) return vals.length === 1 ? `has(${f}, ${chVal(vals[0])})` : `hasAny(${f}, [${vals.map(chVal).join(', ')}])`;
      return inList(ctx, f, vals.map(chVal));
    }
    case 'range': { const [field, spec] = fieldEntry(body); return rangeClause(ctx, field, spec); }
    case 'exists': {
      const f = mapField(ctx, body.field); const type = fieldType(ctx, body.field);
      H(ctx, 'filters', `${body.field} renseigné`);
      // Un champ existe s’il a au moins une valeur : tableau non vide, colonne non NULL, ou chaîne non vide selon la convention
      if (type && type.array) { ctx.stats.ok++; return `notEmpty(${f})`; }
      if (type && !type.nullable && emptyIsMissing(ctx, type)) { ctx.stats.ok++; return `${f} != ''`; }
      if (type && !type.nullable) {
        ctx.stats.approx++;
        ctx.notes.add('warn', `exists sur ${body.field}`, 'La colonne n’est pas Nullable : un champ absent y prend la valeur par défaut et ne se distingue plus d’un champ renseigné, la condition est donc toujours vraie. Si la chaîne vide représente l’absence, activez clickhouse.empty_as_missing.');
        return `isNotNull(${f})`;
      }
      ctx.stats.ok++;
      if (!type && !ctx.runtime[String(body.field).replace(/\.keyword$/, '')]) ctx.schemaGaps.add('exists');
      return `isNotNull(${f})`;
    }
    case 'prefix': {
      const [field, raw] = fieldEntry(body);
      const v = isObj(raw) ? raw.value : raw; const ci = isObj(raw) && raw.case_insensitive;
      ctx.stats.ok++;
      H(ctx, 'filters', `${field} commence par « ${v} »`);
      return onValues(ctx, field, x => (ci ? `startsWith(lower(${x}), ${chStr(String(v).toLowerCase())})` : `startsWith(${x}, ${chStr(v)})`));
    }
    case 'wildcard': {
      const [field, raw] = fieldEntry(body);
      const v = String(isObj(raw) ? (raw.value !== undefined ? raw.value : raw.wildcard) : raw);
      const ci = isObj(raw) && raw.case_insensitive;
      const f = mapField(ctx, field);
      if (v === '*') return tq(ctx, { exists: { field } });
      H(ctx, 'filters', `${field} ~ ${v}`);
      if (!/[*?]/.test(v)) { ctx.stats.ok++; return isArrayField(ctx, field) ? `has(${f}, ${chStr(v)})` : `${f} = ${chStr(v)}`; }
      if (/^[^*?]+\*$/.test(v) && !ci && !isTextField(ctx, field)) { ctx.stats.ok++; return onValues(ctx, field, x => `startsWith(${x}, ${chStr(v.slice(0, -1))})`); }
      let like = likeEscape(v).replace(/\*/g, '%').replace(/\?/g, '_');
      if (/^[*?]/.test(v)) ctx.leadingWildcard = f;
      if (isTextField(ctx, field)) {
        ctx.stats.approx++;
        ctx.notes.add('warn', 'Wildcard sur champ texte', `Elasticsearch applique le motif à chaque token de « ${field} » ; ici il s’applique à la valeur entière (ILIKE '%…%').`);
        return `${f} ILIKE ${chStr('%' + like.replace(/^%|%$/g, '') + '%')}`;
      }
      ctx.stats.ok++;
      return onValues(ctx, field, x => `${x} ${ci ? 'ILIKE' : 'LIKE'} ${chStr(like)}`);
    }
    case 'regexp': {
      const [field, raw] = fieldEntry(body);
      const v = String(isObj(raw) ? raw.value : raw);
      const f = mapField(ctx, field);
      if (/[@#&~<>]/.test(v)) { ctx.stats.approx++; ctx.notes.add('warn', 'Syntaxe regexp Lucene', 'Les opérateurs Lucene @ # & ~ <n-m> n’existent pas en RE2 : vérifiez l’expression.'); } else ctx.stats.ok++;
      H(ctx, 'filters', `${field} correspond à /${v}/`);
      return onValues(ctx, field, x => `match(${x}, ${chStr('^(?:' + v + ')$')})`);
    }
    case 'fuzzy': {
      const [field, raw] = fieldEntry(body);
      const v = String(isObj(raw) ? raw.value : raw);
      let fz = isObj(raw) && raw.fuzziness !== undefined ? raw.fuzziness : 'AUTO';
      const d = /^\d+$/.test(String(fz)) ? +fz : v.length <= 2 ? 0 : v.length <= 5 ? 1 : 2;
      const f = mapField(ctx, field); ctx.stats.approx++;
      ctx.notes.add('info', 'fuzzy → editDistanceUTF8', 'Distance d’édition calculée à la volée : coûteux sur de gros volumes, à combiner avec un filtre sélectif. Nécessite une version récente de ClickHouse.');
      H(ctx, 'filters', `${field} ≈ ${v}`);
      if (isTextField(ctx, field)) return `arrayExists(t -> editDistanceUTF8(t, ${chStr(v.toLowerCase())}) <= ${d}, tokens(lower(${f})))`;
      return `editDistanceUTF8(${f}, ${chStr(v)}) <= ${d}`;
    }
    case 'ids': {
      ctx.stats.ok++; mapField(ctx, '_id');
      return `_id IN (${(body.values || []).map(chVal).join(', ')})`;
    }
    case 'match': case 'match_phrase': case 'match_phrase_prefix': case 'match_bool_prefix': {
      const [field, raw] = fieldEntry(body);
      return matchClause(ctx, field, isObj(raw) ? raw : { query: raw }, type);
    }
    case 'multi_match': case 'combined_fields': {
      let fields = (body.fields || ['*']).map(f => String(f).replace(/\^[\d.]+$/, ''));
      if (fields.some(f => f.includes('*') && f !== '*')) ctx.notes.add('warn', 'Champs à motif', 'Les noms de champs avec * sont remplacés par les champs texte de la configuration.');
      fields = [...new Set(fields.flatMap(f => (f.includes('*') ? textFieldsOr(ctx) : [f])))];
      const mtype = body.type || 'best_fields';
      const op = String(body.operator || 'or').toLowerCase();
      if (/phrase/.test(mtype)) return orJoin(fields.map(f => matchClause(ctx, f, { query: body.query }, mtype === 'phrase' ? 'match_phrase' : 'match_phrase_prefix')));
      if (op === 'and' || type === 'combined_fields') {
        const toks = [...new Set(tokensOf(body.query))];
        const tf = fields.filter(f => isTextField(ctx, f)); const kf = fields.filter(f => !isTextField(ctx, f));
        ctx.stats.ok++;
        tf.forEach(f => textIndexNote(ctx, mapField(ctx, f)));
        H(ctx, 'text', `${fields.join(', ')} contiennent ${toks.map(t => `« ${t} »`).join(' et ')}`);
        const tokConds = tf.length ? andJoin(toks.map(t => orJoin(tf.map(f => hasTok(mapField(ctx, f), t))))) : null;
        return orJoin([tokConds].concat(kf.map(f => `${mapField(ctx, f)} = ${chVal(body.query)}`)).filter(x => x !== null));
      }
      return orJoin(fields.map(f => matchClause(ctx, f, { query: body.query, minimum_should_match: body.minimum_should_match, fuzziness: body.fuzziness }, 'match')));
    }
    case 'query_string': case 'simple_query_string': {
      const defFields = body.default_field ? (body.default_field === '*' ? textFieldsOr(ctx) : [body.default_field]) : body.fields ? body.fields.map(f => String(f).replace(/\^[\d.]+$/, '')) : textFieldsOr(ctx);
      const simple = type === 'simple_query_string';
      let ast;
      try { ast = simple ? simpleQueryParse(body.query, body.default_operator) : luceneParse(body.query, body.default_operator); }
      catch (e) { return todo(ctx, 'query_string', `${e.message} — requête : ${body.query}`); }
      if (ast === null) { ctx.stats.ok++; return 'false'; }
      ctx.cap.push([]);
      const out = luceneSQL(ctx, ast, defFields, simple ? (c, f, tok) => simpleLeaf(c, f, tok, body.default_operator) : luceneLeaf);
      ctx.cap.pop();
      H(ctx, 'text', `la recherche « ${body.query} » est satisfaite`);
      return out;
    }
    case 'nested': {
      ctx.stats.approx++;
      ctx.notes.add('warn', `Requête nested (${body.path})`, 'Les objets nested deviennent des colonnes Array ou Nested : remplacez la condition à plat par arrayExists((x, y) -> …, col.x, col.y) pour garder la corrélation entre sous-champs.');
      return tq(ctx, body.query);
    }
    case 'constant_score': return tq(ctx, body.filter);
    case 'dis_max': return anyOf(ctx, (body.queries || []).map(x => tq(ctx, x)));
    case 'function_score': case 'script_score':
      ctx.notes.add('info', `${type} : score ignoré`, 'Le calcul de score n’a pas d’équivalent : seule la requête filtrante est conservée.');
      return tq(ctx, body.query || { match_all: {} });
    case 'boosting':
      ctx.notes.add('info', 'boosting : partie négative ignorée', 'La partie negative ne fait que baisser le score ; seule la partie positive filtre.');
      return tq(ctx, body.positive);
    case 'script': {
      const sc = body.script || body; const src = typeof sc === 'string' ? sc : sc.source;
      try { const r = painlessToSQL(ctx, src, { mode: 'expr', params: sc.params || {} }); ctx.stats.ok++; H(ctx, 'filters', 'condition scriptée'); return r.sql; }
      catch (e) { return todo(ctx, 'script de requête', e.message); }
    }
    case 'geo_distance': {
      const field = Object.keys(body).find(k => !['distance', 'distance_type', 'validation_method', '_name', 'boost', 'ignore_unmapped'].includes(k));
      let pt = body[field]; let lat, lon;
      if (Array.isArray(pt)) [lon, lat] = pt; else if (isObj(pt)) ({ lat, lon } = pt); else if (typeof pt === 'string') [lat, lon] = pt.split(',').map(Number);
      lat = chNum(lat, 'geo_distance (latitude)'); lon = chNum(lon, 'geo_distance (longitude)');
      const m = /^([\d.]+)\s*(km|m|mi|yd|ft)?$/.exec(String(body.distance));
      const meters = m ? +m[1] * ({ km: 1000, m: 1, mi: 1609.344, yd: 0.9144, ft: 0.3048 }[m[2] || 'm']) : 0;
      const f = mapField(ctx, field); ctx.stats.approx++;
      ctx.notes.add('warn', 'geo_distance', `Suppose une colonne Point (lon, lat) « ${field} ». Adaptez si la position est stockée en deux colonnes.`);
      H(ctx, 'filters', `${field} à moins de ${body.distance}`);
      return `geoDistance(${f}.1, ${f}.2, ${lon}, ${lat}) <= ${Math.round(meters)}`;
    }
    default:
      return todo(ctx, type, `La clause « ${type} » n’a pas d’équivalent automatique en SQL.`);
  }
}
function luceneSQL(ctx, n, defFields, leaf) {
  // « a OR b OR c » est analysé en ((a OR b) OR c) : les opérandes sont remis à plat avant d’être réunis
  const operands = op => (function flat(x) { return x.op === op ? x.a.flatMap(flat) : [x]; })(n).map(x => luceneSQL(ctx, x, defFields, leaf));
  if (n.op === 'and') return andJoin(operands('and'));
  if (n.op === 'or') return anyOf(ctx, operands('or'));
  if (n.op === 'not') { const s = luceneSQL(ctx, n.a[0], defFields, leaf); ctx.schemaGaps.add('must_not'); return s === null ? 'false' : negate(ctx, s); }
  const fields = n.field ? [n.field] : defFields;
  return orJoin(fields.map(f => leaf(ctx, f, n.tok)));
}
// Terme d’une requête simple_query_string : pas de syntaxe champ:valeur, d’intervalle ni de joker interne
function simpleLeaf(ctx, field, tok, defaultOp) {
  if (tok.t === 'phrase') return tq(ctx, { match_phrase: { [field]: tok.v } });
  if (tok.t === 'fuzzy') return tq(ctx, { fuzzy: { [field]: tok.n === null ? { value: tok.v } : { value: tok.v, fuzziness: tok.n } } });
  if (tok.t === 'prefix') return tq(ctx, { wildcard: { [field]: { value: tok.v + '*' } } });
  if (isTextField(ctx, field)) return tq(ctx, { match: { [field]: { query: tok.v, operator: defaultOp || 'or' } } });
  return tq(ctx, { term: { [field]: /^-?\d+(\.\d+)?$/.test(tok.v) ? Number(tok.v) : tok.v } });
}
function luceneLeaf(ctx, field, tok) {
  if (field === '_exists_') return tq(ctx, { exists: { field: tok.v } });
  if (tok.t === 'phrase') return tq(ctx, { match_phrase: { [field]: tok.v } });
  if (tok.t === 'regex') return tq(ctx, { regexp: { [field]: tok.v } });
  if (tok.t === 'range') {
    const m = /^\s*(\S+)\s+TO\s+(\S+)\s*$/i.exec(tok.v);
    if (!m) return todo(ctx, 'intervalle Lucene', tok.v);
    const spec = {}; const num = x => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x);
    if (m[1] !== '*') spec[tok.lo ? 'gte' : 'gt'] = num(m[1]);
    if (m[2] !== '*') spec[tok.hi ? 'lte' : 'lt'] = num(m[2]);
    return tq(ctx, { range: { [field]: spec } });
  }
  let v = String(tok.v).replace(/\^[\d.]+$/, '');
  if (/~\d*$/.test(v)) return tq(ctx, { fuzzy: { [field]: { value: v.replace(/~\d*$/, '') } } });
  if (v === '*') return tq(ctx, { exists: { field } });
  const m = /^(>=|<=|>|<)(.+)$/.exec(v);
  if (m) { const op = { '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' }[m[1]]; const x = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2]; return tq(ctx, { range: { [field]: { [op]: x } } }); }
  if (/[*?]/.test(v)) return tq(ctx, { wildcard: { [field]: { value: v } } });
  if (isTextField(ctx, field)) return tq(ctx, { match: { [field]: { query: v } } });
  return tq(ctx, { term: { [field]: /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v } });
}

/* ---------- Construction SQL ---------- */
function sqlSelect(o, ind) {
  ind = ind || ''; const I = ind + '    '; const L = [];
  if (o.with && o.with.length) L.push(ind + 'WITH', o.with.map(w => I + w).join(',\n'));
  L.push(ind + 'SELECT', o.select.map(s => I + s).join(',\n'));
  L.push(ind + 'FROM ' + o.from);
  if (o.where && o.where.length) L.push(ind + 'WHERE ' + o.where.map(w => paren(w, 'AND')).join(`\n${ind}  AND `));
  if (o.groupBy && o.groupBy.length) L.push(ind + 'GROUP BY ' + o.groupBy.join(', '));
  if (o.having && o.having.length) L.push(ind + 'HAVING ' + o.having.map(h => paren(h, 'AND')).join(' AND '));
  if (o.orderBy && o.orderBy.length) L.push(ind + 'ORDER BY ' + o.orderBy.join(', '));
  if (o.limitBy) L.push(ind + `LIMIT ${o.limitBy.n}${o.limitBy.offset ? ' OFFSET ' + o.limitBy.offset : ''} BY ${o.limitBy.by.join(', ')}`);
  if (o.limit !== undefined && o.limit !== null) L.push(ind + `LIMIT ${o.limit}${o.offset ? ' OFFSET ' + o.offset : ''}`);
  if (o.settings && o.settings.length) L.push(ind + 'SETTINGS ' + o.settings.join(', '));
  return L.join('\n');
}
function indent(s, pre) { return s.split('\n').map(l => pre + l).join('\n'); }

/* ---------- Agrégations ---------- */
const METRIC_TYPES = new Set(['avg', 'sum', 'min', 'max', 'value_count', 'cardinality', 'stats', 'extended_stats', 'percentiles', 'percentile_ranks', 'weighted_avg', 'top_metrics', 'median_absolute_deviation', 'geo_bounds', 'geo_centroid', 'scripted_metric', 'string_stats', 'boxplot', 'rate', 't_test', 'matrix_stats']);
const PIPE_TYPES = new Set(['bucket_selector', 'bucket_sort', 'bucket_script', 'cumulative_sum', 'derivative', 'moving_fn', 'moving_avg', 'serial_diff', 'cumulative_cardinality', 'normalize', 'inference']);
const SIBLING_PIPES = new Set(['avg_bucket', 'sum_bucket', 'min_bucket', 'max_bucket', 'stats_bucket', 'extended_stats_bucket', 'percentiles_bucket']);
const CAL = { minute: ['toStartOfMinute', 'MINUTE', 'minute'], '1m': ['toStartOfMinute', 'MINUTE', 'minute'], hour: ['toStartOfHour', 'HOUR', 'heure'], '1h': ['toStartOfHour', 'HOUR', 'heure'], day: ['toStartOfDay', 'DAY', 'jour'], '1d': ['toStartOfDay', 'DAY', 'jour'], week: ['toMonday', 'WEEK', 'semaine'], '1w': ['toMonday', 'WEEK', 'semaine'], month: ['toStartOfMonth', 'MONTH', 'mois'], '1M': ['toStartOfMonth', 'MONTH', 'mois'], quarter: ['toStartOfQuarter', 'QUARTER', 'trimestre'], '1q': ['toStartOfQuarter', 'QUARTER', 'trimestre'], year: ['toStartOfYear', 'YEAR', 'année'], '1y': ['toStartOfYear', 'YEAR', 'année'] };
const FIXED_UNIT = { ms: 'MILLISECOND', s: 'SECOND', m: 'MINUTE', h: 'HOUR', d: 'DAY' };
const FIXED_FR = { ms: 'ms', s: 's', m: 'min', h: 'h', d: 'j' };
const aggType = def => Object.keys(def).find(k => !['aggs', 'aggregations', 'meta'].includes(k));
const aggChildren = def => def.aggs || def.aggregations || {};
/*
 * Alias de colonne de résultat.
 *
 * ClickHouse préfère un alias de SELECT à la colonne du même nom, dans toute la requête. Une agrégation
 * « host » posée sur le champ service donnerait « service AS host » : un filtre WHERE host = … porterait
 * alors sur service, en silence. De même sum(bytes) AS bytes rend illégal tout autre usage de bytes.
 * Un alias qui porte le nom d’une colonne citée par la requête reçoit donc le suffixe _agg.
 * translateDSL relève ces colonnes par une première passe, puis traduit pour de bon.
 */
const aliasGuard = { columns: new Set(), renamed: new Map() };
function rawAlias(name) { return String(name).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'); }
function aliasOf(name) {
  const raw = rawAlias(name);
  if (!aliasGuard.columns.has(raw)) return chIdent(raw);
  aliasGuard.renamed.set(String(name), `${raw}_agg`);
  return chIdent(`${raw}_agg`);
}

function valueExpr(ctx, body) {
  let e;
  if (body.script) {
    const sc = body.script; const src = typeof sc === 'string' ? sc : sc.source;
    e = painlessToSQL(ctx, src, { mode: 'expr', params: sc.params || {} }).sql;
  } else e = mapField(ctx, body.field);
  if (body.missing !== undefined) e = `ifNull(${e}, ${chVal(body.missing)})`;
  return e;
}
const HM = { avg: 'moyenne', sum: 'somme', min: 'minimum', max: 'maximum', value_count: 'nombre de valeurs', cardinality: 'nombre distinct', stats: 'statistiques', extended_stats: 'statistiques étendues', percentiles: 'percentiles', percentile_ranks: 'rangs centiles', weighted_avg: 'moyenne pondérée', top_metrics: 'dernière valeur' };
/*
 * Appel d’agrégat. « cond » ajoute le combinateur -If. « mayBeEmpty » signale un calcul qui peut ne porter
 * sur aucune ligne (mesure globale, sous-filtre, tranche ajoutée par WITH FILL) : Elasticsearch répond alors
 * null pour min, max, avg… là où ClickHouse répond 0 ou nan. Le combinateur -OrNull rétablit le null.
 */
const NULL_WHEN_EMPTY = new Set(['min', 'max', 'avg', 'varPop', 'stddevPop', 'avgWeighted']);
function aggCall(fn, args, cond, mayBeEmpty) {
  const orNull = mayBeEmpty && NULL_WHEN_EMPTY.has(fn) ? 'OrNull' : '';
  return cond ? `${fn}If${orNull}(${args}, ${cond})` : `${fn}${orNull}(${args})`;
}
/* Renvoie [{alias, render(cond, mayBeEmpty)}] */
function metricDef(ctx, name, type, body) {
  const A = aliasOf(name);
  const colType = typeof body.field === 'string' && !body.script && body.missing === undefined ? fieldType(ctx, body.field) : null;
  // Sur un champ multivalué, avg, sum, min et max portent sur toutes les valeurs : combinateur -Array
  const simple = (fn, x) => [{ alias: A, render: (c, e) => aggCall(colType && colType.array && /^(avg|sum|min|max)$/.test(fn) ? `${fn}Array` : fn, x, c, e) }];
  const fieldName = body.field || (body.script ? 'script' : '?');
  if (HM[type]) H(ctx, 'metrics', `${HM[type]} de ${fieldName}`);
  switch (type) {
    case 'avg': case 'sum': case 'min': case 'max': ctx.stats.ok++; return simple(type, valueExpr(ctx, body));
    case 'value_count': {
      // Nombre de valeurs : chaque élément d’un tableau compte, un champ absent ne compte pas
      ctx.stats.ok++; const x = valueExpr(ctx, body);
      if (colType && colType.array) return [{ alias: A, render: c => aggCall('sum', `length(${x})`, c) }];
      if (emptyIsMissing(ctx, colType)) return [{ alias: A, render: c => `countIf(${x} != ''${c ? ` AND ${c}` : ''})` }];
      return simple('count', x);
    }
    case 'cardinality':
      ctx.stats.ok++;
      ctx.notes.add('info', 'cardinality → uniq()', 'uniq() est approximatif comme HyperLogLog d’Elasticsearch (erreur < 2 %). Utilisez uniqExact() pour un compte exact, plus coûteux en mémoire.');
      if (colType && colType.array) return simple('uniqArray', valueExpr(ctx, body));
      if (emptyIsMissing(ctx, colType)) { const x = valueExpr(ctx, body); return [{ alias: A, render: c => `uniqIf(${x}, ${x} != ''${c ? ` AND ${c}` : ''})` }]; }
      return simple('uniq', valueExpr(ctx, body));
    case 'stats': case 'extended_stats': {
      ctx.stats.ok++; const x = valueExpr(ctx, body);
      const cols = [['count', 'count'], ['min', 'min'], ['max', 'max'], ['avg', 'avg'], ['sum', 'sum']];
      if (type === 'extended_stats') cols.push(['varPop', 'variance'], ['stddevPop', 'std_deviation']);
      const out = cols.map(([fn, suf]) => ({ alias: aliasOf(`${name}_${suf}`), render: (c, e) => aggCall(fn, x, c, e) }));
      // Sans document, Elasticsearch renvoie 0 pour sum mais null pour sum_of_squares
      if (type === 'extended_stats') out.push({ alias: aliasOf(`${name}_sum_of_squares`), render: (c, e) => aggCall(e ? 'sumOrNull' : 'sum', `${pArg(x)} * ${pArg(x)}`, c, false) });
      return out;
    }
    case 'percentiles': {
      ctx.stats.ok++; const x = valueExpr(ctx, body);
      const ps = (body.percents || [1, 5, 25, 50, 75, 95, 99]).map(p => +(chNum(p, 'percentiles.percents') / 100).toFixed(4));
      ctx.notes.add('info', 'percentiles → quantilesTDigest()', 'Même algorithme (t-digest) qu’Elasticsearch : résultats comparables. Le résultat est un tableau dans l’ordre des percentiles demandés.');
      return [{ alias: A, render: c => (c ? `quantilesTDigestIf(${ps.join(', ')})(${x}, ${c})` : `quantilesTDigest(${ps.join(', ')})(${x})`) }];
    }
    case 'percentile_ranks': {
      ctx.stats.ok++; const x = valueExpr(ctx, body);
      return (body.values || []).map(v => chNum(v, 'percentile_ranks.values')).map(v => ({ alias: aliasOf(`${name}_${String(v).replace(/\W/g, '_')}`), render: c => (c ? `round(100 * countIf(${pArg(x)} <= ${v} AND ${c}) / countIf(${x}, ${c}), 3)` : `round(100 * countIf(${pArg(x)} <= ${v}) / count(${x}), 3)`) }));
    }
    case 'weighted_avg': {
      ctx.stats.ok++; const v = valueExpr(ctx, body.value || {}); const w = valueExpr(ctx, body.weight || {});
      return [{ alias: A, render: (c, e) => aggCall('avgWeighted', `${v}, ${w}`, c, e) }];
    }
    case 'top_metrics': {
      ctx.stats.ok++;
      const ms = [].concat(body.metrics || []); const sort = body.sort || {};
      const sf = isObj(sort) ? Object.keys(sort)[0] : String(sort);
      const dir = isObj(sort) ? String(isObj(sort[sf]) ? sort[sf].order : sort[sf]).toLowerCase() : 'asc';
      const s = mapField(ctx, sf); const fn = dir === 'desc' ? 'argMax' : 'argMin';
      return ms.map(m => { const f = mapField(ctx, m.field); return { alias: aliasOf(ms.length > 1 ? `${name}_${m.field}` : name), render: c => (c ? `${fn}If(${f}, ${s}, ${c})` : `${fn}(${f}, ${s})`) }; });
    }
    case 'boxplot': {
      ctx.stats.ok++; const x = valueExpr(ctx, body);
      return [{ alias: A, render: c => (c ? `quantilesTDigestIf(0, 0.25, 0.5, 0.75, 1)(${x}, ${c})` : `quantilesTDigest(0, 0.25, 0.5, 0.75, 1)(${x})`) }];
    }
    default:
      todo(ctx, `agrégation ${type}`, `« ${name} » (${type}) n’a pas d’équivalent automatique.`);
      return [{ alias: A, render: () => `NULL /* à traduire : ${chComment(type)} */` }];
  }
}
function resolveBucketsPath(level, path) {
  const p = String(path);
  if (p === '_count') return 'doc_count';
  if (p === '_key') return level.keys.length ? level.keys[level.keys.length - 1].alias : 'NULL';
  const [head, sub] = p.split(/[.\[]/);
  const clean = head.replace(/>.*/, '');
  const m = level.metrics.find(x => x.alias === aliasOf(`${clean}_${sub}`)) || level.metrics.find(x => x.alias === aliasOf(clean));
  return m ? m.alias : aliasOf(clean);
}
// Accepte les trois écritures d’Elasticsearch : "champ", { champ: "desc" } et { champ: { order: "desc" } }
function parseOrder(order, def) {
  if (!order) return def;
  const arr = Array.isArray(order) ? order : typeof order === 'string' ? [order] : Object.entries(order).map(([k, v]) => ({ [k]: v }));
  return arr.map(o => {
    if (typeof o === 'string') return { by: o === '_term' ? '_key' : o, dir: 'asc' };
    const k = Object.keys(o)[0];
    const dir = String(isObj(o[k]) ? o[k].order || 'asc' : o[k]).toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`sens de tri inconnu pour ${k} : ${JSON.stringify(o[k])}`);
    return { by: k === '_term' ? '_key' : k, dir };
  });
}
function buildLevel(ctx, name, def) {
  const type = aggType(def); const body = def[type] || {};
  const L = { name, type, keys: [], where: [], having: [], order: [{ by: '_count', dir: 'desc' }, { by: '_key', dir: 'asc' }], size: null, limitable: false, fill: null, global: false, metrics: [], pipes: [], windows: [], sorted: false };
  // Un regroupement qui porte le nom de son propre champ (service: terms service) ne masque rien : pas de suffixe
  const ownColumn = typeof body.field === 'string' && !body.script && body.missing === undefined && /^(terms|significant_terms|rare_terms|significant_text)$/.test(type) ? mapField(ctx, body.field) : null;
  const A = ownColumn !== null && ownColumn === chIdent(rawAlias(name)) ? ownColumn : aliasOf(name);
  const incl = (k, inc, neg) => {
    if (inc === undefined) return;
    let c;
    if (typeof inc === 'string') c = `match(${k}, ${chStr('^(?:' + inc + ')$')})`;
    else if (Array.isArray(inc)) c = `${k} IN (${inc.map(chVal).join(', ')})`;
    else if (isObj(inc) && inc.num_partitions) c = `cityHash64(${k}) % ${chInt(inc.num_partitions, 'num_partitions')} = ${chInt(inc.partition || 0, 'partition')}`;
    // Les documents sans le champ sont déjà écartés du regroupement : la négation simple suffit
    if (c) L.where.push(neg ? negateWith(c, false) : c);
  };
  switch (type) {
    case 'terms': case 'significant_terms': case 'rare_terms': case 'significant_text': {
      let k = body.script ? painlessToSQL(ctx, body.script.source || body.script, { mode: 'expr', params: (body.script && body.script.params) || {} }).sql : mapField(ctx, body.field);
      if (body.field && !ctx.runtime[String(body.field).replace(/\.keyword$/, '')]) ctx.groupCols.add(mapField(ctx, body.field));
      const computed = !!body.script || !!ctx.runtime[String(body.field || '').replace(/\.keyword$/, '')];
      const colType = computed ? null : fieldType(ctx, body.field);
      const absent = emptyIsMissing(ctx, colType) ? `${k} = ''` : null;
      if (colType && colType.array) {
        // Champ multivalué : un document compte dans le groupe de chacune de ses valeurs ; un tableau vide ne compte nulle part
        k = body.missing !== undefined ? `arrayJoin(if(empty(${k}), [${chVal(body.missing)}], ${k}))` : `arrayJoin(${k})`;
      } else if (body.missing !== undefined) k = absent ? `if(${absent}, ${chVal(body.missing)}, ${k})` : `ifNull(${k}, ${chVal(body.missing)})`;
      else if (body.missing_bucket && absent) k = `nullIf(${k}, '')`;
      L.keys.push({ sql: k, alias: A });
      // Elasticsearch ne crée pas de groupe pour les documents qui n’ont pas le champ,
      // sauf missing_bucket (source d’un composite), qui les réunit sous une clé null
      if (body.missing === undefined && !body.missing_bucket) {
        // Un champ runtime qui émet toujours une valeur n’a pas besoin de ce filtre
        const rtField = body.script ? null : ctx.runtime[String(body.field || '').replace(/\.keyword$/, '')];
        if (body.script || (rtField && rtField.nullable !== false) || (colType && colType.nullable)) L.where.push(`isNotNull(${k})`);
        else if (absent) L.where.push(`${k} != ''`);
      }
      incl(k, body.include, false); incl(k, body.exclude, true);
      if (type === 'rare_terms') {
        L.having.push(`doc_count <= ${chInt(body.max_doc_count || 1, 'max_doc_count')}`); L.order = [{ by: '_count', dir: 'asc' }, { by: '_key', dir: 'asc' }];
        ctx.stats.ok++; H(ctx, 'groups', `valeurs rares de ${body.field}`);
      } else {
        L.size = body.size !== undefined ? chInt(body.size, 'terms.size') : 10; L.limitable = true;
        L.order = parseOrder(body.order, L.order);
        if ((body.min_doc_count || 1) > 1) L.having.push(`doc_count >= ${chInt(body.min_doc_count, 'min_doc_count')}`);
        if (body.min_doc_count === 0) ctx.notes.add('warn', 'min_doc_count: 0', 'Les valeurs sans document ne peuvent pas apparaître via GROUP BY : il faudrait une jointure avec la liste des valeurs attendues.');
        if (type !== 'terms') { ctx.stats.approx++; ctx.notes.add('warn', `${type} approximé`, 'Le score de significativité n’est pas calculé : regroupement simple par fréquence.'); } else ctx.stats.ok++;
        H(ctx, 'groups', `par ${body.field || 'script'} (${L.size} premiers)`);
      }
      break;
    }
    case 'multi_terms': {
      (body.terms || []).forEach((t, i) => { const k = mapField(ctx, t.field); ctx.groupCols.add(k); L.keys.push({ sql: k, alias: aliasOf(`${name}_${t.field}`) }); });
      L.size = body.size !== undefined ? chInt(body.size, 'multi_terms.size') : 10; L.limitable = true; L.order = parseOrder(body.order, L.order);
      ctx.stats.ok++; H(ctx, 'groups', `par ${(body.terms || []).map(t => t.field).join(' + ')} (${L.size} premiers)`);
      break;
    }
    case 'date_histogram': case 'auto_date_histogram': {
      const f = mapField(ctx, body.field); const tz = body.time_zone; const tzA = tzArg(ctx.cfg, tz);
      let ci = body.calendar_interval || (body.interval && CAL[body.interval] ? body.interval : null);
      let fi = body.fixed_interval || (!ci && body.interval) || null;
      if (type === 'auto_date_histogram') { ci = 'hour'; ctx.stats.approx++; ctx.notes.add('warn', 'auto_date_histogram', `L’intervalle automatique (${body.buckets || 10} tranches) est fixé à l’heure : ajustez selon la période.`); } else ctx.stats.ok++;
      // bucket(x) : début de la tranche qui contient x, pour la colonne comme pour les bornes de extended_bounds
      let bucket, step, hum;
      if (ci && CAL[ci]) { const [fn, unit, fr] = CAL[ci]; bucket = x => `${fn}(${x}${tzA})`; step = `INTERVAL 1 ${unit}`; hum = `par ${fr}`; }
      else {
        const m = /^(\d+)(ms|s|m|h|d)$/.exec(String(fi || '1h'));
        const n = m ? m[1] : '1', u = m ? m[2] : 'h';
        bucket = x => `toStartOfInterval(${x}, INTERVAL ${n} ${FIXED_UNIT[u]}${tzA})`; step = `INTERVAL ${n} ${FIXED_UNIT[u]}`; hum = `par tranche de ${n} ${FIXED_FR[u]}`;
      }
      const key = bucket(f);
      if (body.offset) ctx.notes.add('warn', 'offset de date_histogram', `Le décalage « ${body.offset} » n’est pas appliqué : utilisez toStartOfInterval(…, origin) si besoin.`);
      if (body.hard_bounds) {
        if (body.hard_bounds.min !== undefined) L.where.push(`${f} >= ${dateBoundSQL(ctx, body.hard_bounds.min, tz)}`);
        if (body.hard_bounds.max !== undefined) L.where.push(`${f} <= ${dateBoundSQL(ctx, body.hard_bounds.max, tz)}`);
      }
      // Semaine, mois, trimestre et année donnent une clé de type Date ; les autres intervalles, un DateTime
      L.keys.push({ sql: key, alias: A, date: { asDate: !!(ci && CAL[ci]) && /^(toMonday|toStartOfMonth|toStartOfQuarter|toStartOfYear)$/.test(CAL[ci][0]), zone: zoneOf(ctx.cfg, tz) } });
      L.order = parseOrder(body.order, [{ by: '_key', dir: 'asc' }]);
      if ((body.min_doc_count || 0) === 0) {
        L.fill = step;
        // extended_bounds étend la série de tranches au-delà des données (Kibana y met la période affichée)
        const eb = body.extended_bounds || {};
        if (eb.min !== undefined && eb.min !== null) L.fillFrom = bucket(dateBoundSQL(ctx, eb.min, tz));
        if (eb.max !== undefined && eb.max !== null) L.fillTo = `${bucket(dateBoundSQL(ctx, eb.max, tz))} + ${step}`;
      } else if (body.min_doc_count > 1) L.having.push(`doc_count >= ${chInt(body.min_doc_count, 'min_doc_count')}`);
      H(ctx, 'groups', hum);
      break;
    }
    case 'histogram': {
      const f = mapField(ctx, body.field); const iv = chNum(body.interval || 1, 'histogram.interval'); const off = chNum(body.offset || 0, 'histogram.offset');
      const bucket = x => (off ? `floor((${x} - ${off}) / ${iv}) * ${iv} + ${off}` : `floor(${x} / ${iv}) * ${iv}`);
      const key = bucket(f);
      L.keys.push({ sql: key, alias: A }); L.order = parseOrder(body.order, [{ by: '_key', dir: 'asc' }]);
      if ((body.min_doc_count || 0) === 0) {
        L.fill = String(iv);
        const eb = body.extended_bounds || {};
        if (eb.min !== undefined && eb.min !== null) L.fillFrom = bucket(chNum(eb.min, 'extended_bounds.min'));
        if (eb.max !== undefined && eb.max !== null) L.fillTo = `${bucket(chNum(eb.max, 'extended_bounds.max'))} + ${iv}`;
      }
      ctx.stats.ok++; H(ctx, 'groups', `par tranches de ${iv} sur ${body.field}`);
      break;
    }
    case 'range': case 'date_range': case 'ip_range': {
      const f = mapField(ctx, body.field); const tz = body.time_zone;
      const bound = v => { if (type !== 'date_range') return type === 'ip_range' ? `toIPv4(${chStr(v)})` : chVal(v); return dateBoundSQL(ctx, v, tz); };
      const lhs = type === 'ip_range' ? `toIPv4(${f})` : f;
      const items = (body.ranges || []).map(r => {
        const key = r.key || (r.mask ? r.mask : `${r.from !== undefined ? r.from : '*'}-${r.to !== undefined ? r.to : '*'}`);
        let cond;
        if (r.mask) cond = `isIPAddressInRange(toString(${f}), ${chStr(r.mask)})`;
        else cond = andJoin([r.from !== undefined ? `${lhs} >= ${bound(r.from)}` : null, r.to !== undefined ? `${lhs} < ${bound(r.to)}` : null]) || '1';
        return { key, cond };
      });
      L.keys.push({ sql: `arrayJoin(arrayFilter(x -> x != '', [${items.map(i => `if(${i.cond}, ${chStr(i.key)}, '')`).join(', ')}]))`, alias: A });
      L.order = [{ by: `indexOf([${items.map(i => chStr(i.key)).join(', ')}], ${A})`, dir: 'asc', raw: true }];
      ctx.stats.ok++; H(ctx, 'groups', `par plages de ${body.field}`);
      ctx.notes.add('info', 'Plages via arrayJoin', 'Une ligne peut appartenir à plusieurs plages, comme dans Elasticsearch : arrayJoin duplique la ligne dans chaque plage correspondante. Les plages vides ne sont pas renvoyées.');
      break;
    }
    case 'filters': {
      ctx.humanOff++;
      const entries = Array.isArray(body.filters) ? body.filters.map((q, i) => [String(i), q]) : Object.entries(body.filters || {});
      const items = entries.map(([k, q]) => ({ key: k, cond: tq(ctx, q) || '1' }));
      if (body.other_bucket || body.other_bucket_key) items.push({ key: body.other_bucket_key || '_other_', cond: (any => (any === null ? 'false' : negate(ctx, any)))(orJoin(items.map(i => i.cond))) });
      ctx.humanOff--;
      L.keys.push({ sql: `arrayJoin(arrayFilter(x -> x != '', [${items.map(i => `if(${i.cond}, ${chStr(i.key)}, '')`).join(', ')}]))`, alias: A });
      L.order = [{ by: `indexOf([${items.map(i => chStr(i.key)).join(', ')}], ${A})`, dir: 'asc', raw: true }];
      H(ctx, 'groups', `par filtres (${items.map(i => i.key).join(', ')})`);
      break;
    }
    case 'filter': { ctx.humanOff++; const c = tq(ctx, body); ctx.humanOff--; if (c) L.where.push(c); H(ctx, 'groups', `sous-ensemble « ${name} »`); break; }
    case 'missing': {
      const f = mapField(ctx, body.field); const colType = fieldType(ctx, body.field);
      // « Sans le champ » : tableau vide, chaîne vide selon la convention, ou NULL
      if (colType && colType.array) L.where.push(`empty(${f})`);
      else if (emptyIsMissing(ctx, colType)) L.where.push(`${f} = ''`);
      else L.where.push(`isNull(${f})`);
      if (colType && !colType.array && !colType.nullable && !emptyIsMissing(ctx, colType)) {
        ctx.stats.approx++;
        ctx.notes.add('warn', `missing sur ${body.field}`, 'La colonne n’est pas Nullable : un champ absent y prend la valeur par défaut, isNull() n’est donc jamais vrai. Si la chaîne vide représente l’absence, activez clickhouse.empty_as_missing.');
      } else ctx.stats.ok++;
      H(ctx, 'groups', `${body.field} absent`);
      break;
    }
    case 'global': { L.global = true; ctx.stats.ok++; ctx.notes.add('info', 'Agrégation global', 'Cette branche ignore le filtre de la requête principale, comme dans Elasticsearch.'); break; }
    case 'sampler': case 'diversified_sampler': ctx.stats.approx++; ctx.notes.add('info', `${type} ignoré`, 'Pour échantillonner, ajoutez SAMPLE 0.1 si la table déclare une clé d’échantillonnage (SAMPLE BY).'); break;
    case 'nested': case 'reverse_nested': ctx.stats.approx++; ctx.notes.add('warn', `Agrégation ${type}`, 'Les objets nested deviennent des tableaux : utilisez ARRAY JOIN sur la colonne concernée pour agréger par élément.'); break;
    case 'composite': {
      (body.sources || []).forEach(src => {
        const sn = Object.keys(src)[0]; const st = Object.keys(src[sn])[0]; const sb = src[sn][st];
        const sub = buildLevel(ctx, sn, { [st]: sb });
        const desc = String(sb.order || 'asc').toLowerCase() === 'desc';
        // Clé null (missing_bucket) : en tête en ordre croissant, en queue en ordre décroissant, sauf missing_order
        const nullable = !!sb.missing_bucket;
        const nullsFirst = sb.missing_order === 'first' || (sb.missing_order !== 'last' && !desc);
        sub.keys.forEach(k => L.keys.push(Object.assign({ source: sn, desc, nullable, nullsFirst }, k)));
        L.where.push(...sub.where);
      });
      L.composite = true; ctx.stats.ok++;
      if (ctx.cfg.clickhouse.composite_mode === 'stream') {
        // Export complet : une seule requête, sans page ni tri, que le client lit en flux
        L.size = null; L.order = [];
        if (body.after) ctx.notes.add('warn', 'composite : after ignoré', 'En mode stream (clickhouse.composite_mode), la requête renvoie tous les groupes d’un coup : le client ne doit plus boucler sur after_key.');
        ctx.notes.add('opt', 'composite → export en une requête', 'La pagination composite existe parce qu’Elasticsearch ne renvoie pas un nombre illimité de groupes. ClickHouse les diffuse en flux : une seule lecture de la table au lieu d’une par page. Pour un très grand nombre de groupes, fixez max_bytes_before_external_group_by afin que l’agrégation déborde sur disque.');
        break;
      }
      L.size = chInt(body.size || 10, 'composite.size');
      L.order = L.keys.map(k => ({ by: `${k.alias} ${k.desc ? 'DESC' : 'ASC'}${k.nullable && k.nullsFirst ? ' NULLS FIRST' : ''}`, raw: true }));
      if (body.after) L.where.push(compositeCursor(L.keys, body.after));
      ctx.notes.add('info', 'composite → pagination par curseur', 'La page suivante se lit en passant les dernières clés dans after. Le curseur est une condition WHERE écrite clé par clé, que ClickHouse peut confronter à la clé de tri de la table (une comparaison de tuples ne le permet pas).');
      ctx.notes.add('opt', 'composite : une lecture par page', 'Chaque page relit et regroupe les lignes situées après le curseur. Pour parcourir tous les groupes, clickhouse.composite_mode: stream produit une seule requête sans pagination. Si les sources suivent l’ordre de la clé de tri de la table, le curseur écarte d’emblée les blocs déjà parcourus, et optimize_aggregation_in_order = 1 laisse ClickHouse regrouper au fil de la lecture.');
      break;
    }
    case 'geohash_grid': case 'geotile_grid': {
      const f = mapField(ctx, body.field); L.keys.push({ sql: `geohashEncode(${f}.1, ${f}.2, ${chInt(body.precision || 5, 'precision')})`, alias: A });
      L.size = chInt(body.size || 10000, 'size'); L.limitable = true; ctx.stats.approx++;
      ctx.notes.add('warn', type, 'Traduit en geohashEncode sur une colonne Point (lon, lat) ; les tuiles geotile diffèrent des geohash.');
      break;
    }
    default:
      todo(ctx, `agrégation ${type}`, `« ${name} » (${type}) n’a pas d’équivalent automatique.`);
  }
  // Enfants
  const kids = aggChildren(def);
  L.children = [];
  for (const [cn, cdef] of Object.entries(kids)) {
    const ct = aggType(cdef); const cb = cdef[ct] || {};
    if (METRIC_TYPES.has(ct)) L.metrics.push(...metricDef(ctx, cn, ct, cb).map(m => Object.assign(m, { cond: null })));
    else if (PIPE_TYPES.has(ct)) L.pipes.push({ name: cn, type: ct, body: cb });
    else if (ct === 'top_hits') L.topHits = L.topHits || [], L.topHits.push({ name: cn, body: cb });
    else if (ct === 'filter' && Object.values(aggChildren(cdef)).every(d => METRIC_TYPES.has(aggType(d)))) {
      ctx.humanOff++; const c = tq(ctx, cb) || '1'; ctx.humanOff--;
      L.metrics.push({ alias: aliasOf(`${cn}_doc_count`), render: () => `countIf(${c})` });
      for (const [mn, md] of Object.entries(aggChildren(cdef))) { const mt = aggType(md); metricDef(ctx, `${cn}_${mn}`, mt, md[mt] || {}).forEach(m => L.metrics.push({ alias: m.alias, render: () => m.render(c, true) })); }
      ctx.stats.ok++;
      ctx.notes.add('opt', `Filtre « ${cn} » fusionné`, 'Plutôt qu’une requête de plus, le sous-filtre est calculé dans la même passe grâce aux combinateurs -If (countIf, avgIf…).');
    } else L.children.push({ name: cn, def: cdef });
  }
  return L;
}
/*
 * Curseur d’une agrégation composite : les groupes situés après la clé « after », dans l’ordre des sources.
 * C’est une comparaison lexicographique, écrite branche par branche plutôt qu’en tuples :
 *     k1 > v1  OR  (k1 = v1 AND k2 > v2)  OR  (k1 = v1 AND k2 = v2 AND k3 > v3)  …
 * Cette forme accepte un sens par source (< pour une source décroissante), les clés null de missing_bucket,
 * et laisse ClickHouse utiliser la clé primaire, ce qu’il ne fait pas d’une comparaison de tuples.
 */
function compositeCursor(keys, after) {
  const value = k => after[k.source];
  const isNull = k => value(k) === null || value(k) === undefined;
  const equals = k => (isNull(k) ? `${k.alias} IS NULL` : `${k.alias} = ${cursorValueSQL(k, value(k))}`);
  // Groupes strictement après la valeur du curseur pour cette source, null compris ; null si aucun ne peut l’être
  const beyond = k => {
    if (isNull(k)) return k.nullable && k.nullsFirst ? `${k.alias} IS NOT NULL` : null;
    const cmp = `${k.alias} ${k.desc ? '<' : '>'} ${cursorValueSQL(k, value(k))}`;
    return k.nullable && !k.nullsFirst ? `(${cmp} OR ${k.alias} IS NULL)` : cmp;
  };
  const branches = [];
  keys.forEach((k, i) => {
    const next = beyond(k);
    if (next === null) return;
    const prefix = keys.slice(0, i).map(equals);
    branches.push(prefix.length ? `(${prefix.concat([next]).join(' AND ')})` : next);
  });
  if (!branches.length) return 'false';
  if (branches.length === 1) return branches[0];
  return `(\n         ${branches.join('\n      OR ')}\n  )`;
}
function levelOrder(L, alias) {
  return L.order.map(o => {
    if (o.raw) return o.dir ? `${o.by} ${o.dir.toUpperCase()}` : o.by;
    if (o.by === '_count') return `doc_count ${o.dir.toUpperCase()}`;
    if (o.by === '_key') return L.keys.map(k => `${k.alias} ${o.dir.toUpperCase()}`).join(', ');
    return `${alias ? resolveBucketsPath(L, o.by) : resolveBucketsPath(L, o.by)} ${o.dir.toUpperCase()}`;
  }).filter(Boolean);
}
function orderInSub(L) {
  // Ordre exprimé avec des agrégats, pour les sous-requêtes de restriction
  return L.order.map(o => {
    if (o.raw) return o.dir ? `${o.by} ${o.dir.toUpperCase()}` : o.by;
    if (o.by === '_count') return `count() ${o.dir.toUpperCase()}`;
    if (o.by === '_key') return L.keys.map(k => `${k.alias} ${o.dir.toUpperCase()}`).join(', ');
    const alias = resolveBucketsPath(L, o.by); const m = L.metrics.find(x => x.alias === alias);
    return `${m ? m.render(null) : alias} ${o.dir.toUpperCase()}`;
  });
}
function keyLevels(path) { return path.filter(l => l.keys.length); }
// « x AS x » est inutile, et ClickHouse le refuse quand x est déjà un champ runtime défini par WITH (alias déclaré deux fois)
function selectAs(k) { return k.sql === k.alias ? k.sql : `${k.sql} AS ${k.alias}`; }
/*
 * Portée d’une requête d’agrégation imbriquée.
 *
 * Le top N d’un regroupement parent se calcule par une première requête, que la requête principale consulte.
 * Plutôt que de recopier le filtre de la requête dans chacune, il est nommé une fois (CTE « base »), et chaque
 * top N aussi (« top_<nom> ») : le SQL se lit de haut en bas, sans sous-requête à dérouler.
 * ClickHouse recopie une CTE à chaque emploi : c’est une affaire de lisibilité, le nombre de lectures
 * de la table reste le même que sans CTE.
 *
 * upto : niveau le plus profond dont le top N restreint la requête.
 */
function nestedScope(ctx, env, path, upto) {
  const scope = { from: env.table, filtered: false, ctes: [], names: new Set(['base']) };
  if (!path.slice(0, upto + 1).some(l => l.limitable && l.size !== null)) return scope;
  // Une agrégation global ignore le filtre de la requête pour une partie du chemin : il reste alors dans chaque requête
  scope.filtered = env.baseWhere.length > 0 && !path.some(l => l.global);
  // Les champs runtime deviennent des colonnes de « base » : définis une fois, là où la table est lue, chaque CTE les lit comme des colonnes ordinaires
  const runtime = Object.values(ctx.runtime).some(r => r.sql);
  if (!scope.filtered && !runtime) return scope;
  scope.from = 'base';
  scope.ctes.push(`base AS (\n${sqlSelect({ select: [`*${RUNTIME_COLUMNS}`], from: env.table, where: scope.filtered ? env.baseWhere : [] }, '        ')}\n    )`);
  return scope;
}
// Emplacement, dans la CTE « base », des champs runtime dont la requête se sert (rempli par withClause)
const RUNTIME_COLUMNS = '/*@@*/';
function pathWhere(env, path, upto, scope) {
  let start = 0;
  for (let i = 0; i <= upto; i++) if (path[i].global) start = i;
  const base = (scope && scope.filtered) || path.slice(0, upto + 1).some(l => l.global) ? [] : env.baseWhere.slice();
  for (let i = start; i <= upto; i++) base.push(...path[i].where);
  return base;
}
function restriction(ctx, env, path, upto, scope) {
  // Cherche le parent « limitable » le plus profond (index < upto+1)
  let j = -1;
  for (let i = upto; i >= 0; i--) if (path[i].limitable && path[i].size !== null) { j = i; break; }
  if (j < 0) return null;
  const lv = path.slice(0, j + 1); const kl = keyLevels(lv);
  const keys = kl.flatMap(l => l.keys);
  const parentKeys = keyLevels(path.slice(0, j)).flatMap(l => l.keys);
  const where = pathWhere(env, path, j, scope);
  const inner = restriction(ctx, env, path, j - 1, scope);
  if (inner) where.push(inner);
  const sub = sqlSelect({
    select: keys.map(selectAs),
    from: scope.from, where,
    groupBy: keys.map(k => k.alias),
    having: path[j].having.map(h => h.replace(/\bdoc_count\b/g, 'count()')),
    orderBy: orderInSub(path[j]),
    limitBy: parentKeys.length ? { n: path[j].size, by: parentKeys.map(k => k.alias) } : null,
    limit: parentKeys.length ? null : path[j].size
  }, '        ');
  // Une CTE par top N, nommée d’après le regroupement qu’elle limite
  let name = `top_${keys[keys.length - 1].alias.replace(/`/g, '')}`;
  for (let n = 2; scope.names.has(name); n++) name = `top_${keys[keys.length - 1].alias.replace(/`/g, '')}_${n}`;
  scope.names.add(name);
  scope.ctes.push(`${name} AS (\n${sub}\n    )`);
  const lhs = keys.length === 1 ? keys[0].sql : `(${keys.map(k => k.sql).join(', ')})`;
  return `${lhs} IN (SELECT ${keys.map(k => k.alias).join(', ')} FROM ${name})`;
}
function aggQuery(ctx, env, path) {
  const L = path[path.length - 1]; const k = path.length - 1;
  const kl = keyLevels(path); const keys = kl.flatMap(l => l.keys);
  const scope = nestedScope(ctx, env, path, k - 1);
  const where = pathWhere(env, path, k, scope);
  const r = restriction(ctx, env, path, k - 1, scope);
  if (r) where.push(r);
  // Les tranches vides d’un histogramme sont ajoutées par WITH FILL, sur sa clé triée en ordre croissant.
  // Pas avec un pipeline : une fonction de fenêtre est calculée avant l’ajout et ne verrait pas ces lignes.
  const fills = !!L.fill && !L.pipes.length && L.keys.length > 0 && L.order.length > 0 && L.order[0].by === '_key' && L.order[0].dir === 'asc';
  const mayBeEmpty = keys.length === 0 || fills;
  const select = keys.map(selectAs).concat(['count() AS doc_count']).concat(L.metrics.map(m => `${m.render(null, mayBeEmpty)} AS ${m.alias}`));
  const order = []; const parentKL = keyLevels(path.slice(0, k));
  parentKL.forEach((pl, i) => {
    const pkeys = parentKL.slice(0, i + 1).flatMap(l => l.keys).map(x => x.alias);
    if (pl.limitable && pl.order[0] && pl.order[0].by === '_count') {
      const a = aliasOf(`${pl.name}_doc_count`);
      select.push(`sum(count()) OVER (PARTITION BY ${pkeys.join(', ')}) AS ${a}`);
      order.push(`${a} ${pl.order[0].dir.toUpperCase()}`, ...pl.keys.map(x => x.alias));
    } else order.push(...pl.keys.map(x => `${x.alias} ${pl.order[0] && pl.order[0].by === '_key' ? pl.order[0].dir.toUpperCase() : 'ASC'}`));
  });
  // Pipelines
  const having = L.having.slice(); let limitOverride = null;
  const partKeys = parentKL.flatMap(l => l.keys).map(x => x.alias);
  const ownKey = L.keys.length ? L.keys[L.keys.length - 1].alias : null;
  const win = rows => `OVER (${partKeys.length ? 'PARTITION BY ' + partKeys.join(', ') + ' ' : ''}ORDER BY ${ownKey} ${rows})`;
  for (const p of L.pipes) {
    const b = p.body; const bp = b.buckets_path;
    const res = x => resolveBucketsPath(L, x);
    try {
      if (p.type === 'bucket_selector' || p.type === 'bucket_script') {
        const map = {}; if (isObj(bp)) for (const [v, path] of Object.entries(bp)) map[v] = res(path);
        const sc = b.script; const src = typeof sc === 'string' ? sc : sc.source;
        const e = painlessToSQL(ctx, src, { mode: 'expr', paramSQL: map, params: (isObj(sc) && sc.params) || {} }).sql;
        if (p.type === 'bucket_selector') { having.push(e); ctx.notes.add('opt', `bucket_selector « ${p.name} » → HAVING`, 'Le filtrage des groupes se fait côté serveur, sans transférer les groupes écartés.'); }
        else select.push(`${e} AS ${aliasOf(p.name)}`);
        ctx.stats.ok++;
      } else if (p.type === 'bucket_sort') {
        if (b.sort) { L.order = parseOrder(b.sort, L.order); L.sorted = true; }
        limitOverride = { n: b.size === undefined ? undefined : chInt(b.size, 'bucket_sort.size'), offset: chInt(b.from || 0, 'bucket_sort.from') }; ctx.stats.ok++;
      } else if (['cumulative_sum', 'derivative', 'serial_diff', 'moving_fn', 'moving_avg'].includes(p.type)) {
        if (!ownKey) throw new Error('pipeline sans clé d’ordre');
        const m = res(bp); const src = m === 'doc_count' ? 'count()' : m;
        let e;
        if (p.type === 'cumulative_sum') e = `sum(${src}) ${win('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')}`;
        else if (p.type === 'derivative' || p.type === 'serial_diff') {
          // Les premiers points n’ont pas de prédécesseur : null dans Elasticsearch. Sur une valeur Nullable,
          // lagInFrame renvoie NULL hors de la fenêtre (et non 0), donc la différence aussi.
          const lag = chInt(b.lag || 1, 'lag');
          e = `${src} - lagInFrame(toNullable(${src}), ${lag}) ${win(`ROWS BETWEEN ${lag} PRECEDING AND CURRENT ROW`)}`;
        } else {
          const w = chInt(b.window || 5, 'window'); const sh = chInt(b.shift || 0, 'shift');
          const fnm = /max\(/.test(b.script || '') ? 'max' : /min\(/.test(b.script || '') ? 'min' : /sum\(/.test(b.script || '') ? 'sum' : /stdDev/.test(b.script || '') ? 'stddevPop' : 'avg';
          if (/linearWeightedAvg|ewma|holt/.test(b.script || '') || p.type === 'moving_avg') ctx.notes.add('warn', `${p.name} : moyenne simple`, 'Les moyennes pondérées (linéaire, ewma, holt) sont remplacées par une moyenne simple sur la fenêtre.');
          // Fenêtre vide (premières tranches) : null dans Elasticsearch, sauf pour une somme qui vaut 0
          const arg = fnm === 'sum' ? src : `toNullable(${src})`;
          e = `${fnm}(${arg}) ${win(`ROWS BETWEEN ${w - sh} PRECEDING AND ${sh > 0 ? sh - 1 + ' FOLLOWING' : '1 PRECEDING'}`)}`;
        }
        select.push(`${e} AS ${aliasOf(p.name)}`); ctx.stats.ok++;
      } else todo(ctx, `pipeline ${p.type}`, `« ${p.name} » n’a pas d’équivalent automatique.`);
    } catch (e) { todo(ctx, `pipeline ${p.name}`, e.message); }
  }
  order.push(...levelOrder(L));
  const orderBy = order.filter(Boolean);
  if (fills) {
    // WITH FILL porte sur la dernière colonne de tri. Les colonnes qui la précèdent (regroupements parents)
    // délimitent des séries complétées séparément, chacune entre sa première et sa dernière tranche.
    const bounds = (L.fillFrom ? `\n    FROM ${L.fillFrom}` : '') + (L.fillTo ? `\n    TO ${L.fillTo}` : '');
    orderBy[orderBy.length - 1] = `${ownKey} ASC WITH FILL${bounds}${bounds ? '\n   ' : ''} STEP ${L.fill}`;
    ctx.notes.add('opt', 'Tranches vides comblées (WITH FILL)', 'Comme un histogramme avec min_doc_count: 0, les intervalles sans document sont générés par ClickHouse au lieu d’être comblés côté client. Avec extended_bounds, la série est étendue jusqu’aux bornes demandées.');
  } else if (L.fill && L.pipes.length) {
    ctx.stats.approx++;
    ctx.notes.add('warn', `Tranches vides non comblées (${L.name})`, 'Avec un pipeline d’agrégation, les tranches sans document ne sont pas ajoutées : le calcul porte sur les tranches présentes, alors qu’Elasticsearch compte aussi les tranches vides.');
  }
  let limit = null, limitBy = null;
  const size = limitOverride && limitOverride.n !== undefined ? limitOverride.n : L.size;
  const offset = limitOverride ? limitOverride.offset : 0;
  if (L.limitable || L.composite || limitOverride) {
    if (partKeys.length && size !== null && size !== undefined) limitBy = { n: size, offset, by: partKeys };
    else if (size !== null && size !== undefined) limit = size;
  }
  return sqlSelect({ with: scope.ctes, select, from: scope.from, where, groupBy: keys.map(x => x.alias), having, orderBy, limitBy, limit, offset: limitBy ? 0 : offset });
}
function walkAggs(ctx, env, aggs, parentPath, out) {
  for (const [name, def] of Object.entries(aggs || {})) {
    const t = aggType(def);
    if (!t) continue;
    // Elasticsearch refuse une agrégation global ailleurs qu’au premier niveau
    if (t === 'global' && parentPath.length) { todo(ctx, `agrégation ${name}`, 'Une agrégation global ne peut être définie qu’au premier niveau des agrégations.'); continue; }
    let L;
    try { L = buildLevel(ctx, name, def); }
    catch (e) { todo(ctx, `agrégation ${name}`, e.message); continue; }
    const path = parentPath.concat([L]);
    const needSelf = L.metrics.length || L.pipes.length || !L.children.length;
    if (needSelf && !(t === 'sampler' && !L.metrics.length && L.children.length)) {
      try { out.push({ title: `Agrégation ${path.map(p => p.name).join(' › ')}`, sql: aggQuery(ctx, env, path), path: path.map(p => p.name), keyAlias: L.keys.length ? L.keys[L.keys.length - 1].alias : null }); }
      catch (e) { todo(ctx, `agrégation ${name}`, e.message); }
    }
    if (L.topHits) L.topHits.forEach(th => out.push({ title: `Top hits ${path.map(p => p.name).join(' › ')} › ${th.name}`, sql: topHitsQuery(ctx, env, path, th) }));
    const kidAggs = {}; L.children.forEach(c => (kidAggs[c.name] = c.def));
    walkAggs(ctx, env, kidAggs, path, out);
  }
}
function topHitsQuery(ctx, env, path, th) {
  const b = th.body; const keys = keyLevels(path).flatMap(l => l.keys);
  const scope = nestedScope(ctx, env, path, path.length - 1);
  const where = pathWhere(env, path, path.length - 1, scope);
  const r = restriction(ctx, env, path, path.length - 1, scope); if (r) where.push(r);
  const cols = selectList(ctx, b); const order = sortList(ctx, b.sort);
  ctx.stats.ok++;
  ctx.notes.add('opt', `top_hits « ${th.name} » → LIMIT n BY`, 'LIMIT n BY renvoie les n meilleurs documents de chaque groupe en une seule passe triée.');
  const n = chInt(b.size || 3, 'top_hits.size');
  return sqlSelect({ with: scope.ctes, select: keys.map(selectAs).concat(cols), from: scope.from, where, orderBy: keys.map(k => k.alias).concat(order), limitBy: keys.length ? { n, by: keys.map(k => k.alias) } : null, limit: keys.length ? null : n });
}
function rootAggs(ctx, env, aggs) {
  const out = [];
  const metrics = []; const rest = {}; const siblings = [];
  for (const [name, def] of Object.entries(aggs || {})) {
    const t = aggType(def); const b = def[t] || {};
    if (METRIC_TYPES.has(t)) metrics.push(...metricDef(ctx, name, t, b));
    else if (SIBLING_PIPES.has(t)) siblings.push({ name, type: t, body: b });
    else if (t === 'filter' && Object.values(aggChildren(def)).every(d => METRIC_TYPES.has(aggType(d)))) {
      ctx.humanOff++; const c = tq(ctx, b) || '1'; ctx.humanOff--;
      metrics.push({ alias: aliasOf(`${name}_doc_count`), render: () => `countIf(${c})` });
      for (const [mn, md] of Object.entries(aggChildren(def))) { const mt = aggType(md); metricDef(ctx, `${name}_${mn}`, mt, md[mt] || {}).forEach(m => metrics.push({ alias: m.alias, render: () => m.render(c, true) })); }
      ctx.stats.ok++;
    } else rest[name] = def;
  }
  if (metrics.length) out.push({ title: 'Mesures globales', sql: sqlSelect({ select: metrics.map(m => `${m.render(null, true)} AS ${m.alias}`), from: env.table, where: env.baseWhere }) });
  walkAggs(ctx, env, rest, [], out);
  for (const s of siblings) {
    const bp = String(s.body.buckets_path || ''); const [aggName, metric] = bp.split('>');
    const target = out.find(q => q.path && q.path.length === 1 && q.path[0] === aggName);
    if (!target || bp.split('>').length > 2) { todo(ctx, `pipeline ${s.type}`, `buckets_path « ${bp} » trop profond pour une traduction automatique.`); continue; }
    const m = metric ? aliasOf(metric.replace(/\..*$/, '')) : 'doc_count';
    const col = metric === '_count' ? 'doc_count' : m; const key = target.keyAlias || aliasOf(aggName); const A = aliasOf(s.name);
    const sel = { avg_bucket: [`avg(${col}) AS ${A}`], sum_bucket: [`sum(${col}) AS ${A}`], min_bucket: [`min(${col}) AS ${A}`, `argMin(${key}, ${col}) AS ${aliasOf(s.name + '_key')}`], max_bucket: [`max(${col}) AS ${A}`, `argMax(${key}, ${col}) AS ${aliasOf(s.name + '_key')}`], stats_bucket: [`count() AS ${aliasOf(s.name + '_count')}`, `min(${col}) AS ${aliasOf(s.name + '_min')}`, `max(${col}) AS ${aliasOf(s.name + '_max')}`, `avg(${col}) AS ${aliasOf(s.name + '_avg')}`, `sum(${col}) AS ${aliasOf(s.name + '_sum')}`], extended_stats_bucket: [`avg(${col}) AS ${aliasOf(s.name + '_avg')}`, `stddevPop(${col}) AS ${aliasOf(s.name + '_std_deviation')}`], percentiles_bucket: [`quantilesTDigest(${(s.body.percents || [1, 5, 25, 50, 75, 95, 99]).map(p => chNum(p, 'percents') / 100).join(', ')})(${col}) AS ${A}`] }[s.type];
    out.push({ title: `Pipeline ${s.name}`, sql: `SELECT\n${sel.map(x => '    ' + x).join(',\n')}\nFROM (\n${indent(target.sql, '    ')}\n)` });
    ctx.stats.ok++;
  }
  return out;
}

/* ---------- Documents (hits) ---------- */
function selectList(ctx, dsl) {
  const cols = [];
  const src = dsl._source;
  const addField = f => {
    if (String(f).includes('*')) { cols.push(`COLUMNS(${chStr(globToRe(String(f).replace(/\.keyword$/, '')))})`); ctx.notes.add('opt', 'Motif de champs → COLUMNS()', 'COLUMNS(\'regex\') sélectionne dynamiquement les colonnes dont le nom correspond.'); }
    else cols.push(mapField(ctx, f));
  };
  if (src === false) { /* rien */ }
  else if (typeof src === 'string') addField(src);
  else if (Array.isArray(src)) src.forEach(addField);
  else if (isObj(src)) {
    (src.includes || src.include || []).forEach(addField);
    const ex = src.excludes || src.exclude || [];
    if (!cols.length && ex.length) cols.push(`* EXCEPT (${ex.map(f => mapField(ctx, f)).join(', ')})`);
  }
  for (const f of [].concat(dsl.fields || [], dsl.docvalue_fields || [], (dsl.stored_fields || []).filter(x => x !== '_none_'))) {
    const name = isObj(f) ? f.field : f;
    const m = mapField(ctx, name); if (!cols.includes(m)) cols.push(m);
  }
  for (const [n, sf] of Object.entries(dsl.script_fields || {})) {
    try { const sc = sf.script || sf; const r = painlessToSQL(ctx, typeof sc === 'string' ? sc : sc.source, { mode: 'expr', params: sc.params || {} }); cols.push(`${r.sql} AS ${aliasOf(n)}`); ctx.stats.ok++; }
    catch (e) { todo(ctx, `script_field ${n}`, e.message); }
  }
  if (!cols.length) {
    cols.push('*');
    ctx.notes.add('opt', 'SELECT * sur une base colonnaire', 'ClickHouse lit chaque colonne séparément : listez uniquement les champs utiles dans _source pour réduire fortement les lectures disque.');
  }
  return cols;
}
function sortList(ctx, sort) {
  if (!sort) return [];
  const arr = Array.isArray(sort) ? sort : [sort];
  const out = [];
  for (const s of arr) {
    let f, o = {};
    if (typeof s === 'string') { f = s; o = { order: s === '_score' ? 'desc' : 'asc' }; }
    else { f = Object.keys(s)[0]; o = isObj(s[f]) ? s[f] : { order: s[f] }; }
    if (f === '_score') { ctx.notes.add('info', 'Tri par _score ignoré', 'Pas de score de pertinence en SQL.'); continue; }
    if (f === '_doc' || f === '_shard_doc') continue;
    if (f === '_script') {
      try { const sc = o.script; const r = painlessToSQL(ctx, typeof sc === 'string' ? sc : sc.source, { mode: 'expr', params: sc.params || {} }); out.push(`${r.sql} ${String(o.order || 'asc').toUpperCase()}`); ctx.stats.ok++; }
      catch (e) { todo(ctx, 'tri scripté', e.message); }
      continue;
    }
    if (f === '_geo_distance') { todo(ctx, 'tri _geo_distance', 'Utilisez ORDER BY geoDistance(lon, lat, x, y).'); continue; }
    let e = mapField(ctx, f);
    if (o.missing !== undefined && o.missing !== '_last' && o.missing !== '_first') e = `ifNull(${e}, ${chVal(o.missing)})`;
    let dir = String(o.order || 'asc').toUpperCase();
    out.push(`${e} ${dir}${o.missing === '_first' ? ' NULLS FIRST' : ''}`);
  }
  return out;
}
function hitsQuery(ctx, env, dsl, where) {
  const size = dsl.size !== undefined ? chInt(dsl.size, 'size') : 10;
  const from = chInt(dsl.from || 0, 'from');
  if (!size) return null;
  const cols = selectList(ctx, dsl);
  let order = sortList(ctx, dsl.sort);
  const tf = [...ctx.dateFields][0] || (ctx.cfg.clickhouse.time_field ? chIdent(ctx.cfg.clickhouse.time_field) : null);
  if (!order.length && tf) { order = [`${tf} DESC`]; ctx.notes.add('info', 'Tri par défaut', `Sans tri explicite, Elasticsearch classe par pertinence. Ici : ${tf} décroissant, le plus proche d’un usage « logs récents ».`); }
  const w = where.slice(); let limitBy = null;
  if (dsl.search_after && dsl.sort) {
    const arr = Array.isArray(dsl.sort) ? dsl.sort : [dsl.sort];
    const dirs = order.map(o => /DESC/.test(o));
    if (dirs.every(d => d === dirs[0])) {
      const cols2 = order.map(o => o.replace(/\s+(ASC|DESC).*$/, ''));
      // Elasticsearch renvoie la valeur de tri d’une date en epoch millis
      const timeColumn = ctx.cfg.clickhouse.time_field ? chIdent(ctx.cfg.clickhouse.time_field) : null;
      const vals = dsl.search_after.map((v, i) => (typeof v === 'number' && (cols2[i] === timeColumn || /time|date|timestamp/i.test(cols2[i] || '')) ? epochMillisSQL(v) : chVal(v)));
      w.push(`(${cols2.join(', ')}) ${dirs[0] ? '<' : '>'} (${vals.join(', ')})`); ctx.stats.ok++;
    } else todo(ctx, 'search_after à sens mixtes', 'Réécrivez la condition de curseur à la main pour des tris de sens différents.');
  }
  if (dsl.collapse && dsl.collapse.field) {
    limitBy = { n: 1, by: [mapField(ctx, dsl.collapse.field)] }; ctx.stats.ok++;
    ctx.notes.add('opt', 'collapse → LIMIT 1 BY', `Un seul document par valeur de ${dsl.collapse.field}, en une passe (inner_hits non repris).`);
  }
  const settings = [];
  if (dsl.timeout) { const m = /^(\d+)(ms|s|m)?$/.exec(String(dsl.timeout)); if (m) settings.push(`max_execution_time = ${Math.max(1, Math.ceil(+m[1] * ({ ms: 0.001, s: 1, m: 60 }[m[2] || 's'])))}`); }
  if (dsl.terminate_after) ctx.notes.add('info', 'terminate_after', 'Pas d’équivalent exact ; max_rows_to_read peut borner le volume lu (la requête échoue alors au lieu de tronquer).');
  if (dsl.highlight) ctx.notes.add('info', 'highlight ignoré', 'La mise en évidence se fait côté application en SQL.');
  const human = `renvoie ${size} document${size > 1 ? 's' : ''}` + (order.length ? ` triés par ${order[0].replace(/ DESC.*/, ' (décroissant)').replace(/ ASC.*/, '')}` : '') + (dsl.collapse ? `, un par ${dsl.collapse.field}` : '');
  ctx.human.hits = human;
  return sqlSelect({ select: cols, from: env.table, where: w, orderBy: order, limitBy, limit: size, offset: from, settings });
}

/* ---------- Entrée principale ---------- */
function resolveTable(ctx, index) {
  const ch = ctx.cfg.clickhouse;
  const idx = String(index || '').split(',')[0].trim();
  if (idx) {
    for (const [pat, table] of Object.entries(ch.index_mapping || {})) {
      if (pat === idx || new RegExp(globToRe(pat)).test(idx)) return { table, index: idx, matched: pat };
    }
    const guess = `${ch.database || 'default'}.${idx.replace(/\*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+$/, '') || 'events'}`;
    ctx.notes.add('warn', 'Index sans correspondance', `« ${idx} » n’a pas de table associée dans la configuration : ${guess} est utilisée par défaut.`);
    return { table: guess, index: idx, matched: null };
  }
  return { table: ch.default_table || `${ch.database}.events`, index: '', matched: null };
}
function preprocessDSL(text) {
  return text.replace(/"""([\s\S]*?)"""/g, (m, inner) => JSON.stringify(inner.replace(/^\n+|\s+$/g, '')));
}
/*
 * Place les champs runtime dont la requête se sert : en colonnes de la CTE « base » quand elle existe
 * (chaque CTE les lit alors comme des colonnes ordinaires), sinon en expressions WITH.
 */
function withClause(ctx, sql) {
  const rts = Object.values(ctx.runtime).filter(r => r.sql);
  const bare = r => r.alias.replace(/`/g, '');
  const used = new Set();
  const visit = s => {
    for (const r of rts) {
      if (used.has(bare(r)) || !new RegExp('(^|[^A-Za-z0-9_.])' + escRe(bare(r)) + '($|[^A-Za-z0-9_])').test(s)) continue;
      used.add(bare(r));
      visit(r.sql);
    }
  };
  visit(sql);
  const defs = rts.filter(r => used.has(bare(r))).map(r => `${r.sql} AS ${r.alias}`);
  if (sql.includes(RUNTIME_COLUMNS)) return sql.replace(RUNTIME_COLUMNS, () => defs.map(d => `,\n            ${d}`).join(''));
  if (!defs.length) return sql;
  // Une seule clause WITH : les champs runtime d’abord, puis les CTE de la requête
  const list = defs.map(d => `    ${d}`).join(',\n');
  return sql.startsWith('WITH\n') ? `WITH\n${list},\n${sql.slice(5)}` : `WITH\n${list}\n${sql}`;
}
function sentence(h) {
  const parts = [];
  const where = h.filters.concat(h.text);
  let s = '';
  if (where.length) s += `garde les documents où ${where.join(', ')}`;
  if (h.excludes.length) s += where.length ? `, sauf ${h.excludes.join(', ')}` : `écarte ${h.excludes.join(', ')}`;
  if (s) parts.push(s);
  if (h.groups.length) parts.push(`${parts.length ? 'puis regroupe' : 'regroupe'} ${h.groups.join(', puis ')}${h.metrics.length ? `, avec ${h.metrics.join(', ')}` : ''}`);
  else if (h.metrics.length) parts.push(`${parts.length ? 'puis calcule' : 'calcule'} ${h.metrics.join(', ')}`);
  if (h.hits) parts.push(`${parts.length ? 'et ' : ''}${h.hits}`);
  let out = parts.join(', ').replace(/^puis /, '').replace(/^et /, '');
  if (!out) return h.period ? `Sur ${h.period}, renvoie tous les documents.` : 'Renvoie tous les documents.';
  if (h.period) out = `Sur ${h.period}, ${out}`;
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return out.replace(/\s+,/g, ',') + '.';
}
function translateDSL(input, cfg, opts) {
  // Première passe à blanc : elle relève les colonnes citées, que les alias de la seconde passe éviteront
  const columns = new Set();
  aliasGuard.columns = new Set(); aliasGuard.renamed = new Map();
  try {
    translateRequest(input, cfg, opts, columns);
    aliasGuard.columns = columns; aliasGuard.renamed = new Map();
    return translateRequest(input, cfg, opts, new Set());
  } finally {
    aliasGuard.columns = new Set(); aliasGuard.renamed = new Map();
  }
}
function translateRequest(input, cfg, opts, columns) {
  opts = opts || {};
  const ctx = makeDslCtx(cfg);
  ctx.columns = columns;
  let text = String(input || '').trim(); let index = opts.index || ''; let endpoint = '_search';
  if (!text) return { empty: true };
  const m = /^(GET|POST)\s+(\S+)[^\n]*\n?/i.exec(text);
  if (m) {
    const segs = m[2].replace(/^\//, '').split('/');
    if (segs[0] && !segs[0].startsWith('_')) { index = segs[0]; endpoint = segs[1] || '_search'; } else endpoint = segs[0] || '_search';
    text = text.slice(m[0].length).trim();
  }
  let dsl;
  try { dsl = text ? JSON.parse(preprocessDSL(text)) : {}; }
  catch (e) { return { error: `JSON invalide : ${e.message}` }; }
  if (!isObj(dsl)) return { error: 'La requête doit être un objet JSON.' };
  if (dsl.params && isObj(dsl.params.body)) { index = index || dsl.params.index || ''; dsl = dsl.params.body; }
  else if (isObj(dsl.body) && (dsl.index || Object.keys(dsl).length <= 3)) { index = index || dsl.index || ''; dsl = dsl.body; }
  const { table, matched } = resolveTable(ctx, index);
  ctx.table = table;
  const env = { table, baseWhere: [] };
  // Champs runtime
  const rtm = dsl.runtime_mappings || {};
  for (const name of Object.keys(rtm)) ctx.runtime[name] = { alias: chIdent(rawAlias(name)), type: rtm[name].type, sql: null };
  for (const [name, def] of Object.entries(rtm)) {
    const r = ctx.runtime[name];
    if (!def.script) { ctx.notes.add('info', `Champ runtime « ${name} » sans script`, 'Il masque simplement un champ existant : la colonne est lue directement.'); delete ctx.runtime[name]; continue; }
    const sc = def.script; const src = typeof sc === 'string' ? sc : sc.source;
    r.busy = true;
    try {
      const out = painlessToSQL(ctx, src, { mode: 'emit', params: (isObj(sc) && sc.params) || {}, rtType: def.type });
      r.sql = out.sql; r.tree = out.tree; r.name = name;
      // Le script lit une colonne du même nom que le champ : l’alias est distingué (hors chaînes, qui ne sont pas des colonnes)
      if (new RegExp('(^|[^A-Za-z0-9_])' + escRe(r.alias) + '($|[^A-Za-z0-9_])').test(out.sql.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) r.alias = chIdent(rawAlias(name + '_rt'));
      // Le champ runtime vaut NULL s’il lit une colonne Nullable, ou quand le script n’émet rien
      r.nullable = mayBeNull(ctx, r.sql) || /\bNULL\b/.test(r.sql.replace(/'(?:[^'\\]|\\.)*'/g, "''"));
      if (r.nullable) ctx.nullableCols.add(r.alias);
      ctx.stats.ok++; H(ctx, 'runtime', name);
    } catch (e) {
      r.sql = `NULL /* à traduire : ${e.message.replace(/\*\//g, '')} */`;
      ctx.stats.ko++; ctx.notes.add('err', `Champ runtime « ${name} » non traduit`, `Painless : ${e.message}.`, src);
    }
    r.busy = false;
  }
  // Requête
  let where = [];
  try { where = dsl.query ? conjunctsOf(ctx, dsl.query) : []; }
  catch (e) { return { error: `Requête non analysable : ${e.message}` }; }
  env.baseWhere = where;
  const statements = [];
  try {
    if (endpoint === '_count') {
      statements.push({ title: 'Comptage', sql: sqlSelect({ select: ['count() AS count'], from: table, where }) });
      ctx.human.hits = 'compte les documents';
    } else {
      if (dsl.aggs || dsl.aggregations) {
        ctx.aggMode = true;
        statements.push(...rootAggs(ctx, env, dsl.aggs || dsl.aggregations));
      }
      let hw = where;
      if (dsl.post_filter) { ctx.humanOff++; hw = where.concat(conjunctsOf(ctx, dsl.post_filter)); ctx.humanOff--; ctx.notes.add('info', 'post_filter', 'Appliqué uniquement à la liste des documents, pas aux agrégations, comme dans Elasticsearch.'); }
      const hq = hitsQuery(ctx, env, dsl, hw);
      if (hq) {
        statements.push({ title: 'Documents', sql: hq });
        if (dsl.size === undefined && (dsl.aggs || dsl.aggregations)) ctx.notes.add('info', 'size absent', 'Elasticsearch renvoie aussi 10 documents par défaut. Ajoutez "size": 0 pour ne garder que les agrégations.');
      }
      if (dsl.track_total_hits === true || (dsl.track_total_hits === undefined && hq && false)) statements.push({ title: 'Total (track_total_hits)', sql: sqlSelect({ select: ['count() AS total'], from: table, where: hw }) });
    }
  } catch (e) {
    // Paramètre invalide (taille, sens de tri…) ou construction hors de portée : mieux vaut refuser
    // la requête, comme Elasticsearch le fait d’un paramètre invalide, que renvoyer un SQL douteux
    return { error: `Traduction impossible : ${e.message}` };
  }
  if (!statements.length) statements.push({ title: 'Comptage', sql: sqlSelect({ select: ['count() AS count'], from: table, where }) });
  // Conseils
  if (ctx.dateFields.size) {
    const tf = [...ctx.dateFields][0];
    ctx.notes.add('opt', 'Filtre temporel et clé de tri', `Le filtre sur ${tf} n’élague les données que si la table est partitionnée par date et si ${tf} figure dans la clé de tri, après les colonnes de faible cardinalité les plus filtrées.`, `-- Exemple de schéma adapté\nPARTITION BY toYYYYMMDD(${tf})\nORDER BY (${[...ctx.groupCols][0] || 'service'}, ${tf})`);
  }
  for (const col of ctx.textCols) {
    const base = col.replace(/[`.]/g, '_');
    ctx.notes.add('opt', `Index de tokens sur ${col}`, 'hasTokenCaseInsensitive exploite un index tokenbf_v1 construit sur la version en minuscules de la colonne : les blocs sans le mot sont sautés sans être lus.', `ALTER TABLE ${table}\n    ADD INDEX idx_${base}_tokens lower(${col}) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1;\nALTER TABLE ${table} MATERIALIZE INDEX idx_${base}_tokens;`);
  }
  if (ctx.leadingWildcard) ctx.notes.add('opt', 'Joker en tête de motif', `Un motif qui commence par * impose de lire toute la colonne ${ctx.leadingWildcard}. Un index ngrambf_v1 permet d’éviter une partie des lectures.`, `ALTER TABLE ${table}\n    ADD INDEX idx_ngram ${ctx.leadingWildcard} TYPE ngrambf_v1(3, 65536, 3, 0) GRANULARITY 1;`);
  if (ctx.groupCols.size) ctx.notes.add('opt', 'LowCardinality pour les regroupements', `${[...ctx.groupCols].join(', ')} : si le nombre de valeurs distinctes reste sous ~10 000, le type LowCardinality(String) accélère nettement GROUP BY et réduit le stockage.`);
  if (statements.some(s => /\btop_\w+ AS \(\n/.test(s.sql))) ctx.notes.add('info', 'Top N imbriqués', 'Les terms imbriqués d’Elasticsearch (top N par parent) sont reproduits en deux temps : une CTE top_<nom> retient les N premiers groupes du parent, puis la requête principale s’y limite, avec des comptes exacts là où Elasticsearch les estime par shard. Le filtre commun est nommé une fois (CTE base). ClickHouse recopie une CTE à chaque emploi : la table est lue une fois par CTE top_ et une fois par la requête principale.');
  const sql = statements.map(s => `-- ${s.title}\n${withClause(ctx, s.sql)};`).join('\n\n');
  const statementsOut = statements.map(s => ({ title: s.title, sql: withClause(ctx, s.sql) }));
  // Champs runtime : conseil de matérialisation, avec un index quand le champ sert de filtre
  for (const r of Object.values(ctx.runtime)) {
    if (!r.tree) continue;
    const chType = { keyword: 'String', long: 'Int64', double: 'Float64', date: 'DateTime64(3)', boolean: 'Bool', ip: 'String' }[r.type] || 'String';
    const column = `ALTER TABLE ${table}\n    ADD COLUMN ${r.alias} ${r.nullable ? `Nullable(${chType})` : chType} MATERIALIZED ${r.sql};`;
    const bare = r.alias.replace(/`/g, '');
    const index = `ALTER TABLE ${table}\n    ADD INDEX idx_${bare} ${r.alias} TYPE bloom_filter GRANULARITY 4;\nALTER TABLE ${table} MATERIALIZE INDEX idx_${bare};`;
    if (r.filtered) ctx.notes.add('opt', `Matérialiser et indexer « ${r.name} »`, 'Ce champ runtime sert de filtre. Calculé à la volée, il oblige ClickHouse à lire chaque ligne : ni la clé de tri ni les index ne peuvent l’aider, ce qui pèse d’autant plus qu’il est comparé à une longue liste. Stocké comme colonne MATERIALIZED, il est calculé une fois à l’insertion ; un index de saut permet alors d’écarter des blocs entiers.', `${column}\n${index}`);
    else ctx.notes.add('opt', `Matérialiser « ${r.name} »`, 'Un champ runtime est recalculé à chaque requête. Stocké comme colonne MATERIALIZED, il est calculé une fois à l’insertion et peut être indexé.', column);
  }
  // Listes nommées : la table à créer et les lignes à y insérer accompagnent le SQL
  const lists = [...ctx.lists.values()].map(l => {
    const rows = l.values.map(v => `(${chStr(l.name)}, ${l.integers ? `'${v}'` : v})`);
    const create = `CREATE TABLE IF NOT EXISTS ${l.table}\n(\n    name LowCardinality(String),\n    value String\n)\nENGINE = ReplacingMergeTree\nORDER BY (name, value);`;
    const insert = shown => `INSERT INTO ${l.table} (name, value) VALUES\n    ${shown.join(',\n    ')};`;
    const preview = rows.length > 20 ? `${insert(rows.slice(0, 20)).slice(0, -1)},\n    -- … ${rows.length - 20} autres valeurs : liste complète dans le champ « lists » de l’API, ou dans le fichier .lists.sql écrit par la CLI` : insert(rows);
    ctx.notes.add('opt', `Liste nommée ${l.name} (${l.values.length} valeurs)`, `La liste est sortie du SQL et rangée dans ${l.table} sous le nom ${l.name}. Ce nom est l’empreinte de son contenu : la même liste dans une autre requête désigne la même ligne de table. Pour lui donner un nom lisible, déclarez clickhouse.lists.names: { ${l.fingerprint}: mon_nom }. Un IN sur sous-requête garde l’usage de la clé primaire d’un IN en clair.`, `${create}\n\n${preview}`);
    return { name: l.name, fingerprint: l.fingerprint, table: l.table, count: l.values.length, sql: `${create}\n\n${insert(rows)}` };
  });
  // Au-delà de max_query_size (256 Kio par défaut), ClickHouse refuse la requête
  const longest = statementsOut.reduce((n, s) => Math.max(n, s.sql.length), 0);
  if (longest > 262144) ctx.notes.add('warn', 'Requête trop longue pour ClickHouse', `Une requête fait ${Math.round(longest / 1024)} Kio. Au-delà de 256 Kio, ClickHouse la refuse par défaut (max_query_size). Si une longue liste de valeurs en est la cause, clickhouse.lists.threshold la sort du SQL pour une table nommée.`);
  if (!ctx.schema && ctx.schemaGaps.size) {
    const labels = { must_not: 'une exclusion (must_not, NOT)', exists: 'exists' };
    ctx.notes.add('warn', 'Schéma des colonnes non fourni', `La requête contient ${[...ctx.schemaGaps].map(g => labels[g]).join(' et ')}, dont le résultat dépend du type des colonnes. Sur une colonne Nullable, une exclusion écarte les lignes NULL qu’Elasticsearch garde ; sur une colonne non Nullable, exists est toujours vrai. Renseignez clickhouse.columns pour que la traduction en tienne compte.`);
  }
  for (const [name, alias] of aliasGuard.renamed) ctx.notes.add('warn', `Agrégation « ${name} » renommée ${alias}`, `${rawAlias(name)} est aussi une colonne citée par la requête : un alias du même nom la masquerait partout, y compris dans WHERE. La colonne de résultat s’appelle donc ${alias}.`);
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  ctx.notes.list.sort((a, b) => order[a.level] - order[b.level]);
  return { sql, statements: statementsOut, lists, notes: ctx.notes.list, stats: ctx.stats, table, index, matched, human: ctx.human, sentence: sentence(ctx.human) };
}

