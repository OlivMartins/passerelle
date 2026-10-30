/* Passerelle — interface */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const verdictLabel = v => VERDICTS[v].charAt(0).toUpperCase() + VERDICTS[v].slice(1);
const ICON_COPY =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/></svg>';
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('passerelle:' + k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('passerelle:' + k, JSON.stringify(v));
    } catch (e) {
      /* stockage indisponible */
    }
  }
};

/* ---------- Coloration syntaxique ---------- */
const LANGS = {
  json: [
    ['str', '"""[\\s\\S]*?"""'],
    ['kw', '^(?:GET|POST|PUT)\\s.*$'],
    ['key', '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'],
    ['str', '"(?:[^"\\\\]|\\\\.)*"'],
    ['num', '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'],
    ['kw', '\\b(?:true|false|null)\\b']
  ],
  sql: [
    ['com', '--.*$'],
    ['str', "'(?:[^'\\\\]|\\\\.)*'"],
    ['key', '`[^`]*`'],
    [
      'kw',
      '\\b(?:SELECT|FROM|WHERE|AND|OR|NOT|IN|AS|GROUP|BY|ORDER|LIMIT|OFFSET|HAVING|WITH|FILL|STEP|INTERVAL|ASC|DESC|NULLS|FIRST|LAST|BETWEEN|LIKE|ILIKE|OVER|PARTITION|ROWS|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|ROW|SETTINGS|ALTER|TABLE|ADD|COLUMN|INDEX|TYPE|GRANULARITY|MATERIALIZE|MATERIALIZED|EXCEPT|NULL|EXPLAIN|HOUR|DAY|MINUTE|SECOND|WEEK|MONTH|YEAR|QUARTER|MILLISECOND|Nullable|String|Int64|Float64|Bool)\\b'
    ],
    ['fn', '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\()'],
    ['num', '\\b\\d+(?:\\.\\d+)?\\b']
  ],
  vrl: [
    ['com', '#.*$'],
    ['str', "[sr]'(?:[^'\\\\]|\\\\.)*'"],
    ['str', '"(?:[^"\\\\]|\\\\.)*"'],
    ['kw', '\\b(?:if|else|abort|null|true|false)\\b'],
    ['fn', '\\b[a-z_][a-z0-9_]*!?(?=\\()'],
    ['path', '(?<![\\w)\\]"])[.%](?:"[^"]*"|[A-Za-z_@][\\w@]*)(?:\\.(?:"[^"]*"|[A-Za-z_@][\\w@]*))*'],
    ['num', '\\b\\d+(?:\\.\\d+)?\\b']
  ],
  logstash: [
    ['com', '#.*$'],
    ['str', '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\''],
    ['kw', '\\b(?:if|else|and|or|not|in|xor|nand)\\b'],
    ['path', '(?:\\[[^\\]\\s"\',]+\\])+'],
    ['fn', '\\b[a-z_][a-z0-9_]*(?=\\s*\\{)'],
    ['op', '=>|==|!=|=~|!~'],
    ['num', '\\b\\d+(?:\\.\\d+)?\\b']
  ],
  bash: [
    ['com', '(?:^|\\s)#.*$'],
    ['str', '\'(?:[^\'])*\'|"(?:[^"\\\\]|\\\\.)*"'],
    ['env', '\\$\\{?[A-Z_][A-Z0-9_]*\\}?'],
    ['kw', '\\b(?:curl|vector|clickhouse|docker|kubectl|passerelle|jq|for|do|done|in)\\b'],
    ['fn', '(?<=\\s)--?[A-Za-z][\\w-]*']
  ]
};
const RE_CACHE = {};
function hlRules(text, lang) {
  const rules = LANGS[lang];
  if (!rules) return esc(text);
  const re = RE_CACHE[lang] || (RE_CACHE[lang] = new RegExp(rules.map(r => `(${r[1]})`).join('|'), 'gm'));
  re.lastIndex = 0;
  let out = '',
    last = 0,
    m;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out += esc(text.slice(last, m.index));
    let gi = 1;
    while (gi < m.length && m[gi] === undefined) gi++;
    out += `<span class="t-${rules[gi - 1][0]}">${esc(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}
function hlYAML(text) {
  let block = -1;
  return text
    .split('\n')
    .map(line => {
      const ind = line.match(/^ */)[0].length;
      if (block >= 0) {
        if (!line.trim() || ind > block) return hlRules(line, 'vrl');
        block = -1;
      }
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
    })
    .join('\n');
}
function hlTOML(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map(line => {
      if (inBlock) {
        if (line.trim() === "'''") {
          inBlock = false;
          return "<span class=\"t-str\">'''</span>";
        }
        return hlRules(line, 'vrl');
      }
      if (/^\s*#/.test(line)) return `<span class="t-com">${esc(line)}</span>`;
      if (/^\s*\[.*\]\s*$/.test(line)) return `<span class="t-kw">${esc(line)}</span>`;
      const m = /^(\s*)([\w"\-.]+)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return esc(line);
      if (m[4] === "'''") {
        inBlock = true;
        return `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${esc(m[3])}<span class="t-str">'''</span>`;
      }
      let v = hlRules(m[4], 'json').replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, x => `<span class="t-env">${x}</span>`);
      return `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${esc(m[3])}${v}`;
    })
    .join('\n');
}
function hl(text, lang) {
  if (lang === 'yaml') return hlYAML(text);
  if (lang === 'toml') return hlTOML(text);
  return hlRules(text, lang);
}

/* ---------- Éditeur ---------- */
function makeEditor(host, lang, label, placeholder, onInput) {
  host.innerHTML =
    '<pre aria-hidden="true"><code></code></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>';
  const pre = host.querySelector('pre');
  const code = pre.firstChild;
  const ta = host.querySelector('textarea');
  ta.setAttribute('aria-label', label);
  ta.placeholder = placeholder;
  let tabTraps = true;
  const sync = () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };
  const render = () => {
    code.innerHTML = hl(ta.value, lang) + '\n\n';
    sync();
  };
  ta.addEventListener('input', () => {
    tabTraps = true;
    render();
    onInput(ta.value);
  });
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      tabTraps = false;
      return;
    }
    if (e.key === 'Tab' && tabTraps && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!document.execCommand || !document.execCommand('insertText', false, '  ')) {
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        render();
        onInput(ta.value);
      }
    }
  });
  return {
    get value() {
      return ta.value;
    },
    set value(v) {
      ta.value = v;
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
      render();
    },
    focus() {
      ta.focus();
    }
  };
}

/* ---------- État ---------- */
// En mode serveur, la configuration de référence est fournie par le binaire (sans secrets en clair)
const SERVER_CFG = (() => {
  try {
    const el = document.getElementById('server-config');
    return el ? JSON.parse(el.textContent) : null;
  } catch (e) {
    return null;
  }
})();
const BASE_CFG = SERVER_CFG ? mergeConfig(DEFAULT_CONFIG, SERVER_CFG) : DEFAULT_CONFIG;
let cfg = mergeConfig(BASE_CFG, store.get(SERVER_CFG ? 'config-srv' : 'config', {}));
const CFG_KEY = SERVER_CFG ? 'config-srv' : 'config';
const S = {
  view: store.get('view', 'dsl'),
  dsl: {
    files: [{ name: EXAMPLES.dsl[0].file, text: EXAMPLES.dsl[0].text, example: true }],
    active: 0,
    index: 'logs-*',
    tab: 'sql',
    res: null,
    ed: null,
    lang: 'json'
  },
  ls: {
    files: [{ name: EXAMPLES.ls[0].file, text: EXAMPLES.ls[0].text, example: true }],
    active: 0,
    tab: 'config',
    res: null,
    ed: null,
    lang: 'logstash'
  },
  ingest: {
    files: EXAMPLES.ingest.map(e => ({ name: e.file, text: e.text, example: true })),
    active: 0,
    tab: 'config',
    res: null,
    ed: null,
    lang: 'yaml'
  }
};
// Libellés propres à chaque banc de traduction
const BENCH = {
  dsl: {
    file: 'requete.json',
    label: 'Requête DSL Elasticsearch',
    placeholder:
      'Collez ici une requête DSL, par exemple { "query": { "match_all": {} } }, ou une requête de la console Kibana (GET index/_search).',
    empty: 'Aucune requête à traduire',
    emptyHint: 'Collez une requête DSL à gauche ou déposez des fichiers .json.',
    error: 'Vérifiez les virgules et accolades du JSON, ou la ligne « GET index/_search » en tête.',
    zip: 'passerelle-sql.zip',
    copy: 'SQL'
  },
  ls: {
    file: 'pipeline.conf',
    label: 'Pipeline Logstash',
    placeholder: 'Collez ici un pipeline Logstash : input { kafka { … } } filter { … } output { kafka { … } }',
    empty: 'Aucun pipeline à traduire',
    emptyHint: 'Collez un pipeline Logstash à gauche ou déposez des fichiers .conf.',
    error: 'Vérifiez l’équilibre des accolades et la syntaxe des blocs input, filter et output.',
    zip: 'passerelle-vector.zip',
    copy: 'Configuration'
  },
  ingest: {
    file: 'pipeline.yml',
    label: 'Pipeline d’ingestion Elasticsearch',
    placeholder:
      'Collez ici un pipeline d’ingestion : processors: [ { set: { field: …, value: … } } ], en YAML ou en JSON, ou la requête PUT _ingest/pipeline de la console Kibana.',
    empty: 'Aucun pipeline d’ingestion à traduire',
    emptyHint: 'Collez un pipeline d’ingestion à gauche ou déposez des fichiers .yml ou .json.',
    error: 'Vérifiez l’indentation du YAML (ou les accolades du JSON) et la liste processors.',
    zip: 'passerelle-ingest.zip',
    copy: 'Configuration'
  }
};
let downloads = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}
async function copyText(text, what) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch (e2) {
      ok = false;
    }
    ta.remove();
  }
  toast(
    ok
      ? `${what} copié${/configuration|requête/i.test(what) ? 'e' : ''} dans le presse-papiers`
      : 'La copie a été bloquée par le navigateur : sélectionnez le texte à la main.'
  );
}
async function saveFile(filename, data) {
  if (!downloads) {
    toast('Téléchargement indisponible dans cette vue : utilisez la copie.');
    return;
  }
  try {
    await downloads.save({ filename, data });
    toast(`${filename} prêt`);
  } catch (e) {
    toast('Le téléchargement n’a pas abouti. Utilisez la copie.');
  }
}

/* ---------- Traductions ---------- */
// Pastille d’un fichier : la couleur de son verdict (moteur, base.js)
function statusOf(r) {
  if (!r || r.empty) return 'ok';
  return { ready: 'ok', review: 'warn' }[verdictOf(r)] || 'err';
}
function translate(kind, file) {
  if (!file) return { empty: true };
  try {
    if (kind === 'ingest') {
      if (!file.text.trim()) return { empty: true };
      const pname = f =>
        String(f.name)
          .replace(/^.*[\\/]/, '')
          .replace(/\.(ya?ml|json|txt)$/i, '') || 'pipeline';
      const mine = { name: pname(file), text: file.text };
      // Les autres fichiers ouverts servent aux processeurs pipeline : le pipeline appelé est traduit en place
      const others = S.ingest.files
        .filter(f => f !== file && f.text.trim())
        .map(f => ({ name: pname(f), text: f.text }));
      const all = others.length ? translateIngest([mine, ...others], cfg) : null;
      if (all && !all.error && all.pipelines.some(p => p.name === mine.name)) return all;
      return translateIngest([mine], cfg);
    }
    return kind === 'dsl' ? translateDSL(file.text, cfg, { index: S.dsl.index }) : translateLogstash(file.text, cfg);
  } catch (e) {
    return { error: `Erreur interne du traducteur : ${e.message}` };
  }
}
function run(kind, pulse) {
  const st = S[kind];
  const f = st.files[st.active];
  const r = translate(kind, f);
  const changed =
    !st.res || JSON.stringify(st.res.sql || st.res.yaml || st.res.error) !== JSON.stringify(r.sql || r.yaml || r.error);
  st.res = r;
  if (f) f.status = statusOf(r);
  render(kind);
  if (pulse && changed && !r.error && !r.empty) pulseSeam(kind);
}
const debounced = {};
function runSoon(kind) {
  clearTimeout(debounced[kind]);
  debounced[kind] = setTimeout(() => run(kind, true), 180);
}
function pulseSeam(kind) {
  // Le banc Kibana n’est plus une vue : il vit dans « Autres sources », sous #kb
  const seam = $(`${kind === 'kibana' ? '#kb' : `#view-${kind}`} .seam`);
  seam.classList.remove('run');
  void seam.offsetWidth;
  seam.classList.add('run');
}

/* ---------- Rendu des vues de traduction ---------- */
const TABS = {
  dsl: [
    ['sql', 'SQL'],
    ['notes', 'Remarques'],
    ['anatomy', 'Lecture'],
    ['validate', 'Valider']
  ],
  ls: [
    ['config', 'Configuration'],
    ['flow', 'Topologie'],
    ['notes', 'Remarques'],
    ['validate', 'Valider']
  ],
  ingest: [
    ['config', 'Configuration'],
    ['flow', 'Topologie'],
    ['notes', 'Remarques'],
    ['validate', 'Valider']
  ]
};
function render(kind) {
  const view = $(`#view-${kind}`);
  const st = S[kind];
  const r = st.res || { empty: true };
  // fichiers
  const files = $('[data-role="files"]', view);
  files.hidden = st.files.length < 2;
  files.innerHTML = st.files
    .map(
      (f, i) =>
        `<button class="file-chip" type="button" data-file="${i}" aria-pressed="${i === st.active}"><i class="${f.status || 'ok'}"></i>${esc(f.name)}<span class="x" data-close="${i}" role="button" aria-label="Fermer ${esc(f.name)}">×</span></button>`
    )
    .join('');
  $('[data-role="fname"]', view).textContent = st.files[st.active] ? st.files[st.active].name : '';
  if (kind === 'dsl') $('[data-role="table"]', view).textContent = r.table || cfg.clickhouse.default_table || '';
  // verdict
  const v = $('[data-role="verdict"]', view);
  if (r.empty) {
    v.hidden = true;
  } else if (r.error) {
    v.hidden = false;
    v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-unrecognized"><i></i>${verdictLabel('unrecognized')}</span></div><p class="sentence error">${esc(r.error)}</p>`;
  } else {
    v.hidden = false;
    const { ok, approx, ko } = r.stats;
    const total = ok + approx + ko || 1;
    const verdict = verdictOf(r);
    // Le verdict d’abord : il dit si la sortie part telle quelle ; le pourcentage compte des clauses
    v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-${verdict}"><i></i>${verdictLabel(verdict)}</span><span class="score">${coverage(r.stats).percent} %</span><span class="score-label">traduit automatiquement</span>
      <span class="counts"><span><i class="c-ok"></i>${ok} direct${ok > 1 ? 's' : ''}</span><span><i class="c-approx"></i>${approx} à vérifier</span><span><i class="c-ko"></i>${ko} à reprendre</span></span></div>
      <div class="gauge" role="img" aria-label="${ok} éléments traduits directement, ${approx} à vérifier, ${ko} à reprendre"><span class="c-ok" style="width:${(100 * ok) / total}%"></span><span class="c-approx" style="width:${(100 * approx) / total}%"></span><span class="c-ko" style="width:${(100 * ko) / total}%"></span></div>
      <p class="sentence">${esc(r.sentence || '')}</p>`;
  }
  // onglets
  const tabs = $('[data-role="tabs"]', view);
  tabs.hidden = !!(r.empty || r.error);
  const nNotes = r.notes ? r.notes.length : 0;
  const nErr = r.notes ? r.notes.filter(n => n.level === 'err').length : 0;
  tabs.innerHTML = TABS[kind]
    .map(
      ([id, label]) =>
        `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="${st.tab === id}">${label}${id === 'notes' && nNotes ? `<span class="badge ${nErr ? 'err' : ''}">${nNotes}</span>` : ''}</button>`
    )
    .join('');
  // corps
  const out = $('[data-role="out"]', view);
  const foot = $('.out-foot', view);
  foot.hidden = !!(r.empty || r.error);
  if (r.empty) {
    out.innerHTML = emptyState(kind);
    return;
  }
  if (r.error) {
    out.innerHTML = `<div class="empty"><strong>La saisie n’est pas encore analysable</strong><span>${esc(BENCH[kind].error)}</span></div>`;
    return;
  }
  const tab = st.tab;
  if (tab === 'sql')
    out.innerHTML = r.statements
      .map(
        (s, i) =>
          `<div class="stmt"><div class="stmt-head"><span>${esc(s.title)}</span><button class="icon-btn" type="button" data-copy-stmt="${i}" title="Copier cette requête" aria-label="Copier cette requête">${ICON_COPY}</button></div><pre class="code">${hl(s.sql + ';', 'sql')}</pre></div>`
      )
      .join('');
  else if (tab === 'config')
    out.innerHTML = `<div class="stmt"><div class="stmt-head"><span>vector.${cfg.vector.format}</span><div class="seg" role="group" aria-label="Format">${['yaml', 'toml'].map(f => `<button type="button" data-format="${f}" aria-pressed="${cfg.vector.format === f}">${f.toUpperCase()}</button>`).join('')}</div></div><pre class="code">${hl(r[cfg.vector.format], cfg.vector.format)}</pre></div>`;
  else if (tab === 'notes') out.innerHTML = notesHTML(r.notes);
  else if (tab === 'anatomy') out.innerHTML = anatomyHTML(r);
  else if (tab === 'validate') out.innerHTML = kind === 'dsl' ? validateDSL(r) : validateLS(r, kind);
  else if (tab === 'flow') {
    out.innerHTML = flowHTML(r.graph);
    requestAnimationFrame(() => drawEdges(out, r.graph));
  }
}
function emptyState(kind) {
  const ex = EXAMPLES[kind];
  return `<div class="empty"><strong>${BENCH[kind].empty}</strong>
    <span>${BENCH[kind].emptyHint}</span>
    <div class="row">${ex.map((e, i) => `<button class="btn" type="button" data-load-example="${i}">${esc(e.title)}</button>`).join('')}</div></div>`;
}
const LEVEL = { err: 'À reprendre', warn: 'À vérifier', opt: 'Optimisation', info: 'Information' };
function notesHTML(notes) {
  if (!notes.length)
    return '<div class="empty"><strong>Aucune remarque</strong><span>La traduction est directe, sans approximation.</span></div>';
  return `<ul class="notes">${notes.map(n => `<li class="note ${n.level}"><span class="note-kind">${LEVEL[n.level]}</span><h3>${esc(n.title)}</h3>${n.detail ? `<p>${esc(n.detail)}</p>` : ''}${n.code ? `<pre class="code boxed">${hl(n.code, /^(ALTER|--|PARTITION)/.test(n.code) ? 'sql' : 'vrl')}</pre>` : ''}</li>`).join('')}</ul>`;
}
function anatomyHTML(r) {
  const h = r.human;
  const rows = [
    ['Table ClickHouse', [r.table + (r.matched ? ` (index ${r.matched})` : '')]],
    ['Période', h.period ? [h.period] : []],
    ['Filtres', h.filters],
    ['Exclusions', h.excludes],
    ['Recherche de texte', h.text],
    ['Regroupements', h.groups],
    ['Mesures', h.metrics],
    ['Documents renvoyés', h.hits ? [h.hits] : []],
    ['Champs calculés', h.runtime]
  ].filter(([, v]) => v && v.length);
  return `<dl class="anatomy">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</dd>`).join('')}</dl>`;
}
function chHost() {
  try {
    return new URL(cfg.clickhouse.endpoint).host;
  } catch (e) {
    return cfg.clickhouse.endpoint || 'clickhouse';
  }
}
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
function validateLS(r, kind) {
  const f = `vector.${cfg.vector.format}`;
  // Vector 0.57 et suivants ne remplacent ${VAR} (et $$) qu’avec cette option, que demande l’en-tête du fichier
  const interp = /^# Vector 0\.57 et suivants : lancer avec --dangerously-allow-env-var-interpolation/m.test(
    r.yaml || ''
  );
  const env = (r.env || [])
    .map(e => `${e}=…`)
    .concat(interp ? ['VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true'] : [])
    .join(' ');
  // La table geoip lit sa base MaxMind au démarrage : sans le fichier, Vector refuse le VRL (error[E401])
  const mmdb =
    r.config && r.config.enrichment_tables && r.config.enrichment_tables.geoip && r.config.enrichment_tables.geoip.path;
  const base = mmdb ? mmdb.split('/').pop() : '';
  const cmd = `# 1. Contrôle complet : syntaxe, topologie et compilation du VRL
#    (--no-environment ne compile pas le VRL : préférez --skip-healthchecks)${mmdb ? `\n#    La base geoip doit exister à ${mmdb}` : ''}
${env ? env + ' ' : ''}vector validate --skip-healthchecks ${f}

# 2. Rejouer une étape sur un événement réel extrait du topic source
vector vrl --input evenement.json --program etape.vrl --print-object

${kind === 'ingest' ? '# 3. Lancer : Elastic Agent ou Beats envoient leurs documents au port 5044 (sortie Logstash)' : '# 3. Lancer en parallèle de Logstash (mode shadow conseillé dans la configuration)'}
docker run --rm -v "$PWD/${f}:/etc/vector/vector.${cfg.vector.format}:ro" \\
  ${mmdb ? `-v "$PWD/${base}:${mmdb}:ro" \\\n  ` : ''}${(r.env || []).map(e => `-e ${e} `).join('')}${interp ? '-e VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true ' : ''}timberio/vector:0.59.0-debian --config /etc/vector/vector.${cfg.vector.format}`;
  return `<div class="prose"><p>Cette configuration a été générée pour Vector 0.59 et suit ses règles de typage VRL : chaque appel faillible est traité explicitement.</p>
    <pre class="code boxed">${hl(cmd, 'bash')}</pre>
    <p>L’archive téléchargée contient aussi un squelette de test unitaire, exécutable avec vector test, à compléter avec un message réel.</p></div>`;
}
const KIND_LABEL = n =>
  n.kind === 'source'
    ? `Source ${n.type === 'kafka' ? 'Kafka' : n.type}`
    : n.kind === 'sink'
      ? `Destination ${n.type === 'kafka' ? 'Kafka' : n.type}`
      : n.type === 'route'
        ? 'Aiguillage'
        : 'Étape VRL';
function flowHTML(g) {
  const incoming = {};
  g.edges.forEach(([a, b]) => (incoming[b] = incoming[b] || []).push(a));
  const lvl = {};
  const lv = id => {
    if (lvl[id] !== undefined) return lvl[id];
    lvl[id] = 0;
    const ins = incoming[id] || [];
    lvl[id] = ins.length ? Math.max(...ins.map(lv)) + 1 : 0;
    return lvl[id];
  };
  g.nodes.forEach(n => lv(n.id));
  const rows = [];
  g.nodes.forEach(n => (rows[lvl[n.id]] = rows[lvl[n.id]] || []).push(n));
  return `<div class="flow"><svg class="edges" aria-hidden="true"></svg>${rows.map(row => `<div class="flow-row">${row.map(n => `<div class="node ${n.kind}${n.todo ? ' todo' : ''}" data-node="${esc(n.id)}"><small>${KIND_LABEL(n)}</small><b>${esc(n.label || n.id)}</b>${n.todo ? '<span>contient un filtre à reprendre</span>' : n.drop ? '<span>peut écarter des événements</span>' : n.detail ? `<span>${esc(n.detail)}</span>` : ''}</div>`).join('')}</div>`).join('')}</div>`;
}
function drawEdges(out, g) {
  const flow = $('.flow', out);
  if (!flow) return;
  const svg = $('svg.edges', flow);
  const box = flow.getBoundingClientRect();
  const pos = id => {
    const el = flow.querySelector(`[data-node="${CSS.escape(id)}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left - box.left + b.width / 2, top: b.top - box.top, bottom: b.bottom - box.top };
  };
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = g.edges
    .map(([a, b]) => {
      const p = pos(a),
        q = pos(b);
      if (!p || !q) return '';
      const y1 = p.bottom,
        y2 = q.top,
        dy = Math.max(12, (y2 - y1) / 2);
      return `<path d="M${p.x} ${y1} C${p.x} ${y1 + dy} ${q.x} ${y2 - dy} ${q.x} ${y2}"/>`;
    })
    .join('');
}

/* ---------- Exports ---------- */
const base = name =>
  String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]+/g, '_') || 'fichier';
function notesMD(title, list) {
  return list
    .map(
      ({ name, r }) =>
        `## ${name}\n\n${r.error ? `Erreur : ${r.error}\n` : r.notes.length ? r.notes.map(n => `- **${LEVEL[n.level]}** — ${n.title}${n.detail ? ` : ${n.detail}` : ''}${n.code ? `\n\n\`\`\`\n${n.code}\n\`\`\`` : ''}`).join('\n') : 'Traduction directe, aucune remarque.'}\n`
    )
    .join('\n')
    .replace(/^/, `# ${title}\n\n`);
}
function exportKind(kind) {
  const st = S[kind];
  const results = st.files.map(f => ({ name: f.name, r: translate(kind, f) })).filter(x => !x.r.empty);
  const files = [];
  if (kind === 'dsl') {
    results.forEach(({ name, r }) => {
      if (!r.error)
        files.push({
          name: `sql/${base(name)}.sql`,
          content: `-- Traduit par Passerelle depuis ${name}\n-- Table ClickHouse : ${r.table}\n\n${r.sql}\n`
        });
    });
    files.push({ name: 'NOTES.md', content: notesMD('Remarques de traduction DSL vers SQL', results) });
  } else {
    const fmt = cfg.vector.format;
    results.forEach(({ name, r }) => {
      if (r.error) return;
      files.push({ name: `vector/${base(name)}.${fmt}`, content: r[fmt] });
      const tnames = Object.keys(r.config.transforms || {});
      const first = tnames.find(t => !/_init$/.test(t)) || tnames[0];
      const last = r.lastTransform || tnames[tnames.length - 1];
      if (first && kind === 'ls')
        files.push({
          name: `tests/${base(name)}.test.yaml`,
          content: `# Test unitaire : vector test vector/${base(name)}.${fmt} tests/${base(name)}.test.yaml\n# Remplacez le message par un événement réel du topic source.\ntests:\n  - name: '${base(name)} : événement de référence'\n    inputs:\n      - insert_at: ${first}\n        type: log\n        log_fields:\n          message: '<message réel>'\n    outputs:\n      - extract_from: ${last}\n        conditions:\n          - type: vrl\n            source: |\n              assert!(exists(."@timestamp"))\n`
        });
    });
    files.push({
      name: 'NOTES.md',
      content: notesMD(
        kind === 'ingest'
          ? 'Remarques de traduction des pipelines d’ingestion vers Vector'
          : 'Remarques de traduction Logstash vers Vector',
        results
      )
    });
  }
  files.push({ name: 'passerelle.yaml', content: configToYAML(cfg) });
  saveFile(BENCH[kind].zip, makeZip(files));
}

/* ---------- Fichiers et glisser-déposer ---------- */
function readFiles(list) {
  return Promise.all(
    [...list].map(
      f =>
        new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res({ name: f.name, text: String(fr.result) });
          fr.onerror = () => res(null);
          fr.readAsText(f);
        })
    )
  ).then(x => x.filter(Boolean));
}
function addFiles(kind, files) {
  const st = S[kind];
  if (st.files.length === 1 && (st.files[0].example || !st.files[0].text.trim())) st.files = [];
  files.forEach(f => st.files.push({ name: f.name, text: f.text }));
  st.active = st.files.length - files.length;
  st.files.forEach(f => {
    if (!f.status) f.status = statusOf(translate(kind, f));
  });
  st.ed.value = st.files[st.active].text;
  run(kind, true);
}
async function handleDrop(fileList) {
  handleFiles(await readFiles(fileList));
}
function handleFiles(files) {
  const cfgFile = files.find(
    f => /passerelle.*\.(ya?ml|json)$/i.test(f.name) || (S.view === 'config' && /\.(ya?ml|json)$/i.test(f.name))
  );
  if (cfgFile) {
    importConfig(cfgFile);
    return;
  }
  // Chaque fichier va où son contenu le désigne : export Kibana, tableau Grafana, pipeline d’ingestion, pipeline Logstash, requête DSL
  const kindOf = f => {
    const grafana = /"panels"\s*:|"rows"\s*:/.test(f.text) && /"(?:datasource|targets)"/.test(f.text);
    // Un export Kibana (.ndjson, ou une première ligne qui est un objet sauvegardé ou une règle de détection)
    // va à l’outil Kibana de la vue « autres sources », d’où qu’il soit déposé
    const firstLine = (/^\s*(\{.*)$/m.exec(f.text) || [])[1] || '';
    const savedObject =
      /"attributes"\s*:/.test(firstLine) && /"type"\s*:\s*"/.test(firstLine) && /"id"\s*:/.test(firstLine);
    const detectionRule = /"rule_id"\s*:/.test(firstLine) && /"(?:severity|risk_score)"\s*:/.test(firstLine);
    if (/\.ndjson$/i.test(f.name) || savedObject || detectionRule) return 'kibana';
    // Des watches (console, export _query/watches, définition) vont à l’outil Watcher, d’où qu’elles soient déposées
    if (
      /^[ \t]*(?:PUT|POST)[ \t]+\/?_watcher\/watch\//m.test(f.text) ||
      /"watches"\s*:\s*\[/.test(f.text) ||
      (/"trigger"\s*:/.test(f.text) && /"input"\s*:/.test(f.text) && /"(?:condition|actions)"\s*:/.test(f.text))
    )
      return 'watcher';
    // Dans la vue « autres sources », un fichier .json ou .txt va à l’outil choisi (schéma, analyseurs), sauf un tableau Grafana reconnu ;
    // l’outil Kibana ne lit que les exports reconnus plus haut : tout autre fichier va où son contenu l’envoie
    if (S.view === 'tools' && !TOOLS[S.tools.tool].bench && /\.(json|txt|es)$/i.test(f.name) && !grafana)
      return 'tools';
    if (/\.(conf|cfg|logstash)$/i.test(f.name)) return 'ls';
    if (grafana) return 'grafana';
    if (/^\s*[{\[]?\s*"?(?:processors|description)"?\s*:/m.test(f.text) && /"?processors"?\s*:/.test(f.text))
      return 'ingest';
    if (/\.ya?ml$/i.test(f.name)) return 'ingest';
    if (S.view === 'ls' && !/\.json$/i.test(f.name)) return 'ls';
    return 'dsl';
  };
  const groups = {};
  files.forEach(f => (groups[kindOf(f)] = groups[kindOf(f)] || []).push(f));
  let last = null;
  for (const [k, list] of Object.entries(groups)) {
    if (k === 'tools') {
      S.tools.texts[S.tools.tool] = list[0].text;
      S.tools.ed.value = list[0].text;
      runTool();
      last = 'tools';
    } else if (k === 'kibana') {
      addKibanaFiles(list);
      S.tools.tool = 'kibana';
      last = 'tools';
    } else if (k === 'grafana' || k === 'watcher') {
      S.tools.tool = k;
      S.tools.texts[k] = list[0].text;
      S.tools.ed && (S.tools.ed.value = list[0].text);
      runTool();
      last = 'tools';
    } else {
      addFiles(k, list);
      last = k;
    }
  }
  if (last) show(last);
  toast(`${files.length} fichier${files.length > 1 ? 's' : ''} ajouté${files.length > 1 ? 's' : ''}`);
}
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
// La zone de dépôt de la vue ouverte : dans « Autres sources », celle du banc affiché (Kibana ou générique)
const dropPane = () => $$(`#view-${S.view} .pane-in`).find(p => !p.closest('[hidden]'));
window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  const pane = dropPane();
  if (pane) pane.classList.add('dragging');
});
window.addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) $$('.dragging').forEach(x => x.classList.remove('dragging'));
});
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $$('.dragging').forEach(x => x.classList.remove('dragging'));
  handleDrop(e.dataTransfer.files);
});

/* ---------- Configuration ---------- */
const CFG_FORM = [
  {
    title: 'ClickHouse',
    intro: 'Utilisé pour résoudre les tables cibles, renommer les champs et générer les commandes de vérification.',
    fields: [
      ['clickhouse.endpoint', 'Endpoint HTTP(S)', 'text', 'Port 8443 en TLS, 8123 en clair.'],
      ['clickhouse.database', 'Base de données', 'text'],
      ['clickhouse.user', 'Utilisateur', 'text', 'Une variable ${…} est résolue au déploiement.'],
      ['clickhouse.password', 'Mot de passe', 'text', 'Jamais en clair : gardez ${CLICKHOUSE_PASSWORD}.'],
      [
        'clickhouse.sink_user',
        'Utilisateur d’écriture (sortie Vector)',
        'text',
        'Compte qui a INSERT, pour vector.elasticsearch_output: clickhouse. Vide : l’utilisateur ci-dessus.'
      ],
      ['clickhouse.sink_password', 'Mot de passe d’écriture', 'text', 'Gardez ${CLICKHOUSE_SINK_PASSWORD}.'],
      ['clickhouse.default_table', 'Table par défaut', 'text'],
      ['clickhouse.cluster', 'Cluster (optionnel)', 'text', 'Pour cibler des tables Distributed.'],
      ['clickhouse.time_field', 'Colonne temporelle', 'text', 'Tri par défaut des documents.'],
      [
        'clickhouse.timezone',
        'Fuseau du serveur',
        'text',
        'UTC si le serveur et les colonnes de date sont en UTC. Vide : le SQL précise « UTC » dans chaque calcul de date, comme le fait Elasticsearch.'
      ],
      [
        'clickhouse.composite_mode',
        'Agrégations composite',
        'select',
        'page : une requête par page, avec curseur. stream : une seule requête sans pagination, à lire en flux.',
        ['page', 'stream']
      ],
      [
        'clickhouse.text_match',
        'Recherche plein texte',
        'select',
        'tokens : hasToken seul pour un mot simple, lisible et indexable. strict : chaque mot est vérifié par une expression régulière, pour le découpage exact d’Elasticsearch.',
        ['tokens', 'strict']
      ],
      [
        'clickhouse.lists.threshold',
        'Seuil des listes nommées',
        'text',
        'Au-delà de ce nombre de valeurs, une liste (terms, should…) quitte le SQL pour une table. 0 : jamais.'
      ],
      ['clickhouse.lists.table', 'Table des listes', 'text', 'Vide : passerelle_lists dans la base de données.'],
      [
        'clickhouse.text_fields',
        'Champs plein texte',
        'list',
        'Séparés par des virgules. Recherche par tokens (hasToken).'
      ]
    ],
    maps: [
      ['clickhouse.index_mapping', 'Index ou motif Elasticsearch', 'Table ClickHouse', 'Correspondance index → table'],
      ['clickhouse.field_mapping', 'Champ Elasticsearch', 'Colonne ClickHouse', 'Renommage des champs'],
      [
        'clickhouse.columns',
        'Colonne ClickHouse',
        'Type, par exemple Nullable(String)',
        'Types des colonnes : champs facultatifs (Nullable), multivalués (Array), entiers et dates'
      ]
    ],
    toggles: [
      [
        'clickhouse.empty_as_missing',
        'Chaîne vide = champ absent',
        "Dans une colonne String non Nullable, une chaîne vide représente un champ absent : exists devient colonne != '' et les regroupements l’ignorent."
      ]
    ]
  },
  {
    title: 'Kafka',
    intro:
      'Laissez un champ vide pour reprendre la valeur écrite dans le pipeline Logstash. Renseigné, il s’impose à tous les pipelines traduits.',
    fields: [
      ['kafka.bootstrap_servers', 'Bootstrap servers', 'text', 'hôte:port, séparés par des virgules.'],
      [
        'kafka.security_protocol',
        'Protocole de sécurité',
        'select',
        '',
        ['', 'PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL']
      ],
      ['kafka.sasl_mechanism', 'Mécanisme SASL', 'select', '', ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']],
      ['kafka.ca_file', 'Certificat d’autorité (PEM)', 'text'],
      ['kafka.username', 'Utilisateur SASL', 'text'],
      ['kafka.password', 'Mot de passe SASL', 'text', 'Gardez ${KAFKA_PASSWORD}.'],
      ['kafka.consumer_group', 'Groupe de consommateurs', 'text', 'Nom du consumer group lu par Vector.'],
      ['kafka.input_topics', 'Topics d’entrée', 'list', 'Séparés par des virgules ; ^regex accepté.'],
      ['kafka.output_topic', 'Topic de sortie', 'text', 'Appliqué quand le pipeline n’a qu’une sortie Kafka.']
    ]
  },
  {
    title: 'Vector',
    intro: 'Options de génération des configurations.',
    toggles: [
      [
        'vector.log_namespace',
        'Isoler les métadonnées Kafka',
        'Topic, offset et clé restent hors de la charge utile : les messages écrits sont identiques à ceux de Logstash.'
      ],
      [
        'vector.logstash_compat',
        'Compatibilité Logstash',
        'Ajoute @timestamp et @version et reproduit le format de date de Logstash, pour ne rien changer côté consommateurs.'
      ],
      [
        'vector.acknowledgements',
        'Accusés de réception de bout en bout',
        'L’offset Kafka n’est validé qu’une fois l’événement écrit dans le topic de sortie.'
      ],
      [
        'vector.shadow_mode',
        'Mode shadow',
        'Suffixe -shadow sur le groupe et les topics de sortie : Vector tourne à côté de Logstash sans lui prendre de partitions, le temps de comparer.'
      ]
    ],
    fields: [
      ['vector.format', 'Format de sortie', 'select', '', ['yaml', 'toml']],
      [
        'vector.ecs_compatibility',
        'Compatibilité ECS',
        'select',
        'v8 : comme Logstash 8 et suivants ([event][original], noms ECS des motifs grok, cibles de fingerprint et translate). disabled : pipelines d’avant ECS. Un réglage ecs_compatibility écrit dans le pipeline l’emporte.',
        ['v8', 'disabled']
      ]
    ]
  }
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v;
};
function renderConfigForm() {
  $('#cfg-form').innerHTML = CFG_FORM.map(
    sec => `<section class="form-section"><h2>${sec.title}</h2><p>${sec.intro}</p>
    ${sec.toggles ? `<div class="toggles">${sec.toggles.map(([p, t, d]) => `<label class="toggle"><input type="checkbox" data-path="${p}" ${getPath(cfg, p) ? 'checked' : ''}><div><b>${t}</b><span>${d}</span></div></label>`).join('')}</div>` : ''}
    <div class="fields">${sec.fields
      .map(([p, label, type, help, opts]) => {
        const val = getPath(cfg, p);
        const id = 'f-' + p.replace(/\W/g, '-');
        const input =
          type === 'select'
            ? `<select id="${id}" data-path="${p}">${opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o || 'repris du pipeline'}</option>`).join('')}</select>`
            : `<input id="${id}" data-path="${p}" data-type="${type}" value="${esc(type === 'list' ? (val || []).join(', ') : val || '')}" spellcheck="false" placeholder="${p.startsWith('kafka.') ? 'repris du pipeline' : ''}">`;
        return `<div class="field ${type === 'list' && p.includes('topics') ? 'wide' : ''}"><label for="${id}">${label}</label>${input}${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
      })
      .join('')}</div>
    ${(sec.maps || [])
      .map(
        ([p, a, b, t]) =>
          `<div class="field wide"><span>${t}</span><div class="map-rows" data-map="${p}">${Object.entries(
            getPath(cfg, p) || {}
          )
            .map(([k, v]) => mapRow(k, v, a, b))
            .join(
              ''
            )}</div><button class="btn quiet" type="button" data-add-map="${p}" data-a="${a}" data-b="${b}" style="justify-self:start">Ajouter une correspondance</button></div>`
      )
      .join('')}
  </section>`
  ).join('');
  renderConfigPreview();
}
const mapRow = (k, v, a, b) =>
  `<div class="map-row"><input value="${esc(k)}" aria-label="${a}" placeholder="${a}" spellcheck="false"><span class="arrow" aria-hidden="true">→</span><input value="${esc(v)}" aria-label="${b}" placeholder="${b}" spellcheck="false"><button class="icon-btn" type="button" data-del-map aria-label="Supprimer la correspondance">×</button></div>`;
function readMaps() {
  $$('[data-map]').forEach(box => {
    const o = {};
    $$('.map-row', box).forEach(row => {
      const [k, v] = $$('input', row).map(i => i.value.trim());
      if (k) o[k] = v;
    });
    setPath(cfg, box.dataset.map, o);
  });
}
function renderConfigPreview() {
  $('#cfg-preview').innerHTML = hl(configToYAML(cfg), 'yaml');
  renderEnv();
}
function renderEnv() {
  const k = cfg.kafka.bootstrap_servers ? cfg.kafka.bootstrap_servers.split(',')[0] : 'repris des pipelines';
  $('#env-chip').innerHTML =
    `<span>ClickHouse<em title="${esc(cfg.clickhouse.endpoint)}">${esc(chHost())}</em></span><span>Kafka<em title="${esc(k)}">${esc(k)}</em></span>${cfg.vector.shadow_mode ? '<span>Mode<em>shadow</em></span>' : ''}${SERVER_CFG ? '<span>Source<em>serveur</em></span>' : ''}`;
  $('#index-list').innerHTML = Object.keys(cfg.clickhouse.index_mapping || {})
    .map(k2 => `<option value="${esc(k2)}">`)
    .join('');
}
function configChanged() {
  store.set(CFG_KEY, cfg);
  renderConfigPreview();
  clearTimeout(configChanged.h);
  configChanged.h = setTimeout(() => {
    run('dsl');
    run('ls');
    run('ingest');
    runKibana();
  }, 250);
}
function importConfig(f) {
  try {
    const parsed = /\.json$/i.test(f.name) ? JSON.parse(f.text) : parseYAMLConfig(f.text);
    cfg = mergeConfig(DEFAULT_CONFIG, { clickhouse: parsed.clickhouse, kafka: parsed.kafka, vector: parsed.vector });
    store.set(CFG_KEY, cfg);
    renderConfigForm();
    run('dsl');
    run('ls');
    run('ingest');
    runKibana();
    toast(`Configuration importée depuis ${f.name}`);
  } catch (e) {
    toast(`${f.name} n’est pas lisible : ${e.message}`);
  }
}

/* ---------- Vues documentaires ---------- */
function renderAPI() {
  const ch = (cfg.clickhouse.endpoint || '').replace(/\/+$/, '');
  $('#view-api').innerHTML =
    `<header class="view-head"><div><h1>API et infrastructure as code</h1><p>Le moteur de traduction de cette interface est une bibliothèque autonome. Exposée en API et en CLI, elle traduit automatiquement tout ce qui est versionné dans Git, avec la même configuration.</p></div></header>
  <div class="doc">
    <section><h2>Contrat d’API</h2><p>Service sans état, authentifié par jeton, documenté en OpenAPI. Les réponses reprennent exactement ce qu’affiche l’interface : SQL ou configuration, remarques et taux de couverture.</p>
      <div class="endpoints">${[
        [
          'POST',
          '/v1/translate/dsl?index=logs-*',
          'Traduit une requête DSL (JSON brut ou format console Kibana). Renvoie verdict, sql, statements, parameters, notes et coverage.'
        ],
        [
          'POST',
          '/v1/translate/logstash?format=yaml',
          'Traduit un pipeline .conf. Renvoie le verdict, la configuration Vector, la topologie et les remarques.'
        ],
        [
          'POST',
          '/v1/translate/logstash/pipelines',
          'Traduit tout un parc de pipelines : pipelines.yml (ou { pipelines, files }) devient une seule configuration Vector, les sorties pipeline { send_to } reliées entre elles.'
        ],
        [
          'POST',
          '/v1/translate/ingest?format=yaml',
          'Traduit des pipelines d’ingestion Elasticsearch (YAML, JSON ou requête PUT _ingest/pipeline, ou { files }) en VRL, avec verdict par pipeline.'
        ],
        [
          'POST',
          '/v1/inventory/kibana?format=json',
          'Inventaire d’un export Kibana (.ndjson) : objets, requêtes traduites, verdict et effort par objet. Formats json, md, html, csv.'
        ],
        [
          'POST',
          '/v1/translate/watcher?format=json',
          'Traduit des watches Elasticsearch (export _query/watches, GET _watcher/watch/<id> ou console) : requête SQL, décision de la condition, planification et actions à recréer, verdict et effort par watch. Formats json, md, html, csv.'
        ],
        [
          'POST',
          '/v1/translate/grafana?format=md',
          'Convertit un tableau de bord Grafana de la source Elasticsearch au plugin ClickHouse. Sans format, renvoie le tableau converti et son rapport.'
        ],
        [
          'POST',
          '/v1/schema/ddl?preset=otel&format=sql',
          'CREATE TABLE ClickHouse déduit d’un mapping ou d’un modèle d’index (ou { files }). Sans format, renvoie verdict, sql, profils par table et remarques.'
        ],
        [
          'POST',
          '/v1/schema/analyzers?text=…&field=…',
          'Plan ClickHouse des analyseurs personnalisés d’un mapping : colonne de mots, index, requêtes, et aperçu des mots pour le texte donné. format=md pour le rapport.'
        ],
        [
          'POST',
          '/v1/validate/sql',
          'Vérifie les tables lues (EXPLAIN AST), puis exécute EXPLAIN indexes = 1 sur le ClickHouse de recette et renvoie le plan. Paramètres : param_nom=… dans l’adresse.'
        ],
        ['POST', '/v1/validate/vector', 'Compile la configuration et son VRL avec vector validate.'],
        ['GET', '/v1/config', 'Configuration active, secrets masqués.']
      ]
        .map(
          ([vb, p, d]) => `<div class="endpoint"><span class="verb">${vb}</span><code>${esc(p)}</code><p>${d}</p></div>`
        )
        .join('')}</div></section>
    <section><h2>Traduire depuis un script</h2>${codeCard(
      'curl',
      `curl -sS -X POST "https://passerelle.internal/v1/translate/dsl?index=logs-*" \\
  -H "Authorization: Bearer $PASSERELLE_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary @requetes/erreurs_5xx.json | jq -r .sql > sql/erreurs_5xx.sql

curl -sS -X POST "https://passerelle.internal/v1/translate/logstash?format=${cfg.vector.format}" \\
  -H "Authorization: Bearer $PASSERELLE_TOKEN" \\
  --data-binary @pipelines/nginx.conf | jq -r .config > vector/nginx.${cfg.vector.format}`,
      'bash'
    )}</section>
    <section><h2>CLI pour les dépôts Git</h2><p>La CLI lit passerelle.yaml, traduit des dossiers entiers et échoue si une traduction contient un élément à reprendre : les régressions sont bloquées avant la fusion.</p>${codeCard(
      'CLI',
      `passerelle dsl2sql requetes/ --config passerelle.yaml --out build/sql --fail-on todo
passerelle ls2vector pipelines/ --config passerelle.yaml --format ${cfg.vector.format} --out build/vector --fail-on todo
passerelle ingest ingest_pipelines/ --config passerelle.yaml --out build/ingest --fail-on todo
passerelle kibana export.ndjson --config passerelle.yaml --format md --out build/kibana
passerelle grafana tableaux/ --config passerelle.yaml --out build/grafana
passerelle watcher watches.json --config passerelle.yaml --out build/watcher
passerelle watcher pull --config passerelle.yaml --out build/watcher
passerelle schema ddl modeles/ --config passerelle.yaml --out build/schema
passerelle schema analyzers modeles/catalogue.txt --text "Les téléviseurs d’été" --out build/analyseurs`,
      'bash'
    )}</section>
    <section><h2>Chaîne d’intégration continue</h2><p>Exemple GitLab CI : traduction, validation avec les vrais moteurs, puis déploiement de la configuration Vector par ConfigMap, repris par Argo CD.</p>${codeCard(
      '.gitlab-ci.yml',
      `stages: [traduire, valider, deployer]

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
  image: timberio/vector:0.59.0-debian
  script:
    - mkdir -p /var/lib/vector
    - for f in build/vector/*.${cfg.vector.format}; do vector validate --skip-healthchecks "$f"; done

valider_sql:
  stage: valider
  image: clickhouse/clickhouse-server:26.9
  script:
    - for f in build/sql/*.sql; do clickhouse format --multiquery < "$f" > /dev/null; done

deployer:
  stage: deployer
  when: manual
  script:
    - kubectl create configmap vector-pipelines --from-file=build/vector/ --dry-run=client -o yaml > gitops/vector-pipelines.yaml
    - git -C gitops commit -am "Pipelines Vector $CI_COMMIT_SHORT_SHA" && git -C gitops push`,
      'yaml'
    )}</section>
    <section><h2>Configuration de référence</h2><p>Endpoint ClickHouse actuel : ${esc(ch || 'non renseigné')}. Kafka : ${esc(cfg.kafka.bootstrap_servers || 'repris des pipelines')}. Modifiez ces valeurs dans Configuration ; les exemples ci-dessus suivent.</p></section>
  </div>`;
}
function codeCard(title, code, lang) {
  return `<div class="codecard"><div class="stmt-head"><span>${esc(title)}</span><button class="icon-btn" type="button" data-copy-raw="${esc(code)}" aria-label="Copier">${ICON_COPY}</button></div><pre class="code">${hl(code, lang)}</pre></div>`;
}
function renderArch() {
  const L = (name, sub, boxes, note) =>
    `<div class="layer"><div class="layer-name">${name}<small>${sub}</small></div><div class="boxes">${boxes.map(([b, s, core]) => `<div class="box${core ? ' core' : ''}"><b>${b}</b><span>${s}</span></div>`).join('')}</div>${note ? `<div class="layer-note">${note}</div>` : ''}</div>`;
  $('#view-arch').innerHTML =
    `<header class="view-head"><div><h1>Architecture cible</h1><p>Un moteur de traduction unique, trois façons de l’utiliser, et une validation systématique par les vrais moteurs avant tout déploiement.</p></div></header>
  <div class="doc">
    <section class="layers">
      ${L('Entrées', 'qui soumet', [
        ['Interface web', 'Glisser-déposer, lecture en langage clair, revue des remarques.'],
        ['API REST', 'Intégration aux outils existants, traductions à la demande.'],
        ['Dépôt Git', 'Requêtes, pipelines et passerelle.yaml versionnés ensemble.']
      ])}
      ${L(
        'Moteur',
        'bibliothèque TypeScript',
        [
          ['Analyseurs', 'DSL, Lucene, Painless, grammaire Logstash.', 1],
          ['Modèle intermédiaire', 'Types, dépendances entre champs, conditions.', 1],
          ['Générateurs', 'SQL ClickHouse optimisé, Vector et VRL typé.', 1]
        ],
        'Le même code tourne dans le navigateur, l’API et la CLI : un résultat identique partout.'
      )}
      ${L('Validation', 'avant déploiement', [
        ['ClickHouse de recette', 'clickhouse format, puis EXPLAIN indexes = 1.'],
        ['Vector CLI', 'vector validate compile le VRL ; vector test rejoue des événements.'],
        ['Tests différentiels', 'Mêmes données en entrée, sorties comparées à Elasticsearch et Logstash.']
      ])}
      ${L('Exécution', 'production', [
        ['ClickHouse', 'MergeTree partitionné par jour, index de tokens pour le texte.'],
        ['Vector sur Kubernetes', 'Configuration en ConfigMap, déployée par Argo CD.'],
        ['Kafka', 'Topics source et destination inchangés pour les consommateurs.']
      ])}
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
/* ---------- Autres sources : Kibana, Grafana, Watcher, schéma, analyseurs ---------- */
// Rendu minimal d’un rapport Markdown : titres, listes, tableaux, blocs de code, gras, italique, code
function mdInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}
function mdHTML(md) {
  const L = String(md).split('\n');
  const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push(`<pre class="code boxed">${hl(buf.join('\n'), lang || 'sql')}</pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1].length + 1}>${mdInline(h[2])}</h${h[1].length + 1}>`);
      i++;
      continue;
    }
    if (/^\|/.test(l) && /^\|[\s:|-]+\|?$/.test(L[i + 1] || '')) {
      const cells = r =>
        r
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map(c => c.trim().replace(/\\\|/g, '|'));
      // Colonnes alignées à droite (---:) : des nombres, gardés sur une ligne
      const head = cells(l);
      const num = cells(L[i + 1]).map(c => /-:$/.test(c));
      i += 2;
      const rows = [];
      while (i < L.length && /^\|/.test(L[i])) rows.push(cells(L[i++]));
      const td = (tag, c, j) => `<${tag}${num[j] ? ' class="n"' : ''}>${mdInline(c)}</${tag}>`;
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, j) => td('td', c, j)).join('')}</tr>`).join('')}</tbody></table></div>`
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < L.length && /^\s*[-*]\s+/.test(L[i])) items.push(L[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(`<ul>${items.map(x => `<li>${mdInline(x)}</li>`).join('')}</ul>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|\||\s*[-*]\s)/.test(L[i])) para.push(L[i++]);
    out.push(`<p>${mdInline(para.join(' '))}</p>`);
  }
  return `<div class="prose md">${out.join('')}</div>`;
}
// Le pire verdict d’une liste, du pire au meilleur : non reconnu, à reprendre, à vérifier, prêt
const worstOf = list => ['unrecognized', 'todo', 'review', 'ready'].find(v => list.includes(v)) || 'ready';
const schemaText = t => (/^\s*(GET|PUT|POST)\s/i.test(t) ? t : `POST _passerelle\n${t}`);
const notesMDList = notes =>
  notes.map(n => `- **${LEVEL[n.level] || n.level}** — ${n.title}${n.detail ? ` : ${n.detail}` : ''}`).join('\n');
const TOOLS = {
  // Kibana n’a pas de rapport générique : son banc (l’arbre des objets à gauche, les requêtes de l’objet choisi à droite)
  // est plus bas, avec le reste de son code (setupKibana, renderKibana)
  kibana: { label: 'Kibana', bench: 'kibana' },
  grafana: {
    label: 'Tableau Grafana',
    title: 'Tableau de bord Grafana (JSON)',
    file: 'tableau.json',
    hint: 'Fichiers .json : l’export d’un tableau de bord (schéma classique)',
    opts: [['index', 'Index', 'text', 'logs-*']],
    run(text) {
      const r = grafanaDashboard(text, cfg, { index: S.tools.opts.index || '' });
      if (r.error) return { error: r.error };
      if (r.empty) return { error: 'Aucune requête Elasticsearch dans ce tableau de bord.' };
      const v = r.summary.byVerdict;
      const md = grafanaReportMarkdown(r);
      const json = JSON.stringify(r.dashboard, null, 2);
      return {
        verdict: r.verdict,
        counts: { ok: v.ready, approx: v.review, ko: v.todo + (v.unrecognized || 0) },
        sentence: `${r.summary.panels} panneau${r.summary.panels > 1 ? 'x' : ''} converti${r.summary.panels > 1 ? 's' : ''} pour le plugin ClickHouse.`,
        tabs: [
          ['rapport', 'Rapport', 'md', md],
          ['json', 'Tableau converti', 'json', json]
        ],
        files: [
          { name: 'grafana/tableau-clickhouse.json', content: json },
          { name: 'grafana/rapport.md', content: md }
        ],
        copy: json
      };
    }
  },
  watcher: {
    label: 'Watcher',
    title: 'Watches Elasticsearch',
    file: 'watches.json',
    hint: 'Fichiers .json ou .txt : GET _watcher/_query/watches, GET _watcher/watch/<id> ou PUT _watcher/watch/<id> de la console',
    run(text) {
      const rep = watcherTranslate(text, cfg, {});
      if (!rep.entries.length)
        return { error: `Aucune watch lisible${rep.source.errors.length ? ` (${rep.source.errors[0]})` : ''}.` };
      const s = rep.summary;
      const b = s.byVerdict;
      const md = watcherReportMarkdown(rep);
      const csv = watcherReportCSV(rep);
      const sqlFiles = watcherSQLFiles(rep);
      const sql = sqlFiles.map(f => f.content).join('\n') || '-- aucune requête traduite';
      return {
        verdict: s.watches ? worstOf(Object.keys(b).filter(k => b[k])) : 'ready',
        counts: { ok: b.ready, approx: b.review, ko: b.todo + b.unrecognized },
        sentence: `${nb(s.watches, 'watch à migrer', 'watches à migrer')}, ${nb(s.conditions, 'condition traduite', 'conditions traduites')} en décision SQL. Effort estimé : ${frHours(s.effort.hours)}.${s.skipped ? ` ${nb(s.skipped, 'watch de Stack Monitoring', 'watches de Stack Monitoring')}, sans objet.` : ''}`,
        tabs: [
          ['rapport', 'Rapport', 'md', md],
          ['sql', 'SQL', 'sql', sql],
          ['csv', 'CSV', 'text', csv]
        ],
        files: [
          { name: 'watcher/rapport.md', content: md },
          { name: 'watcher/rapport.csv', content: csv },
          { name: 'watcher/rapport.html', content: watcherReportHTML(rep, 'Watches Elasticsearch') }
        ].concat(sqlFiles.map(f => ({ name: `watcher/sql/${f.name}`, content: f.content }))),
        copy: md
      };
    }
  },
  schema: {
    label: 'Schéma',
    title: 'Modèles d’index et mappings',
    file: 'modele.txt',
    hint: 'Fichiers .json ou .txt : PUT _index_template, PUT mon-index, GET _mapping, politique ILM',
    opts: [
      [
        'preset',
        'Préréglage',
        'select',
        '',
        [
          ['', 'Aucun'],
          ['otel', 'OpenTelemetry'],
          ['otel-json', 'OpenTelemetry (JSON)']
        ]
      ]
    ],
    run(text) {
      const r = schemaFromElastic(schemaText(text), cfg, { preset: S.tools.opts.preset || undefined });
      if (r.error) return { error: r.error };
      if (r.empty) return { error: 'Aucun mapping lisible.' };
      return {
        verdict: verdictOf(r),
        counts: r.stats,
        sentence: `${r.tables.length} table${r.tables.length > 1 ? 's' : ''} ClickHouse à créer.`,
        tabs: [
          ['ddl', 'CREATE TABLE', 'sql', r.sql],
          ['profils', 'Profils', 'yaml', r.yaml],
          ['notes', 'Remarques', 'md', notesMDList(r.notes) || 'Aucune remarque.']
        ],
        files: [
          { name: 'schema/schema.sql', content: r.sql },
          { name: 'schema/passerelle.tables.yaml', content: r.yaml }
        ],
        copy: r.sql
      };
    }
  },
  analyzers: {
    label: 'Analyseurs',
    title: 'Index avec analyseurs personnalisés',
    file: 'catalogue.txt',
    hint: 'Fichiers .json ou .txt : la définition de l’index (settings.analysis et mappings)',
    opts: [
      ['field', 'Champ', 'text', 'tous'],
      ['text', 'Texte d’essai', 'text', 'Les téléviseurs d’été']
    ],
    run(text) {
      const r = schemaFromElastic(schemaText(text), cfg, {});
      if (r.error) return { error: r.error };
      if (r.empty) return { error: 'Aucun mapping lisible.' };
      const o = S.tools.opts;
      const rep = anReport(r.tables, o.text || undefined, o.field || undefined);
      const ps = rep.plans.map(p => p.plan.verdict);
      const sql = rep.plans
        .filter(p => p.plan.ddl)
        .map(p => `-- ${p.plan.table} · ${p.plan.field} · analyseur ${p.plan.name}\n${p.plan.ddl.join('\n')}`)
        .join('\n\n');
      return {
        verdict: rep.verdict,
        counts: {
          ok: ps.filter(v => v === 'ready').length,
          approx: ps.filter(v => v === 'review').length,
          ko: ps.filter(v => v === 'todo').length
        },
        sentence: rep.plans.length
          ? `${rep.plans.length} analyseur${rep.plans.length > 1 ? 's' : ''} à traduire en colonne de mots et index de texte.`
          : 'Aucun analyseur personnalisé : le standard est déjà reproduit par la traduction des requêtes.',
        tabs: [
          ['rapport', 'Plan', 'md', rep.markdown],
          ['ddl', 'DDL', 'sql', sql || '-- aucun analyseur à traduire']
        ],
        files: [
          { name: 'analyseurs/analyseurs.md', content: rep.markdown },
          { name: 'analyseurs/analyseurs.sql', content: sql + '\n' }
        ],
        copy: sql
      };
    }
  }
};
S.tools = {
  tool: store.get('tool', 'kibana'),
  texts: {},
  opts: { index: 'logs-*', preset: '', field: '', text: 'Les téléviseurs d’été' },
  tab: {},
  res: null,
  ed: null
};
if (!TOOLS[S.tools.tool]) S.tools.tool = 'kibana';
Object.keys(TOOLS).forEach(k => {
  if (!TOOLS[k].bench) S.tools.texts[k] = EXAMPLES[k][0].text;
  S.tools.tab[k] = null;
});
function runTool() {
  const st = S.tools;
  const t = TOOLS[st.tool];
  if (!t.bench) {
    const text = st.texts[st.tool] || '';
    try {
      st.res = text.trim() ? t.run(text) : { empty: true };
    } catch (e) {
      st.res = { error: `Erreur interne : ${e.message}` };
    }
  }
  renderTools();
}
function renderTools() {
  const st = S.tools;
  const t = TOOLS[st.tool];
  const view = $('#view-tools');
  if (!view) return;
  $$('[data-tool]', view).forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === st.tool));
  // Kibana a son propre banc ; les autres outils se partagent le banc générique
  const kb = t.bench === 'kibana';
  $('#kb', view).hidden = !kb;
  $('#tools-bench', view).hidden = kb;
  $('[data-role="file"]', view).accept = kb ? '.ndjson,.json,.txt' : '';
  // Les exemples proposés suivent l’outil, qu’on l’ait choisi ou qu’un fichier déposé l’ait ouvert
  const sel = $('[data-act="example"]', view);
  if (sel.dataset.examplesFor !== st.tool) {
    sel.dataset.examplesFor = st.tool;
    sel.innerHTML = `<option value="">Charger un exemple</option>${EXAMPLES[st.tool].map((e, i) => `<option value="${i}">${esc(e.title)}</option>`).join('')}`;
  }
  if (kb) {
    renderKibana();
    return;
  }
  const bench = $('#tools-bench', view);
  $('[data-role="tool-title"]', bench).textContent = t.title;
  $('[data-role="drop-hint"]', bench).textContent = t.hint;
  $('[data-role="tool-opts"]', bench).innerHTML =
    (t.opts || [])
      .map(
        ([k, label, kind, ph, choices]) =>
          `<label for="tool-${k}">${esc(label)}</label>${kind === 'select' ? `<select id="tool-${k}" data-opt="${k}" class="btn" style="height:30px">${choices.map(([v, l]) => `<option value="${esc(v)}"${st.opts[k] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` : `<input id="tool-${k}" data-opt="${k}" value="${esc(st.opts[k] || '')}" placeholder="${esc(ph)}" spellcheck="false">`}`
      )
      .join('') +
    '<button class="btn quiet" data-act="clear" type="button" style="height:30px;padding:0 9px">Effacer</button>';
  const r = st.res || { empty: true };
  const v = $('[data-role="verdict"]', bench);
  const tabs = $('[data-role="tabs"]', bench);
  const out = $('[data-role="out"]', bench);
  $('.out-foot', bench).hidden = !!(r.empty || r.error);
  if (r.empty) {
    v.hidden = true;
    tabs.hidden = true;
    out.innerHTML = `<div class="empty"><strong>Rien à analyser</strong><span>${esc(t.hint)}. Collez le contenu à gauche ou chargez un exemple.</span><div class="row">${EXAMPLES[st.tool].map((e, i) => `<button class="btn" type="button" data-load-example="${i}">${esc(e.title)}</button>`).join('')}</div></div>`;
    return;
  }
  if (r.error) {
    v.hidden = false;
    v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-unrecognized"><i></i>${verdictLabel('unrecognized')}</span></div><p class="sentence error">${esc(r.error)}</p>`;
    tabs.hidden = true;
    out.innerHTML = '';
    $('.out-foot', bench).hidden = true;
    return;
  }
  const { ok, approx, ko } = r.counts;
  const total = ok + approx + ko || 1;
  v.hidden = false;
  v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-${r.verdict}"><i></i>${verdictLabel(r.verdict)}</span>
    <span class="counts"><span><i class="c-ok"></i>${ok} prêt${ok > 1 ? 's' : ''}</span><span><i class="c-approx"></i>${approx} à vérifier</span><span><i class="c-ko"></i>${ko} à reprendre</span></span></div>
    <div class="gauge" role="img" aria-label="${ok} prêts, ${approx} à vérifier, ${ko} à reprendre"><span class="c-ok" style="width:${(100 * ok) / total}%"></span><span class="c-approx" style="width:${(100 * approx) / total}%"></span><span class="c-ko" style="width:${(100 * ko) / total}%"></span></div>
    <p class="sentence">${esc(r.sentence)}</p>`;
  const cur = r.tabs.find(x => x[0] === st.tab[st.tool]) || r.tabs[0];
  st.tab[st.tool] = cur[0];
  tabs.hidden = r.tabs.length < 2;
  tabs.innerHTML = r.tabs
    .map(
      ([id, label]) =>
        `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="${cur[0] === id}">${esc(label)}</button>`
    )
    .join('');
  const [, , kind, body] = cur;
  out.innerHTML =
    kind === 'md' ? mdHTML(body) : `<pre class="code">${kind === 'text' ? esc(body) : hl(body, kind)}</pre>`;
}
function setupTools() {
  const view = $('#view-tools');
  const st = S.tools;
  const bench = $('#tools-bench', view);
  st.ed = makeEditor(
    $('[data-role="editor"]', bench),
    'json',
    'Source à analyser',
    'Collez ici un tableau de bord Grafana, des watches, un modèle d’index ou la définition d’un index.',
    text => {
      st.texts[st.tool] = text;
      clearTimeout(setupTools.h);
      setupTools.h = setTimeout(runTool, 180);
    }
  );
  $('[data-role="tool-seg"]', view).innerHTML = Object.entries(TOOLS)
    .map(([k, t]) => `<button type="button" data-tool="${k}" aria-pressed="false">${esc(t.label)}</button>`)
    .join('');
  // L’en-tête (exemples, ouverture de fichiers) sert tous les outils : pour Kibana, il alimente le banc Kibana
  const isKb = () => !!TOOLS[st.tool].bench;
  const load = i => {
    if (isKb()) {
      loadKibanaExample(i);
      return;
    }
    const e = EXAMPLES[st.tool][i];
    if (!e) return;
    st.texts[st.tool] = e.text;
    st.ed.value = e.text;
    runTool();
  };
  const pick = k => {
    st.tool = k;
    store.set('tool', k);
    st.ed.value = st.texts[k] || '';
    runTool();
  };
  const sel = $('[data-act="example"]', view);
  sel.addEventListener('change', () => {
    load(+sel.value);
    sel.value = '';
  });
  const fi = $('[data-role="file"]', view);
  $('[data-act="open"]', view).addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const files = await readFiles(fi.files);
    if (files.length) isKb() ? addKibanaFiles(files) : handleFiles(files);
    fi.value = '';
  });
  $('[data-act="copy"]', bench).addEventListener('click', () => {
    const r = st.res;
    if (r && r.copy) copyText(r.copy, 'Rapport');
  });
  $('[data-act="export"]', bench).addEventListener('click', () => {
    const r = st.res;
    if (r && r.files) saveFile(`passerelle-${st.tool}.zip`, makeZip(r.files));
  });
  view.addEventListener('click', e => {
    if (e.target.closest('#kb')) return; // le banc Kibana a ses propres gestionnaires (setupKibana)
    const t = e.target.closest('[data-tool],[data-tab],[data-load-example],[data-act="clear"]');
    if (!t) return;
    if (t.dataset.tool) pick(t.dataset.tool);
    else if (t.dataset.tab) {
      st.tab[st.tool] = t.dataset.tab;
      renderTools();
    } else if (t.dataset.loadExample !== undefined) load(+t.dataset.loadExample);
    else if (t.dataset.act === 'clear') {
      st.texts[st.tool] = '';
      st.ed.value = '';
      runTool();
      st.ed.focus();
    }
  });
  view.addEventListener('input', e => {
    const o = e.target.closest('[data-opt]');
    if (!o) return;
    st.opts[o.dataset.opt] = o.value.trim();
    clearTimeout(setupTools.h2);
    setupTools.h2 = setTimeout(runTool, 180);
  });
  st.ed.value = st.texts[st.tool] || '';
  runTool();
}
/* ---------- Outil Kibana : un export, ses objets à gauche, leurs requêtes à droite ---------- */
// L’inventaire (moteur, kibana.js) fait l’analyse ; ce banc la parcourt objet par objet
const KB_OVERVIEW = '@ensemble';
const KB_LEVEL = { todo: 'err', review: 'warn', info: 'info' };
const KB_RANK = { err: 0, warn: 1, opt: 2, info: 3 };
const kbNorm = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const nb = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const ucfirst = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
S.kibana = {
  files: [{ name: EXAMPLES.kibana[0].file, text: EXAMPLES.kibana[0].text, example: true }],
  active: 0,
  mode: 'tree',
  sel: null,
  tab: 'sql',
  filter: '',
  inv: null,
  error: null,
  byKey: new Map(),
  flat: [],
  ed: null
};
const kbEntry = k => S.kibana.byKey.get(k);
const kbKids = x => (x.children || []).map(kbEntry).filter(Boolean);
const kbDashboards = () => (S.kibana.inv ? S.kibana.inv.entries.filter(x => x.type === 'dashboard') : []);
const kbKind = x => [KB_TYPES[x.type], x.kind].filter(Boolean).join(' · ');
const kbOwners = x => (x.parent ? [x.parent] : x.usedBy || []).map(k => (kbEntry(k) || {}).title).filter(Boolean);
const kbFileStatus = f => {
  try {
    return kibanaObjects(f.text).objects.length ? 'ok' : 'err';
  } catch (e) {
    return 'err';
  }
};

function runKibana(pulse) {
  const st = S.kibana;
  const files = st.files.filter(f => f.text.trim());
  const before = st.inv ? st.inv.summary.queries + ':' + st.inv.summary.objects : '';
  st.inv = null;
  st.error = null;
  if (files.length) {
    try {
      // Plusieurs exports (un par espace) : réunis, un objet présent deux fois compte une fois
      const inv = kibanaInventory(
        files.map(f => f.text),
        cfg,
        { names: files.map(f => f.name) }
      );
      if (!inv.summary.objects && !Object.keys(inv.source.ignored).length)
        st.error = `Aucun objet sauvegardé lisible${inv.source.errors.length ? ` (${inv.source.errors[0]})` : ''}.`;
      else st.inv = inv;
    } catch (e) {
      st.error = `Erreur interne de l’inventaire : ${e.message}`;
    }
  }
  st.byKey = new Map(st.inv ? st.inv.entries.map(x => [x.key, x]) : []);
  if (st.sel !== KB_OVERVIEW && !kbEntry(st.sel)) st.sel = kbDefault();
  renderKibana();
  if (pulse && st.inv && before !== st.inv.summary.queries + ':' + st.inv.summary.objects) pulseSeam('kibana');
}
// Premier tableau de bord de l’export, sinon la vue d’ensemble
function kbDefault() {
  const d = kbDashboards()[0];
  return d ? d.key : KB_OVERVIEW;
}
function kbSelect(key, focus) {
  const st = S.kibana;
  if (st.sel === key) return;
  st.sel = key;
  renderKibana();
  pulseSeam('kibana');
  const view = $('#kb');
  $('[data-role="out"]', view).scrollTop = 0;
  if (focus) {
    const row = $(`.kb-row[data-key="${CSS.escape(key)}"]`, view);
    if (row) {
      row.focus();
      row.scrollIntoView({ block: 'nearest' });
    }
  }
}

/* Ce qui s’affiche à droite pour la sélection : verdict, comptes, effort, phrase, et les objets dont on montre les requêtes */
function kbSelection() {
  const st = S.kibana;
  const inv = st.inv;
  const x = st.sel === KB_OVERVIEW ? null : kbEntry(st.sel);
  if (!x) {
    const s = inv.summary;
    const b = s.byVerdict;
    const dashes = kbDashboards();
    const ign = Object.entries(inv.source.ignored);
    return {
      overview: true,
      verdict: worstOf(Object.keys(b).filter(k => b[k])),
      title: 'Vue d’ensemble',
      counts: { ok: b.ready, approx: b.review, ko: b.todo + b.unrecognized },
      noun: ['objet', 'objets'],
      hours: s.effort.hours,
      hoursLabel: `effort estimé, soit ${frNum(s.effort.days)} j à ${inv.effortScale.hoursPerDay} h`,
      meta: [
        st.files.length > 1 ? `${st.files.length} exports réunis` : (st.files[0] || {}).name,
        ign.length ? `non comptés : ${ign.map(([t, n]) => `${n} ${t}`).join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' · '),
      sentence: `${nb(s.objects, 'objet', 'objets')} à migrer${dashes.length ? `, dont ${nb(dashes.length, 'tableau de bord', 'tableaux de bord')}` : ''} ; ${nb(s.queries, 'requête traduite', 'requêtes traduites')} en SQL ClickHouse.`,
      groups: inv.entries.filter(y => y.queries.length).map(y => ({ x: y, qs: y.queries, path: true }))
    };
  }
  if (x.type === 'dashboard') {
    const kids = kbKids(x);
    const c = { ok: 0, approx: 0, ko: 0 };
    kids.forEach(k => c[{ ready: 'ok', review: 'approx' }[k.verdict] || 'ko']++);
    const nq = x.queries.length + kids.reduce((n, k) => n + k.queries.length, 0);
    const manual = kids.filter(k => !k.queries.length && k.verdict !== 'ready');
    // Ce que le tableau de bord ajoute à ses panneaux : un filtre commun, des contrôles
    const ctrls = x.queries
      .filter(q => /^Contrôle /.test(q.title))
      .map(q => q.title.replace(/^Contrôle « (.*) »$/, '$1'));
    const own = [
      x.queries.some(q => q.title === 'Filtre commun') ? 'un filtre commun' : '',
      ctrls.length ? `${ctrls.length > 1 ? `${ctrls.length} contrôles` : 'un contrôle'} (${ctrls.join(', ')})` : ''
    ].filter(Boolean);
    return {
      x,
      verdict: x.verdict,
      counts: kids.length ? c : null,
      noun: ['panneau', 'panneaux'],
      hours: x.effortTotal || x.effort,
      hoursLabel: 'effort estimé, panneaux compris',
      meta: [kbKind(x), [...new Set(kids.flatMap(k => k.views))].join(', ')].filter(Boolean).join(' · '),
      sentence: `${nb(x.panels || kids.length, 'panneau', 'panneaux')}, ${nb(nq, 'requête SQL', 'requêtes SQL')}.${own.length ? ` Le tableau de bord ajoute ${own.join(' et ')}.` : ''}${manual.length ? ` ${nb(manual.length, 'panneau se recrée', 'panneaux se recréent')} sans traduction : ${manual.map(k => k.title).join(', ')}.` : ''}`,
      groups: [x]
        .concat(kids)
        .map(y => ({ x: y, qs: y.queries, own: y === x }))
        .filter(g => !g.own || g.qs.length)
    };
  }
  const c = { ok: 0, approx: 0, ko: 0 };
  x.queries.forEach(q => c[{ ready: 'ok', review: 'approx' }[q.verdict] || 'ko']++);
  const owners = kbOwners(x);
  const firstTodo = x.issues.find(i => i.kind === 'todo');
  const sentence =
    x.queries.length === 1 && x.queries[0].sentence
      ? x.queries[0].sentence
      : x.queries.length
        ? `${nb(x.queries.length, 'requête SQL', 'requêtes SQL')} : ${x.queries.map(q => q.title).join(', ')}.`
        : firstTodo
          ? firstTodo.detail
          : 'Aucune requête à traduire : l’objet se recrée tel quel dans l’outil cible.';
  return {
    x,
    verdict: x.verdict,
    counts: x.queries.length ? c : null,
    noun: ['requête', 'requêtes'],
    hours: x.effort,
    hoursLabel: 'effort estimé',
    meta: [
      kbKind(x),
      x.views.length ? `${x.views.join(', ')} → ${x.tables.join(', ') || '?'}` : '',
      owners.length ? `dans ${owners.map(t => `« ${t} »`).join(', ')}` : ''
    ]
      .filter(Boolean)
      .join(' · '),
    sentence,
    groups: [{ x, qs: x.queries }]
  };
}

function renderKibana() {
  const st = S.kibana;
  const view = $('#kb');
  if (!view) return;
  const files = $('[data-role="files"]', view);
  files.hidden = st.files.length < 2;
  files.innerHTML = st.files
    .map(
      (f, i) =>
        `<button class="file-chip" type="button" data-file="${i}" aria-pressed="${i === st.active}"><i class="${f.status || 'ok'}"></i>${esc(f.name)}<span class="x" data-close="${i}" role="button" aria-label="Fermer ${esc(f.name)}">×</span></button>`
    )
    .join('');
  $('[data-role="fname"]', view).textContent =
    st.files.length > 1 ? `${st.files.length} fichiers` : st.files[0] ? st.files[0].name : '';
  $$('[data-mode]', view).forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === st.mode));
  $('[data-role="browse"]', view).hidden = st.mode !== 'tree';
  $('[data-role="editor"]', view).hidden = st.mode !== 'source';
  renderKbBrowse(view);
  renderKbOut(view);
}

function renderKbBrowse(view) {
  const st = S.kibana;
  const inv = st.inv;
  const stats = $('[data-role="stats"]', view);
  const tree = $('[data-role="tree"]', view);
  $('.kb-search', view).hidden = !inv || !inv.entries.length;
  if (!inv) {
    stats.hidden = true;
    tree.innerHTML = st.error
      ? `<div class="empty"><strong>Aucun objet à afficher</strong><span>Passez sur NDJSON pour voir le fichier lu.</span></div>`
      : `<div class="empty"><strong>Aucun export</strong><span>Déposez ici un fichier .ndjson exporté de Kibana, ou chargez un exemple.</span><div class="row">${EXAMPLES.kibana.map((e, i) => `<button class="btn" type="button" data-load-example="${i}">${esc(e.title)}</button>`).join('')}</div></div>`;
    return;
  }
  const s = inv.summary;
  const b = s.byVerdict;
  const total = s.objects || 1;
  const dashes = kbDashboards();
  stats.hidden = false;
  stats.innerHTML = `<div class="kb-figs"><span><b>${s.objects}</b>objet${s.objects > 1 ? 's' : ''}</span><span><b>${dashes.length}</b>tableau${dashes.length > 1 ? 'x' : ''} de bord</span><span><b>${s.queries}</b>requête${s.queries > 1 ? 's' : ''} SQL</span><span><b>${esc(frHours(s.effort.hours))}</b>d’effort</span></div>
    <div class="gauge" role="img" aria-label="${b.ready} objets prêts, ${b.review} à vérifier, ${b.todo + b.unrecognized} à reprendre"><span class="c-ok" style="width:${(100 * b.ready) / total}%"></span><span class="c-approx" style="width:${(100 * b.review) / total}%"></span><span class="c-ko" style="width:${(100 * (b.todo + b.unrecognized)) / total}%"></span></div>`;
  // Arbre : vue d’ensemble, tableaux de bord et leurs panneaux, puis les objets qu’aucun tableau de bord n’affiche
  const q = kbNorm(st.filter.trim());
  const match = x => !q || kbNorm(x.title).includes(q);
  const row = (x, child) => {
    const n = x.queries.length + (x.type === 'dashboard' ? kbKids(x).reduce((m, k) => m + k.queries.length, 0) : 0);
    return `<button type="button" class="kb-row${child ? ' child' : ''}${x.type === 'dashboard' ? ' dash' : ''}" role="option" data-key="${esc(x.key)}" aria-selected="${st.sel === x.key}" tabindex="-1"><i class="dot v-${x.verdict}" title="${esc(verdictLabel(x.verdict))}"></i><span class="kb-name"><b>${esc(x.title)}</b><small>${esc(kbKind(x))}</small></span>${n ? `<span class="kb-count" title="${nb(n, 'requête SQL', 'requêtes SQL')}">${n}</span>` : '<span></span>'}</button>`;
  };
  const html = [
    `<button type="button" class="kb-row overview" role="option" data-key="${KB_OVERVIEW}" aria-selected="${st.sel === KB_OVERVIEW}" tabindex="-1"><i class="dot v-${worstOf(Object.keys(b).filter(k => b[k]))}"></i><span class="kb-name"><b>Vue d’ensemble</b><small>Inventaire, prérequis, points à reprendre</small></span><span></span></button>`
  ];
  const dashRows = [];
  for (const d of dashes) {
    const kids = kbKids(d);
    const shown = match(d) ? kids : kids.filter(match);
    if (match(d) || shown.length) dashRows.push(row(d), ...shown.map(k => row(k, true)));
  }
  if (dashRows.length)
    html.push(`<div class="kb-group"><span>Tableaux de bord</span><span>${dashes.length}</span></div>`, ...dashRows);
  const loose = inv.entries.filter(x => x.type !== 'dashboard' && !x.parent && !(x.usedBy || []).length);
  const looseShown = loose.filter(match);
  if (looseShown.length)
    html.push(
      `<div class="kb-group"><span>${dashes.length ? 'Hors tableau de bord' : 'Objets'}</span><span>${loose.length}</span></div>`,
      ...looseShown.map(x => row(x))
    );
  if (q && !dashRows.length && !looseShown.length)
    html.push(`<p class="kb-none">Aucun titre ne contient « ${esc(st.filter.trim())} ».</p>`);
  tree.innerHTML = html.join('');
  const cur = $('.kb-row[aria-selected="true"]', tree) || $('.kb-row', tree);
  if (cur) cur.tabIndex = 0;
}

const KB_TABS = {
  overview: [
    ['synth', 'Synthèse'],
    ['sql', 'SQL'],
    ['notes', 'Remarques']
  ],
  object: [
    ['sql', 'SQL'],
    ['dsl', 'Requête DSL'],
    ['notes', 'Remarques'],
    ['anatomy', 'Lecture']
  ]
};
function renderKbOut(view) {
  const st = S.kibana;
  const v = $('[data-role="verdict"]', view);
  const tabs = $('[data-role="tabs"]', view);
  const out = $('[data-role="out"]', view);
  const foot = $('.out-foot', view);
  st.flat = [];
  if (!st.inv) {
    tabs.hidden = true;
    foot.hidden = true;
    if (!st.error) {
      v.hidden = true;
      out.innerHTML = `<div class="empty"><strong>Aucun tableau de bord à traduire</strong><span>Déposez un export .ndjson de Kibana (objets enregistrés, avec les objets liés) : chaque panneau donne ses requêtes SQL.</span><div class="row">${EXAMPLES.kibana.map((e, i) => `<button class="btn" type="button" data-load-example="${i}">${esc(e.title)}</button>`).join('')}</div></div>`;
      return;
    }
    v.hidden = false;
    v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-unrecognized"><i></i>${verdictLabel('unrecognized')}</span></div><p class="sentence error">${esc(st.error)}</p>`;
    out.innerHTML =
      '<div class="empty"><strong>L’export n’est pas lisible</strong><span>Un export d’objets sauvegardés compte un objet JSON par ligne (type, id, attributes). Exportez-le depuis Gestion de la pile &gt; Objets enregistrés.</span></div>';
    return;
  }
  const sel = kbSelection();
  v.hidden = false;
  foot.hidden = false;
  const c = sel.counts;
  const total = c ? c.ok + c.approx + c.ko || 1 : 1;
  const [one, many] = sel.noun;
  const ready = n => `${n} ${n > 1 ? many : one} prêt${one === 'requête' ? 'e' : ''}${n > 1 ? 's' : ''}`;
  v.innerHTML = `<div class="verdict-top"><span class="verdict-chip v-${sel.verdict}"><i></i>${verdictLabel(sel.verdict)}</span><span class="score">${esc(frHours(sel.hours))}</span><span class="score-label">${esc(sel.hoursLabel)}</span>
    ${c ? `<span class="counts"><span><i class="c-ok"></i>${ready(c.ok)}</span><span><i class="c-approx"></i>${c.approx} à vérifier</span><span><i class="c-ko"></i>${c.ko} à reprendre</span></span>` : ''}</div>
    ${c ? `<div class="gauge" role="img" aria-label="${ready(c.ok)}, ${c.approx} à vérifier, ${c.ko} à reprendre"><span class="c-ok" style="width:${(100 * c.ok) / total}%"></span><span class="c-approx" style="width:${(100 * c.approx) / total}%"></span><span class="c-ko" style="width:${(100 * c.ko) / total}%"></span></div>` : ''}
    <p class="kb-meta"><b>${esc(sel.overview ? sel.title : sel.x.title)}</b>${sel.meta ? ` · ${esc(sel.meta)}` : ''}</p>
    <p class="sentence">${esc(sel.sentence)}</p>${kbIssuesLine(sel)}`;
  const list = KB_TABS[sel.overview ? 'overview' : 'object'];
  if (!list.some(([id]) => id === st.tab)) st.tab = list[0][0];
  const notes = kbNotes(sel);
  const nErr = notes.filter(n => n.level === 'err').length;
  tabs.hidden = false;
  tabs.innerHTML = list
    .map(
      ([id, label]) =>
        `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="${st.tab === id}">${label}${id === 'notes' && notes.length ? `<span class="badge ${nErr ? 'err' : ''}">${notes.length}</span>` : ''}</button>`
    )
    .join('');
  if (st.tab === 'sql') out.innerHTML = kbQueriesHTML(sel, 'sql');
  else if (st.tab === 'dsl') out.innerHTML = kbQueriesHTML(sel, 'dsl');
  else if (st.tab === 'notes') out.innerHTML = kbNotesHTML(notes);
  else if (st.tab === 'anatomy') out.innerHTML = kbAnatomyHTML(sel);
  else if (st.tab === 'synth') out.innerHTML = mdHTML(kbSynthesisMD(st.inv));
}
// Ce qui pèse sur l’objet lui-même, hors de ses requêtes : le verdict peut être plus sévère que celui des requêtes
function kbIssuesLine(sel) {
  if (sel.overview) return '';
  const part = (kind, label) => {
    const l = [...new Set(sel.x.issues.filter(i => i.kind === kind).map(i => i.label))];
    return l.length ? `<span><b class="v-${kind}">${label}</b> ${esc(l.join(', '))}</span>` : '';
  };
  const html = part('todo', 'À reprendre :') + part('review', 'À vérifier :');
  return html ? `<p class="kb-issues">${html}</p>` : '';
}
// Corps de recherche reconstitué, au format de la console Kibana
const kbConsole = q => `GET ${q.pattern || '_all'}/_search\n${JSON.stringify(q.dsl, null, 2)}`;
// SQL (ou DSL) de chaque objet de la sélection ; un tableau de bord montre ses panneaux l’un après l’autre
function kbQueriesHTML(sel, what) {
  const st = S.kibana;
  const multi = sel.overview || sel.x.type === 'dashboard';
  const parts = [];
  if (what === 'dsl')
    parts.push(
      '<p class="kb-hint">Ce que Kibana envoie à Elasticsearch pour cet affichage, reconstitué depuis l’export. {{time_from}} et {{time_to}} tiennent la place de la période choisie ; ils deviennent les paramètres {time_from:String} et {time_to:String} du SQL.</p>'
    );
  for (const g of sel.groups) {
    if (multi) {
      const path = g.path && g.x.parent && kbEntry(g.x.parent) ? `${kbEntry(g.x.parent).title} › ` : '';
      parts.push(
        `<div class="kb-sub"><i class="dot v-${g.x.verdict}"></i><b>${esc(g.own ? 'Tableau de bord' : path + g.x.title)}</b><small>${esc(g.own ? 'filtre commun et contrôles' : kbKind(g.x))}</small>${g.own ? '' : `<button class="btn quiet kb-go" type="button" data-go="${esc(g.x.key)}">Détail</button>`}</div>`
      );
    }
    if (!g.qs.length) {
      const todo = g.x.issues.find(i => i.kind === 'todo');
      parts.push(
        `<p class="kb-none${todo ? ' err' : ''}">${esc(todo ? `${ucfirst(todo.label)} : ${todo.detail}` : 'Contenu sans requête (texte, image, liens) : à recréer tel quel.')}</p>`
      );
      continue;
    }
    for (const q of g.qs) {
      const i = st.flat.push({ x: g.x, q }) - 1;
      const head = `<div class="stmt-head"><span class="kb-qtitle">${esc(q.title)}${what === 'dsl' && q.pattern ? ` <small>${esc(q.pattern)}</small>` : ''}<span class="vmini v-${q.verdict}">${esc(VERDICTS[q.verdict])}</span></span><span class="kb-acts">${what === 'dsl' ? `<button class="btn quiet kb-go" type="button" data-kb-bench="${i}" title="Traduire cette requête dans la section Requêtes">Ouvrir dans Requêtes</button>` : ''}<button class="icon-btn" type="button" data-kb-copy="${i}" data-what="${what}" title="Copier" aria-label="Copier ${what === 'dsl' ? 'la requête DSL' : 'le SQL'}">${ICON_COPY}</button></span></div>`;
      if (what === 'dsl')
        parts.push(`<div class="stmt">${head}<pre class="code">${hl(kbConsole(q), 'json')}</pre></div>`);
      else
        parts.push(
          `<div class="stmt">${head}${q.sql ? `<pre class="code">${hl(q.sql, 'sql')}</pre>` : `<p class="kb-none err">${esc(q.error || 'La traduction n’a pas produit de SQL.')}</p>`}</div>`
        );
    }
  }
  return parts.join('');
}
// Remarques de la sélection : celles de l’objet et celles de ses requêtes, chaque remarque une fois avec les objets concernés
function kbNotes(sel) {
  const inv = S.kibana.inv;
  if (sel.overview) {
    return inv.prerequisites
      .map(p => ({ level: 'warn', title: p.label, detail: p.detail, where: [nb(p.objects, 'objet', 'objets')] }))
      .concat(
        inv.blockers.map(b => ({
          level: b.kind === 'todo' ? 'err' : 'warn',
          title: ucfirst(b.label),
          detail: '',
          where: [`${nb(b.objects, 'objet', 'objets')}, ${frHours(b.hours)}`]
        }))
      )
      .concat(
        inv.source.errors.length
          ? [
              {
                level: 'warn',
                title: nb(inv.source.errors.length, 'ligne illisible', 'lignes illisibles'),
                detail: inv.source.errors.slice(0, 5).join(' ; '),
                where: []
              }
            ]
          : []
      );
  }
  const multi = sel.x.type === 'dashboard';
  const map = new Map();
  const add = (level, title, detail, code, where) => {
    const k = `${level}|${title}|${detail}`;
    if (!map.has(k)) map.set(k, { level, title, detail, code, where: [] });
    if (where && !map.get(k).where.includes(where)) map.get(k).where.push(where);
  };
  for (const g of sel.groups) {
    const who = multi && !g.own ? g.x.title : '';
    for (const i of g.x.issues) add(KB_LEVEL[i.kind] || 'info', ucfirst(i.label), i.detail, null, who);
    for (const q of g.qs)
      for (const n of q.notes)
        add(
          n.level,
          n.title,
          n.detail,
          n.code,
          multi ? [who, q.title].filter(Boolean).join(' › ') : g.qs.length > 1 ? q.title : ''
        );
  }
  return [...map.values()].sort((a, b) => KB_RANK[a.level] - KB_RANK[b.level]);
}
function kbNotesHTML(notes) {
  if (!notes.length)
    return '<div class="empty"><strong>Aucune remarque</strong><span>Traduction directe, sans approximation.</span></div>';
  return `<ul class="notes">${notes.map(n => `<li class="note ${n.level}"><span class="note-kind">${LEVEL[n.level]}</span><h3>${esc(n.title)}</h3>${n.detail ? `<p>${esc(n.detail)}</p>` : ''}${n.where.length ? `<p class="kb-where">${n.where.length > 1 || /›/.test(n.where[0]) || !/\d/.test(n.where[0]) ? 'Concerne : ' : ''}${esc(n.where.join(' ; '))}</p>` : ''}${n.code ? `<pre class="code boxed">${hl(n.code, /^(ALTER|--|PARTITION)/.test(n.code) ? 'sql' : 'vrl')}</pre>` : ''}</li>`).join('')}</ul>`;
}
function kbAnatomyHTML(sel) {
  const x = sel.x;
  const all = sel.groups.map(g => g.x);
  const uniq = list => [...new Set(list)];
  const params = uniq(
    all.flatMap(y =>
      y.queries.flatMap(q => (q.parameters || []).map(p => `{${p.name}:${(p.types || ['String'])[0]}} ← ${p.source}`))
    )
  );
  const rows = [
    ['Objet', [kbKind(x)]],
    ['Identifiant', [x.id]],
    ['Tableau de bord', kbOwners(x)],
    ['Panneaux', x.type === 'dashboard' ? kbKids(x).map(k => k.title) : []],
    ['Contrôles', x.controls ? [nb(x.controls, 'contrôle', 'contrôles')] : []],
    ['Vue de données', uniq(all.flatMap(y => y.views))],
    ['Table ClickHouse', uniq(all.flatMap(y => y.tables))],
    ['Paramètres', params],
    ['Champs cités', uniq(all.flatMap(y => y.fields || [])).sort()],
    ['Effort', x.effortDetail.map(l => `${l.label} · ${frHours(l.hours)}`)]
  ].filter(([, list]) => list && list.length);
  return `<dl class="anatomy">${rows.map(([k, list]) => `<dt>${k}</dt><dd>${list.map(y => `<span class="chip">${esc(y)}</span>`).join('')}</dd>`).join('')}</dl>`;
}
// Synthèse de l’inventaire : son rapport, sans le détail objet par objet que l’arbre montre déjà
function kbSynthesisMD(inv) {
  return inventoryMarkdown(inv)
    .split(/^(?=## )/m)
    .filter(sec => !/^## (Objets|Détail par objet)\b/.test(sec))
    .join('')
    .replace(/^# .*\n+/, '');
}
function kbSQLText(sel) {
  return (
    sel.groups
      .filter(g => g.qs.some(q => q.sql))
      .map(
        g =>
          `-- ===== ${KB_TYPES[g.x.type]} : ${kbFlat(g.x.title)}\n${g.qs
            .filter(q => q.sql)
            .map(q => `-- ${kbFlat(q.title)} (${VERDICTS[q.verdict]})\n${q.sql}`)
            .join('\n\n')}`
      )
      .join('\n\n') + '\n'
  );
}
function addKibanaFiles(files) {
  const st = S.kibana;
  if (st.files.length === 1 && (st.files[0].example || !st.files[0].text.trim())) st.files = [];
  files.forEach(f => st.files.push({ name: f.name, text: f.text, status: kbFileStatus(f) }));
  st.active = st.files.length - files.length;
  st.sel = null;
  st.filter = '';
  $('#kb [data-role="filter"]').value = '';
  st.ed.value = st.files[st.active].text;
  runKibana(true);
}
function loadKibanaExample(i) {
  const e = EXAMPLES.kibana[i];
  if (!e) return;
  const st = S.kibana;
  st.files = [{ name: e.file, text: e.text, example: true }];
  st.active = 0;
  st.sel = null;
  st.ed.value = e.text;
  runKibana(true);
}
function setupKibana() {
  const view = $('#kb');
  const st = S.kibana;
  st.ed = makeEditor(
    $('[data-role="editor"]', view),
    'json',
    'Export Kibana (NDJSON)',
    'Collez ici un export d’objets sauvegardés : un objet JSON par ligne, avec type, id et attributes.',
    text => {
      const f = st.files[st.active];
      if (f) {
        f.text = text;
        f.example = false;
        f.status = kbFileStatus(f);
      } else st.files.push({ name: 'export.ndjson', text });
      clearTimeout(setupKibana.h);
      setupKibana.h = setTimeout(() => runKibana(true), 300);
    }
  );
  st.ed.value = st.files[st.active].text;
  // Les exemples et l’ouverture de fichiers sont dans l’en-tête d’« Autres sources » (voir setupTools)
  $('[data-act="clear"]', view).addEventListener('click', () => {
    st.files = [{ name: 'export.ndjson', text: '' }];
    st.active = 0;
    st.mode = 'source';
    st.ed.value = '';
    runKibana();
    st.ed.focus();
  });
  $('[data-act="copy"]', view).addEventListener('click', () => {
    if (!st.inv) return;
    const t = kbSQLText(kbSelection());
    if (t.trim()) copyText(t, 'SQL');
    else toast('Aucune requête SQL pour cet objet.');
  });
  $('[data-act="export"]', view).addEventListener('click', () => {
    const inv = st.inv;
    if (!inv) return;
    const files = inventorySQLFiles(inv)
      .map(f => ({ name: `sql/${f.name}`, content: f.content }))
      .concat([
        { name: 'inventaire/inventaire.md', content: inventoryMarkdown(inv) },
        { name: 'inventaire/inventaire.csv', content: inventoryCSV(inv) },
        { name: 'inventaire/inventaire.html', content: inventoryHTML(inv, 'Inventaire Kibana') },
        { name: 'passerelle.yaml', content: configToYAML(cfg) }
      ]);
    saveFile('passerelle-kibana.zip', makeZip(files));
  });
  const filter = $('[data-role="filter"]', view);
  filter.addEventListener('input', () => {
    st.filter = filter.value;
    renderKbBrowse(view);
  });
  view.addEventListener('click', e => {
    const t = e.target.closest(
      '[data-key],[data-go],[data-tab],[data-mode],[data-file],[data-close],[data-kb-copy],[data-kb-bench],[data-load-example]'
    );
    if (!t) return;
    if (t.dataset.close !== undefined) {
      e.stopPropagation();
      st.files.splice(+t.dataset.close, 1);
      if (!st.files.length) st.files.push({ name: 'export.ndjson', text: '' });
      st.active = Math.min(st.active, st.files.length - 1);
      st.ed.value = st.files[st.active].text;
      runKibana(true);
      return;
    }
    if (t.dataset.key) {
      kbSelect(t.dataset.key);
      if (matchMedia('(max-width: 900px)').matches)
        $('.pane-out', view).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.dataset.go) {
      kbSelect(t.dataset.go, true);
      return;
    }
    if (t.dataset.tab) {
      st.tab = t.dataset.tab;
      renderKbOut(view);
      return;
    }
    if (t.dataset.mode) {
      st.mode = t.dataset.mode;
      renderKibana();
      if (st.mode === 'source') st.ed.focus();
      return;
    }
    if (t.dataset.file !== undefined) {
      st.active = +t.dataset.file;
      st.ed.value = st.files[st.active].text;
      renderKibana();
      return;
    }
    if (t.dataset.kbCopy !== undefined) {
      const it = st.flat[+t.dataset.kbCopy];
      if (it) t.dataset.what === 'dsl' ? copyText(kbConsole(it.q), 'Requête') : copyText(it.q.sql, 'SQL');
      return;
    }
    if (t.dataset.kbBench !== undefined) {
      // La requête reconstituée part dans la section Requêtes, où elle se modifie et se retraduit
      const it = st.flat[+t.dataset.kbBench];
      if (!it) return;
      const slug =
        kbNorm(`${it.x.title} ${it.x.queries.length > 1 ? it.q.title : ''}`)
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 50) || 'requete';
      if (it.q.pattern) {
        S.dsl.index = it.q.pattern;
        $('#view-dsl [data-role="index"]').value = it.q.pattern;
      }
      addFiles('dsl', [{ name: `${slug}.json`, text: kbConsole(it.q) }]);
      show('dsl');
      return;
    }
    if (t.dataset.loadExample !== undefined) loadKibanaExample(+t.dataset.loadExample);
  });
  // Clavier : flèches dans l’arbre, flèches entre les onglets
  $('[data-role="tree"]', view).addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = $$('.kb-row', view);
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.findIndex(r => r === document.activeElement || r.getAttribute('aria-selected') === 'true');
    const j =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    kbSelect(rows[j].dataset.key, true);
  });
  $('[data-role="tabs"]', view).addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const ids = $$('[data-tab]', view).map(b => b.dataset.tab);
    const i = ids.indexOf(st.tab);
    st.tab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    renderKbOut(view);
    const b = $(`[data-tab="${st.tab}"]`, view);
    if (b) b.focus();
  });
  st.files.forEach(f => {
    f.status = kbFileStatus(f);
  });
  runKibana();
}

function show(view) {
  S.view = view;
  store.set('view', view);
  $$('.view').forEach(v => (v.hidden = v.id !== `view-${view}`));
  $$('.nav-item').forEach(b =>
    b.getAttribute('data-view') === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')
  );
  if (view === 'api') renderAPI();
  if (view === 'arch') renderArch();
  if ((view === 'ls' || view === 'ingest') && S[view].tab === 'flow') render(view);
  if (view === 'tools') renderTools();
}
function setupBench(kind) {
  const view = $(`#view-${kind}`);
  const st = S[kind];
  st.ed = makeEditor($('[data-role="editor"]', view), st.lang, BENCH[kind].label, BENCH[kind].placeholder, text => {
    const f = st.files[st.active];
    if (f) {
      f.text = text;
      f.example = false;
    } else st.files.push({ name: BENCH[kind].file, text });
    runSoon(kind);
  });
  st.ed.value = st.files[st.active].text;
  const sel = $('[data-act="example"]', view);
  sel.innerHTML = `<option value="">Charger un exemple</option>${EXAMPLES[kind].map((e, i) => `<option value="${i}">${esc(e.title)}</option>`).join('')}`;
  const loadExample = i => {
    const e = EXAMPLES[kind][i];
    if (!e) return;
    const f = { name: e.file, text: e.text, example: true };
    if (st.files.length === 1 && (st.files[0].example || !st.files[0].text.trim())) st.files = [f];
    else st.files.push(f);
    st.active = st.files.indexOf(f);
    st.ed.value = f.text;
    run(kind, true);
  };
  sel.addEventListener('change', () => {
    loadExample(+sel.value);
    sel.value = '';
  });
  const fileInput = $('input[type="file"]', view);
  $('[data-act="open"]', view).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = await readFiles(fileInput.files);
    if (files.length) addFiles(kind, files);
    fileInput.value = '';
  });
  $('[data-act="clear"]', view).addEventListener('click', () => {
    const f = st.files[st.active];
    if (f) f.text = '';
    st.ed.value = '';
    run(kind);
    st.ed.focus();
  });
  if (kind === 'dsl') {
    const ix = $('[data-role="index"]', view);
    ix.value = st.index;
    ix.addEventListener('input', () => {
      S.dsl.index = ix.value.trim();
      runSoon('dsl');
    });
  }
  $('[data-act="copy"]', view).addEventListener('click', () => {
    const r = st.res;
    if (!r || r.error || r.empty) return;
    copyText(kind === 'dsl' ? r.sql : r[cfg.vector.format], BENCH[kind].copy);
  });
  $('[data-act="export"]', view).addEventListener('click', () => exportKind(kind));
  view.addEventListener('click', e => {
    const t = e.target.closest(
      '[data-tab],[data-file],[data-close],[data-format],[data-copy-stmt],[data-load-example]'
    );
    if (!t) return;
    if (t.dataset.close !== undefined) {
      e.stopPropagation();
      const i = +t.dataset.close;
      st.files.splice(i, 1);
      if (!st.files.length) st.files.push({ name: BENCH[kind].file, text: '' });
      st.active = Math.min(st.active, st.files.length - 1);
      st.ed.value = st.files[st.active].text;
      run(kind);
      return;
    }
    if (t.dataset.tab) {
      st.tab = t.dataset.tab;
      render(kind);
      return;
    }
    if (t.dataset.file !== undefined) {
      st.active = +t.dataset.file;
      st.ed.value = st.files[st.active].text;
      run(kind, true);
      return;
    }
    if (t.dataset.format) {
      cfg.vector.format = t.dataset.format;
      store.set(CFG_KEY, cfg);
      renderConfigPreview();
      render(kind);
      return;
    }
    if (t.dataset.copyStmt !== undefined) {
      const s = st.res.statements[+t.dataset.copyStmt];
      copyText(s.sql + ';', 'Requête');
      return;
    }
    if (t.dataset.loadExample !== undefined) loadExample(+t.dataset.loadExample);
  });
  $('[data-role="tabs"]', view).addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const ids = TABS[kind].map(x => x[0]);
    const i = ids.indexOf(st.tab);
    st.tab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    render(kind);
    const b = $(`[data-tab="${st.tab}"]`, view);
    if (b) b.focus();
  });
}
function setupConfig() {
  renderConfigForm();
  const form = $('#cfg-form');
  form.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.path) {
      const p = el.dataset.path;
      const v =
        el.type === 'checkbox'
          ? el.checked
          : el.dataset.type === 'list'
            ? el.value
                .split(',')
                .map(x => x.trim())
                .filter(Boolean)
            : el.value.trim();
      setPath(cfg, p, v);
    } else if (el.closest('[data-map]')) readMaps();
    configChanged();
  });
  form.addEventListener('change', e => {
    if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') {
      const el = e.target;
      setPath(cfg, el.dataset.path, el.type === 'checkbox' ? el.checked : el.value);
      configChanged();
    }
  });
  form.addEventListener('click', e => {
    const add = e.target.closest('[data-add-map]');
    if (add) {
      const box = $(`[data-map="${add.dataset.addMap}"]`);
      box.insertAdjacentHTML('beforeend', mapRow('', '', add.dataset.a, add.dataset.b));
      $$('input', box).slice(-2)[0].focus();
      return;
    }
    const del = e.target.closest('[data-del-map]');
    if (del) {
      del.closest('.map-row').remove();
      readMaps();
      configChanged();
    }
  });
  const fi = $('#cfg-file');
  $('[data-act="cfg-import"]').addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const [f] = await readFiles(fi.files);
    if (f) importConfig(f);
    fi.value = '';
  });
  $('[data-act="cfg-export"]').addEventListener('click', () =>
    saveFile('passerelle-config.zip', makeZip([{ name: 'passerelle.yaml', content: configToYAML(cfg) }]))
  );
  $('[data-act="cfg-copy"]').addEventListener('click', () => copyText(configToYAML(cfg), 'Configuration'));
  $('[data-act="cfg-reset"]').addEventListener('click', () => {
    cfg = mergeConfig(BASE_CFG, {});
    store.set(CFG_KEY, cfg);
    renderConfigForm();
    run('dsl');
    run('ls');
    run('ingest');
    runKibana();
    toast('Configuration réinitialisée');
  });
}
function setupTheme() {
  const modes = ['auto', 'light', 'dark'];
  const labels = { auto: 'automatique', light: 'clair', dark: 'sombre' };
  let mode = store.get('theme', 'auto');
  const apply = () => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    $('#theme-btn').textContent = `Thème : ${labels[mode]}`;
  };
  $('#theme-btn').addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    store.set('theme', mode);
    apply();
  });
  apply();
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy-raw]');
  if (c) copyText(c.getAttribute('data-copy-raw'), 'Code');
});
$$('.nav-item').forEach(b => b.addEventListener('click', () => show(b.getAttribute('data-view'))));
window.addEventListener('resize', () => {
  const k = S.view;
  if ((k === 'ls' || k === 'ingest') && S[k].tab === 'flow' && S[k].res && S[k].res.graph)
    drawEdges($(`#view-${k} [data-role="out"]`), S[k].res.graph);
});

setupTheme();
setupBench('dsl');
setupBench('ls');
setupBench('ingest');
setupKibana();
setupTools();
setupConfig();
run('dsl');
run('ls');
run('ingest');
// La section « Kibana » est devenue l’outil Kibana d’« Autres sources » : une vue mémorisée par une version précédente y mène
if (S.view === 'kibana') {
  S.view = 'tools';
  S.tools.tool = 'kibana';
  store.set('tool', 'kibana');
}
show(['dsl', 'ls', 'ingest', 'tools', 'config', 'api', 'arch'].includes(S.view) ? S.view : 'dsl');
// Téléchargement classique par le navigateur (page servie par le binaire ou ouverte en local)
downloads = {
  save: async ({ filename, data }) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return { status: 'saved' };
  }
};
$$('.dl').forEach(b => (b.hidden = false));
