/* Passerelle — interface */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/></svg>';
const store = {
  get(k, d) { try { const v = localStorage.getItem('passerelle:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('passerelle:' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
};

/* ---------- Coloration syntaxique ---------- */
const LANGS = {
  json: [['str', '"""[\\s\\S]*?"""'], ['kw', '^(?:GET|POST|PUT)\\s.*$'], ['key', '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'], ['str', '"(?:[^"\\\\]|\\\\.)*"'], ['num', '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'], ['kw', '\\b(?:true|false|null)\\b']],
  sql: [['com', '--.*$'], ['str', "'(?:[^'\\\\]|\\\\.)*'"], ['key', '`[^`]*`'], ['kw', '\\b(?:SELECT|FROM|WHERE|AND|OR|NOT|IN|AS|GROUP|BY|ORDER|LIMIT|OFFSET|HAVING|WITH|FILL|STEP|INTERVAL|ASC|DESC|NULLS|FIRST|LAST|BETWEEN|LIKE|ILIKE|OVER|PARTITION|ROWS|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|ROW|SETTINGS|ALTER|TABLE|ADD|COLUMN|INDEX|TYPE|GRANULARITY|MATERIALIZE|MATERIALIZED|EXCEPT|NULL|EXPLAIN|HOUR|DAY|MINUTE|SECOND|WEEK|MONTH|YEAR|QUARTER|MILLISECOND|Nullable|String|Int64|Float64|Bool)\\b'], ['fn', '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\()'], ['num', '\\b\\d+(?:\\.\\d+)?\\b']],
  vrl: [['com', '#.*$'], ['str', "[sr]'(?:[^'\\\\]|\\\\.)*'"], ['str', '"(?:[^"\\\\]|\\\\.)*"'], ['kw', '\\b(?:if|else|abort|null|true|false)\\b'], ['fn', '\\b[a-z_][a-z0-9_]*!?(?=\\()'], ['path', '(?<![\\w)\\]"])[.%](?:"[^"]*"|[A-Za-z_@][\\w@]*)(?:\\.(?:"[^"]*"|[A-Za-z_@][\\w@]*))*'], ['num', '\\b\\d+(?:\\.\\d+)?\\b']],
  logstash: [['com', '#.*$'], ['str', '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\''], ['kw', '\\b(?:if|else|and|or|not|in|xor|nand)\\b'], ['path', '(?:\\[[^\\]\\s"\',]+\\])+'], ['fn', '\\b[a-z_][a-z0-9_]*(?=\\s*\\{)'], ['op', '=>|==|!=|=~|!~'], ['num', '\\b\\d+(?:\\.\\d+)?\\b']],
  bash: [['com', '(?:^|\\s)#.*$'], ['str', "'(?:[^'])*'|\"(?:[^\"\\\\]|\\\\.)*\""], ['env', '\\$\\{?[A-Z_][A-Z0-9_]*\\}?'], ['kw', '\\b(?:curl|vector|clickhouse|docker|kubectl|passerelle|jq|for|do|done|in)\\b'], ['fn', '(?<=\\s)--?[A-Za-z][\\w-]*']]
};
const RE_CACHE = {};
function hlRules(text, lang) {
  const rules = LANGS[lang]; if (!rules) return esc(text);
  const re = RE_CACHE[lang] || (RE_CACHE[lang] = new RegExp(rules.map(r => `(${r[1]})`).join('|'), 'gm'));
  re.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    let gi = 1; while (gi < m.length && m[gi] === undefined) gi++;
    out += `<span class="t-${rules[gi - 1][0]}">${esc(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}
function hlYAML(text) {
  let block = -1;
  return text.split('\n').map(line => {
    const ind = line.match(/^ */)[0].length;
    if (block >= 0) { if (!line.trim() || ind > block) return hlRules(line, 'vrl'); block = -1; }
    if (/^\s*#/.test(line)) return `<span class="t-com">${esc(line)}</span>`;
    const m = /^(\s*(?:-\s+)?)((?:'[^']*'|[\w.\-@"]+))(:)(\s*)(.*)$/.exec(line);
    if (!m) return esc(line);
    if (/^\|[-+]?$/.test(m[5].trim())) block = ind;
    let val = m[5];
    let v = esc(val);
    if (/^'.*'$|^".*"$/.test(val.trim())) v = `<span class="t-str">${v}</span>`;
    else if (/^(true|false|null|\d+(\.\d+)?)$/.test(val.trim())) v = `<span class="t-num">${v}</span>`;
    v = v.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, x => `<span class="t-env">${x}</span>`);
    return `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${m[3]}${m[4]}${v}`;
  }).join('\n');
}
function hlTOML(text) {
  let inBlock = false;
  return text.split('\n').map(line => {
    if (inBlock) { if (line.trim() === "'''") { inBlock = false; return '<span class="t-str">\'\'\'</span>'; } return hlRules(line, 'vrl'); }
    if (/^\s*#/.test(line)) return `<span class="t-com">${esc(line)}</span>`;
    if (/^\s*\[.*\]\s*$/.test(line)) return `<span class="t-kw">${esc(line)}</span>`;
    const m = /^(\s*)([\w"\-.]+)(\s*=\s*)(.*)$/.exec(line);
    if (!m) return esc(line);
    if (m[4] === "'''") { inBlock = true; return `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${esc(m[3])}<span class="t-str">'''</span>`; }
    let v = hlRules(m[4], 'json').replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, x => `<span class="t-env">${x}</span>`);
    return `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${esc(m[3])}${v}`;
  }).join('\n');
}
function hl(text, lang) { if (lang === 'yaml') return hlYAML(text); if (lang === 'toml') return hlTOML(text); return hlRules(text, lang); }

/* ---------- Éditeur ---------- */
function makeEditor(host, lang, label, placeholder, onInput) {
  host.innerHTML = '<pre aria-hidden="true"><code></code></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>';
  const pre = host.querySelector('pre'); const code = pre.firstChild; const ta = host.querySelector('textarea');
  ta.setAttribute('aria-label', label); ta.placeholder = placeholder;
  let tabTraps = true;
  const sync = () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
  const render = () => { code.innerHTML = hl(ta.value, lang) + '\n\n'; sync(); };
  ta.addEventListener('input', () => { tabTraps = true; render(); onInput(ta.value); });
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { tabTraps = false; return; }
    if (e.key === 'Tab' && tabTraps && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!document.execCommand || !document.execCommand('insertText', false, '  ')) { ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); render(); onInput(ta.value); }
    }
  });
  return { get value() { return ta.value; }, set value(v) { ta.value = v; ta.scrollTop = 0; ta.scrollLeft = 0; render(); }, focus() { ta.focus(); } };
}

/* ---------- État ---------- */
// En mode serveur, la configuration de référence est fournie par le binaire (sans secrets en clair)
const SERVER_CFG = (() => { try { const el = document.getElementById('server-config'); return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; } })();
const BASE_CFG = SERVER_CFG ? mergeConfig(DEFAULT_CONFIG, SERVER_CFG) : DEFAULT_CONFIG;
let cfg = mergeConfig(BASE_CFG, store.get(SERVER_CFG ? 'config-srv' : 'config', {}));
const CFG_KEY = SERVER_CFG ? 'config-srv' : 'config';
const S = {
  view: store.get('view', 'dsl'),
  dsl: { files: [{ name: EXAMPLES.dsl[0].file, text: EXAMPLES.dsl[0].text, example: true }], active: 0, index: 'logs-*', tab: 'sql', res: null, ed: null, lang: 'json' },
  ls: { files: [{ name: EXAMPLES.ls[0].file, text: EXAMPLES.ls[0].text, example: true }], active: 0, tab: 'config', res: null, ed: null, lang: 'logstash' }
};
let downloads = null;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}
async function copyText(text, what) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  toast(ok ? `${what} copié${/configuration|requête/i.test(what) ? 'e' : ''} dans le presse-papiers` : 'La copie a été bloquée par le navigateur : sélectionnez le texte à la main.');
}
async function saveFile(filename, data) {
  if (!downloads) { toast('Téléchargement indisponible dans cette vue : utilisez la copie.'); return; }
  try { await downloads.save({ filename, data }); toast(`${filename} prêt`); }
  catch (e) { toast('Le téléchargement n’a pas abouti. Utilisez la copie.'); }
}

/* ---------- Traductions ---------- */
function statusOf(r) {
  if (!r || r.empty) return 'ok';
  if (r.error || r.stats.ko) return 'err';
  if (r.stats.approx || r.notes.some(n => n.level === 'warn')) return 'warn';
  return 'ok';
}
function translate(kind, file) {
  if (!file) return { empty: true };
  try {
    return kind === 'dsl' ? translateDSL(file.text, cfg, { index: S.dsl.index }) : translateLogstash(file.text, cfg);
  } catch (e) { return { error: `Erreur interne du traducteur : ${e.message}` }; }
}
function run(kind, pulse) {
  const st = S[kind]; const f = st.files[st.active];
  const r = translate(kind, f);
  const changed = !st.res || JSON.stringify(st.res.sql || st.res.yaml || st.res.error) !== JSON.stringify(r.sql || r.yaml || r.error);
  st.res = r; if (f) f.status = statusOf(r);
  render(kind);
  if (pulse && changed && !r.error && !r.empty) pulseSeam(kind);
}
const debounced = {};
function runSoon(kind) { clearTimeout(debounced[kind]); debounced[kind] = setTimeout(() => run(kind, true), 180); }
function pulseSeam(kind) {
  const seam = $(`#view-${kind} .seam`); seam.classList.remove('run'); void seam.offsetWidth; seam.classList.add('run');
}

/* ---------- Rendu des vues de traduction ---------- */
const TABS = {
  dsl: [['sql', 'SQL'], ['notes', 'Remarques'], ['anatomy', 'Lecture'], ['validate', 'Valider']],
  ls: [['config', 'Configuration'], ['flow', 'Topologie'], ['notes', 'Remarques'], ['validate', 'Valider']]
};
function render(kind) {
  const view = $(`#view-${kind}`); const st = S[kind]; const r = st.res || { empty: true };
  // fichiers
  const files = $('[data-role="files"]', view);
  files.hidden = st.files.length < 2;
  files.innerHTML = st.files.map((f, i) => `<button class="file-chip" type="button" data-file="${i}" aria-pressed="${i === st.active}"><i class="${f.status || 'ok'}"></i>${esc(f.name)}<span class="x" data-close="${i}" role="button" aria-label="Fermer ${esc(f.name)}">×</span></button>`).join('');
  $('[data-role="fname"]', view).textContent = st.files[st.active] ? st.files[st.active].name : '';
  if (kind === 'dsl') $('[data-role="table"]', view).textContent = r.table || (cfg.clickhouse.default_table || '');
  // verdict
  const v = $('[data-role="verdict"]', view);
  if (r.empty) { v.hidden = true; }
  else if (r.error) { v.hidden = false; v.innerHTML = `<p class="sentence error">${esc(r.error)}</p>`; }
  else {
    v.hidden = false;
    const { ok, approx, ko } = r.stats; const total = ok + approx + ko || 1;
    const pct = Math.round((100 * (ok + approx)) / total);
    v.innerHTML = `<div class="verdict-top"><span class="score">${pct} %</span><span class="score-label">traduit automatiquement</span>
      <span class="counts"><span><i class="c-ok"></i>${ok} direct${ok > 1 ? 's' : ''}</span><span><i class="c-approx"></i>${approx} à vérifier</span><span><i class="c-ko"></i>${ko} à reprendre</span></span></div>
      <div class="gauge" role="img" aria-label="${ok} éléments traduits directement, ${approx} à vérifier, ${ko} à reprendre"><span class="c-ok" style="width:${(100 * ok) / total}%"></span><span class="c-approx" style="width:${(100 * approx) / total}%"></span><span class="c-ko" style="width:${(100 * ko) / total}%"></span></div>
      <p class="sentence">${esc(r.sentence || '')}</p>`;
  }
  // onglets
  const tabs = $('[data-role="tabs"]', view);
  tabs.hidden = !!(r.empty || r.error);
  const nNotes = r.notes ? r.notes.length : 0; const nErr = r.notes ? r.notes.filter(n => n.level === 'err').length : 0;
  tabs.innerHTML = TABS[kind].map(([id, label]) => `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="${st.tab === id}">${label}${id === 'notes' && nNotes ? `<span class="badge ${nErr ? 'err' : ''}">${nNotes}</span>` : ''}</button>`).join('');
  // corps
  const out = $('[data-role="out"]', view);
  const foot = $('.out-foot', view);
  foot.hidden = !!(r.empty || r.error);
  if (r.empty) { out.innerHTML = emptyState(kind); return; }
  if (r.error) { out.innerHTML = `<div class="empty"><strong>La saisie n’est pas encore analysable</strong><span>${kind === 'dsl' ? 'Vérifiez les virgules et accolades du JSON, ou la ligne « GET index/_search » en tête.' : 'Vérifiez l’équilibre des accolades et la syntaxe des blocs input, filter et output.'}</span></div>`; return; }
  const tab = st.tab;
  if (tab === 'sql') out.innerHTML = r.statements.map((s, i) => `<div class="stmt"><div class="stmt-head"><span>${esc(s.title)}</span><button class="icon-btn" type="button" data-copy-stmt="${i}" title="Copier cette requête" aria-label="Copier cette requête">${ICON_COPY}</button></div><pre class="code">${hl(s.sql + ';', 'sql')}</pre></div>`).join('');
  else if (tab === 'config') out.innerHTML = `<div class="stmt"><div class="stmt-head"><span>vector.${cfg.vector.format}</span><div class="seg" role="group" aria-label="Format">${['yaml', 'toml'].map(f => `<button type="button" data-format="${f}" aria-pressed="${cfg.vector.format === f}">${f.toUpperCase()}</button>`).join('')}</div></div><pre class="code">${hl(r[cfg.vector.format], cfg.vector.format)}</pre></div>`;
  else if (tab === 'notes') out.innerHTML = notesHTML(r.notes);
  else if (tab === 'anatomy') out.innerHTML = anatomyHTML(r);
  else if (tab === 'validate') out.innerHTML = kind === 'dsl' ? validateDSL(r) : validateLS(r);
  else if (tab === 'flow') { out.innerHTML = flowHTML(r.graph); requestAnimationFrame(() => drawEdges(out, r.graph)); }
}
function emptyState(kind) {
  const ex = EXAMPLES[kind];
  return `<div class="empty"><strong>${kind === 'dsl' ? 'Aucune requête à traduire' : 'Aucun pipeline à traduire'}</strong>
    <span>${kind === 'dsl' ? 'Collez une requête DSL à gauche ou déposez des fichiers .json.' : 'Collez un pipeline Logstash à gauche ou déposez des fichiers .conf.'}</span>
    <div class="row">${ex.map((e, i) => `<button class="btn" type="button" data-load-example="${i}">${esc(e.title)}</button>`).join('')}</div></div>`;
}
const LEVEL = { err: 'À reprendre', warn: 'À vérifier', opt: 'Optimisation', info: 'Information' };
function notesHTML(notes) {
  if (!notes.length) return '<div class="empty"><strong>Aucune remarque</strong><span>La traduction est directe, sans approximation.</span></div>';
  return `<ul class="notes">${notes.map(n => `<li class="note ${n.level}"><span class="note-kind">${LEVEL[n.level]}</span><h3>${esc(n.title)}</h3>${n.detail ? `<p>${esc(n.detail)}</p>` : ''}${n.code ? `<pre class="code boxed">${hl(n.code, /^(ALTER|--|PARTITION)/.test(n.code) ? 'sql' : 'vrl')}</pre>` : ''}</li>`).join('')}</ul>`;
}
function anatomyHTML(r) {
  const h = r.human;
  const rows = [
    ['Table ClickHouse', [r.table + (r.matched ? ` (index ${r.matched})` : '')]],
    ['Période', h.period ? [h.period] : []], ['Filtres', h.filters], ['Exclusions', h.excludes], ['Recherche de texte', h.text],
    ['Regroupements', h.groups], ['Mesures', h.metrics], ['Documents renvoyés', h.hits ? [h.hits] : []], ['Champs calculés', h.runtime]
  ].filter(([, v]) => v && v.length);
  return `<dl class="anatomy">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</dd>`).join('')}</dl>`;
}
function chHost() { try { return new URL(cfg.clickhouse.endpoint).host; } catch (e) { return cfg.clickhouse.endpoint || 'clickhouse'; } }
function validateDSL(r) {
  const ep = (cfg.clickhouse.endpoint || 'https://clickhouse:8443').replace(/\/+$/, '');
  const first = r.statements[0];
  const cmd = `# 1. Contrôle syntaxique hors ligne, sans connexion
clickhouse format --multiquery < requete.sql

# 2. Plan d’exécution et index réellement utilisés, sur une base de recette
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \\
  "${ep}/?database=${cfg.clickhouse.database || 'default'}" \\
  --data-binary @- <<'SQL'
EXPLAIN indexes = 1
${first.sql}
SQL`;
  return `<div class="prose"><p>Vérifiez chaque requête contre un ClickHouse de recette avant la mise en service. La sortie d’EXPLAIN indique les parts et granules écartés par la clé de tri et les index de saut.</p>
    <pre class="code boxed">${hl(cmd, 'bash')}</pre>
    <p>${r.statements.length > 1 ? `La commande porte sur la première des ${r.statements.length} requêtes ; répétez-la pour les suivantes.` : 'Comparez ensuite quelques résultats avec Elasticsearch sur la même période : c’est le meilleur test de non-régression.'}</p></div>`;
}
function validateLS(r) {
  const f = `vector.${cfg.vector.format}`;
  const env = (r.env || []).map(e => `${e}=…`).join(' ');
  const cmd = `# 1. Contrôle complet : syntaxe, topologie et compilation du VRL
#    (--no-environment ne compile pas le VRL : préférez --skip-healthchecks)
${env ? env + ' ' : ''}vector validate --skip-healthchecks ${f}

# 2. Rejouer une étape sur un événement réel extrait du topic source
vector vrl --input evenement.json --program etape.vrl --print-object

# 3. Lancer en parallèle de Logstash (mode shadow conseillé dans la configuration)
docker run --rm -v "$PWD/${f}:/etc/vector/vector.${cfg.vector.format}:ro" \\
  ${(r.env || []).map(e => `-e ${e} `).join('')}timberio/vector:0.49.0-debian`;
  return `<div class="prose"><p>Cette configuration a été générée pour Vector 0.49 et suit ses règles de typage VRL : chaque appel faillible est traité explicitement.</p>
    <pre class="code boxed">${hl(cmd, 'bash')}</pre>
    <p>L’archive téléchargée contient aussi un squelette de test unitaire, exécutable avec vector test, à compléter avec un message réel.</p></div>`;
}
const KIND_LABEL = n => n.kind === 'source' ? `Source ${n.type === 'kafka' ? 'Kafka' : n.type}` : n.kind === 'sink' ? `Destination ${n.type === 'kafka' ? 'Kafka' : n.type}` : n.type === 'route' ? 'Aiguillage' : 'Étape VRL';
function flowHTML(g) {
  const incoming = {}; g.edges.forEach(([a, b]) => (incoming[b] = incoming[b] || []).push(a));
  const lvl = {}; const lv = id => { if (lvl[id] !== undefined) return lvl[id]; lvl[id] = 0; const ins = incoming[id] || []; lvl[id] = ins.length ? Math.max(...ins.map(lv)) + 1 : 0; return lvl[id]; };
  g.nodes.forEach(n => lv(n.id));
  const rows = []; g.nodes.forEach(n => (rows[lvl[n.id]] = rows[lvl[n.id]] || []).push(n));
  return `<div class="flow"><svg class="edges" aria-hidden="true"></svg>${rows.map(row => `<div class="flow-row">${row.map(n => `<div class="node ${n.kind}${n.todo ? ' todo' : ''}" data-node="${esc(n.id)}"><small>${KIND_LABEL(n)}</small><b>${esc(n.label || n.id)}</b>${n.todo ? '<span>contient un filtre à reprendre</span>' : n.drop ? '<span>peut écarter des événements</span>' : n.detail ? `<span>${esc(n.detail)}</span>` : ''}</div>`).join('')}</div>`).join('')}</div>`;
}
function drawEdges(out, g) {
  const flow = $('.flow', out); if (!flow) return;
  const svg = $('svg.edges', flow); const box = flow.getBoundingClientRect();
  const pos = id => { const el = flow.querySelector(`[data-node="${CSS.escape(id)}"]`); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left - box.left + b.width / 2, top: b.top - box.top, bottom: b.bottom - box.top }; };
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = g.edges.map(([a, b]) => {
    const p = pos(a), q = pos(b); if (!p || !q) return '';
    const y1 = p.bottom, y2 = q.top, dy = Math.max(12, (y2 - y1) / 2);
    return `<path d="M${p.x} ${y1} C${p.x} ${y1 + dy} ${q.x} ${y2 - dy} ${q.x} ${y2}"/>`;
  }).join('');
}

/* ---------- Exports ---------- */
const base = name => String(name).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'fichier';
function notesMD(title, list) {
  return list.map(({ name, r }) => `## ${name}\n\n${r.error ? `Erreur : ${r.error}\n` : (r.notes.length ? r.notes.map(n => `- **${LEVEL[n.level]}** — ${n.title}${n.detail ? ` : ${n.detail}` : ''}${n.code ? `\n\n\`\`\`\n${n.code}\n\`\`\`` : ''}`).join('\n') : 'Traduction directe, aucune remarque.')}\n`).join('\n').replace(/^/, `# ${title}\n\n`);
}
function exportKind(kind) {
  const st = S[kind];
  const results = st.files.map(f => ({ name: f.name, r: translate(kind, f) })).filter(x => !x.r.empty);
  const files = [];
  if (kind === 'dsl') {
    results.forEach(({ name, r }) => { if (!r.error) files.push({ name: `sql/${base(name)}.sql`, content: `-- Traduit par Passerelle depuis ${name}\n-- Table ClickHouse : ${r.table}\n\n${r.sql}\n` }); });
    files.push({ name: 'NOTES.md', content: notesMD('Remarques de traduction DSL vers SQL', results) });
  } else {
    const fmt = cfg.vector.format;
    results.forEach(({ name, r }) => {
      if (r.error) return;
      files.push({ name: `vector/${base(name)}.${fmt}`, content: r[fmt] });
      const tnames = Object.keys(r.config.transforms || {});
      const first = tnames.find(t => !/_init$/.test(t)) || tnames[0]; const last = r.lastTransform || tnames[tnames.length - 1];
      if (first) files.push({ name: `tests/${base(name)}.test.yaml`, content: `# Test unitaire : vector test vector/${base(name)}.${fmt} tests/${base(name)}.test.yaml\n# Remplacez le message par un événement réel du topic source.\ntests:\n  - name: '${base(name)} : événement de référence'\n    inputs:\n      - insert_at: ${first}\n        type: log\n        log_fields:\n          message: '<message réel>'\n    outputs:\n      - extract_from: ${last}\n        conditions:\n          - type: vrl\n            source: |\n              assert!(exists(."@timestamp"))\n` });
    });
    files.push({ name: 'NOTES.md', content: notesMD('Remarques de traduction Logstash vers Vector', results) });
  }
  files.push({ name: 'passerelle.yaml', content: configToYAML(cfg) });
  saveFile(kind === 'dsl' ? 'passerelle-sql.zip' : 'passerelle-vector.zip', makeZip(files));
}

/* ---------- Fichiers et glisser-déposer ---------- */
function readFiles(list) { return Promise.all([...list].map(f => new Promise(res => { const fr = new FileReader(); fr.onload = () => res({ name: f.name, text: String(fr.result) }); fr.onerror = () => res(null); fr.readAsText(f); }))).then(x => x.filter(Boolean)); }
function addFiles(kind, files) {
  const st = S[kind];
  if (st.files.length === 1 && (st.files[0].example || !st.files[0].text.trim())) st.files = [];
  files.forEach(f => st.files.push({ name: f.name, text: f.text }));
  st.active = st.files.length - files.length;
  st.files.forEach(f => { if (!f.status) f.status = statusOf(translate(kind, f)); });
  st.ed.value = st.files[st.active].text;
  run(kind, true);
}
async function handleDrop(fileList) {
  const files = await readFiles(fileList);
  const cfgFile = files.find(f => /passerelle.*\.(ya?ml|json)$/i.test(f.name) || (S.view === 'config' && /\.(ya?ml|json)$/i.test(f.name)));
  if (cfgFile) { importConfig(cfgFile); return; }
  const ls = files.filter(f => /\.(conf|cfg|logstash)$/i.test(f.name) || (S.view === 'ls' && !/\.json$/i.test(f.name)));
  const dsl = files.filter(f => !ls.includes(f));
  if (ls.length) { addFiles('ls', ls); if (!dsl.length) show('ls'); }
  if (dsl.length) { addFiles('dsl', dsl); show('dsl'); }
  toast(`${files.length} fichier${files.length > 1 ? 's' : ''} ajouté${files.length > 1 ? 's' : ''}`);
}
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; const pane = $(`#view-${S.view} .pane-in`); if (pane) pane.classList.add('dragging'); });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth--; if (dragDepth <= 0) $$('.dragging').forEach(x => x.classList.remove('dragging')); });
window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $$('.dragging').forEach(x => x.classList.remove('dragging')); handleDrop(e.dataTransfer.files); });

/* ---------- Configuration ---------- */
const CFG_FORM = [
  { title: 'ClickHouse', intro: 'Utilisé pour résoudre les tables cibles, renommer les champs et générer les commandes de vérification.', fields: [
    ['clickhouse.endpoint', 'Endpoint HTTP(S)', 'text', 'Port 8443 en TLS, 8123 en clair.'], ['clickhouse.database', 'Base de données', 'text'],
    ['clickhouse.user', 'Utilisateur', 'text', 'Une variable ${…} est résolue au déploiement.'], ['clickhouse.password', 'Mot de passe', 'text', 'Jamais en clair : gardez ${CLICKHOUSE_PASSWORD}.'],
    ['clickhouse.default_table', 'Table par défaut', 'text'], ['clickhouse.cluster', 'Cluster (optionnel)', 'text', 'Pour cibler des tables Distributed.'],
    ['clickhouse.time_field', 'Colonne temporelle', 'text', 'Tri par défaut des documents.'], ['clickhouse.timezone', 'Fuseau du serveur', 'text', 'UTC si le serveur et les colonnes de date sont en UTC. Vide : le SQL précise « UTC » dans chaque calcul de date, comme le fait Elasticsearch.'],
    ['clickhouse.composite_mode', 'Agrégations composite', 'select', 'page : une requête par page, avec curseur. stream : une seule requête sans pagination, à lire en flux.', ['page', 'stream']],
    ['clickhouse.lists.threshold', 'Seuil des listes nommées', 'text', 'Au-delà de ce nombre de valeurs, une liste (terms, should…) quitte le SQL pour une table. 0 : jamais.'], ['clickhouse.lists.table', 'Table des listes', 'text', 'Vide : passerelle_lists dans la base de données.'],
    ['clickhouse.text_fields', 'Champs plein texte', 'list', 'Séparés par des virgules. Recherche par tokens (hasToken).']
  ], maps: [['clickhouse.index_mapping', 'Index ou motif Elasticsearch', 'Table ClickHouse', 'Correspondance index → table'], ['clickhouse.field_mapping', 'Champ Elasticsearch', 'Colonne ClickHouse', 'Renommage des champs'], ['clickhouse.columns', 'Colonne ClickHouse', 'Type, par exemple Nullable(String)', 'Types des colonnes : champs facultatifs (Nullable), multivalués (Array), entiers et dates']],
    toggles: [['clickhouse.empty_as_missing', 'Chaîne vide = champ absent', 'Dans une colonne String non Nullable, une chaîne vide représente un champ absent : exists devient colonne != \'\' et les regroupements l’ignorent.']] },
  { title: 'Kafka', intro: 'Laissez un champ vide pour reprendre la valeur écrite dans le pipeline Logstash. Renseigné, il s’impose à tous les pipelines traduits.', fields: [
    ['kafka.bootstrap_servers', 'Bootstrap servers', 'text', 'hôte:port, séparés par des virgules.'], ['kafka.security_protocol', 'Protocole de sécurité', 'select', '', ['', 'PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL']],
    ['kafka.sasl_mechanism', 'Mécanisme SASL', 'select', '', ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']], ['kafka.ca_file', 'Certificat d’autorité (PEM)', 'text'],
    ['kafka.username', 'Utilisateur SASL', 'text'], ['kafka.password', 'Mot de passe SASL', 'text', 'Gardez ${KAFKA_PASSWORD}.'],
    ['kafka.consumer_group', 'Groupe de consommateurs', 'text', 'Nom du consumer group lu par Vector.'], ['kafka.input_topics', 'Topics d’entrée', 'list', 'Séparés par des virgules ; ^regex accepté.'],
    ['kafka.output_topic', 'Topic de sortie', 'text', 'Appliqué quand le pipeline n’a qu’une sortie Kafka.']
  ] },
  { title: 'Vector', intro: 'Options de génération des configurations.', toggles: [
    ['vector.log_namespace', 'Isoler les métadonnées Kafka', 'Topic, offset et clé restent hors de la charge utile : les messages écrits sont identiques à ceux de Logstash.'],
    ['vector.logstash_compat', 'Compatibilité Logstash', 'Ajoute @timestamp et @version et reproduit le format de date de Logstash, pour ne rien changer côté consommateurs.'],
    ['vector.acknowledgements', 'Accusés de réception de bout en bout', 'L’offset Kafka n’est validé qu’une fois l’événement écrit dans le topic de sortie.'],
    ['vector.shadow_mode', 'Mode shadow', 'Suffixe -shadow sur le groupe et les topics de sortie : Vector tourne à côté de Logstash sans lui prendre de partitions, le temps de comparer.']
  ], fields: [['vector.format', 'Format de sortie', 'select', '', ['yaml', 'toml']]] }
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v; };
function renderConfigForm() {
  $('#cfg-form').innerHTML = CFG_FORM.map(sec => `<section class="form-section"><h2>${sec.title}</h2><p>${sec.intro}</p>
    ${sec.toggles ? `<div class="toggles">${sec.toggles.map(([p, t, d]) => `<label class="toggle"><input type="checkbox" data-path="${p}" ${getPath(cfg, p) ? 'checked' : ''}><div><b>${t}</b><span>${d}</span></div></label>`).join('')}</div>` : ''}
    <div class="fields">${sec.fields.map(([p, label, type, help, opts]) => {
      const val = getPath(cfg, p); const id = 'f-' + p.replace(/\W/g, '-');
      const input = type === 'select' ? `<select id="${id}" data-path="${p}">${opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o || 'repris du pipeline'}</option>`).join('')}</select>` : `<input id="${id}" data-path="${p}" data-type="${type}" value="${esc(type === 'list' ? (val || []).join(', ') : val || '')}" spellcheck="false" placeholder="${p.startsWith('kafka.') ? 'repris du pipeline' : ''}">`;
      return `<div class="field ${type === 'list' && p.includes('topics') ? 'wide' : ''}"><label for="${id}">${label}</label>${input}${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
    }).join('')}</div>
    ${(sec.maps || []).map(([p, a, b, t]) => `<div class="field wide"><span>${t}</span><div class="map-rows" data-map="${p}">${Object.entries(getPath(cfg, p) || {}).map(([k, v]) => mapRow(k, v, a, b)).join('')}</div><button class="btn quiet" type="button" data-add-map="${p}" data-a="${a}" data-b="${b}" style="justify-self:start">Ajouter une correspondance</button></div>`).join('')}
  </section>`).join('');
  renderConfigPreview();
}
const mapRow = (k, v, a, b) => `<div class="map-row"><input value="${esc(k)}" aria-label="${a}" placeholder="${a}" spellcheck="false"><span class="arrow" aria-hidden="true">→</span><input value="${esc(v)}" aria-label="${b}" placeholder="${b}" spellcheck="false"><button class="icon-btn" type="button" data-del-map aria-label="Supprimer la correspondance">×</button></div>`;
function readMaps() { $$('[data-map]').forEach(box => { const o = {}; $$('.map-row', box).forEach(row => { const [k, v] = $$('input', row).map(i => i.value.trim()); if (k) o[k] = v; }); setPath(cfg, box.dataset.map, o); }); }
function renderConfigPreview() { $('#cfg-preview').innerHTML = hl(configToYAML(cfg), 'yaml'); renderEnv(); }
function renderEnv() {
  const k = cfg.kafka.bootstrap_servers ? cfg.kafka.bootstrap_servers.split(',')[0] : 'repris des pipelines';
  $('#env-chip').innerHTML = `<span>ClickHouse<em title="${esc(cfg.clickhouse.endpoint)}">${esc(chHost())}</em></span><span>Kafka<em title="${esc(k)}">${esc(k)}</em></span>${cfg.vector.shadow_mode ? '<span>Mode<em>shadow</em></span>' : ''}${SERVER_CFG ? '<span>Source<em>serveur</em></span>' : ''}`;
  $('#index-list').innerHTML = Object.keys(cfg.clickhouse.index_mapping || {}).map(k2 => `<option value="${esc(k2)}">`).join('');
}
function configChanged() { store.set(CFG_KEY, cfg); renderConfigPreview(); clearTimeout(configChanged.h); configChanged.h = setTimeout(() => { run('dsl'); run('ls'); }, 250); }
function importConfig(f) {
  try {
    const parsed = /\.json$/i.test(f.name) ? JSON.parse(f.text) : parseYAMLConfig(f.text);
    cfg = mergeConfig(DEFAULT_CONFIG, { clickhouse: parsed.clickhouse, kafka: parsed.kafka, vector: parsed.vector });
    store.set(CFG_KEY, cfg); renderConfigForm(); run('dsl'); run('ls');
    toast(`Configuration importée depuis ${f.name}`);
  } catch (e) { toast(`${f.name} n’est pas lisible : ${e.message}`); }
}

/* ---------- Vues documentaires ---------- */
function renderAPI() {
  const ch = (cfg.clickhouse.endpoint || '').replace(/\/+$/, '');
  $('#view-api').innerHTML = `<header class="view-head"><div><h1>API et infrastructure as code</h1><p>Le moteur de traduction de cette interface est une bibliothèque autonome. Exposée en API et en CLI, elle traduit automatiquement tout ce qui est versionné dans Git, avec la même configuration.</p></div></header>
  <div class="doc">
    <section><h2>Contrat d’API</h2><p>Service sans état, authentifié par jeton, documenté en OpenAPI. Les réponses reprennent exactement ce qu’affiche l’interface : SQL ou configuration, remarques et taux de couverture.</p>
      <div class="endpoints">${[
        ['POST', '/v1/translate/dsl?index=logs-*', 'Traduit une requête DSL (JSON brut ou format console Kibana). Renvoie sql, statements, notes et coverage.'],
        ['POST', '/v1/translate/logstash?format=yaml', 'Traduit un pipeline .conf. Renvoie la configuration Vector, la topologie et les remarques.'],
        ['POST', '/v1/validate/sql', 'Exécute EXPLAIN indexes = 1 sur le ClickHouse de recette et renvoie le plan.'],
        ['POST', '/v1/validate/vector', 'Compile la configuration et son VRL avec vector validate.'],
        ['GET', '/v1/config', 'Configuration active, secrets masqués.']
      ].map(([vb, p, d]) => `<div class="endpoint"><span class="verb">${vb}</span><code>${esc(p)}</code><p>${d}</p></div>`).join('')}</div></section>
    <section><h2>Traduire depuis un script</h2>${codeCard('curl', `curl -sS -X POST "https://passerelle.internal/v1/translate/dsl?index=logs-*" \\
  -H "Authorization: Bearer $PASSERELLE_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary @requetes/erreurs_5xx.json | jq -r .sql > sql/erreurs_5xx.sql

curl -sS -X POST "https://passerelle.internal/v1/translate/logstash?format=${cfg.vector.format}" \\
  -H "Authorization: Bearer $PASSERELLE_TOKEN" \\
  --data-binary @pipelines/nginx.conf | jq -r .config > vector/nginx.${cfg.vector.format}`, 'bash')}</section>
    <section><h2>CLI pour les dépôts Git</h2><p>La CLI lit passerelle.yaml, traduit des dossiers entiers et échoue si une traduction contient un élément à reprendre : les régressions sont bloquées avant la fusion.</p>${codeCard('CLI', `passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
passerelle ls2vector pipelines/ --config passerelle.yaml --format ${cfg.vector.format} --out build/vector --fail-on todo`, 'bash')}</section>
    <section><h2>Chaîne d’intégration continue</h2><p>Exemple GitLab CI : traduction, validation avec les vrais moteurs, puis déploiement de la configuration Vector par ConfigMap, repris par Argo CD.</p>${codeCard('.gitlab-ci.yml', `stages: [traduire, valider, deployer]

traduire:
  stage: traduire
  image: registry.internal/passerelle-cli:1
  script:
    - passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
    - passerelle ls2vector pipelines/ --config passerelle.yaml --out build/vector --fail-on todo
  artifacts:
    paths: [build/]

valider_vector:
  stage: valider
  image: timberio/vector:0.49.0-debian
  script:
    - mkdir -p /var/lib/vector
    - for f in build/vector/*.${cfg.vector.format}; do vector validate --skip-healthchecks "$f"; done

valider_sql:
  stage: valider
  image: clickhouse/clickhouse-server:latest
  script:
    - for f in build/sql/*.sql; do clickhouse format --multiquery < "$f" > /dev/null; done

deployer:
  stage: deployer
  when: manual
  script:
    - kubectl create configmap vector-pipelines --from-file=build/vector/ --dry-run=client -o yaml > gitops/vector-pipelines.yaml
    - git -C gitops commit -am "Pipelines Vector $CI_COMMIT_SHORT_SHA" && git -C gitops push`, 'yaml')}</section>
    <section><h2>Configuration de référence</h2><p>Endpoint ClickHouse actuel : ${esc(ch || 'non renseigné')}. Kafka : ${esc(cfg.kafka.bootstrap_servers || 'repris des pipelines')}. Modifiez ces valeurs dans Configuration ; les exemples ci-dessus suivent.</p></section>
  </div>`;
}
function codeCard(title, code, lang) { return `<div class="codecard"><div class="stmt-head"><span>${esc(title)}</span><button class="icon-btn" type="button" data-copy-raw="${esc(code)}" aria-label="Copier">${ICON_COPY}</button></div><pre class="code">${hl(code, lang)}</pre></div>`; }
function renderArch() {
  const L = (name, sub, boxes, note) => `<div class="layer"><div class="layer-name">${name}<small>${sub}</small></div><div class="boxes">${boxes.map(([b, s, core]) => `<div class="box${core ? ' core' : ''}"><b>${b}</b><span>${s}</span></div>`).join('')}</div>${note ? `<div class="layer-note">${note}</div>` : ''}</div>`;
  $('#view-arch').innerHTML = `<header class="view-head"><div><h1>Architecture cible</h1><p>Un moteur de traduction unique, trois façons de l’utiliser, et une validation systématique par les vrais moteurs avant tout déploiement.</p></div></header>
  <div class="doc">
    <section class="layers">
      ${L('Entrées', 'qui soumet', [['Interface web', 'Glisser-déposer, lecture en langage clair, revue des remarques.'], ['API REST', 'Intégration aux outils existants, traductions à la demande.'], ['Dépôt Git', 'Requêtes, pipelines et passerelle.yaml versionnés ensemble.']])}
      ${L('Moteur', 'bibliothèque TypeScript', [['Analyseurs', 'DSL, Lucene, Painless, grammaire Logstash.', 1], ['Modèle intermédiaire', 'Types, dépendances entre champs, conditions.', 1], ['Générateurs', 'SQL ClickHouse optimisé, Vector et VRL typé.', 1]], 'Le même code tourne dans le navigateur, l’API et la CLI : un résultat identique partout.')}
      ${L('Validation', 'avant déploiement', [['ClickHouse de recette', 'clickhouse format, puis EXPLAIN indexes = 1.'], ['Vector CLI', 'vector validate compile le VRL ; vector test rejoue des événements.'], ['Tests différentiels', 'Mêmes données en entrée, sorties comparées à Elasticsearch et Logstash.']])}
      ${L('Exécution', 'production', [['ClickHouse', 'MergeTree partitionné par jour, index de tokens pour le texte.'], ['Vector sur Kubernetes', 'Configuration en ConfigMap, déployée par Argo CD.'], ['Kafka', 'Topics source et destination inchangés pour les consommateurs.']])}
    </section>
    <section><h2>Bascule sans interruption</h2><p>Kafka rend la migration réversible à chaque étape : Logstash et Vector peuvent lire les mêmes topics avec des groupes de consommateurs distincts.</p>
      <ol class="steps">
        <li><b>Traduire</b><span>Requêtes et pipelines passent dans Passerelle ; les éléments à reprendre sont traités en revue de code.</span></li>
        <li><b>Valider</b><span>La CI compile chaque configuration Vector et vérifie chaque requête SQL.</span></li>
        <li><b>Lancer en shadow</b><span>Vector lit avec son propre groupe et écrit dans des topics suffixés -shadow.</span></li>
        <li><b>Comparer</b><span>Les messages de Logstash et de Vector sont comparés champ à champ sur plusieurs jours.</span></li>
        <li><b>Basculer</b><span>Vector reprend le groupe et les topics de production ; Logstash reste prêt à redémarrer.</span></li>
        <li><b>Décommissionner</b><span>Logstash et les index Elasticsearch concernés sont arrêtés après la période d’observation.</span></li>
      </ol></section>
    <section><h2>Choix techniques</h2>
      <div class="table-wrap"><table class="stack"><thead><tr><th>Domaine</th><th>Choix</th><th>Pourquoi</th></tr></thead><tbody>
        <tr><td>Interface</td><td>React, TypeScript, Vite, éditeur Monaco</td><td>Monaco apporte l’autocomplétion et le signalement d’erreurs de VS Code. Ce prototype fonctionne sans dépendance.</td></tr>
        <tr><td>Moteur</td><td>TypeScript isomorphe, grammaires Peggy</td><td>Un seul code pour le navigateur, l’API et la CLI, testé une fois.</td></tr>
        <tr><td>API</td><td>Fastify, OpenAPI, conteneur sans état</td><td>Montée en charge horizontale, contrat documenté et testable.</td></tr>
        <tr><td>Validation</td><td>clickhouse-local et Vector CLI en conteneurs annexes</td><td>La vérification passe par les moteurs réels, pas par une imitation.</td></tr>
        <tr><td>IaC</td><td>passerelle.yaml dans Git, CI GitLab ou GitHub, Argo CD</td><td>Chaque traduction est relue en merge request et déployée de façon traçable.</td></tr>
        <tr><td>Sécurité</td><td>SSO OIDC, secrets en variables d’environnement ou Vault, journal d’audit</td><td>Aucun mot de passe dans les fichiers générés ; chaque traduction est attribuée.</td></tr>
      </tbody></table></div></section>
  </div>`;
}

/* ---------- Navigation et événements ---------- */
function show(view) {
  S.view = view; store.set('view', view);
  $$('.view').forEach(v => (v.hidden = v.id !== `view-${view}`));
  $$('.nav-item').forEach(b => (b.getAttribute('data-view') === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (view === 'api') renderAPI();
  if (view === 'arch') renderArch();
  if (view === 'ls' && S.ls.tab === 'flow') render('ls');
}
function setupBench(kind) {
  const view = $(`#view-${kind}`); const st = S[kind];
  st.ed = makeEditor($('[data-role="editor"]', view), st.lang, kind === 'dsl' ? 'Requête DSL Elasticsearch' : 'Pipeline Logstash',
    kind === 'dsl' ? 'Collez ici une requête DSL, par exemple { "query": { "match_all": {} } }, ou une requête de la console Kibana (GET index/_search).' : 'Collez ici un pipeline Logstash : input { kafka { … } } filter { … } output { kafka { … } }',
    text => { const f = st.files[st.active]; if (f) { f.text = text; f.example = false; } else st.files.push({ name: kind === 'dsl' ? 'requete.json' : 'pipeline.conf', text }); runSoon(kind); });
  st.ed.value = st.files[st.active].text;
  const sel = $('[data-act="example"]', view);
  sel.innerHTML = `<option value="">Charger un exemple</option>${EXAMPLES[kind].map((e, i) => `<option value="${i}">${esc(e.title)}</option>`).join('')}`;
  const loadExample = i => {
    const e = EXAMPLES[kind][i]; if (!e) return;
    const f = { name: e.file, text: e.text, example: true };
    if (st.files.length === 1 && (st.files[0].example || !st.files[0].text.trim())) st.files = [f]; else st.files.push(f);
    st.active = st.files.indexOf(f); st.ed.value = f.text; run(kind, true);
  };
  sel.addEventListener('change', () => { loadExample(+sel.value); sel.value = ''; });
  const fileInput = $('input[type="file"]', view);
  $('[data-act="open"]', view).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => { const files = await readFiles(fileInput.files); if (files.length) addFiles(kind, files); fileInput.value = ''; });
  $('[data-act="clear"]', view).addEventListener('click', () => { const f = st.files[st.active]; if (f) f.text = ''; st.ed.value = ''; run(kind); st.ed.focus(); });
  if (kind === 'dsl') { const ix = $('[data-role="index"]', view); ix.value = st.index; ix.addEventListener('input', () => { S.dsl.index = ix.value.trim(); runSoon('dsl'); }); }
  $('[data-act="copy"]', view).addEventListener('click', () => { const r = st.res; if (!r || r.error || r.empty) return; copyText(kind === 'dsl' ? r.sql : r[cfg.vector.format], kind === 'dsl' ? 'SQL' : 'Configuration'); });
  $('[data-act="export"]', view).addEventListener('click', () => exportKind(kind));
  view.addEventListener('click', e => {
    const t = e.target.closest('[data-tab],[data-file],[data-close],[data-format],[data-copy-stmt],[data-load-example]'); if (!t) return;
    if (t.dataset.close !== undefined) { e.stopPropagation(); const i = +t.dataset.close; st.files.splice(i, 1); if (!st.files.length) st.files.push({ name: kind === 'dsl' ? 'requete.json' : 'pipeline.conf', text: '' }); st.active = Math.min(st.active, st.files.length - 1); st.ed.value = st.files[st.active].text; run(kind); return; }
    if (t.dataset.tab) { st.tab = t.dataset.tab; render(kind); return; }
    if (t.dataset.file !== undefined) { st.active = +t.dataset.file; st.ed.value = st.files[st.active].text; run(kind, true); return; }
    if (t.dataset.format) { cfg.vector.format = t.dataset.format; store.set(CFG_KEY, cfg); renderConfigPreview(); render('ls'); return; }
    if (t.dataset.copyStmt !== undefined) { const s = st.res.statements[+t.dataset.copyStmt]; copyText(s.sql + ';', 'Requête'); return; }
    if (t.dataset.loadExample !== undefined) loadExample(+t.dataset.loadExample);
  });
  $('[data-role="tabs"]', view).addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const ids = TABS[kind].map(x => x[0]); const i = ids.indexOf(st.tab);
    st.tab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]; render(kind); const b = $(`[data-tab="${st.tab}"]`, view); if (b) b.focus();
  });
}
function setupConfig() {
  renderConfigForm();
  const form = $('#cfg-form');
  form.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.path) {
      const p = el.dataset.path;
      const v = el.type === 'checkbox' ? el.checked : el.dataset.type === 'list' ? el.value.split(',').map(x => x.trim()).filter(Boolean) : el.value.trim();
      setPath(cfg, p, v);
    } else if (el.closest('[data-map]')) readMaps();
    configChanged();
  });
  form.addEventListener('change', e => { if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') { const el = e.target; setPath(cfg, el.dataset.path, el.type === 'checkbox' ? el.checked : el.value); configChanged(); } });
  form.addEventListener('click', e => {
    const add = e.target.closest('[data-add-map]');
    if (add) { const box = $(`[data-map="${add.dataset.addMap}"]`); box.insertAdjacentHTML('beforeend', mapRow('', '', add.dataset.a, add.dataset.b)); $$('input', box).slice(-2)[0].focus(); return; }
    const del = e.target.closest('[data-del-map]');
    if (del) { del.closest('.map-row').remove(); readMaps(); configChanged(); }
  });
  const fi = $('#cfg-file');
  $('[data-act="cfg-import"]').addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => { const [f] = await readFiles(fi.files); if (f) importConfig(f); fi.value = ''; });
  $('[data-act="cfg-export"]').addEventListener('click', () => saveFile('passerelle-config.zip', makeZip([{ name: 'passerelle.yaml', content: configToYAML(cfg) }])));
  $('[data-act="cfg-copy"]').addEventListener('click', () => copyText(configToYAML(cfg), 'Configuration'));
  $('[data-act="cfg-reset"]').addEventListener('click', () => { cfg = mergeConfig(BASE_CFG, {}); store.set(CFG_KEY, cfg); renderConfigForm(); run('dsl'); run('ls'); toast('Configuration réinitialisée'); });
}
function setupTheme() {
  const modes = ['auto', 'light', 'dark']; const labels = { auto: 'automatique', light: 'clair', dark: 'sombre' };
  let mode = store.get('theme', 'auto');
  const apply = () => { if (mode === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', mode); $('#theme-btn').textContent = `Thème : ${labels[mode]}`; };
  $('#theme-btn').addEventListener('click', () => { mode = modes[(modes.indexOf(mode) + 1) % modes.length]; store.set('theme', mode); apply(); });
  apply();
}
document.addEventListener('click', e => { const c = e.target.closest('[data-copy-raw]'); if (c) copyText(c.getAttribute('data-copy-raw'), 'Code'); });
$$('.nav-item').forEach(b => b.addEventListener('click', () => show(b.getAttribute('data-view'))));
window.addEventListener('resize', () => { if (S.view === 'ls' && S.ls.tab === 'flow' && S.ls.res && S.ls.res.graph) drawEdges($('#view-ls [data-role="out"]'), S.ls.res.graph); });

setupTheme(); setupBench('dsl'); setupBench('ls'); setupConfig();
run('dsl'); run('ls');
show(['dsl', 'ls', 'config', 'api', 'arch'].includes(S.view) ? S.view : 'dsl');
// Téléchargement classique par le navigateur (page servie par le binaire ou ouverte en local)
downloads = { save: async ({ filename, data }) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/zip' })); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return { status: 'saved' }; } };
$$('.dl').forEach(b => (b.hidden = false));

