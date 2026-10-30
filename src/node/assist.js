/* Passerelle — Node.js : aide aux cas « à reprendre » (passerelle assist) */
/*
 * Une traduction qui ne sait pas faire laisse un commentaire « À TRADUIRE » (filtre ruby de Logstash) ou « À REPRENDRE »
 * (script Painless) et le code d’origine. « passerelle assist » prépare une PROPOSITION pour chacun de ces cas, puis la
 * fait juger par deux épreuves, dans cet ordre :
 *   1. Vector compile la configuration où la proposition a pris la place du commentaire ;
 *   2. le banc la rejoue sur un échantillon et compare ce qu’elle produit à ce que produit le moteur d’origine
 *      (le même comparateur que « passerelle verify pipelines »).
 * Une proposition n’est jamais reprise dans une traduction : elle va dans un fichier à part, marquée « à vérifier ».
 *
 * Les propositions viennent de règles (un sous-ensemble de Ruby, src/engine/assist.js) et, seulement avec --local-model,
 * d’un modèle qui tourne sur ce poste. Rien ne part du poste : le modèle est joint sur la boucle locale (toute autre
 * adresse est refusée avant la moindre connexion), il ne reçoit que le code du cas (jamais un événement de
 * l’échantillon, jamais la configuration), et Vector rejoue l’échantillon avec des sources et des sorties remplacées par
 * des fichiers. Ce code ne s’exécute pas à son chargement : il emploie les modules et fonctions que src/server.js
 * et src/node/verify.js déclarent, dans ses fonctions seulement.
 */
const asstNet = require('node:net');
const asstDns = require('node:dns');

const ASST_MARK = {
  confirmed: '✓',
  different: '≠',
  error: '✗',
  inconclusive: '~',
  not_replayed: '-',
  refused: '!',
  none: '·'
};
const asstStamp = d =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');

/* ---------- Le modèle local ---------- */
const asstLoopback = a => (asstNet.isIPv4(a) ? a.split('.')[0] === '127' : a === '::1');
const ASST_REFUSED =
  'le modèle local doit être sur la boucle locale de ce poste : utilisez http://127.0.0.1:PORT, http://[::1]:PORT ou http://localhost:PORT';

// L’adresse du modèle, refusée avant toute connexion si elle n’est pas celle de la boucle locale
async function asstModelTarget(m) {
  const raw = expand(m.endpoint).trim();
  if (!raw)
    throw new Error(
      'le modèle n’a pas d’adresse : assist.model.endpoint ou --model-endpoint (par exemple http://127.0.0.1:11434)'
    );
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw new Error(`adresse du modèle illisible : ${raw}`);
  }
  if (u.protocol !== 'http:') throw new Error(`${ASST_REFUSED} (pas ${u.protocol}//)`);
  if (u.username || u.password) throw new Error('l’adresse du modèle ne porte ni identifiant ni mot de passe');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addr = host;
  if (!asstNet.isIP(host)) {
    // Un nom : seul « localhost » est admis, résolu par le fichier hosts, et toutes ses adresses doivent être locales
    if (host !== 'localhost') throw new Error(`${ASST_REFUSED} (« ${host} » n’est pas une adresse de bouclage)`);
    const all = await asstDns.promises.lookup('localhost', { all: true });
    if (!all.length || !all.every(a => asstLoopback(a.address)))
      throw new Error(`${ASST_REFUSED} (localhost ne désigne pas la boucle locale sur ce poste)`);
    addr = (all.find(a => a.family === 4) || all[0]).address;
  }
  if (!asstLoopback(addr)) throw new Error(`${ASST_REFUSED} (« ${host} » n’est pas une adresse de bouclage)`);
  return { addr, port: Number(u.port) || 80, base: u.pathname.replace(/\/+$/, ''), host: u.host };
}

// Une demande au modèle ; la réponse est son texte. Connexion directe à l’adresse de bouclage, jamais par un proxy.
function asstModelAsk(m, prompt) {
  const t = m.target;
  const openai = m.api === 'openai';
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];
  const payload = JSON.stringify(
    openai
      ? { model: m.model, messages, temperature: 0, stream: false }
      : { model: m.model, messages, stream: false, options: { temperature: 0 } }
  );
  const route = openai ? `${t.base.replace(/\/v1$/, '')}/v1/chat/completions` : `${t.base}/api/chat`;
  const timeout = (Number(m.timeout) || 300) * 1000;
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = http.request(
      {
        host: t.addr,
        port: t.port,
        method: 'POST',
        path: route,
        agent: false,
        headers: { host: t.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      },
      res => {
        const chunks = [];
        let size = 0;
        res.on('data', d => {
          size += d.length;
          if (size > 4e6) req.destroy(new Error('réponse trop longue'));
          else chunks.push(d);
        });
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200)
            return reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 160).replace(/\s+/g, ' ')}`.trim()));
          try {
            const j = JSON.parse(text);
            const out = openai ? j.choices[0].message.content : j.message.content;
            if (typeof out !== 'string') throw new Error('contenu absent');
            resolve(out);
          } catch (e) {
            reject(new Error('réponse illisible'));
          }
        });
      }
    );
    timer = setTimeout(() => req.destroy(new Error('délai dépassé')), timeout);
    req.on('error', e => {
      clearTimeout(timer);
      reject(
        new Error(
          e.code === 'ECONNREFUSED' ? `connexion refusée sur ${t.addr}:${t.port} (le modèle tourne-t-il ?)` : e.message
        )
      );
    });
    req.end(payload);
  });
}

/* ---------- Les propositions ---------- */
const asstFirstError = out => {
  const lines = String(out)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return (lines.find(l => /error\[E\d+\]|error:|Error/.test(l)) || lines[0] || 'refus sans message').slice(0, 200);
};

// La configuration où seul ce cas porte la proposition, jugée par Vector
async function asstCompile(config, cases, c, prop) {
  return validateVector(toYAML(assistApply(config, cases, { [c.id]: prop })) + '\n', 'yaml');
}

/*
 * Une proposition par cas : les règles d’abord (filtres ruby), puis le modèle local s’il est permis. Chaque candidat
 * est compilé par Vector avant d’être gardé. Rend { proposals: { id: { vrl, origin } }, records }.
 */
async function asstPropose(config, cases, x) {
  const proposals = {};
  const records = [];
  for (const [k, c] of cases.entries()) {
    const rec = {
      id: c.id,
      kind: c.kind,
      label: c.label,
      status: 'refused',
      origin: '',
      reason: '',
      notes: [],
      vrl: ''
    };
    records.push(rec);
    const keep = (vrl, origin, notes) => {
      proposals[c.id] = { vrl, origin };
      Object.assign(rec, { status: 'proposed', origin, vrl, notes: notes || [], reason: '' });
    };
    let why = '';
    if (c.kind === 'ruby') {
      const r = assistRuby(c.code, { ns: x.cfg.vector.log_namespace !== false, tag: String(k + 1) });
      if (r.error) why = `règles : ${r.error}`;
      else {
        const v = await asstCompile(config, cases, c, { vrl: r.vrl, origin: 'règles' });
        if (v.valid) {
          keep(r.vrl, 'règles', r.notes);
          continue;
        }
        why = `règles : Vector refuse la proposition (${asstFirstError(v.output)})`;
      }
    } else why = 'aucune règle pour Painless';
    if (!x.model) {
      rec.reason = `${why} ; --local-model peut en demander une à un modèle de ce poste`;
      continue;
    }
    let previous = '';
    for (let a = 1; a <= x.model.attempts; a++) {
      let answer;
      try {
        answer = await asstModelAsk(x.model, assistPrompt(c, previous));
      } catch (e) {
        why = `modèle local : ${e.message}`;
        break;
      }
      const g = assistFromModel(answer);
      if (g.error) {
        why = `modèle local : ${g.error}`;
        if (/ne peut pas garder/.test(g.error)) break;
        previous = g.error;
        continue;
      }
      const origin = `modèle local ${x.model.model}`;
      const v = await asstCompile(config, cases, c, { vrl: g.vrl, origin });
      if (v.valid) {
        keep(g.vrl, origin, [
          'Proposition d’un modèle : relisez-la ligne à ligne, le banc ne prouve que l’échantillon.'
        ]);
        why = '';
        break;
      }
      previous = String(v.output).slice(0, 1500);
      why = `modèle local : Vector refuse la proposition (${asstFirstError(v.output)})${a < x.model.attempts ? '' : ` après ${a} essai${a > 1 ? 's' : ''}`}`;
    }
    if (!proposals[c.id]) rec.reason = why;
  }
  return { proposals, records };
}
// Les propositions d’une configuration reportées sur celles d’une autre, cas par cas : même sorte, même code, dans l’ordre
function asstTransfer(fromCases, proposals, toCases) {
  const out = {};
  const used = new Set();
  for (const t of toCases) {
    const f = fromCases.find(c => !used.has(c.id) && c.kind === t.kind && c.code === t.code && proposals[c.id]);
    if (f) {
      used.add(f.id);
      out[t.id] = proposals[f.id];
    }
  }
  return out;
}
const asstHead = yaml => (String(yaml).match(/^(#[^\n]*\n)+/) || [''])[0];
function asstProposedYAML(full, cases, proposals) {
  const note =
    '# PROPOSITIONS À VÉRIFIER (passerelle assist) : les blocs marqués « PROPOSITION À VÉRIFIER » ne sont pas des traductions.\n# Relisez-les, puis confirmez-les avec le rapport de « passerelle assist » avant tout usage.\n';
  return asstHead(full.yaml) + note + '\n' + toYAML(assistApply(full.config, cases, proposals)) + '\n';
}

/* ---------- Le rejeu ---------- */
const asstEvents = file => verifyEvents(file);
function asstDrop(events, fields) {
  if (!fields.length) return events;
  return events.map(e => {
    const c = JSON.parse(JSON.stringify(e));
    for (const f of fields) {
      const segs = f.split('.');
      let cur = c;
      for (const s of segs.slice(0, -1)) {
        cur = cur && typeof cur === 'object' ? cur[s] : undefined;
      }
      if (cur && typeof cur === 'object') delete cur[segs[segs.length - 1]];
    }
    return c;
  });
}
// Ce que dit le rapport d’une comparaison : l’état, la raison et les écarts cités
function asstVerdict(cmp, outEvents, x) {
  const shown = verifyDiffs(cmp.diffs, x.cfg, x.o);
  if (!cmp.events && !outEvents)
    return {
      state: 'inconclusive',
      reason: 'aucun événement en sortie : l’échantillon est vide ou entièrement écarté par le pipeline',
      docs: 0,
      diffs: []
    };
  if (cmp.diffs.length)
    return {
      state: 'different',
      reason: `${cmp.events - cmp.identical} événement(s) sur ${cmp.events} diffèrent de la référence`,
      docs: cmp.events,
      diffs: shown
    };
  return { state: 'confirmed', reason: '', docs: cmp.events, diffs: [] };
}

/* ---------- Filtres ruby d’un pipeline Logstash ---------- */
async function asstItemRuby(x, file, n) {
  const t0 = Date.now();
  const title = path.basename(file);
  const id = `p${n}`;
  const item = { title, source: file, cases: [] };
  const finish = (state, reason, extra) => {
    Object.assign(item, { state, reason: reason || '', elapsed_ms: Date.now() - t0 }, extra || {});
    process.stderr.write(`${ASST_MARK[state]} ${ASSIST_STATES[state]} : ${title}${reason ? ` — ${reason}` : ''}\n`);
    return item;
  };
  const text = fs.readFileSync(file, 'utf8');
  const full = translateLogstash(text, x.cfg);
  if (full.error || full.empty) return finish('error', `traduction impossible : ${full.error || 'résultat vide'}`);
  const cases = assistCases(full.config).filter(c => c.kind === 'ruby');
  if (!cases.length) return finish('none', 'aucun filtre ruby à reprendre');
  const base = await validateVector(toYAML(full.config) + '\n', 'yaml');
  if (!base.valid)
    return finish(
      'error',
      `Vector refuse déjà la traduction, avant toute proposition (${asstFirstError(base.output)})`
    );
  const { proposals, records } = await asstPropose(full.config, cases, x);
  item.cases = records;
  const made = Object.keys(proposals).length;
  if (made)
    x.files.push({
      name: `${title.replace(/\.[^.]*$/, '')}.propositions.yaml`,
      content: asstProposedYAML(full, cases, proposals)
    });
  if (!made) return finish('refused', `${cases.length} cas, aucune proposition`);
  const missing = cases.length - made;
  if (!x.replay)
    return finish(
      'not_replayed',
      `${made} proposition${made > 1 ? 's' : ''} sur ${cases.length} cas, compilée${made > 1 ? 's' : ''} par Vector mais non rejouée${made > 1 ? 's' : ''} : ${x.replayHint}`
    );
  if (missing)
    return finish(
      'inconclusive',
      `${missing} cas sur ${cases.length} sans proposition : le pipeline ne peut pas être comparé en entier`
    );

  const parts = eqPipelineParts(text);
  if (parts.error) return finish('not_replayed', `pipeline non rejouable : ${parts.error}`);
  parts.caveats.forEach(c => x.notes.add(c));
  const dir = path.join(x.work, id);
  const dirs = { vec: path.join(dir, 'vector'), ls: path.join(dir, 'logstash') };
  for (const d of Object.values(dirs)) fs.mkdirSync(path.join(d, 'out'), { recursive: true });
  fs.mkdirSync(path.join(dirs.vec, 'data'), { recursive: true });
  const input = path.join(dir, 'sample.ndjson');
  fs.writeFileSync(input, x.sample.join('\n') + '\n');
  // Le pipeline réduit à ses filtres, comme « verify pipelines » : mêmes cas, repris dans le même ordre
  const red = translateLogstash(eqVectorSource(parts, path.join(dirs.vec, 'out'), id), x.cfg);
  if (red.error || red.empty)
    return finish('error', `traduction du pipeline réduit impossible : ${red.error || 'résultat vide'}`);
  const redCases = assistCases(red.config).filter(c => c.kind === 'ruby');
  const redProps = asstTransfer(cases, proposals, redCases);
  if (Object.keys(redProps).length !== redCases.length)
    return finish('error', 'les cas du pipeline réduit ne correspondent pas à ceux du pipeline entier');
  const translation = { verdict: verdictOf(red), coverage: coverage(red.stats).percent };
  const failure = await verifyPlayVector(
    verifyRetouch(toYAML(assistApply(red.config, redCases, redProps)) + '\n', path.join(dirs.vec, 'data')),
    dirs.vec,
    input,
    x.vectorBin,
    x.timeout
  );
  if (failure) return finish('error', failure, { translation });
  const got = await verifyReference(x.o, parts, dirs, input, x.mode, id, x.timeout);
  if (got.error) return finish('error', got.error, { translation });
  const vec = verifyOutputs(path.join(dirs.vec, 'out'), id, parts.outputNames);
  const ref = Object.fromEntries(Object.entries(got.ref).map(([k, v]) => [k, asstDrop(v, x.ignore)]));
  for (const k of Object.keys(vec)) vec[k] = asstDrop(vec[k], x.ignore);
  const cmp = eqComparePipelineOutputs(ref, vec, parts.outputNames, [x.now - 60000, Date.now() + 60000], {
    labels: { ref: x.o.reference ? 'référence' : 'Logstash', vec: 'Vector avec la proposition' }
  });
  const v = asstVerdict(
    cmp,
    Object.values(vec).some(l => l.length),
    x
  );
  return finish(v.state, v.reason, { translation, docs: v.docs, diffs: v.diffs });
}

/* ---------- Scripts Painless d’un pipeline d’ingestion ---------- */
// La configuration jouée : l’entrée standard à la place de la source Elastic Agent, un fichier à la place des sorties
function asstIngestReplayConfig(config, dir) {
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.data_dir = path.join(dir, 'data');
  cfg.api = { enabled: false };
  cfg.sources = { agent_in_raw: { type: 'stdin', decoding: { codec: 'json' }, log_namespace: true } };
  cfg.transforms = Object.assign(
    { agent_in: { type: 'remap', inputs: ['agent_in_raw'], source: '. = object!(.)' } },
    cfg.transforms
  );
  cfg.transforms.marque = { type: 'remap', inputs: ['bilan.echecs'], source: '.__echec = %ingest_failure' };
  cfg.sinks = {
    sortie: {
      type: 'file',
      inputs: ['bilan._unmatched', 'marque'],
      path: path.join(dir, 'sortie.ndjson'),
      encoding: { codec: 'json' }
    }
  };
  return cfg;
}
async function asstItemPainless(x, files) {
  const t0 = Date.now();
  const title = files.length === 1 ? path.basename(files[0]) : `${files.length} pipelines d’ingestion`;
  const item = { title, source: files.join(', '), cases: [] };
  const finish = (state, reason, extra) => {
    Object.assign(item, { state, reason: reason || '', elapsed_ms: Date.now() - t0 }, extra || {});
    process.stderr.write(`${ASST_MARK[state]} ${ASSIST_STATES[state]} : ${title}${reason ? ` — ${reason}` : ''}\n`);
    return item;
  };
  const r = translateIngest(ingestInputs(files), x.cfg);
  if (r.error) return finish('error', `traduction impossible : ${r.error}`);
  const cases = assistCases(r.config).filter(c => c.kind === 'painless');
  if (!cases.length) return finish('none', 'aucun script Painless à reprendre');
  const base = await validateVector(toYAML(r.config) + '\n', 'yaml');
  if (!base.valid)
    return finish(
      'error',
      `Vector refuse déjà la traduction, avant toute proposition (${asstFirstError(base.output)})`
    );
  const { proposals, records } = await asstPropose(r.config, cases, x);
  item.cases = records;
  const made = Object.keys(proposals).length;
  if (made) x.files.push({ name: 'ingest.propositions.yaml', content: asstProposedYAML(r, cases, proposals) });
  if (!made) return finish('refused', `${cases.length} cas, aucune proposition`);
  const missing = cases.length - made;
  if (!x.replay)
    return finish(
      'not_replayed',
      `${made} proposition${made > 1 ? 's' : ''} sur ${cases.length} cas, compilée${made > 1 ? 's' : ''} par Vector mais non rejouée${made > 1 ? 's' : ''} : ${x.replayHint}`
    );
  if (missing)
    return finish(
      'inconclusive',
      `${missing} cas sur ${cases.length} sans proposition : les pipelines ne peuvent pas être comparés en entier`
    );

  const dir = path.join(x.work, 'ingest');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = asstIngestReplayConfig(assistApply(r.config, cases, proposals), dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  const input = path.join(dir, 'sample.ndjson');
  fs.writeFileSync(input, x.sample.join('\n') + '\n');
  const venv = Object.assign({}, process.env, { VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION: 'true' });
  const v = await verifyRun(x.vectorBin, ['--quiet', '--color', 'never', '--config', path.join(dir, 'config.json')], {
    stdin: input,
    env: venv,
    timeout: x.timeout
  });
  if (v.error || v.code !== 0)
    return finish(
      'error',
      `Vector : ${v.timedOut ? 'délai dépassé' : v.error ? v.out : `code ${v.code}, ${lastLines(v.out, 3)}`}`
    );
  const vec = asstDrop(asstEvents(path.join(dir, 'sortie.ndjson')), x.ignore);
  let refEvents;
  try {
    refEvents = asstDrop(asstEvents(x.o.reference), x.ignore);
  } catch (e) {
    return finish('error', `référence illisible : ${e.message}`);
  }
  const translation = { verdict: verdictOf(r), coverage: coverage(r.stats).percent };
  const cmp = eqComparePipelineOutputs({ '': refEvents }, { '': vec }, [''], [x.now - 60000, Date.now() + 60000], {
    labels: { ref: 'référence', vec: 'Vector avec la proposition' }
  });
  const w = asstVerdict(cmp, vec.length > 0, x);
  return finish(w.state, w.reason, { translation, docs: w.docs, diffs: w.diffs });
}

/* ---------- La commande ---------- */
function asstWriteReport(rep, files, o) {
  const render = {
    md: assistReportMarkdown,
    html: assistReportHTML,
    csv: assistReportCSV,
    json: r => JSON.stringify(r, null, 2) + '\n'
  };
  const fmt = o.format || 'md';
  if (!render[fmt]) fail(`--format attend md, html, csv ou json pour assist, pas « ${fmt} »`);
  if (!o.out) {
    process.stdout.write(render[fmt](rep));
    return;
  }
  outDir(o.out);
  const base = path.join(o.out, `assistance-${rep.kind}-${asstStamp(new Date(rep.generated_at))}`);
  for (const f of ['md', 'html', 'csv', 'json']) fs.writeFileSync(`${base}.${f}`, render[f](rep));
  for (const f of files) fs.writeFileSync(path.join(o.out, f.name), f.content);
  process.stderr.write(
    `rapport → ${base}.{md,html,csv,json}${files.length ? `\npropositions (à vérifier) → ${files.map(f => path.join(o.out, f.name)).join(', ')}` : ''}\n`
  );
}
function asstExit(rep, o) {
  const s = rep.summary.byState;
  if (s.different) process.exit(2);
  if (s.error) process.exit(1);
  if (o.strict && (s.inconclusive || s.not_replayed || s.refused)) process.exit(2);
}

async function asstRun(o, kind) {
  const ruby = kind === 'ruby';
  if (!o._.length)
    fail(
      ruby
        ? 'aucun pipeline à lire. Exemple : passerelle assist ruby pipelines/web.conf --sample echantillon.ndjson --logstash-bin /usr/share/logstash/bin/logstash --out aide/'
        : 'aucun pipeline à lire. Exemple : passerelle assist painless pipelines/ --local-model --sample echantillon.ndjson --reference attendu.ndjson --out aide/'
    );
  const mode = o.ecs || 'v8';
  if (!EQ_ECS_MODES.includes(mode)) fail(`--ecs attend ${EQ_ECS_MODES.join(' ou ')}, pas « ${mode} »`);
  const cfg0 = loadCfgOrFail(o);
  const cfg = mergeConfig(cfg0, { vector: { ecs_compatibility: mode } });

  // Le modèle : seulement avec --local-model, et seulement sur la boucle locale
  let model = null;
  if (o['local-model']) {
    const m = Object.assign({}, cfg.assist.model);
    if (o['model-endpoint']) m.endpoint = o['model-endpoint'];
    if (o['model-name']) m.model = o['model-name'];
    if (o['model-api']) m.api = o['model-api'];
    if (!m.model) fail('--local-model demande le nom du modèle : --model-name ou assist.model.model');
    if (!['ollama', 'openai'].includes(m.api)) fail(`--model-api attend ollama ou openai, pas « ${m.api} »`);
    try {
      m.target = await asstModelTarget(m);
    } catch (e) {
      fail(e.message);
    }
    m.attempts = Math.max(1, Math.min(5, Number(m.max_attempts) || 2));
    model = m;
  }

  // Le rejeu : un échantillon et une référence
  const replayHint = ruby
    ? '--sample et --logstash-bin (ou --reference) permettent de la rejouer'
    : '--sample et --reference permettent de la rejouer';
  if (o.sample && !fs.existsSync(o.sample)) fail(`échantillon introuvable : ${o.sample}`);
  if (ruby && o['logstash-bin'] && o.reference)
    fail('--logstash-bin et --reference sont deux références : choisissez l’une');
  if (!ruby && o['logstash-bin'])
    fail('--logstash-bin ne sert qu’aux filtres ruby : pour Painless, la référence est un fichier (--reference)');
  const replay = !!(o.sample && (o.reference || (ruby && o['logstash-bin'])));
  const sample = o.sample
    ? fs
        .readFileSync(o.sample, 'utf8')
        .split('\n')
        .filter(l => l.trim())
    : [];
  if (replay && !sample.length) fail(`échantillon vide : ${o.sample}`);
  const vectorBin = o['vector-bin'] || process.env.PASSERELLE_VECTOR_BIN || 'vector';
  process.env.PASSERELLE_VECTOR_BIN = vectorBin;
  const ignore = [].concat(o.ignore || []);
  const files = collect(o._, ruby ? /\.(conf|cfg|logstash)$/i : /\.(ya?ml|json)(\.link)?$/i);
  if (!files.length) fail(ruby ? 'aucun fichier .conf trouvé' : 'aucun fichier .yml, .yaml ou .json trouvé');
  const now = Date.now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-assist-'));
  const x = {
    o,
    cfg,
    model,
    replay,
    replayHint,
    sample,
    vectorBin,
    ignore,
    now,
    work,
    mode,
    timeout: (Number(o.timeout) || 600) * 1000,
    notes: new Set(),
    files: []
  };
  const items = [];
  try {
    if (ruby) for (const [n, file] of files.entries()) items.push(await asstItemRuby(x, file, n));
    else items.push(await asstItemPainless(x, files));
  } catch (e) {
    if (e instanceof HttpError) fail(e.message);
    throw e;
  } finally {
    if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
    else process.stderr.write(`fichiers de travail conservés : ${work}\n`);
  }
  const rep = {
    kind,
    generated_at: new Date(now).toISOString(),
    passerelle: VERSION,
    conditions: {
      engines: Object.assign(
        { Vector: `${vectorBin}, ecs_compatibility ${mode}` },
        replay
          ? {
              Référence: o.reference
                ? `événements déjà produits (${path.basename(o.reference)})`
                : `Logstash ${path.basename(o['logstash-bin'])}, ecs_compatibility ${mode}`
            }
          : {}
      ),
      sample: replay ? `${sample.length} événement${sample.length > 1 ? 's' : ''} (${path.basename(o.sample)})` : '',
      model: model
        ? `${model.api}, modèle ${model.model}, ${model.target.addr}:${model.target.port} (boucle locale ; il ne reçoit que le code des cas, jamais un événement)`
        : 'aucun : règles seules',
      notes: [...x.notes]
        .concat(replay ? [] : [`Aucune proposition n’a été rejouée : ${replayHint}.`])
        .concat(
          replay && sample.length < 100
            ? ['Un échantillon de moins de 100 événements ne dit rien des cas rares : élargissez-le avant de conclure.']
            : []
        )
        .concat(ignore.length ? [`Champs écartés des deux côtés avant la comparaison : ${ignore.join(', ')}.`] : [])
    },
    values_hidden: !!o['no-values'],
    items
  };
  rep.summary = assistSummarize(items);
  process.stderr.write(`${assistSentence(rep.summary, ruby ? 'pipeline' : 'jeu de pipelines')}\n`);
  asstWriteReport(rep, x.files, o);
  asstExit(rep, o);
}

function assistCommand(o) {
  const sub = o._.shift();
  if (sub === 'ruby' || sub === 'painless') return asstRun(o, sub).catch(e => fail(e.message));
  return fail(`sous-commande inconnue : assist ${sub || ''}`.trim() + ' (ruby ou painless)');
}
