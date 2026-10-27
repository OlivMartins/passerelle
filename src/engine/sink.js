/* Passerelle — moteur partie 6 : écriture dans ClickHouse (sortie elasticsearch → table de index_mapping) */

/*
 * Table d’un nom d’index : la correspondance la plus précise de clickhouse.index_mapping (la partie fixe la plus
 * longue du motif), null sans correspondance.
 */
function chTableOfIndex(cfg, index) {
  let best = null;
  for (const [pat, table] of Object.entries(cfg.clickhouse.index_mapping || {})) {
    if (pat !== index && !new RegExp(globToRe(pat)).test(index)) continue;
    const w = pat.replace(/\*/g, '').length;
    if (!best || w > best.w) best = { table: String(table), pattern: pat, w };
  }
  return best;
}
// « base.table » ou « table » (base de la configuration)
function chSplitTable(cfg, table) {
  const t = String(table); const k = t.indexOf('.');
  return k > 0 ? { database: t.slice(0, k), table: t.slice(k + 1) } : { database: cfg.clickhouse.database || 'default', table: t };
}

/*
 * Mise en forme d’un événement pour une table : l’événement est aplati (a.b.c), field_mapping renomme les champs,
 * chaque champ va dans sa colonne, ou dans la colonne d’attributs (Map ou JSON) dont le motif de
 * clickhouse.attributes lui correspond le mieux, comme le fait la traduction des requêtes. Les colonnes numériques
 * déclarées reçoivent un nombre, les Map de chaînes du texte.
 *   ind : indentation des lignes rendues
 */
function chShapeLines(cfg, table, ind) {
  const tc = tableConfig(cfg, table); const ch = tc.clickhouse;
  const pad = '  '.repeat(ind || 0); const L = [];
  const emit = l => L.push(pad + l);
  const fm = isObj(ch.field_mapping) ? ch.field_mapping : {};
  const cols = isObj(ch.columns) ? ch.columns : {};
  const colType = name => { const raw = cols[`${table}.${name}`] !== undefined ? cols[`${table}.${name}`] : cols[name]; return raw ? parseColumnType(raw) : null; };
  const attrs = isObj(ch.attributes) ? Object.entries(ch.attributes) : [];
  // Colonnes d’attributs et leur forme : Map de chaînes (ou de nombres), JSON
  const attrCols = attrs.map(([c]) => c);
  const store = c => { const t = colType(c); return t && t.kind === 'json' ? 'json' : t && t.kind === 'map' ? (t.value && (t.value.kind === 'int' || t.value.kind === 'float') ? t.value.kind : 'map') : 'map'; };
  emit('flat = flatten(object!(.))');
  emit('row = {}');
  attrCols.forEach(c => emit(`row.${segName(c)} = {}`));
  // Valeur écrite dans une Map de chaînes : le texte, ou le JSON d’une liste ou d’un objet
  const text = x => `if is_string(${x}) { string!(${x}) } else if is_array(${x}) || is_object(${x}) { encode_json(${x}) } else { to_string(${x}) ?? "" }`;
  const putAttr = (c, keyExpr, x) => {
    const s = store(c);
    if (s === 'json') return `row.${segName(c)} = set!(row.${segName(c)}, [${keyExpr}], ${x})`;
    if (s === 'int' || s === 'float') return `n = ${s === 'int' ? 'to_int' : 'to_float'}(${x}) ?? null; if n != null { row.${segName(c)} = set!(row.${segName(c)}, [${keyExpr}], n) }`;
    return `tv = ${text(x)}; row.${segName(c)} = set!(row.${segName(c)}, [${keyExpr}], tv)`;
  };
  // Colonne déclarée : un nombre attendu reçoit un nombre (une chaîne numérique est convertie)
  const putCol = (name, x) => {
    const t = colType(name);
    if (t && !t.array && (t.kind === 'int' || t.kind === 'float')) return `n = if is_string(${x}) { ${t.kind === 'int' ? 'to_int' : 'to_float'}(string!(${x})) ?? ${x} } else { ${x} }; row = set!(row, [${vq(name)}], n)`;
    if (t && !t.array && t.kind === 'bool') return `n = if is_string(${x}) { downcase(string!(${x})) == "true" } else { ${x} }; row = set!(row, [${vq(name)}], n)`;
    if (t && !t.array && t.kind === 'string') return `n = if is_string(${x}) || ${x} == null { ${x} } else if is_array(${x}) || is_object(${x}) { encode_json(${x}) } else { to_string(${x}) ?? "" }; row = set!(row, [${vq(name)}], n)`;
    return `row = set!(row, [${vq(name)}], ${x})`;
  };
  // Renommages explicites (field_mapping) : colonne, ou « Colonne['clé'] » d’attributs
  for (const [from, to] of Object.entries(fm)) {
    if (!to) continue;
    const ref = ATTR_REF.exec(String(to));
    emit(`if exists(flat.${segName(from)}) {`);
    emit(`  x = del(flat.${segName(from)})`);
    emit(`  ${ref ? putAttr(ref[1], vq((ref[2] !== undefined ? ref[2] : ref[3]).replace(/\\(.)/g, '$1')), 'x') : putCol(String(to), 'x')}`);
    emit('}');
  }
  // Puis chaque champ restant : sa colonne si le schéma la déclare, sinon le motif d’attributs le plus précis
  const patterns = [];
  for (const [c, ps] of attrs) for (const p of [].concat(ps || []).map(String)) patterns.push({ c, p, w: p === '*' ? -1 : p.replace(/\*/g, '').length });
  patterns.sort((a, b) => b.w - a.w);
  // Colonnes du schéma (clé « table.colonne » ou « colonne »), hors colonnes d’attributs, groupées par conversion
  const declared = [...new Set(Object.keys(cols).map(k => (k.startsWith(`${table}.`) ? k.slice(table.length + 1) : k)))].filter(k => !attrCols.includes(k) && !attrCols.some(c => k === `${c}Keys`)).sort();
  const groups = { int: [], float: [], bool: [], string: [], other: [] };
  for (const c of declared) { const t = colType(c); groups[t && !t.array && groups[t.kind] ? t.kind : 'other'].push(c); }
  const conv = {
    int: x => `if is_string(${x}) { to_int(string!(${x})) ?? ${x} } else { ${x} }`,
    float: x => `if is_string(${x}) { to_float(string!(${x})) ?? ${x} } else { ${x} }`,
    bool: x => `if is_string(${x}) { downcase(string!(${x})) == "true" } else { ${x} }`,
    string: x => `if is_string(${x}) { ${x} } else if is_array(${x}) || is_object(${x}) { encode_json(${x}) } else { to_string(${x}) ?? "" }`
  };
  const list = a => `[${a.map(vq).join(', ')}]`;
  const branches = [];
  for (const kind of ['string', 'int', 'float', 'bool']) if (groups[kind].length) branches.push([`includes(${list(groups[kind])}, k)`, `n = ${conv[kind]('val')}; row = set!(row, [k], n)`]);
  if (groups.other.length) branches.push([`includes(${list(groups.other)}, k)`, 'row = set!(row, [k], val)']);
  // Motifs d’attributs, du plus précis au plus large ; des motifs voisins de la même colonne n’en font qu’un
  let otherwise = 'row = set!(row, [k], val)';
  const merged = [];
  for (const pt of patterns) {
    const rel = pt.p === `${pt.c}.*`;
    const last = merged[merged.length - 1];
    if (pt.p !== '*' && last && last.c === pt.c && !last.rel && !rel) last.res.push(globToRe(pt.p).slice(1, -1));
    else merged.push({ c: pt.c, rel, star: pt.p === '*', res: [globToRe(pt.p).slice(1, -1)] });
  }
  for (const m of merged) {
    const act = putAttr(m.c, m.rel ? `slice!(k, ${m.c.length + 1})` : 'k', 'val');
    if (m.star) { otherwise = act; break; }
    branches.push([`match(k, ${vraw(`^(?:${m.res.join('|')})$`, 'r')})`, act]);
  }
  emit('for_each(flat) -> |k, val| {');
  emit('  if val != null {');
  branches.forEach(([c, a], i) => { emit(`    ${i ? '} else if' : 'if'} ${c} {`); emit(`      ${a}`); });
  if (branches.length) { emit('    } else {'); emit(`      ${otherwise}`); emit('    }'); } else emit(`    ${otherwise}`);
  emit('  }');
  emit('}');
  // Liste des clés d’une colonne JSON (…Keys), comme l’exportateur OpenTelemetry
  attrCols.filter(c => store(c) === 'json' && colType(`${c}Keys`)).forEach(c => emit(`row.${segName(`${c}Keys`)} = keys(object!(row.${segName(c)}))`));
  emit('. = row');
  return { lines: L, profile: tc };
}

/*
 * Sortie ClickHouse d’une sortie elasticsearch de Logstash, ou d’un pipeline d’ingestion. index : nom d’index
 * fixe, ou { expr } calculé dans l’événement. Rend le programme de mise en forme et le sink.
 */
function clickhouseOutput(v, cfg, index, label) {
  const ch = cfg.clickhouse;
  const notes = [];
  let lines = []; let tables = [];
  if (typeof index === 'string') {
    const hit = chTableOfIndex(cfg, index);
    const table = hit ? hit.table : (ch.default_table || `${ch.database}.events`);
    if (!hit) notes.push(['warn', `Index « ${index} » sans table`, `Aucun motif de clickhouse.index_mapping ne correspond : la sortie écrit dans ${table}, la table par défaut.`]);
    tables = [table];
    lines = chShapeLines(cfg, table, 0).lines;
  } else {
    // Index calculé : la table est choisie pour chaque événement, motif le plus précis d’abord
    const maps = Object.entries(ch.index_mapping || {}).map(([p, t]) => ({ p, t: String(t), w: p.replace(/\*/g, '').length })).sort((a, b) => b.w - a.w);
    const dflt = ch.default_table || `${ch.database}.events`;
    tables = [...new Set(maps.map(m => m.t).concat(dflt))];
    lines.push(...index.pre, `idx = ${index.expr}`);
    lines.push(`tbl = ${vq(dflt)}`);
    maps.forEach((m, i) => lines.push(`${i ? '} else if' : 'if'} match(idx, ${vraw(globToRe(m.p), 'r')}) {`, `  tbl = ${vq(m.t)}`));
    if (maps.length) lines.push('}');
    const shapes = tables.map(t => ({ t, l: chShapeLines(cfg, t, 1).lines }));
    // Tables de même profil : une seule mise en forme
    const groups = new Map();
    for (const s of shapes) { const key = s.l.join('\n'); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s.t); }
    const gs = [...groups.entries()];
    if (gs.length === 1) lines.push(...gs[0][0].split('\n').map(l => l.slice(2)));
    else { gs.forEach(([body, ts], i) => { lines.push(`${i ? '} else if' : 'if'} includes([${ts.map(vq).join(', ')}], tbl) {`, ...body.split('\n')); }); lines.push('}'); }
    lines.push('parts = split(tbl, ".", limit: 2)');
    lines.push(`%clickhouse.database = if length(parts) == 2 { parts[0] } else { ${vq(ch.database || 'default')} }`);
    lines.push('%clickhouse.table = if length(parts) == 2 { parts[1] } else { parts[0] }');
    notes.push(['info', `${label} → table selon l’index`, `L’index est calculé pour chaque événement et confronté aux motifs de clickhouse.index_mapping (${tables.join(', ')}) ; sans correspondance, ${dflt}.`]);
  }
  const user = String(ch.user || ''); const password = String(ch.password || '');
  [user, password].forEach(x => { const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(x); if (m) v.env.add(m[1]); });
  const fixed = tables.length === 1 ? chSplitTable(cfg, tables[0]) : null;
  const sink = {
    type: 'clickhouse', inputs: [], endpoint: ch.endpoint,
    database: fixed ? fixed.database : '{{ %clickhouse.database }}',
    table: fixed ? fixed.table : '{{ %clickhouse.table }}',
    skip_unknown_fields: true, date_time_best_effort: true, compression: 'gzip'
  };
  if (user || password) sink.auth = { strategy: 'basic', user, password };
  if (cfg.vector.acknowledgements) sink.acknowledgements = { enabled: true };
  if (!fixed) sink.dangerously_allow_unconfined_template_resolution = true;
  notes.push(['info', 'Sortie ClickHouse', `Les événements sont écrits en JSONEachRow dans ${tables.join(', ')} : champs inconnus de la table ignorés (skip_unknown_fields), dates lues au mieux (date_time_best_effort).`]);
  return { shape: lines.join('\n') + '\n', sink, tables, notes };
}
