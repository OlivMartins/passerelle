/* Passerelle — moteur : KQL, le langage de requête de Kibana, vers le DSL d’Elasticsearch */
/*
 * Kibana traduit lui-même KQL en DSL avant d’interroger Elasticsearch (kbn-es-query). La traduction ci-dessous suit
 * sa grammaire (grammar.peggy) et ses règles de conversion (functions/is.ts, range.ts, exists.ts), puis le DSL obtenu
 * passe par translateDSL comme n’importe quelle requête : un seul moteur de traduction vers SQL.
 *
 * Particularités reproduites, parce qu’elles changent le résultat :
 *   - une valeur sans guillemets peut contenir des espaces (message: connexion refusée) : c’est un match, pas une phrase ;
 *     entre guillemets, c’est un match_phrase ;
 *   - « or », « and » et « not » sont des mots-clés entourés d’espaces, quelle que soit leur casse ; ailleurs ce sont
 *     des lettres ordinaires (« cannot » se lit « can » suivi d’un « not » mal placé, que Kibana refuse aussi) ;
 *   - champ: * vaut exists, *:* tous les documents, et une valeur à joker devient wildcard sur un keyword,
 *     query_string sinon ;
 *   - sur un champ date, champ: valeur devient une plage [valeur, valeur] (le jour entier pour une date sans heure) ;
 *   - sans champ, la valeur est cherchée par multi_match, dans les champs par défaut.
 */
const KQL_WILD = '\u0000*\u0000';
const KQL_MAX_DEPTH = 64;
const KQL_SPECIAL = '\\():<>"*{}';
function kqlParse(input) {
  const s = String(input === undefined || input === null ? '' : input);
  let i = 0; let depth = 0;
  const sp = c => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ' ';
  const fail = msg => { throw new Error(`KQL : ${msg} (position ${i + 1})`); };
  const spaces = () => { const st = i; while (i < s.length && sp(s[i])) i++; return i > st; };
  const word = (w, j) => s.slice(j, j + w.length).toLowerCase() === w;
  // Mot-clé à la position j : « espace or espace », « espace and espace », « not espace »
  const keywordAt = j => (sp(s[j]) && ((word('or', j + 1) && sp(s[j + 3])) || (word('and', j + 1) && sp(s[j + 4])))) || (word('not', j) && sp(s[j + 3]));
  const nested = fn => { if (++depth > KQL_MAX_DEPTH) fail(`requête imbriquée sur plus de ${KQL_MAX_DEPTH} niveaux`); try { return fn(); } finally { depth--; } };
  // Or = Space+ 'or' Space+ ; And = Space+ 'and' Space+
  const op = w => { const st = i; if (!spaces()) return false; if (word(w, i) && sp(s[i + w.length])) { i += w.length; spaces(); return true; } i = st; return false; };
  const not = () => { if (word('not', i) && sp(s[i + 3])) { i += 3; spaces(); return true; } return false; };
  const hex = j => /^[0-9a-fA-F]{4}$/.test(s.slice(j, j + 4));
  function quoted() {
    i++; let v = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') {
        const n = s[i + 1];
        if (n === 't' || n === 'r' || n === 'n') { v += { t: '\t', r: '\r', n: '\n' }[n]; i += 2; continue; }
        if (n === 'u' && hex(i + 2)) { v += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (n === '\\' || n === '"') { v += n; i += 2; continue; }
      }
      v += s[i++];
    }
    if (i >= s.length) fail('guillemet non fermé');
    i++;
    return { value: v, quoted: true };
  }
  function unquoted() {
    const chars = []; const st = i; let wild = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 't' || n === 'r' || n === 'n') { chars.push({ t: '\t', r: '\r', n: '\n' }[n]); i += 2; continue; }
        if (n !== undefined && KQL_SPECIAL.includes(n)) { chars.push(n); i += 2; continue; }
        if (n === 'u' && hex(i + 2)) { chars.push(String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16))); i += 6; continue; }
        const kw = /^(or|and|not)/i.exec(s.slice(i + 1));
        if (kw) { chars.push(kw[0]); i += 1 + kw[0].length; continue; }
        break;
      }
      if (c === '*') { chars.push(KQL_WILD); wild = true; i++; continue; }
      if (KQL_SPECIAL.includes(c) || keywordAt(i)) break;
      chars.push(c); i++;
    }
    if (i === st) return null;
    const seq = chars.join('').trim();
    if (!wild) {
      if (seq === 'null') return { value: null };
      if (seq === 'true') return { value: true };
      if (seq === 'false') return { value: false };
    }
    return { value: seq, wildcard: wild };
  }
  const literal = () => (s[i] === '"' ? quoted() : unquoted());
  function orQuery() {
    const items = [andQuery()];
    while (op('or')) items.push(andQuery());
    return items.length === 1 ? items[0] : { type: 'or', args: items };
  }
  function andQuery() {
    const items = [notQuery()];
    while (op('and')) items.push(notQuery());
    return items.length === 1 ? items[0] : { type: 'and', args: items };
  }
  function notQuery() { return not() ? { type: 'not', arg: nested(subQuery) } : subQuery(); }
  function subQuery() {
    if (s[i] === '(') {
      i++; spaces();
      const q = nested(orQuery); spaces();
      if (s[i] !== ')') fail('« ) » attendue');
      i++; return q;
    }
    return nestedQuery();
  }
  function nestedQuery() {
    const st = i;
    const f = literal();
    if (f) {
      spaces();
      if (s[i] === ':') {
        i++; spaces();
        if (s[i] === '{') {
          i++; spaces();
          const q = nested(orQuery); spaces();
          if (s[i] !== '}') fail('« } » attendue');
          i++; return { type: 'nested', path: f.value, query: q };
        }
      }
    }
    i = st;
    return expression();
  }
  function expression() {
    const st = i;
    const f = literal();
    if (f) {
      spaces();
      const m = /^(<=|>=|<|>)/.exec(s.slice(i));
      if (m) {
        i += m[1].length; spaces();
        const v = literal();
        if (!v) fail('valeur attendue après l’opérateur de comparaison');
        return { type: 'range', field: f, op: { '<=': 'lte', '>=': 'gte', '<': 'lt', '>': 'gt' }[m[1]], value: v };
      }
      if (s[i] === ':') { i++; spaces(); const partial = listOfValues(); return partial(f); }
    }
    i = st;
    const v = literal();
    if (!v) fail(s[i] === undefined ? 'requête incomplète' : `caractère inattendu « ${s[i]} »`);
    return { type: 'is', field: null, value: v };
  }
  // Valeurs d’un champ : une valeur, ou une liste entre parenthèses reliée par or, and, not
  function listOfValues() {
    if (s[i] === '(') {
      i++; spaces();
      const p = nested(orList); spaces();
      if (s[i] !== ')') fail('« ) » attendue');
      i++; return p;
    }
    const v = literal();
    if (!v) fail('valeur attendue');
    return f => ({ type: 'is', field: f, value: v });
  }
  function orList() {
    const items = [andList()];
    while (op('or')) items.push(andList());
    return items.length === 1 ? items[0] : f => ({ type: 'or', args: items.map(p => p(f)) });
  }
  function andList() {
    const items = [notList()];
    while (op('and')) items.push(notList());
    return items.length === 1 ? items[0] : f => ({ type: 'and', args: items.map(p => p(f)) });
  }
  function notList() { if (not()) { const p = nested(listOfValues); return f => ({ type: 'not', arg: p(f) }); } return listOfValues(); }

  spaces();
  if (i >= s.length) return { type: 'all' };
  const q = orQuery();
  spaces();
  if (i < s.length) fail(`fin de requête attendue, trouvé « ${s.slice(i, i + 12)} »`);
  return q;
}
// Valeur à joker écrite pour query_string : les caractères réservés sont échappés, le joker reste *
function kqlQueryString(value) {
  return String(value).split(KQL_WILD).map(x => x.replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, '\\$&')).join('*');
}
const kqlLoneWildcard = v => !!v && v.wildcard && String(v.value).replace(KQL_WILD, '').length === 0;
/*
 * Arbre KQL → DSL. opts.fieldType(nom) renvoie 'keyword', 'text', 'date', 'number', 'boolean', 'ip' ou null (inconnu,
 * Kibana interroge alors le champ tel quel par match). opts.fields : noms connus, pour les champs à motif.
 * opts.issues reçoit ce qui ne se traduit pas fidèlement ({ kind: 'todo' | 'review', label, detail }).
 */
function kqlToDSL(node, opts) {
  opts = opts || {};
  const issues = opts.issues || [];
  const typeOf = name => (opts.fieldType ? opts.fieldType(name) : null);
  const tz = opts.timeZone ? { time_zone: opts.timeZone } : {};
  const fieldsOf = (lit, prefix) => {
    const name = prefix ? `${prefix}.${lit.value}` : String(lit.value);
    if (!lit.wildcard) return [name];
    const re = new RegExp(`^${name.split(KQL_WILD).map(escRe).join('.*')}$`);
    const known = (opts.fields || []).filter(f => re.test(f));
    if (known.length) return known;
    issues.push({ kind: 'todo', label: `champ à motif « ${name.split(KQL_WILD).join('*')} »`, detail: 'Kibana remplace un nom de champ à motif par les champs de la vue de données qui y correspondent. La liste des champs n’est pas dans l’export : écrivez les champs voulus.' });
    return [];
  };
  const either = qs => (qs.length === 1 ? qs[0] : { bool: { should: qs, minimum_should_match: 1 } });
  function walk(n, prefix) {
    switch (n.type) {
      case 'all': return { match_all: {} };
      case 'and': return { bool: { filter: n.args.map(a => walk(a, prefix)) } };
      case 'or': return { bool: { should: n.args.map(a => walk(a, prefix)), minimum_should_match: 1 } };
      case 'not': return { bool: { must_not: walk(n.arg, prefix) } };
      case 'nested': {
        const path = prefix ? `${prefix}.${n.path}` : n.path;
        return { nested: { path, query: walk(n.query, path), score_mode: 'none' } };
      }
      case 'range': {
        const fields = fieldsOf(n.field, prefix);
        if (!fields.length) return { match_none: {} };
        return either(fields.map(f => {
          const t = typeOf(f); let v = n.value.value;
          // Kibana envoie la valeur en chaîne ; un champ numérique la lit comme un nombre
          if (typeof v === 'string' && t !== 'keyword' && t !== 'text' && t !== 'date' && t !== 'ip' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
          return { range: { [f]: Object.assign({ [n.op]: v }, t === 'date' ? tz : {}) } };
        }));
      }
      case 'is': {
        const v = n.value;
        if (n.field && kqlLoneWildcard(n.field) && kqlLoneWildcard(v)) return { match_all: {} };
        if (n.field === null || (n.field.value === null && !n.field.quoted)) {
          if (v.wildcard) return { query_string: { query: kqlQueryString(v.value) } };
          issues.push({ kind: 'review', label: 'recherche sans nom de champ', detail: 'Kibana cherche une valeur sans champ dans tous les champs (index.query.default_field, * par défaut) ; la traduction la cherche dans les champs texte de la configuration (text_fields).' });
          return { multi_match: { type: v.quoted ? 'phrase' : 'best_fields', query: v.value, lenient: true } };
        }
        const fields = fieldsOf(n.field, prefix);
        if (!fields.length) return { match_none: {} };
        return either(fields.map(f => {
          const t = typeOf(f);
          if (kqlLoneWildcard(v)) return { exists: { field: f } };
          if (v.wildcard) return t === 'keyword' ? { wildcard: { [f]: { value: kqlQueryString(v.value) } } } : { query_string: { fields: [f], query: kqlQueryString(v.value) } };
          if (t === 'date') return { range: { [f]: Object.assign({ gte: v.value, lte: v.value }, tz) } };
          if (t === 'keyword') return { term: { [f]: { value: v.value } } };
          return { [v.quoted ? 'match_phrase' : 'match']: { [f]: v.value } };
        }));
      }
    }
    throw new Error(`KQL : nœud ${n.type} inconnu`);
  }
  return walk(node, opts.nestedPath || '');
}
function kqlTranslate(query, opts) {
  return kqlToDSL(kqlParse(query), opts);
}
