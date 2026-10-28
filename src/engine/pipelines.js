/* Passerelle — moteur partie 4 : ensembles de pipelines Logstash (pipelines.yml, pipeline { send_to }) */

/*
 * Lecture de pipelines.yml : une liste de réglages par pipeline (pipeline.id, path.config ou config.string,
 * pipeline.workers…). Le sous-ensemble de YAML qu’on y trouve est pris en charge : liste de tables, tables
 * imbriquées (aplaties en clés pointées, comme le fait Logstash), chaînes entre guillemets, blocs | et >,
 * listes [a, b], commentaires.
 */
function parsePipelinesYML(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  const lines = [];
  // Commentaire : un # précédé d’un blanc (ou en début de ligne) et hors guillemets
  const stripComment = l => {
    let q = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === q && (q === "'" ? l[i + 1] !== "'" : l[i - 1] !== '\\')) q = null; else if (q === "'" && c === "'") i++; }
      else if (c === '"' || c === "'") { if (i === 0 || /[\s:\-\[,{]/.test(l[i - 1])) q = c; }
      else if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i).replace(/\s+$/, '');
    }
    return l.replace(/\s+$/, '');
  };
  raw.forEach((l, i) => lines.push({ n: i + 1, text: l, clean: stripComment(l) }));
  let i = 0;
  const indentOf = l => l.length - l.replace(/^ +/, '').length;
  const fail = (n, msg) => { throw new Error(`pipelines.yml, ligne ${n} : ${msg}`); };
  function scalar(v, n) {
    v = v.trim();
    if (v === '' || v === '~' || v === 'null') return null;
    if (v[0] === '"') {
      if (!/"$/.test(v) || v.length < 2) fail(n, 'chaîne entre guillemets non terminée');
      return v.slice(1, -1).replace(/\\(["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m, e) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[e] || String.fromCharCode(parseInt(e.slice(1), 16)));
    }
    if (v[0] === "'") { if (!/'$/.test(v) || v.length < 2) fail(n, 'chaîne entre apostrophes non terminée'); return v.slice(1, -1).replace(/''/g, "'"); }
    if (v[0] === '[') {
      if (!/\]$/.test(v)) fail(n, 'liste [ … ] non terminée');
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      const items = []; let cur = ''; let q = null;
      for (const c of inner) {
        if (q) { cur += c; if (c === q) q = null; }
        else if (c === '"' || c === "'") { q = c; cur += c; }
        else if (c === ',') { items.push(scalar(cur, n)); cur = ''; }
        else cur += c;
      }
      items.push(scalar(cur, n));
      return items;
    }
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    return v;
  }
  // Bloc | ou > : les lignes plus indentées que la clé, au retrait de la première près
  function block(style, keyIndent) {
    const body = [];
    let base = null;
    while (i < lines.length) {
      const l = lines[i].text;
      if (l.trim() === '') { body.push(''); i++; continue; }
      const ind = indentOf(l);
      if (ind <= keyIndent) break;
      if (base === null) base = ind;
      body.push(l.slice(Math.min(base, ind)));
      i++;
    }
    const chomp = style.includes('-') ? 'strip' : style.includes('+') ? 'keep' : 'clip';
    let out;
    if (style[0] === '>') {
      out = '';
      body.forEach((l, k) => { if (l === '') out += '\n'; else out += (k && body[k - 1] !== '' && !/^\s/.test(l) ? ' ' : '') + l; });
    } else out = body.join('\n');
    if (chomp === 'strip') out = out.replace(/\n+$/, '');
    else if (chomp === 'clip') out = out.replace(/\n+$/, '') + '\n';
    else out += '\n';
    return out;
  }
  // Table dont les clés sont à l’indentation donnée
  function mapping(indent, first) {
    const out = {};
    const entry = (rest, n, keyIndent) => {
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)\s*:(?:\s+(.*)|$)/.exec(rest);
      if (!m) fail(n, `« clé: valeur » attendu, trouvé « ${rest.trim()} »`);
      const key = m[1][0] === '"' || m[1][0] === "'" ? scalar(m[1], n) : m[1].trim();
      const val = (m[2] || '').trim();
      if (/^[|>][+-]?\d*$/.test(val)) out[key] = block(val, keyIndent);
      else if (val === '') {
        // Valeur sur les lignes suivantes : table imbriquée (plus indentée), sinon nulle
        let j = i; while (j < lines.length && lines[j].clean.trim() === '') j++;
        if (j < lines.length && indentOf(lines[j].clean) > keyIndent && !/^\s*-\s/.test(lines[j].clean)) { i = j; out[key] = mapping(indentOf(lines[j].clean)); }
        else out[key] = null;
      } else out[key] = scalar(val, n);
    };
    if (first) entry(first.rest, first.n, indent);
    while (i < lines.length) {
      const { clean, n } = lines[i];
      if (clean.trim() === '') { i++; continue; }
      const ind = indentOf(clean);
      if (ind < indent || (ind === indent && /^\s*-(\s|$)/.test(clean))) break;
      if (ind > indent) fail(n, 'indentation inattendue');
      i++;
      entry(clean.slice(ind), n, ind);
    }
    return out;
  }
  const entries = [];
  while (i < lines.length) {
    const { clean, n } = lines[i];
    if (clean.trim() === '' || /^---\s*$/.test(clean)) { i++; continue; }
    const m = /^(\s*)-(?:\s+(.*))?$/.exec(clean);
    if (!m) fail(n, 'pipelines.yml est une liste : chaque pipeline commence par « - pipeline.id: … »');
    const ind = m[1].length; const rest = m[2] || '';
    i++;
    const item = rest.trim() ? mapping(ind + 2, { rest, n }) : (() => {
      let j = i; while (j < lines.length && lines[j].clean.trim() === '') j++;
      if (j >= lines.length) return {};
      i = j; return mapping(indentOf(lines[j].clean));
    })();
    // Tables imbriquées → clés pointées (pipeline: { id: x } vaut pipeline.id: x)
    const flat = {};
    (function walk(o, pre) {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pre + k + '.');
        else flat[pre + k] = v;
      }
    })(item, '');
    entries.push({ line: n, settings: flat });
  }
  return entries;
}

/*
 * Motif de path.config (glob de Ruby : *, **, ?, [abc], {a,b}) → expression régulière sur un chemin relatif.
 */
function globRegex(pattern) {
  let out = ''; const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') { const j = p.indexOf(']', i + 1); if (j < 0) out += '\\['; else { out += '[' + p.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } }
    else if (c === '{') { const j = p.indexOf('}', i + 1); if (j < 0) out += '\\{'; else { out += '(?:' + p.slice(i + 1, j).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|') + ')'; i = j; } }
    else out += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/*
 * Fichiers d’un path.config parmi les chemins disponibles (relatifs au dossier de pipelines.yml). Un chemin absolu
 * de la machine Logstash (/etc/logstash/conf.d/*.conf) est cherché par ses fins successives : conf.d/*.conf,
 * puis *.conf. Un dossier vaut tous ses fichiers. Comme Logstash, les fichiers sont lus dans l’ordre alphabétique,
 * et ceux qui finissent par ~ (sauvegardes d’éditeur) sont écartés.
 */
function pipelineConfigFiles(pathConfig, available) {
  const norm = String(pathConfig).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const files = available.map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter(f => !/~$/.test(f));
  const tries = [];
  const segs = norm.replace(/^\/+/, '').split('/').filter(Boolean);
  const absolute = norm.startsWith('/') || /^[A-Za-z]:\//.test(norm);
  for (let k = 0; k < segs.length; k++) {
    if (!absolute && k > 0) break;
    tries.push(segs.slice(k).join('/'));
  }
  for (const t of tries) {
    const re = globRegex(t);
    let hit = files.filter(f => re.test(f));
    // Un dossier : ses fichiers, sans descendre dans les sous-dossiers
    if (!hit.length && !/[*?[{]/.test(t)) { const dir = t.replace(/\/+$/, '') + '/'; hit = files.filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/')); }
    if (hit.length) return { files: hit.sort(), matched: t, absolute };
  }
  return { files: [], matched: null, absolute };
}

/*
 * Ensemble de pipelines → une configuration Vector. Chaque pipeline est traduit seul, ses composants préfixés
 * par son identifiant ; une sortie pipeline { send_to => [x] } devient l’entrée des composants qui suivaient
 * l’entrée pipeline { address => x } du destinataire. Aucun composant Vector ne remplace la liaison : Vector
 * relie directement les étapes, ce qui garde l’ordre et la contre-pression.
 *   list : [{ id, config, settings, origin }]
 */
const PIPELINE_SETTINGS_IGNORED = ['pipeline.workers', 'pipeline.batch.size', 'pipeline.batch.delay', 'pipeline.ordered', 'pipeline.unsafe_shutdown', 'pipeline.plugin_classloaders', 'pipeline.separate_logs', 'config.reload.automatic', 'config.reload.interval', 'config.support_escapes', 'config.debug', 'pipeline.system', 'pipeline.buffer.type'];
function translatePipelines(list, cfg) {
  const notes = makeNotes();
  const env = new Set();
  const all = { sources: {}, transforms: {}, sinks: {}, enrich: {} };
  const graph = { nodes: [], edges: [] };
  const stats = { ok: 0, approx: 0, ko: 0 };
  const prefixes = new Set();
  const listeners = new Map(); // adresse → [{ pipeline, name }]
  const producers = new Map(); // adresse → [{ pipeline, refs }]
  const placeholders = new Map(); // composant → adresse
  const pipelines = [];
  const ids = new Set();
  const commonTitles = new Map();
  // Sorties Kafka de tout l’ensemble : kafka.output_topic (configuration) ne vaut que pour une sortie unique
  // de même, kafka.input_topics et consumer_group ne visent qu’une source Kafka unique
  let kafkaOutputs = 0; let kafkaInputs = 0;
  for (const p of list) {
    try {
      if (!p.config) continue;
      const ast = parseLogstash(p.config);
      kafkaOutputs += flatOutputs(ast.output, [], []).filter(o => o.plugin.name === 'kafka').length;
      kafkaInputs += ast.input.filter(st => st.k === 'plugin' && st.name === 'kafka').length;
    } catch (e) { /* signalé à la traduction */ }
  }
  const k = cfg.kafka || {};
  if (kafkaInputs > 1 && ((k.input_topics || []).length || k.consumer_group)) notes.add('warn', 'kafka.input_topics, kafka.consumer_group', `${kafkaInputs} entrées Kafka dans l’ensemble : ces réglages de la configuration ne visent qu’une entrée unique, chaque entrée garde ses topics et son groupe.`);
  if (kafkaOutputs > 1 && k.output_topic) notes.add('warn', 'kafka.output_topic', `${kafkaOutputs} sorties Kafka dans l’ensemble : ce réglage de la configuration ne vise qu’une sortie unique, chaque sortie garde son topic.`);
  for (const p of list) {
    const id = String(p.id || '');
    const info = { id, origin: p.origin || '', addresses: [], sendTo: [], sources: [], sinks: [] };
    pipelines.push(info);
    if (!id) { info.error = 'pipeline.id absent'; notes.add('err', 'Pipeline sans pipeline.id', `${p.origin || 'Une entrée de pipelines.yml'} n’a pas d’identifiant : Logstash refuse de démarrer.`); continue; }
    if (ids.has(id)) { info.error = 'identifiant en double'; notes.add('err', `Pipeline « ${id} » déclaré deux fois`, 'Logstash refuse deux pipelines du même identifiant : seul le premier est traduit.'); continue; }
    ids.add(id);
    if (p.error) { info.error = p.error; notes.add('err', `[${id}] Configuration introuvable`, p.error); continue; }
    const st = p.settings || {};
    const ecs = st['pipeline.ecs_compatibility'];
    const cfgP = ecs === undefined ? cfg : mergeConfig(cfg, { vector: { ecs_compatibility: String(ecs) } });
    const r = translateLogstash(p.config, cfgP, { pipelineIO: true, singleKafka: kafkaOutputs === 1, singleKafkaInput: kafkaInputs <= 1 });
    if (r.error || r.empty) {
      info.error = r.error || 'configuration vide';
      notes.add('err', `[${id}] Pipeline non traduit`, r.error ? `Lecture impossible : ${r.error}` : 'La configuration ne contient ni entrée, ni filtre, ni sortie.');
      continue;
    }
    const pre = uniq(prefixes, compName(id));
    const ren = n => `${pre}_${n}`;
    const renRef = ref => { const k = ref.indexOf('.'); return k < 0 ? ren(ref) : ren(ref.slice(0, k)) + ref.slice(k); };
    for (const [n, src] of Object.entries(r.parts.sources)) {
      if (src.type === '__pipeline') {
        placeholders.set(ren(n), src.address);
        info.addresses.push(src.address);
        if (!listeners.has(src.address)) listeners.set(src.address, []);
        listeners.get(src.address).push({ pipeline: id, name: ren(n) });
      } else { all.sources[ren(n)] = src; info.sources.push(ren(n)); }
    }
    for (const [n, t] of Object.entries(r.parts.transforms)) all.transforms[ren(n)] = Object.assign({}, t, { inputs: t.inputs.map(renRef) });
    for (const [n, k] of Object.entries(r.parts.sinks)) {
      const inputs = k.inputs.map(renRef);
      if (k.type === '__pipeline') {
        for (const a of k.send_to) {
          if (!producers.has(a)) producers.set(a, []);
          producers.get(a).push({ pipeline: id, refs: inputs, name: ren(n) });
          if (!info.sendTo.includes(a)) info.sendTo.push(a);
        }
      } else { all.sinks[ren(n)] = Object.assign({}, k, { inputs }); info.sinks.push(ren(n)); }
    }
    for (const [n, e] of Object.entries(r.parts.enrich || {})) {
      if (all.enrich[n] && JSON.stringify(all.enrich[n]) !== JSON.stringify(e)) notes.add('err', `[${id}] Table d’enrichissement « ${n} »`, 'Un autre pipeline déclare une table du même nom avec d’autres réglages : renommez l’une des deux.');
      else all.enrich[n] = e;
    }
    r.env.forEach(x => env.add(x));
    for (const k of ['ok', 'approx', 'ko']) stats[k] += r.stats[k];
    info.stats = r.stats;
    info.verdict = verdictOf(r);
    info.notes = r.notes.length;
    for (const nd of r.graph.nodes) graph.nodes.push(Object.assign({}, nd, { id: ren(nd.id), pipeline: id }));
    for (const [a, b] of r.graph.edges) graph.edges.push([ren(a), ren(b)]);
    // Les notes propres au pipeline sont préfixées de son identifiant ; celles qui reviennent partout, une fois
    for (const nt of r.notes) {
      const key = `${nt.level}\u0000${nt.title}\u0000${nt.detail}`;
      if (!commonTitles.has(key)) commonTitles.set(key, { note: nt, pipelines: [] });
      commonTitles.get(key).pipelines.push(id);
    }
    // Réglages du pipeline sans équivalent ou à reporter ailleurs
    const ignored = Object.keys(st).filter(k => PIPELINE_SETTINGS_IGNORED.includes(k));
    if (ignored.length) notes.add('info', `[${id}] Réglages d’exécution`, `${ignored.join(', ')} : Vector règle seul son parallélisme et ses lots, ces réglages n’ont pas d’équivalent.`);
    if (st['queue.type'] === 'persisted') notes.add('warn', `[${id}] File persistante`, 'queue.type: persisted gardait les événements sur disque entre l’entrée et les filtres. Avec Vector, donnez aux sorties de ce pipeline un tampon disque (buffer: { type: disk, max_size: … }).');
    if (st['dead_letter_queue.enable'] === true || st['dead_letter_queue.enable'] === 'true') notes.add('warn', `[${id}] File des lettres mortes`, 'La DLQ de Logstash recevait les documents refusés par Elasticsearch : Vector n’en a pas. Les refus restent visibles dans les métriques et le journal de Vector.');
  }
  const order = { err: 0, warn: 1, opt: 2, info: 3 };
  const translated = pipelines.filter(x => !x.error).length;
  for (const { note, pipelines: on } of commonTitles.values()) {
    const shared = on.length === translated && translated > 1;
    notes.add(note.level, shared ? note.title : `[${on.join(', ')}] ${note.title}`, note.detail, note.code);
  }
  // Liaisons : chaque entrée pipeline reçoit les étapes qui précédaient les sorties pipeline vers son adresse
  // Une liaison cassée rend « à reprendre » les pipelines qu’elle touche
  const flag = idsOf => idsOf.forEach(pid => { const x = pipelines.find(y => y.id === pid); if (x) { x.links = (x.links || 0) + 1; x.verdict = 'todo'; } });
  for (const [address, ls] of listeners) {
    if (ls.length > 1) { notes.add('err', `Adresse « ${address} » écoutée par plusieurs pipelines`, `${ls.map(x => x.pipeline).join(', ')} : Logstash n’accepte qu’une entrée par adresse et refuse de démarrer le second.`); flag(ls.map(x => x.pipeline)); }
    if (!producers.has(address)) { notes.add('err', `Adresse « ${address} » sans expéditeur`, `Aucun pipeline n’envoie vers « ${address} » (send_to) : l’entrée de ${ls.map(x => x.pipeline).join(', ')} ne reçoit rien, ses étapes sont retirées de la configuration.`); flag(ls.map(x => x.pipeline)); }
  }
  for (const [address, ps] of producers) {
    if (!listeners.has(address)) { const from = [...new Set(ps.map(x => x.pipeline))]; notes.add('err', `send_to « ${address} » sans destinataire`, `${from.join(', ')} envoie vers « ${address} », qu’aucun pipeline n’écoute : Logstash bloquerait l’envoi (ensure_delivery) ou jetterait les événements ; la traduction ne les envoie nulle part.`); flag(from); }
  }
  const refsOf = address => [...new Set((producers.get(address) || []).flatMap(x => x.refs))];
  const rewire = inputs => [...new Set(inputs.flatMap(x => (placeholders.has(x) ? refsOf(placeholders.get(x)) : [x])))];
  for (const t of Object.values(all.transforms)) t.inputs = rewire(t.inputs);
  for (const k of Object.values(all.sinks)) k.inputs = rewire(k.inputs);
  // Étapes privées d’entrée (adresse sans expéditeur) : retirées de proche en proche, sinon Vector refuse la configuration
  const exists = ref => { const c = ref.split('.')[0]; return all.sources[c] || all.transforms[c]; };
  for (let changed = true; changed;) {
    changed = false;
    for (const group of [all.transforms, all.sinks]) {
      for (const [n, c] of Object.entries(group)) {
        const kept = c.inputs.filter(exists);
        if (kept.length !== c.inputs.length) { c.inputs = kept; changed = true; }
        if (!kept.length) { delete group[n]; changed = true; }
      }
    }
  }
  // Graphe : les entrées pipeline et les sorties pipeline disparaissent, leurs liaisons deviennent des arêtes directes
  const virtualSinks = new Set([...producers.values()].flatMap(ps => ps.map(x => x.name)));
  const live = id => all.sources[id] || all.transforms[id] || all.sinks[id];
  const edges = [];
  for (const [a, b] of graph.edges) {
    if (virtualSinks.has(b)) continue;
    if (placeholders.has(a)) { for (const ref of refsOf(placeholders.get(a))) edges.push([ref.split('.')[0], b]); continue; }
    edges.push([a, b]);
  }
  graph.edges = edges.filter(([a, b]) => live(a) && live(b)).filter((e, k, arr) => arr.findIndex(x => x[0] === e[0] && x[1] === e[1]) === k);
  graph.nodes = graph.nodes.filter(nd => live(nd.id));
  // Boucle entre pipelines : Logstash la tolère, Vector refuse un graphe cyclique
  const next = new Map();
  graph.edges.forEach(([a, b]) => { if (!next.has(a)) next.set(a, []); next.get(a).push(b); });
  const color = new Map(); let cycle = null;
  const visit = (n, path) => {
    if (cycle) return;
    color.set(n, 1);
    for (const m of next.get(n) || []) {
      if (color.get(m) === 1) { cycle = path.concat(n, m); return; }
      if (!color.get(m)) visit(m, path.concat(n));
    }
    color.set(n, 2);
  };
  for (const nd of graph.nodes) if (!color.get(nd.id) && !cycle) visit(nd.id, []);
  if (cycle) {
    const ps = [...new Set(cycle.map(c => (graph.nodes.find(nd => nd.id === c) || {}).pipeline).filter(Boolean))];
    notes.add('err', 'Boucle entre pipelines', `Les événements reviennent à leur point de départ (${ps.join(' → ')}) : Vector refuse une configuration cyclique. Coupez la boucle, par exemple avec une condition sur une étiquette.`);
    flag(ps);
  }
  if (!Object.keys(all.sinks).length) notes.add('err', 'Aucune sortie', 'L’ensemble des pipelines n’a pas de sortie traduisible.');
  if (pipelines.some(x => x.addresses.length || x.sendTo.length)) notes.add('info', 'pipeline { send_to } → liaisons directes', 'Les sorties pipeline relient les étapes du pipeline expéditeur à celles du destinataire, sans file intermédiaire : comme ensure_delivery, un destinataire lent ralentit l’expéditeur (contre-pression).');
  const vAll = { ns: cfg.vector.log_namespace !== false, env, note: (l, t, d, c) => notes.add(l, t, d, c) };
  const doc = vectorDocument(vAll, all, cfg, `depuis ${pipelines.length} pipeline${pipelines.length > 1 ? 's' : ''} Logstash (pipelines.yml)`);
  notes.list.sort((a, b) => order[a.level] - order[b.level]);
  const sentence = `${translated} pipeline${translated > 1 ? 's' : ''} sur ${pipelines.length} traduit${translated > 1 ? 's' : ''}, ${Object.keys(all.sources).length} source${Object.keys(all.sources).length > 1 ? 's' : ''}, ${Object.keys(all.sinks).length} sortie${Object.keys(all.sinks).length > 1 ? 's' : ''}${listeners.size ? `, ${listeners.size} liaison${listeners.size > 1 ? 's' : ''} entre pipelines` : ''}.`;
  const result = { config: doc.config, yaml: doc.yaml, toml: doc.toml, notes: notes.list, stats, graph, env: [...env], pipelines, sentence };
  if (!translated) result.error = pipelines.length ? 'aucun pipeline traduisible' : 'pipelines.yml ne déclare aucun pipeline';
  return result;
}

/*
 * pipelines.yml et ses fichiers → liste de pipelines prête pour translatePipelines.
 *   readFile(path) rend le texte d’un fichier disponible (chemins relatifs au dossier de pipelines.yml).
 */
function pipelinesFromYML(text, available, readFile) {
  const entries = parsePipelinesYML(text);
  return entries.map(e => {
    const st = e.settings;
    const id = st['pipeline.id'] === undefined || st['pipeline.id'] === null ? '' : String(st['pipeline.id']);
    const origin = `pipelines.yml, ligne ${e.line}`;
    if (st['config.string'] !== undefined && st['config.string'] !== null) return { id, config: String(st['config.string']), settings: st, origin, from: 'config.string' };
    if (st['path.config'] === undefined || st['path.config'] === null) return { id, settings: st, origin, error: 'ni path.config ni config.string' };
    const found = pipelineConfigFiles(st['path.config'], available);
    if (!found.files.length) return { id, settings: st, origin, error: `aucun fichier ne correspond à path.config « ${st['path.config']} » ; placez les fichiers à côté de pipelines.yml (même arborescence, ou leur seul nom)` };
    // Logstash lit les fichiers bout à bout, comme un seul fichier
    return { id, config: found.files.map(f => readFile(f)).join('\n'), settings: st, origin, from: found.files, matched: found.matched };
  });
}
