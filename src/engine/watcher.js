/* Passerelle — moteur : watches Elasticsearch (Watcher) → SQL ClickHouse et rapport de migration */
/*
 * Une watch réunit une planification (trigger), une entrée (input, le plus souvent une recherche), une condition
 * évaluée sur le résultat de l’entrée (ctx.payload), une transformation facultative et des actions (notifications).
 * La recherche passe par translateDSL. La condition devient une colonne « declenchee » calculée sur le résultat de
 * la requête, comme pour les règles d’alerte Kibana (decisionWrap). La planification est traduite en clair et en
 * cron. Les actions sont listées : elles se recréent dans l’outil d’alerte cible.
 *
 * Ce que fait Watcher et que la traduction reproduit (code d’Elasticsearch 7.17 à 9.x) :
 *   - dans le payload d’une watch, hits.total est un entier : rest_total_hits_as_int vaut true par défaut
 *     (WatcherSearchTemplateRequest). Sans track_total_hits, le décompte s’arrête à 10 000, et
 *     ctx.payload.hits.total.value n’existe pas (null) ;
 *   - compare : une valeur absente (null) ne satisfait ni eq, ni gt, gte, lt, lte ; elle satisfait not_eq ;
 *   - array_compare : quantifier vaut some par défaut ; sur une liste vide, some est faux et all est vrai.
 * Les valeurs connues dans la watch ({{ctx.metadata.…}}, {{ctx.watch_id}}, paramètres d’un modèle de recherche) sont
 * remplacées avant la traduction. Celles connues à l’exécution seulement ({{ctx.trigger.scheduled_time}},
 * {{ctx.execution_time}}) deviennent des paramètres ClickHouse, comme dans toute requête (dsl-params.js).
 */
const WATCH_ACTIONS = {
  email: 'e-mail',
  webhook: 'webhook',
  index: 'index',
  logging: 'journal',
  slack: 'Slack',
  pagerduty: 'PagerDuty',
  jira: 'Jira'
};
const WATCH_ACTION_KEYS = new Set([
  'throttle_period',
  'throttle_period_in_millis',
  'condition',
  'transform',
  'foreach',
  'max_iterations'
]);
// Watches des alertes de cluster de Stack Monitoring : <uuid du cluster>_<nom>
const WATCH_MONITORING_ID =
  /_(elasticsearch_cluster_status|elasticsearch_version_mismatch|elasticsearch_nodes|kibana_version_mismatch|logstash_version_mismatch|xpack_license_expiration)$/;
const WATCH_OPS = { eq: '=', not_eq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const WATCH_SCRIPT_OPS = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '==': 'eq', '!=': 'not_eq' };
const WATCH_FLIP = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq', not_eq: 'not_eq' };
const WATCH_KINDS = {
  json: 'watch JSON',
  threshold: 'seuil (interface Watcher de Kibana)',
  monitoring: 'Stack Monitoring'
};
const WATCH_EFFORT = { base: 1, action: 0.25 };
const WATCH_TOTAL_CAP = 10000;
const WATCH_METRICS = new Set([
  'avg',
  'sum',
  'min',
  'max',
  'cardinality',
  'value_count',
  'weighted_avg',
  'median_absolute_deviation'
]);
const WATCH_STATS = new Set(['stats', 'extended_stats']);
const WATCH_SINGLE = new Set(['filter', 'missing', 'global']);
const WATCH_BUCKETS = new Set([
  'terms',
  'date_histogram',
  'histogram',
  'auto_date_histogram',
  'rare_terms',
  'significant_terms',
  'multi_terms'
]);

/* ---------- Lecture ---------- */
const isWatchDef = o => isObj(o) && isObj(o.input) && (isObj(o.trigger) || isObj(o.condition) || isObj(o.actions));
// Un document de l’index .watches porte aussi l’état de la watch : il n’appartient pas à sa définition
function watchFromSource(src) {
  const w = Object.assign({}, src);
  const status = w.status || w._status || null;
  delete w.status;
  delete w._status;
  return { watch: w, status };
}
/*
 * Lecture des watches : réponse de GET|POST _watcher/_query/watches ({ count, watches: [{ _id, watch, status }] }),
 * de GET _watcher/watch/<id> ({ found, _id, watch, status }), recherche sur l’index .watches, console Kibana
 * (« PUT _watcher/watch/<id> » suivi du corps, plusieurs à la suite), définition seule, ou NDJSON de ces formes.
 *   name : identifiant par défaut d’une définition seule (le nom du fichier)
 */
function watcherRead(text, name) {
  const watches = [];
  const errors = [];
  const s = String(text || '').replace(/^﻿/, '');
  const add = (id, watch, status, origin) => {
    if (!isWatchDef(watch)) {
      errors.push(`${origin} : définition de watch attendue (trigger, input, condition, actions)`);
      return;
    }
    const meta = isObj(watch.metadata) ? watch.metadata : {};
    // Sans identifiant (définition seule) : le nom du fichier ou de la watch, rendu unique dans le fichier
    let uid = String(id || name || (typeof meta.name === 'string' && meta.name) || 'watch');
    if (!id) {
      const base = uid;
      let i = 2;
      while (watches.some(x => x.id === uid)) uid = `${base}-${i++}`;
    }
    watches.push({ id: uid, watch, status: isObj(status) ? status : null, origin });
  };
  const fromObject = (o, origin) => {
    if (!isObj(o)) {
      errors.push(`${origin} : objet JSON attendu`);
      return;
    }
    if (Array.isArray(o.watches)) {
      o.watches.forEach((w, k) =>
        isObj(w)
          ? add(w._id || w.id, w.watch, w.status, `${origin}, watch ${w._id || w.id || k + 1}`)
          : errors.push(`${origin}, élément ${k + 1} : objet attendu`)
      );
      return;
    }
    if (isObj(o.watch) && (o._id !== undefined || o.found !== undefined || o.id !== undefined)) {
      if (o.found === false) {
        errors.push(`${origin} : watch ${o._id || ''} introuvable (found: false)`);
        return;
      }
      add(o._id || o.id, o.watch, o.status, origin);
      return;
    }
    if (isObj(o.hits) && Array.isArray(o.hits.hits)) {
      o.hits.hits.forEach((h, k) => {
        if (!isObj(h) || !isObj(h._source)) {
          errors.push(`${origin}, document ${k + 1} : _source absent`);
          return;
        }
        const x = watchFromSource(h._source);
        add(h._id, x.watch, x.status, `${origin}, document ${h._id || k + 1}`);
      });
      return;
    }
    if (isWatchDef(o)) {
      const x = watchFromSource(o);
      add(null, x.watch, x.status, origin);
      return;
    }
    // { identifiant: définition } ou { identifiant: { watch, status } }
    const entries = Object.entries(o);
    if (entries.length && entries.every(([, d]) => isWatchDef(d) || (isObj(d) && isWatchDef(d.watch)))) {
      entries.forEach(([n, d]) =>
        add(n, isWatchDef(d) ? d : d.watch, isWatchDef(d) ? null : d.status, `${origin}, watch ${n}`)
      );
      return;
    }
    errors.push(`${origin} : ni watch, ni liste de watches (GET _watcher/_query/watches, GET _watcher/watch/<id>)`);
  };
  const parse = (body, origin) => {
    try {
      return JSON.parse(preprocessDSL(body));
    } catch (e) {
      errors.push(`${origin} : JSON illisible (${e.message})`);
      return undefined;
    }
  };
  // Console : « PUT _watcher/watch/<id> » suivi de son corps JSON ; les autres requêtes sont ignorées
  if (/^[ \t]*(PUT|POST)[ \t]+\/?_watcher\/watch\//m.test(s)) {
    const re = /^[ \t]*(GET|PUT|POST|DELETE|HEAD)[ \t]+(\S+)[^\n]*$/gm;
    const reqs = [];
    let m;
    while ((m = re.exec(s)))
      reqs.push({
        verb: m[1].toUpperCase(),
        path: m[2],
        at: m.index,
        end: re.lastIndex,
        line: s.slice(0, m.index).split('\n').length
      });
    reqs.forEach((r, k) => {
      const pm = /^\/?_watcher\/watch\/([^/?\s]+)(\?[^\s]*)?$/.exec(r.path);
      if (!pm || (r.verb !== 'PUT' && r.verb !== 'POST') || pm[1] === '_execute') return;
      const o = parse(s.slice(r.end, k + 1 < reqs.length ? reqs[k + 1].at : s.length).trim(), `ligne ${r.line}`);
      if (o === undefined) return;
      // ?active=false : la watch est créée désactivée
      const inactive = /[?&]active=false\b/.test(pm[2] || '');
      add(decodeURIComponent(pm[1]), o, inactive ? { state: { active: false } } : null, `ligne ${r.line}`);
    });
    return { watches, errors };
  }
  const t = s.trim();
  if (!t) {
    errors.push('document vide');
    return { watches, errors };
  }
  let o;
  try {
    o = JSON.parse(preprocessDSL(t));
  } catch (e) {
    // NDJSON : un objet par ligne
    const lines = t
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (lines.length > 1 && lines.every(l => l.startsWith('{'))) {
      lines.forEach((l, k) => {
        const x = parse(l, `ligne ${k + 1}`);
        if (x !== undefined) fromObject(x, `ligne ${k + 1}`);
      });
      return { watches, errors };
    }
    errors.push(`JSON illisible : ${e.message}`);
    return { watches, errors };
  }
  if (Array.isArray(o)) o.forEach((d, k) => fromObject(d, `élément ${k + 1}`));
  else fromObject(o, name || 'document');
  return { watches, errors };
}

// Secrets d’une watch (mots de passe, jetons, en-têtes d’autorisation) : masqués avant d’écrire un export sur disque
const WATCH_SECRET_KEY =
  /^(password|passwd|secret|secret_key|token|api_key|apikey|authorization|x-api-key|service_key|integration_key|webhook_url)$/i;
function watcherScrub(v) {
  if (Array.isArray(v)) return v.map(watcherScrub);
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v))
      o[k] =
        WATCH_SECRET_KEY.test(k) && x !== null && typeof x !== 'object' ? '::passerelle_masque::' : watcherScrub(x);
    return o;
  }
  // Identifiants dans une adresse (https://u:mdp@hôte) et paramètres d’adresse qui portent un secret (?token=…)
  if (typeof v === 'string')
    return v
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1::passerelle_masque::@')
      .replace(
        /([?&](?:token|access_token|jeton|key|api_key|apikey|secret|signature|sig|password|pwd|auth)=)[^&#\s"']+/gi,
        '$1::passerelle_masque::'
      );
  return v;
}

/* ---------- Planification ---------- */
const WATCH_DAYS = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
};
const WATCH_DAY_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const WATCH_MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
};
const WATCH_MONTH_FR = [
  '',
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre'
];
// Durée Watcher (« 5m », « 30s », 300) → secondes ; un nombre seul est en secondes
function watchSeconds(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(v === undefined || v === null ? '' : String(v));
  return m ? +m[1] * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || 's').toLowerCase()] : null;
}
function frEvery(sec) {
  for (const [n, unit, masc] of [
    [604800, 'semaines', false],
    [86400, 'jours', true],
    [3600, 'heures', false],
    [60, 'minutes', false],
    [1, 'secondes', false]
  ]) {
    if (sec >= n && sec % n === 0) {
      const k = sec / n;
      return `${masc ? 'tous les' : 'toutes les'} ${k === 1 ? '' : `${k} `}${unit}`;
    }
  }
  return `toutes les ${frNum(sec)} secondes`;
}
const hhmm = ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
// « at » : noon, midnight, « 17:00 », { hour, minute } (valeurs ou listes), ou une liste de ces formes → [[h, m]…]
function watchTimes(at) {
  const out = [];
  const one = v => {
    if (Array.isArray(v)) {
      v.forEach(one);
      return;
    }
    if (isObj(v)) {
      for (const h of [].concat(v.hour === undefined ? 0 : v.hour))
        for (const m of [].concat(v.minute === undefined ? 0 : v.minute)) out.push([+h, +m]);
      return;
    }
    const s = String(v).trim().toLowerCase();
    if (s === 'noon') out.push([12, 0]);
    else if (s === 'midnight') out.push([0, 0]);
    else {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      out.push(m ? [+m[1], +m[2]] : null);
    }
  };
  one(at === undefined || at === null ? 'midnight' : at);
  return out;
}
// Lignes cron (5 champs) pour une liste d’heures : une ligne par minute distincte
function cronAt(times, dom, mon, dow) {
  const byMin = new Map();
  for (const [h, m] of times) {
    if (!byMin.has(m)) byMin.set(m, []);
    if (!byMin.get(m).includes(h)) byMin.get(m).push(h);
  }
  return [...byMin.entries()].map(([m, hs]) => `${m} ${hs.sort((a, b) => a - b).join(',')} ${dom} ${mon} ${dow}`);
}
// Champ « a/b » de Quartz (départ a, pas b) → cron standard
const quartzStep = (f, first, last) =>
  f.replace(/^(\d+|\*)\/(\d+)$/, (x, a, b) => (a === '*' || +a === first ? `*/${b}` : `${a}-${last}/${b}`));
// Cron Quartz de Watcher (secondes, minutes, heures, jour du mois, mois, jour de la semaine, année) → cron à 5 champs
function quartzToCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length < 6 || f.length > 7) return { error: `« ${expr} » n’est pas un cron Quartz (6 ou 7 champs)` };
  const [sec, min, hour, dom, mon, dow, year] = f;
  if (year !== undefined && year !== '*' && year !== '?')
    return { error: `« ${expr} » limite l’année (${year}) : un cron à 5 champs ne le permet pas` };
  if (/[LW#]/i.test(dom + dow))
    return {
      error: `« ${expr} » emploie L, W ou # (dernier jour, jour ouvré le plus proche, n-ième jour du mois) : à reproduire à la main`
    };
  if (!/^\d+$/.test(sec))
    return {
      error: `« ${expr} » se déclenche plusieurs fois par minute (secondes ${sec}) : un cron à 5 champs ne le permet pas`
    };
  const dowStd = dow === '?' ? '*' : quartzStep(dow, 1, 7).replace(/\d+/g, n => String((+n + 6) % 7));
  const cron = [
    quartzStep(min, 0, 59),
    quartzStep(hour, 0, 23),
    dom === '?' ? '*' : quartzStep(dom, 1, 31),
    quartzStep(mon, 1, 12),
    dowStd
  ].join(' ');
  return { cron, seconds: +sec };
}
// Durée en cron : seulement quand elle divise l’heure ou le jour
function everyCron(sec) {
  if (sec % 60) return null;
  const m = sec / 60;
  if (m < 60) return 60 % m === 0 ? `${m === 1 ? '*' : `*/${m}`} * * * *` : null;
  if (m % 60) return null;
  const h = m / 60;
  if (h < 24) return 24 % h === 0 ? `0 ${h === 1 ? '*' : `*/${h}`} * * *` : null;
  return h === 24 ? '0 0 * * *' : null;
}
function watchSchedule(trigger) {
  const issues = [];
  const sch = isObj(trigger) && isObj(trigger.schedule) ? trigger.schedule : null;
  if (!sch)
    return {
      text: 'aucune',
      cron: [],
      every: null,
      issues: [
        {
          kind: 'review',
          label: 'planification absente',
          detail: 'La watch n’a pas de schedule : elle ne s’exécute que sur demande (_execute).'
        }
      ]
    };
  const tz = typeof sch.timezone === 'string' ? sch.timezone : null;
  const bad = what => ({
    text: what,
    cron: [],
    every: null,
    issues: [
      {
        kind: 'review',
        label: 'planification illisible',
        detail: `${what} : à reproduire à la main dans l’outil cible.`
      }
    ]
  });
  const times = at => {
    const t = watchTimes(at);
    return t.some(x => !x) ? null : t;
  };
  let out;
  if (sch.interval !== undefined) {
    const s = watchSeconds(sch.interval);
    if (s === null || s <= 0) return bad(`intervalle « ${sch.interval} »`);
    const c = everyCron(s);
    out = { text: frEvery(s), cron: c ? [c] : [], every: s };
    issues.push({
      kind: 'info',
      label: 'intervalle',
      detail: c
        ? `Un intervalle Watcher part de l’activation de la watch ; le cron proposé (${c}) est aligné sur l’horloge.`
        : `Un intervalle de ${frEvery(s).replace(/^tou(te)?s les /, '')} ne s’écrit pas en cron : utilisez un intervalle d’évaluation (Grafana, par exemple).`
    });
  } else if (sch.hourly !== undefined) {
    const mins = [].concat(isObj(sch.hourly) && sch.hourly.minute !== undefined ? sch.hourly.minute : 0).map(Number);
    if (mins.some(x => !Number.isInteger(x) || x < 0 || x > 59)) return bad('planification hourly');
    out = {
      text: `toutes les heures, à la minute ${mins.join(', ')}`,
      cron: [`${mins.join(',')} * * * *`],
      every: mins.length === 1 ? 3600 : null
    };
  } else if (sch.daily !== undefined) {
    const t = times(isObj(sch.daily) ? sch.daily.at : undefined);
    if (!t) return bad('planification daily');
    out = {
      text: `tous les jours à ${t.map(hhmm).join(', ')}`,
      cron: cronAt(t, '*', '*', '*'),
      every: t.length === 1 ? 86400 : null
    };
  } else if (sch.weekly !== undefined) {
    const parts = [].concat(sch.weekly);
    const cron = [];
    const txt = [];
    for (const p of parts) {
      const days = []
        .concat(isObj(p) && p.on !== undefined ? p.on : 'monday')
        .map(d => WATCH_DAYS[String(d).toLowerCase()]);
      const t = times(isObj(p) ? p.at : undefined);
      if (!t || days.some(d => d === undefined)) return bad('planification weekly');
      cron.push(...cronAt(t, '*', '*', [...new Set(days)].join(',')));
      txt.push(`chaque ${days.map(d => WATCH_DAY_FR[d]).join(', ')} à ${t.map(hhmm).join(', ')}`);
    }
    out = { text: txt.join(' ; '), cron, every: null };
  } else if (sch.monthly !== undefined) {
    const parts = [].concat(sch.monthly);
    const cron = [];
    const txt = [];
    for (const p of parts) {
      const days = [].concat(isObj(p) && p.on !== undefined ? p.on : 1).map(Number);
      const t = times(isObj(p) ? p.at : undefined);
      if (!t || days.some(d => !Number.isInteger(d) || d < 1 || d > 31)) return bad('planification monthly');
      cron.push(...cronAt(t, days.join(','), '*', '*'));
      txt.push(`le ${days.join(', ')} de chaque mois à ${t.map(hhmm).join(', ')}`);
    }
    out = { text: txt.join(' ; '), cron, every: null };
  } else if (sch.yearly !== undefined) {
    const parts = [].concat(sch.yearly);
    const cron = [];
    const txt = [];
    for (const p of parts) {
      const months = []
        .concat(isObj(p) && p.in !== undefined ? p.in : 'january')
        .map(
          x => WATCH_MONTHS[String(x).toLowerCase()] || (Number.isInteger(+x) && +x >= 1 && +x <= 12 ? +x : undefined)
        );
      const days = [].concat(isObj(p) && p.on !== undefined ? p.on : 1).map(Number);
      const t = times(isObj(p) ? p.at : undefined);
      if (!t || months.some(x => x === undefined) || days.some(d => !Number.isInteger(d) || d < 1 || d > 31))
        return bad('planification yearly');
      cron.push(...cronAt(t, days.join(','), months.join(','), '*'));
      txt.push(`le ${days.join(', ')} ${months.map(x => WATCH_MONTH_FR[x]).join(', ')} à ${t.map(hhmm).join(', ')}`);
    }
    out = { text: txt.join(' ; '), cron, every: null };
  } else if (sch.cron !== undefined) {
    const list = [].concat(sch.cron);
    const cron = [];
    for (const c of list) {
      const r = quartzToCron(c);
      if (r.error) issues.push({ kind: 'review', label: 'cron Quartz', detail: r.error });
      else {
        cron.push(r.cron);
        if (r.seconds)
          issues.push({
            kind: 'info',
            label: 'secondes du cron',
            detail: `« ${c} » se déclenche à la seconde ${r.seconds} ; le cron à 5 champs se déclenche à la seconde 0.`
          });
      }
    }
    out = { text: `cron Quartz ${list.map(c => `« ${c} »`).join(', ')}`, cron, every: null };
  } else return bad(`planification ${Object.keys(sch)[0] || 'vide'}`);
  if (tz)
    issues.push({
      kind: 'info',
      label: 'fuseau de la planification',
      detail: `Les heures s’entendent dans le fuseau ${tz} (CRON_TZ=${tz} pour un cron).`
    });
  return Object.assign(out, {
    text: out.text + (tz ? ` (${tz})` : out.cron.length && sch.interval === undefined ? ' (UTC)' : ''),
    timezone: tz,
    issues
  });
}

/* ---------- Valeurs connues dans la watch ---------- */
const watchLookup = (known, p) => {
  let v = known;
  for (const k of String(p).split('.')) {
    if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
};
// Modèles Mustache dont la valeur est connue : remplacés ; les autres restent pour dsl-params.js
function watchRenderText(s, known) {
  return String(s)
    .replace(/\{\{#toJson\}\}\s*([\w.]+)\s*\{\{\/toJson\}\}/g, (m, p) => {
      const v = watchLookup(known, p);
      return v === undefined ? m : JSON.stringify(v);
    })
    .replace(/\{\{#join\}\}\s*([\w.]+)\s*\{\{\/join\}\}/g, (m, p) => {
      const v = watchLookup(known, p);
      return Array.isArray(v) ? v.join(',') : m;
    })
    .replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (m, p) => {
      const v = watchLookup(known, p);
      return v === undefined || v === null || typeof v === 'object' ? m : String(v);
    });
}
function watchRenderDeep(v, known) {
  if (typeof v === 'string') {
    // Un modèle seul qui vaut un nombre ou un booléen garde son type (« size »: "{{ctx.metadata.taille}}")
    const whole = /^\{\{\{?\s*([\w.]+)\s*\}?\}\}$/.exec(v);
    if (whole) {
      const x = watchLookup(known, whole[1]);
      if (typeof x === 'number' || typeof x === 'boolean') return x;
    }
    return watchRenderText(v, known);
  }
  if (Array.isArray(v)) return v.map(x => watchRenderDeep(x, known));
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = watchRenderDeep(x, known);
    return o;
  }
  return v;
}

/* ---------- Entrées ---------- */
// Une entrée seule (search, http, simple, none) ou une chaîne d’entrées nommées
function watchInputList(input) {
  if (!isObj(input) || !Object.keys(input).length) return [{ name: null, type: 'none', def: {} }];
  if (isObj(input.chain)) {
    const list = Array.isArray(input.chain.inputs) ? input.chain.inputs : [];
    return list.flatMap(o =>
      Object.entries(isObj(o) ? o : {}).map(([n, d]) => {
        const t = isObj(d) ? Object.keys(d)[0] : null;
        return { name: n, type: t || 'none', def: t && isObj(d[t]) ? d[t] : {} };
      })
    );
  }
  const t = Object.keys(input)[0];
  return [{ name: null, type: t, def: isObj(input[t]) ? input[t] : {} }];
}
// Index en date math (<logs-{now/d}>) → motif ; la watch lit l’index du jour
function watchIndexName(name, issues) {
  let n = String(name).trim();
  try {
    n = decodeURIComponent(n);
  } catch (e) {
    /* nom gardé tel quel */
  }
  const m = /^<(.+)>$/.exec(n);
  if (!m) return n;
  const pat = m[1].replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g, '*').replace(/\*+/g, '*');
  issues.push({
    kind: 'review',
    label: 'index en date math',
    detail: `${n} désigne l’index du jour de l’exécution ; la traduction lit ${pat}, c’est-à-dire toute la table : la fenêtre de temps de la requête doit suffire à limiter la lecture.`
  });
  return pat;
}
// Corps de recherche d’une entrée search (ou d’une transformation search), valeurs connues remplacées
function watchSearchBody(def, known, issues, label) {
  const req = isObj(def.request) ? def.request : {};
  const raw = Array.isArray(req.indices) ? req.indices : typeof req.indices === 'string' ? req.indices.split(',') : [];
  const indices = raw
    .map(x => String(x).trim())
    .filter(Boolean)
    .map(x => watchIndexName(x, issues));
  let body;
  if (isObj(req.template)) {
    const t = req.template;
    if (t.id) {
      issues.push({
        kind: 'todo',
        label: 'modèle de recherche stocké',
        detail: `${label} lit le modèle de recherche « ${t.id} », qui n’est pas dans la watch : exportez-le (GET _scripts/${t.id}) et placez sa source dans la watch.`
      });
      return null;
    }
    const src = t.source !== undefined ? t.source : t.inline;
    const k2 = Object.assign({}, isObj(t.params) ? t.params : {}, known);
    if (typeof src === 'string') {
      const txt = watchRenderText(src, k2);
      try {
        body = JSON.parse(preprocessDSL(txt));
      } catch (e) {
        issues.push({
          kind: 'todo',
          label: 'modèle de recherche',
          detail: `${label} : après remplacement des valeurs connues, la source du modèle n’est pas un JSON (${e.message}). Les sections Mustache ({{#…}}) se traduisent à la main.`
        });
        return null;
      }
      if (!isObj(body)) {
        issues.push({
          kind: 'todo',
          label: 'modèle de recherche',
          detail: `${label} : la source du modèle n’est pas un objet JSON.`
        });
        return null;
      }
    } else body = isObj(src) ? watchRenderDeep(src, k2) : {};
    if (isObj(t.params) && Object.keys(t.params).length)
      issues.push({
        kind: 'info',
        label: 'modèle de recherche',
        detail: `${label} : les paramètres du modèle (${Object.keys(t.params).join(', ')}) sont remplacés par leur valeur avant la traduction.`
      });
  } else body = isObj(req.body) ? watchRenderDeep(req.body, known) : {};
  if (req.search_type && req.search_type !== 'query_then_fetch')
    issues.push({
      kind: 'info',
      label: `search_type ${req.search_type}`,
      detail: 'Il ne change que le calcul des scores, que ClickHouse ne reproduit pas.'
    });
  if (isObj(req.indices_options))
    issues.push({
      kind: 'info',
      label: 'indices_options',
      detail: `${label} règle l’expansion des motifs et les index absents (${Object.keys(req.indices_options).join(', ')}) : sans objet pour une table ClickHouse.`
    });
  if (Array.isArray(def.extract) && def.extract.length)
    issues.push({
      kind: 'info',
      label: 'extract',
      detail: `${label} ne garde que ${def.extract.join(', ')} dans le payload : les actions n’ont que ces valeurs.`
    });
  return { pattern: indices.join(','), body, totalAsInt: req.rest_total_hits_as_int !== false };
}

/* ---------- Conditions ---------- */
// Chemin d’objet (ctx.payload.a['b.c'][0]) → segments
function watchPath(p) {
  const out = [];
  const re = /\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]|\[\s*(\d+)\s*\]|([^.[\]\s]+)/g;
  let m;
  while ((m = re.exec(String(p))))
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
  return out;
}
// Valeur comparée : constante, chemin {{ctx.…}} (résolu s’il est connu) ou date math <{now-5m}>
function watchValue(v, known) {
  if (typeof v !== 'string') return { v };
  const dm = /^<\{(.+)\}>$/.exec(v);
  if (dm) return { dateMath: dm[1] };
  const p = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v);
  if (p) {
    const x = watchLookup(known, p[1]);
    return x === undefined ? { path: p[1] } : { v: x };
  }
  return { v };
}
const watchTodo = (label, detail) => ({ kind: 'todo', label, detail });
// Valeur d’un script : nombre, texte, booléen, params.x ou ctx.metadata.x
function watchScriptValue(tok, params, known) {
  const t = tok.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return { v: +t };
  if (/^'[^']*'$|^"[^"]*"$/.test(t)) return { v: t.slice(1, -1) };
  if (t === 'true' || t === 'false') return { v: t === 'true' };
  if (t === 'null') return { v: null };
  const pm = /^params(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])$/.exec(t);
  if (pm) {
    const k = pm[1] || pm[2];
    return Object.prototype.hasOwnProperty.call(params, k) ? { v: params[k] } : null;
  }
  if (/^ctx\.metadata(\.\w+)+$/.test(t)) {
    const x = watchLookup(known, t);
    return x === undefined ? null : { v: x };
  }
  return null;
}
// Condition Painless : les formes courantes seulement (comparaison d’un chemin, taille d’une liste, boucle sur des groupes)
function watchScriptForm(def, known) {
  const sc = typeof def === 'string' ? { source: def } : isObj(def) ? def : {};
  if (sc.id)
    return watchTodo(
      'script stocké',
      `La condition appelle le script stocké « ${sc.id} », qui n’est pas dans la watch : exportez-le (GET _scripts/${sc.id}).`
    );
  if (sc.lang && sc.lang !== 'painless') return watchTodo(`script ${sc.lang}`, 'Seul Painless est lu.');
  const src = String(sc.source !== undefined ? sc.source : sc.inline || '');
  const params = isObj(sc.params) ? sc.params : {};
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const P = String.raw`(ctx\.payload(?:\.\w+|\[\s*'[^']*'\s*\]|\[\s*"[^"]*"\s*\]|\[\s*\d+\s*\])+)`;
  const V = String.raw`(-?\d+(?:\.\d+)?|params\.\w+|params\[\s*['"]\w+['"]\s*\]|ctx\.metadata(?:\.\w+)+|'[^']*'|"[^"]*"|true|false|null)`;
  const OP = '(>=|<=|==|!=|>|<)';
  const form = (path, op, tok, extra) => {
    const value = watchScriptValue(tok, params, known);
    return value
      ? Object.assign({ kind: 'compare', path, op: WATCH_SCRIPT_OPS[op], value, script: true }, extra || {})
      : null;
  };
  let m = new RegExp(`^(?:return )?\\(?\\s*${P}\\.(?:size\\(\\)|length)\\s*${OP}\\s*${V}\\s*\\)?\\s*;?$`).exec(code);
  if (m) {
    const f = form(m[1], m[2], m[3], { kind: 'rows' });
    if (f) return f;
  }
  m = new RegExp(`^(?:return )?\\(?\\s*${P}\\s*${OP}\\s*${V}\\s*\\)?\\s*;?$`).exec(code);
  if (m) {
    const f = form(m[1], m[2], m[3]);
    if (f) return f;
  }
  m = new RegExp(`^(?:return )?\\(?\\s*${V}\\s*${OP}\\s*${P}\\s*\\)?\\s*;?$`).exec(code);
  if (m) {
    const f = form(m[3], m[2], m[1]);
    if (f) {
      f.op = WATCH_FLIP[f.op];
      return f;
    }
  }
  // Boucle : « for (… : ctx.payload.aggregations.a.buckets) { if (b.doc_count > N) { return true; } } return false; »
  const list = /(ctx\.payload(?:\.\w+)+?)\.buckets\b/.exec(code);
  const test = new RegExp(
    String.raw`if ?\( ?\w+(?:\[ ?\w+ ?\])? ?(?:\.(\w+)|\[ ?['"](\w+)['"] ?\])( ?\. ?value)? ?${OP} ?${V} ?\)`
  ).exec(code);
  if (
    list &&
    test &&
    /return true/.test(code) &&
    /return false ?;? ?\}?$/.test(code) &&
    (code.match(/\bif ?\(/g) || []).length === 1
  ) {
    const field = test[1] || test[2];
    const inner = field === 'doc_count' && !test[3] ? 'doc_count' : test[3] ? `${field}.value` : field;
    const value = watchScriptValue(test[5], params, known);
    const base = /^(ctx\.payload.*?)(?:\.buckets)?$/.exec(list[1])[1];
    if (value)
      return {
        kind: 'array',
        path: `${base}.buckets`,
        inner,
        op: WATCH_SCRIPT_OPS[test[4]],
        value,
        quantifier: 'some',
        script: true
      };
  }
  return watchTodo(
    'condition Painless',
    `Le script de la condition ne correspond pas aux formes que Passerelle reconnaît (comparaison d’une valeur du payload, taille d’une liste, boucle sur des groupes) : sa logique se réécrit en SQL sur le résultat de la requête. Script : ${src.replace(/\s+/g, ' ').trim().slice(0, 300)}`
  );
}
// Seuil créé par l’interface Watcher de Kibana : metadata.watcherui décrit la condition, plus sûrement que son script
function watchThresholdForm(w, body) {
  const u = w.metadata.watcherui;
  const aggs = (isObj(body) && (body.aggs || body.aggregations)) || {};
  const op = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte', between: 'between' }[u.threshold_comparator];
  const th = [].concat(u.threshold);
  if (!op || th.some(x => typeof x !== 'number')) return null;
  const metricOf = a =>
    Object.entries(a || {}).find(([, d]) => isObj(d) && ['avg', 'sum', 'min', 'max'].some(k => isObj(d[k])));
  const value = op === 'between' ? { between: th.slice(0, 2) } : { v: th[0] };
  const count = !u.agg_type || u.agg_type === 'count';
  if (u.term_field) {
    const t = Object.entries(aggs).find(([, d]) => isObj(d) && isObj(d.terms));
    const m = t && !count ? metricOf(t[1].aggs || t[1].aggregations) : null;
    if (!t || (!count && !m)) return null;
    return {
      kind: 'array',
      path: `ctx.payload.aggregations.${t[0]}.buckets`,
      inner: m ? `${m[0]}.value` : 'doc_count',
      op,
      value,
      quantifier: 'some',
      threshold: true
    };
  }
  if (count) return { kind: 'compare', path: 'ctx.payload.hits.total', op, value, threshold: true };
  const m = metricOf(aggs);
  return m ? { kind: 'compare', path: `ctx.payload.aggregations.${m[0]}.value`, op, value, threshold: true } : null;
}
function watchConditionForm(cond, known) {
  if (!isObj(cond) || !Object.keys(cond).length) return { kind: 'always', implicit: true };
  const type = Object.keys(cond)[0];
  const def = cond[type];
  if (type === 'always') return { kind: 'always' };
  if (type === 'never') return { kind: 'never' };
  if (type === 'compare') {
    const [path, spec] = Object.entries(isObj(def) ? def : {})[0] || [];
    const [op, value] = Object.entries(isObj(spec) ? spec : {})[0] || [];
    if (!path || !WATCH_OPS[op])
      return watchTodo(
        'condition compare',
        'Condition compare illisible : un chemin et une comparaison (eq, not_eq, gt, gte, lt, lte) sont attendus.'
      );
    return { kind: 'compare', path, op, value: watchValue(value, known) };
  }
  if (type === 'array_compare') {
    const [path, spec] = Object.entries(isObj(def) ? def : {})[0] || [];
    const op = isObj(spec) ? Object.keys(spec).find(k => WATCH_OPS[k]) : null;
    if (!path || !op)
      return watchTodo(
        'condition array_compare',
        'Condition array_compare illisible : un chemin, path et une comparaison sont attendus.'
      );
    const o = spec[op];
    const quantifier = (isObj(o) && o.quantifier) || 'some';
    if (quantifier !== 'some' && quantifier !== 'all')
      return watchTodo('condition array_compare', `Quantificateur « ${quantifier} » inconnu (some ou all).`);
    return {
      kind: 'array',
      path,
      inner: typeof spec.path === 'string' ? spec.path : '',
      op,
      value: watchValue(isObj(o) ? o.value : o, known),
      quantifier
    };
  }
  if (type === 'script') return watchScriptForm(def, known);
  return watchTodo(`condition ${type}`, 'Type de condition que Passerelle ne lit pas.');
}
const watchShort = p => String(p).replace(/^ctx\.payload\./, '');
const watchValText = value =>
  value.between
    ? `${value.between[0]} et ${value.between[1]}`
    : value.v === null || value.v === undefined
      ? 'null'
      : typeof value.v === 'string'
        ? `« ${value.v} »`
        : String(value.v);
const WATCH_OP_TEXT = { eq: '=', not_eq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'entre' };
function watchConditionText(f) {
  if (f.kind === 'always') return f.implicit ? 'aucune (toujours vraie)' : 'always (toujours vraie)';
  if (f.kind === 'never') return 'never (jamais vraie)';
  if (f.kind === 'todo') return f.label;
  const via = f.threshold ? ' (seuil de l’interface Watcher)' : f.script ? ' (script)' : '';
  const v = f.value.path ? `{{${f.value.path}}}` : f.value.dateMath ? `<{${f.value.dateMath}}>` : watchValText(f.value);
  if (f.kind === 'rows') return `taille de ${watchShort(f.path)} ${WATCH_OP_TEXT[f.op]} ${v}${via}`;
  if (f.kind === 'compare') return `${watchShort(f.path)} ${WATCH_OP_TEXT[f.op]} ${v}${via}`;
  return `${f.quantifier === 'all' ? 'tous les' : 'au moins un des'} éléments de ${watchShort(f.path)} : ${f.inner || 'valeur'} ${WATCH_OP_TEXT[f.op]} ${v}${via}`;
}
// Littéral SQL d’une valeur de comparaison
function watchLiteral(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return chStr(v);
}
/*
 * Comparaison, avec les règles de Watcher (LenientCompare) : une valeur absente ne satisfait que not_eq ; une valeur
 * configurée en texte est comparée en texte (« 10 » < « 5 »), même quand elle a l’air d’un nombre.
 */
function watchCmp(col, op, value, nullable) {
  if (op === 'between') {
    const e = `${col} > ${watchLiteral(value.between[0])} AND ${col} < ${watchLiteral(value.between[1])}`;
    return nullable ? `ifNull(${e}, 0)` : e;
  }
  if (value.v === null || value.v === undefined)
    return op === 'eq' ? `isNull(${col})` : op === 'not_eq' ? `isNotNull(${col})` : '0';
  const e = `${typeof value.v === 'string' ? `toString(${col})` : col} ${WATCH_OPS[op]} ${watchLiteral(value.v)}`;
  return nullable ? `ifNull(${e}, ${op === 'not_eq' ? 1 : 0})` : e;
}
const watchAggType = d =>
  isObj(d) ? Object.keys(d).find(k => k !== 'aggs' && k !== 'aggregations' && k !== 'meta') : null;
const watchHasCol = (sql, col) =>
  new RegExp(`\\bAS ${escRe(col)}(?![A-Za-z0-9_])|^\\s+${escRe(col)},?$`, 'm').test(sql);
// Statement d’une traduction par son titre
const watchStatement = (r, title) => (r && r.statements ? r.statements.find(s => s.title === title) : null);
/*
 * Chemin d’une valeur du payload → colonne du résultat SQL. Renvoie { stmt, col, nullable } ou { error }.
 * rest : segments après ctx.payload (et après le nom de l’entrée d’une chaîne).
 */
function watchScalarTarget(rest, inp, cfg) {
  const s = inp.search;
  if (rest[0] === 'hits' && rest[1] === 'total' && (rest.length === 2 || (rest.length === 3 && rest[2] === 'value')))
    return { count: true, viaValue: rest.length === 3 };
  if (rest[0] !== 'aggregations' || rest.length < 3)
    return { error: `${rest.join('.')} n’est ni hits.total ni une valeur d’agrégation` };
  const aggs = s.body.aggs || s.body.aggregations || {};
  const [A, ...tail] = rest.slice(1);
  const def = aggs[A];
  const type = watchAggType(def);
  if (!type) return { error: `agrégation « ${A} » absente de la requête` };
  const stmt = watchStatement(inp.r, 'Mesures globales');
  let col = null;
  if (tail.length === 1 && tail[0] === 'value' && WATCH_METRICS.has(type)) col = rawAlias(A);
  else if (tail.length === 1 && tail[0] === 'doc_count' && WATCH_SINGLE.has(type)) col = rawAlias(`${A}_doc_count`);
  else if (tail.length === 2 && tail[1] === 'value' && WATCH_SINGLE.has(type)) col = rawAlias(`${A}_${tail[0]}`);
  else if (tail.length === 1 && WATCH_STATS.has(type) && ['count', 'min', 'max', 'avg', 'sum'].includes(tail[0]))
    col = rawAlias(`${A}_${tail[0]}`);
  else if (tail.length === 2 && tail[0] === 'values' && type === 'percentiles') {
    const pc = (def.percentiles.percents || [1, 5, 25, 50, 75, 95, 99]).map(Number);
    const i = pc.indexOf(Number(tail[1]));
    if (i < 0 || !stmt || !watchHasCol(stmt.sql, rawAlias(A)))
      return { error: `centile ${tail[1]} absent de « ${A} »` };
    return { stmt, col: `${rawAlias(A)}[${i + 1}]`, nullable: true };
  } else if (tail[0] === 'buckets')
    return { error: `${rest.join('.')} désigne un groupe précis : la condition se réécrit sur le résultat groupé` };
  if (!col)
    return { error: `${rest.join('.')} : valeur d’agrégation ${type} que Passerelle ne relie pas à une colonne` };
  if (!stmt || !watchHasCol(stmt.sql, col))
    return { error: `${rest.join('.')} : colonne ${col} absente de la traduction` };
  return { stmt, col, nullable: col !== rawAlias(`${A}_doc_count`) };
}
// Liste du payload (groupes d’une agrégation, documents) → requête ligne à ligne et colonne de chaque élément
function watchArrayTarget(rest, innerPath, inp, cfg) {
  const s = inp.search;
  const inner = watchPath(innerPath || '');
  if (rest[0] === 'hits' && rest[1] === 'hits' && rest.length === 2) {
    const stmt = watchStatement(inp.r, 'Documents');
    if (!stmt) return { empty: true, label: 'documents' };
    if (inner.length === 0) return { stmt, col: null, label: 'documents' };
    if (inner[0] !== '_source' || inner.length < 2)
      return { error: `${innerPath} : seuls les champs de _source se relient à une colonne` };
    return { stmt, col: mapFieldOf(cfg, inp.r.table, inner.slice(1).join('.')), nullable: true, label: 'documents' };
  }
  if (rest[0] !== 'aggregations' || rest.length !== 3 || rest[2] !== 'buckets')
    return { error: `${rest.join('.')} n’est ni hits.hits ni la liste des groupes d’une agrégation` };
  const A = rest[1];
  const aggs = s.body.aggs || s.body.aggregations || {};
  const def = aggs[A];
  const type = watchAggType(def);
  if (!type) return { error: `agrégation « ${A} » absente de la requête` };
  if (!WATCH_BUCKETS.has(type))
    return { error: `« ${A} » (${type}) n’est pas une agrégation à groupes que Passerelle relie` };
  const sub = def.aggs || def.aggregations || {};
  if (Object.values(sub).some(d => WATCH_BUCKETS.has(watchAggType(d)) || WATCH_SINGLE.has(watchAggType(d))))
    return { error: `« ${A} » contient des sous-groupes : la condition se réécrit sur le résultat groupé` };
  const stmt = watchStatement(inp.r, `Agrégation ${A}`);
  if (!stmt) return { error: `regroupement « ${A} » absent de la traduction` };
  let col = null;
  let nullable = true;
  if (inner.length === 0) col = null;
  else if (inner.length === 1 && inner[0] === 'doc_count') {
    col = 'doc_count';
    nullable = false;
  } else if (inner.length === 1 && (inner[0] === 'key' || inner[0] === 'key_as_string'))
    col = watchHasCol(stmt.sql, rawAlias(A)) ? rawAlias(A) : null;
  else if (inner.length === 2 && inner[1] === 'value' && WATCH_METRICS.has(watchAggType(sub[inner[0]])))
    col = rawAlias(inner[0]);
  else if (inner.length === 2 && WATCH_STATS.has(watchAggType(sub[inner[0]])))
    col = rawAlias(`${inner[0]}_${inner[1]}`);
  if (inner.length && (!col || !watchHasCol(stmt.sql, col)))
    return { error: `${innerPath} : élément des groupes de « ${A} » que Passerelle ne relie pas à une colonne` };
  return { stmt, col, nullable, label: 'groupes' };
}
// Corps de recherche réduit au décompte (hits.total) : post_filter compris, comme Elasticsearch le compte
function watchCountBody(body) {
  const b = Object.assign({}, body, { size: 0 });
  for (const k of [
    'aggs',
    'aggregations',
    'sort',
    '_source',
    'highlight',
    'collapse',
    'search_after',
    'from',
    'track_total_hits',
    'script_fields',
    'docvalue_fields',
    'fields',
    'stored_fields'
  ])
    delete b[k];
  if (isObj(body.post_filter)) {
    b.query = { bool: { filter: [body.query || { match_all: {} }, body.post_filter] } };
    delete b.post_filter;
  }
  return b;
}
/*
 * Condition → requête de décision. inputs : entrées traduites ({ name, type, search, r }).
 * Renvoie { sql, text, dsl, pattern, r } ou null ; les points à reprendre ou à vérifier vont dans issues.
 */
function watchDecision(form, inputs, cfg, issues) {
  const fail = (label, detail) => {
    issues.push({ kind: 'todo', label, detail });
    return null;
  };
  const segs = watchPath(form.path);
  if (segs[0] !== 'ctx' || segs[1] !== 'payload')
    return fail('chemin de la condition', `${form.path} ne lit pas le payload de l’entrée.`);
  let rest = segs.slice(2);
  let inp = inputs.find(i => i.name && i.name === rest[0]);
  if (inp) rest = rest.slice(1);
  else inp = inputs.length === 1 ? inputs[0] : null;
  if (!inp)
    return fail(
      'chemin de la condition',
      `${form.path} ne désigne aucune des entrées de la chaîne (${inputs
        .map(i => i.name)
        .filter(Boolean)
        .join(', ')}).`
    );
  // L’entrée elle-même est déjà à reprendre : la condition se recrée avec elle, sans être comptée deux fois
  if (inp.type !== 'search' || !inp.search || !inp.r || inp.r.error) {
    issues.push({
      kind: 'info',
      label: 'condition sur une entrée non traduite',
      detail: `La condition (${watchConditionText(form)}) lit une valeur de l’entrée ${inp.type}${inp.name ? ` « ${inp.name} »` : ''}, qui n’a pas de traduction SQL : elle se recrée avec cette entrée.`
    });
    return null;
  }
  if (form.value && form.value.path)
    return fail(
      'valeur comparée lue dans le payload',
      `La condition compare à {{${form.value.path}}}, une autre valeur du résultat : la comparaison se réécrit en SQL.`
    );
  if (form.value && form.value.dateMath)
    return fail(
      'date math dans la condition',
      `La condition compare à <{${form.value.dateMath}}>, une date calculée à l’exécution : la comparaison se réécrit en SQL (now64(3, 'UTC') - INTERVAL …).`
    );
  const text = watchConditionText(form);
  if (form.value && typeof form.value.v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(form.value.v))
    issues.push({
      kind: 'review',
      label: 'seuil entre guillemets',
      detail: `La condition compare à « ${form.value.v} », un texte : Watcher compare alors en texte (10 est inférieur à « 5 »), et la traduction aussi. Si le seuil est un nombre, retirez les guillemets dans la watch.`
    });
  if (form.op === 'between')
    issues.push({
      kind: 'review',
      label: 'bornes du seuil « entre »',
      detail: `La traduction exclut les bornes (${watchValText(form.value)}) : vérifiez le comportement de la watch d’origine sur une valeur égale à une borne.`
    });
  const s = inp.search;
  if (form.kind === 'compare') {
    const t = watchScalarTarget(rest, inp, cfg);
    if (t.error) return fail('condition non reliée', `${text} : ${t.error}.`);
    if (t.count) {
      if (t.viaValue && s.totalAsInt)
        issues.push({
          kind: 'review',
          label: 'hits.total.value dans une watch',
          detail:
            'Dans une watch, hits.total est un entier (rest_total_hits_as_int vaut true par défaut) : ctx.payload.hits.total.value est vide, et la condition d’origine ne se déclenche jamais (sauf not_eq). La traduction suit l’intention, le nombre de documents : vérifiez l’historique de la watch (status.last_met_condition).'
        });
      if (!t.viaValue && !s.totalAsInt)
        issues.push({
          kind: 'review',
          label: 'hits.total objet',
          detail:
            'La recherche demande rest_total_hits_as_int: false : hits.total est un objet ({ value, relation }), qu’une comparaison numérique ne satisfait pas. La traduction suit l’intention, le nombre de documents.'
        });
      const cap =
        s.body.track_total_hits === true
          ? Infinity
          : typeof s.body.track_total_hits === 'number'
            ? s.body.track_total_hits
            : s.body.track_total_hits === false
              ? 0
              : WATCH_TOTAL_CAP;
      const vals = form.value.between || [form.value.v];
      if (vals.some(v => Number(v) >= cap))
        issues.push({
          kind: 'review',
          label: 'décompte plafonné',
          detail: `Sans track_total_hits: true, Elasticsearch arrête le décompte à ${cap === 0 ? '0 (track_total_hits: false)' : cap} : la watch d’origine compare un total plafonné, la traduction le nombre exact.`
        });
      const body = watchCountBody(s.body);
      const r = translateDSL(JSON.stringify(body), cfg, { index: s.pattern });
      const stmt = watchStatement(r, 'Comptage');
      if (r.error || !stmt)
        return fail('décompte de la condition', r.error || 'Le décompte des documents n’a pas pu être traduit.');
      return {
        sql: decisionWrap(stmt.sql, ['*', `${watchCmp('count', form.op, form.value, false)} AS declenchee`]),
        text,
        dsl: body,
        pattern: s.pattern,
        r
      };
    }
    return {
      sql: decisionWrap(t.stmt.sql, ['*', `${watchCmp(t.col, form.op, form.value, t.nullable)} AS declenchee`]),
      text,
      dsl: s.body,
      pattern: s.pattern,
      r: inp.r
    };
  }
  const t = watchArrayTarget(rest, form.inner, inp, cfg);
  if (t.error) return fail('condition non reliée', `${text} : ${t.error}.`);
  if (t.empty) {
    // size: 0 : aucun document dans le payload, la liste est vide
    const v = form.kind === 'rows' ? watchCmp('0', form.op, form.value, false) : form.quantifier === 'all' ? '1' : '0';
    issues.push({
      kind: 'info',
      label: 'liste vide',
      detail: 'La recherche ne renvoie aucun document (size: 0) : la condition a toujours la même valeur.'
    });
    return { sql: `SELECT ${v} AS declenchee`, text, dsl: s.body, pattern: s.pattern, r: inp.r };
  }
  if (form.kind === 'rows')
    return {
      sql: decisionWrap(t.stmt.sql, [
        `${watchCmp('count()', form.op, form.value, false)} AS declenchee`,
        `count() AS ${t.label}`
      ]),
      text,
      dsl: s.body,
      pattern: s.pattern,
      r: inp.r
    };
  if (!t.col) return fail('condition non reliée', `${text} : l’élément comparé (path) n’est pas précisé.`);
  const cond = watchCmp(t.col, form.op, form.value, t.nullable);
  const decide = form.quantifier === 'all' ? `countIf(NOT (${cond})) = 0` : `countIf(${cond}) > 0`;
  return {
    sql: decisionWrap(t.stmt.sql, [
      `${decide} AS declenchee`,
      `countIf(${cond}) AS ${t.label}_au_seuil`,
      `count() AS ${t.label}`
    ]),
    text,
    dsl: s.body,
    pattern: s.pattern,
    r: inp.r
  };
}

/* ---------- Actions ---------- */
const watchHost = u => String(u || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/i, '$1');
function watchActionList(actions) {
  return Object.entries(isObj(actions) ? actions : {}).map(([id, a]) => {
    const type = Object.keys(isObj(a) ? a : {}).find(k => !WATCH_ACTION_KEYS.has(k)) || '?';
    const d = isObj(a) && isObj(a[type]) ? a[type] : {};
    let target = '';
    if (type === 'email') {
      const to = [].concat(d.to || []).length;
      target = `${to ? `${to} destinataire${to > 1 ? 's' : ''}` : 'destinataires par défaut'}${d.subject ? `, objet « ${String(d.subject).slice(0, 80)} »` : ''}`;
    } else if (type === 'webhook') {
      const r = isObj(d.request) ? d.request : d;
      target = r.url
        ? `${r.method || 'POST'} ${watchHost(r.url).split('?')[0]}`
        : `${String(r.method || 'POST').toUpperCase()} ${r.scheme || 'http'}://${r.host || '?'}${r.port ? `:${r.port}` : ''}${r.path || ''}`;
    } else if (type === 'slack') {
      const m = isObj(d.message) ? d.message : {};
      target = `${d.account ? `compte ${d.account}` : 'compte par défaut'}${m.to ? `, vers ${[].concat(m.to).join(', ')}` : ''}`;
    } else if (type === 'index') target = `index ${d.index || '?'}`;
    else if (type === 'logging') target = `niveau ${d.level || 'info'}`;
    else if (type === 'pagerduty') target = d.account ? `compte ${d.account}` : 'compte par défaut';
    else if (type === 'jira')
      target = d.fields && d.fields.project && d.fields.project.key ? `projet ${d.fields.project.key}` : '';
    const refs = [
      ...new Set(
        [...JSON.stringify(a).matchAll(/\{\{\{?#?\s*(?:toJson\}\}\s*)?ctx\.payload\.([\w.]+)/g)].map(m => m[1])
      )
    ].slice(0, 8);
    const throttle = isObj(a)
      ? a.throttle_period || (a.throttle_period_in_millis !== undefined ? `${a.throttle_period_in_millis}ms` : null)
      : null;
    return {
      id,
      type,
      label: WATCH_ACTIONS[type] || type,
      target,
      refs,
      throttle,
      condition: isObj(a) && isObj(a.condition),
      transform: isObj(a) && isObj(a.transform) ? Object.keys(a.transform)[0] : null,
      foreach: isObj(a) && a.foreach ? String(a.foreach) : null
    };
  });
}

/* ---------- Analyse d’une watch ---------- */
function watchEntry(id, title) {
  return {
    key: `watch:${id}`,
    type: 'watch',
    id,
    title: String(title || '').trim() || id,
    kind: 'json',
    kindLabel: WATCH_KINDS.json,
    active: true,
    skipped: false,
    schedule: null,
    inputs: [],
    condition: '',
    actions: [],
    status: null,
    parent: null,
    views: [],
    tables: [],
    queries: [],
    issues: [],
    children: [],
    usedBy: [],
    fields: new Set(),
    verdict: 'ready',
    effort: 0,
    effortDetail: []
  };
}
function analyzeWatch(item, cfg) {
  const w = item.watch;
  const meta = isObj(w.metadata) ? w.metadata : {};
  const x = watchEntry(item.id, typeof meta.name === 'string' && meta.name ? meta.name : item.id);
  const st = item.status || {};
  x.active = !(isObj(st.state) && st.state.active === false);
  x.status = {
    active: x.active,
    last_checked: st.last_checked || null,
    last_met_condition: st.last_met_condition || null
  };
  const xtype = isObj(meta.xpack) ? meta.xpack.type : null;
  x.kind =
    xtype === 'monitoring' || WATCH_MONITORING_ID.test(item.id)
      ? 'monitoring'
      : xtype === 'threshold' && isObj(meta.watcherui)
        ? 'threshold'
        : 'json';
  x.kindLabel = WATCH_KINDS[x.kind];
  x.schedule = watchSchedule(w.trigger);
  if (x.kind === 'monitoring') {
    x.skipped = true;
    x.condition = '—';
    x.issues.push({
      kind: 'info',
      label: 'alerte de Stack Monitoring',
      detail:
        'Watch créée par la supervision d’Elasticsearch (alertes de cluster) : elle surveille le cluster Elasticsearch lui-même et disparaît avec lui. Sans objet pour la migration.'
    });
    return x;
  }
  const known = { ctx: { metadata: meta, watch_id: item.id } };
  x.issues.push(...x.schedule.issues);
  // Entrées : chaque recherche est traduite
  const inputs = [];
  for (const inp of watchInputList(w.input)) {
    const label = inp.name ? `L’entrée « ${inp.name} »` : 'L’entrée';
    const one = { name: inp.name, type: inp.type, search: null, r: null };
    if (inp.type === 'search') {
      one.search = watchSearchBody(inp.def, known, x.issues, label);
      if (one.search) {
        if (/\{\{\s*ctx\.payload\./.test(JSON.stringify(one.search.body)))
          x.issues.push({
            kind: 'todo',
            label: 'référence à une entrée précédente',
            detail: `${label} se sert du résultat d’une entrée précédente ({{ctx.payload.…}}) : la valeur devient un paramètre, à fournir par l’outil qui enchaîne les requêtes.`
          });
        const title = inp.name ? `Entrée « ${inp.name} »` : 'Recherche';
        addQuery(x, { title, pattern: one.search.pattern, dsl: one.search.body }, cfg);
        one.r = translateDSL(JSON.stringify(one.search.body), cfg, { index: one.search.pattern });
      }
    } else if (inp.type === 'http') {
      const r = isObj(inp.def.request) ? inp.def.request : {};
      const where = r.url
        ? watchHost(r.url).split('?')[0]
        : `${r.host || '?'}${r.port ? `:${r.port}` : ''}${r.path || ''}`;
      x.issues.push({
        kind: 'todo',
        label: 'entrée http',
        detail: `${label} appelle ${where}${/_cluster\/health|_cat\/|_nodes|_cluster\/stats/.test(String(r.path || r.url || '')) ? ' (état du cluster Elasticsearch : sans équivalent après la migration ; la santé de ClickHouse se lit dans ses tables system.*)' : ''} : la donnée surveillée se récupère autrement dans l’outil cible.`
      });
    } else if (inp.type === 'simple')
      x.issues.push({
        kind: 'info',
        label: 'entrée simple',
        detail: `${label} fournit des valeurs fixes (${Object.keys(inp.def).slice(0, 6).join(', ') || 'aucune'}) : rien à interroger.`
      });
    else if (inp.type !== 'none')
      x.issues.push({
        kind: 'todo',
        label: `entrée ${inp.type}`,
        detail: `${label} est de type ${inp.type}, que Passerelle ne lit pas.`
      });
    inputs.push(one);
  }
  x.inputs = inputs.map(i => (i.name ? `${i.name} (${i.type})` : i.type));
  // Condition : forme normalisée, puis requête de décision
  const main = inputs.find(i => i.search) || null;
  let form = x.kind === 'threshold' && main ? watchThresholdForm(w, main.search.body) : null;
  if (x.kind === 'threshold' && !form)
    x.issues.push({
      kind: 'info',
      label: 'seuil de l’interface Watcher',
      detail: 'metadata.watcherui ne correspond pas à la requête : la condition est lue dans son script.'
    });
  if (!form) form = watchConditionForm(w.condition, known);
  x.condition = watchConditionText(form);
  if (form.kind === 'todo') x.issues.push({ kind: 'todo', label: form.label, detail: form.detail });
  else if (form.kind === 'always')
    x.issues.push({
      kind: 'info',
      label: 'condition toujours vraie',
      detail: 'Les actions partent à chaque exécution : la requête traduite fournit les données de la notification.'
    });
  else if (form.kind === 'never')
    x.issues.push({
      kind: 'review',
      label: 'condition jamais vraie',
      detail: 'La condition never empêche toute action : la watch ne sert peut-être plus.'
    });
  else {
    const d = watchDecision(form, inputs, cfg, x.issues);
    if (d) {
      const r = d.r;
      x.queries.push({
        title: 'Condition',
        derived: true,
        pattern: d.pattern,
        table: r.table || null,
        matched: r.matched || null,
        dsl: d.dsl,
        verdict: verdictOf(r),
        coverage: r.stats ? coverage(r.stats) : null,
        notes: [],
        error: null,
        sentence: `Décision : ${d.text}.`,
        parameters: r.parameters || [],
        sql: `-- Condition : ${d.text}\n${d.sql};`
      });
    }
  }
  // Transformation : après la condition, elle ne prépare que les données des actions
  if (isObj(w.transform)) {
    const tlist =
      isObj(w.transform.chain) || Array.isArray(w.transform.chain)
        ? [].concat(w.transform.chain).flatMap(o => Object.entries(isObj(o) ? o : {}))
        : Object.entries(w.transform);
    for (const [t, def] of tlist) {
      if (t === 'search' && isObj(def)) {
        const sb = watchSearchBody(def, known, x.issues, 'La transformation');
        if (sb) addQuery(x, { title: 'Transformation', pattern: sb.pattern, dsl: sb.body }, cfg);
      } else if (t === 'script')
        x.issues.push({
          kind: 'todo',
          label: 'transformation Painless',
          detail:
            'Le script de transformation prépare les données des notifications : à réécrire (SQL ou modèle de message de l’outil cible).'
        });
      else
        x.issues.push({
          kind: 'todo',
          label: `transformation ${t}`,
          detail: 'Type de transformation que Passerelle ne lit pas.'
        });
    }
  }
  // Actions : à recréer dans l’outil d’alerte cible
  x.actions = watchActionList(w.actions);
  if (x.actions.length) {
    const detail = x.actions
      .map(
        a =>
          `${a.id} : ${a.label}${a.target ? ` (${a.target})` : ''}${a.throttle ? `, relance au plus toutes les ${a.throttle}` : ''}${a.refs.length ? `, avec ${a.refs.join(', ')}` : ''}`
      )
      .join(' ; ');
    x.issues.push({
      kind: 'info',
      label: `${x.actions.length} action${x.actions.length > 1 ? 's' : ''} à recréer`,
      detail: `${detail}. Les comptes (e-mail, Slack, PagerDuty, Jira) sont déclarés dans elasticsearch.yml, pas dans la watch.`,
      hours: WATCH_EFFORT.action * x.actions.length
    });
    for (const a of x.actions) {
      if (a.type === 'index')
        x.issues.push({
          kind: 'review',
          label: 'action index',
          detail: `L’action ${a.id} écrit dans l’index Elasticsearch ${a.target.replace(/^index /, '')} : à remplacer (table ClickHouse, ou rien) selon l’usage de cet index.`
        });
      if (a.condition)
        x.issues.push({
          kind: 'review',
          label: 'condition d’action',
          detail: `L’action ${a.id} a sa propre condition : à recréer dans la politique de notification de l’outil cible.`
        });
      if (a.transform === 'script')
        x.issues.push({
          kind: 'todo',
          label: 'transformation Painless d’action',
          detail: `L’action ${a.id} transforme les données par un script : à réécrire dans le modèle du message.`
        });
      if (a.foreach)
        x.issues.push({
          kind: 'review',
          label: 'action foreach',
          detail: `L’action ${a.id} part une fois par élément de ${a.foreach} : une notification par ligne du résultat, à reproduire dans l’outil cible.`
        });
      if (!WATCH_ACTIONS[a.type])
        x.issues.push({
          kind: 'review',
          label: `action ${a.type}`,
          detail: `Type d’action que Passerelle ne décrit pas (${a.id}).`
        });
    }
  } else
    x.issues.push({
      kind: 'review',
      label: 'aucune action',
      detail: 'La watch n’a pas d’action : elle ne prévient personne.'
    });
  const tp =
    w.throttle_period || (w.throttle_period_in_millis !== undefined ? `${w.throttle_period_in_millis}ms` : null);
  if (tp)
    x.issues.push({
      kind: 'info',
      label: 'throttle_period',
      detail: `Une notification au plus toutes les ${tp} : à reproduire (Grafana : intervalle de répétition de la politique de notification).`
    });
  if (!x.active)
    x.issues.push({
      kind: 'info',
      label: 'watch désactivée',
      detail: 'La watch est désactivée : migrez-la seulement si elle sert encore.'
    });
  return x;
}
// Verdict et effort d’une watch
function watchScore(x) {
  const seen = new Set();
  x.issues = x.issues.filter(i => {
    const k = `${i.kind}|${i.label}|${i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (x.skipped) {
    x.verdict = 'ready';
    x.effort = 0;
    x.effortDetail = [];
    return;
  }
  const lines = [{ label: 'Recréer l’alerte (planification, condition, notifications)', hours: WATCH_EFFORT.base }];
  for (const q of x.queries.filter(y => !y.derived)) {
    if (KB_EFFORT.query[q.verdict])
      lines.push({ label: `Vérifier « ${q.title} » (${VERDICTS[q.verdict]})`, hours: KB_EFFORT.query[q.verdict] });
    let warn = 0;
    for (const n of q.notes) {
      if (KB_PREREQ.test(n.title)) continue;
      if (n.level === 'err') lines.push({ label: n.title, hours: todoHours(n.title) });
      else if (n.level === 'warn') warn += KB_EFFORT.warn;
    }
    if (warn) lines.push({ label: `Points à vérifier de « ${q.title} »`, hours: Math.min(warn, KB_EFFORT.warnCap) });
  }
  for (const i of x.issues)
    if (i.kind !== 'info' || i.hours)
      lines.push({
        label: i.label,
        hours: i.hours !== undefined ? i.hours : i.kind === 'todo' ? todoHours(i.label) : KB_EFFORT.review
      });
  x.effortDetail = lines.filter(l => l.hours > 0);
  x.effort = quarter(x.effortDetail.reduce((n, l) => n + l.hours, 0));
  const verdicts = x.queries
    .filter(q => !q.derived)
    .map(q => (q.verdict === 'unrecognized' ? 'todo' : q.verdict))
    .concat(x.issues.filter(i => i.kind !== 'info').map(i => (i.kind === 'todo' ? 'todo' : 'review')));
  x.verdict = x.verdict === 'unrecognized' ? 'unrecognized' : worstVerdict(verdicts);
}

/* ---------- Ensemble des watches ---------- */
/*
 * texts : un ou plusieurs exports (chaînes) ; opts.names : leurs noms ; opts.origin : provenance affichée
 * (fichiers, ou le cluster lu par passerelle watcher pull).
 */
function watcherTranslate(text, cfg, opts) {
  opts = opts || {};
  const texts = Array.isArray(text) ? text : [text];
  const names = opts.names || texts.map(() => null);
  const seen = new Set();
  const watches = [];
  const errors = [];
  texts.forEach((t, i) => {
    const r = watcherRead(t, names[i] ? String(names[i]).replace(/\.[^.]+$/, '') : null);
    r.errors.forEach(e => errors.push(texts.length > 1 && names[i] ? `${names[i]}, ${e}` : e));
    for (const w of r.watches) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      watches.push(w);
    }
  });
  const entries = watches.map(w => {
    try {
      return analyzeWatch(w, cfg);
    } catch (e) {
      const x = watchEntry(w.id, w.id);
      x.verdict = 'unrecognized';
      x.issues.push({
        kind: 'todo',
        label: 'watch illisible',
        detail: `La watch n’a pas pu être analysée : ${e.message}`
      });
      return x;
    }
  });
  entries.forEach(watchScore);
  entries.sort((p, q) => (p.skipped ? 1 : 0) - (q.skipped ? 1 : 0) || p.title.localeCompare(q.title, 'fr'));
  const live = entries.filter(x => !x.skipped);
  const byVerdict = { ready: 0, review: 0, todo: 0, unrecognized: 0 };
  for (const x of live) byVerdict[x.verdict]++;
  const hours = quarter(live.reduce((n, x) => n + x.effort, 0));
  const blockers = new Map();
  const prereq = new Map();
  const guessed = new Map();
  const bump = (label, key) => {
    const k = blockerLabel(label);
    if (!blockers.has(k)) blockers.set(k, { label: k, kind: 'todo', objects: new Set(), hours: 0 });
    const b = blockers.get(k);
    b.objects.add(key);
    b.hours += todoHours(label);
  };
  for (const x of live) {
    for (const i of x.issues) if (i.kind === 'todo') bump(i.label, x.key);
    for (const q of x.queries.filter(y => !y.derived)) {
      if (q.pattern && !q.matched && q.table) guessed.set(q.pattern, q.table);
      for (const n of q.notes) {
        if (KB_PREREQ.test(n.title)) {
          if (!KB_PREREQ_SHOWN.test(n.title)) continue;
          const k = n.title.replace(/ «.*$/, '');
          if (!prereq.has(k)) prereq.set(k, { label: k, detail: n.detail, objects: new Set() });
          prereq.get(k).objects.add(x.key);
        } else if (n.level === 'err') bump(n.title, x.key);
      }
    }
  }
  const actions = {};
  for (const x of live) for (const a of x.actions) actions[a.label] = (actions[a.label] || 0) + 1;
  return {
    source: { watches: entries.length, errors, origin: opts.origin || null },
    summary: {
      watches: live.length,
      skipped: entries.length - live.length,
      inactive: live.filter(x => !x.active).length,
      byVerdict,
      effort: { hours, days: Math.round((hours / KB_EFFORT.hoursPerDay) * 10) / 10 },
      queries: live.reduce((n, x) => n + x.queries.filter(q => !q.derived && q.sql).length, 0),
      conditions: live.filter(x => x.queries.some(q => q.derived)).length,
      actions
    },
    prerequisites: [...prereq.values()]
      .map(p => ({ label: p.label, detail: p.detail, objects: p.objects.size }))
      .concat(
        guessed.size
          ? [
              {
                label: 'Tables à déclarer',
                detail: `${[...guessed.keys()].join(', ')} : aucune correspondance dans clickhouse.index_mapping, la table est devinée. Déclarez-les dans la configuration (passerelle schema ddl génère tables et profils depuis les mappings).`,
                objects: guessed.size
              }
            ]
          : []
      ),
    blockers: [...blockers.values()]
      .map(b => ({ label: b.label, kind: b.kind, objects: b.objects.size, hours: quarter(b.hours) }))
      .sort((p, q) => q.hours - p.hours || q.objects - p.objects)
      .slice(0, 20),
    entries: entries.map(x => Object.assign({}, x, { fields: [...x.fields].sort() })),
    effortScale: {
      hoursPerDay: KB_EFFORT.hoursPerDay,
      base: WATCH_EFFORT.base,
      action: WATCH_EFFORT.action,
      query: KB_EFFORT.query,
      review: KB_EFFORT.review,
      todo: KB_EFFORT.todo.map(([re, h, label]) => ({ label, match: re.source, hours: h })),
      todoDefault: KB_EFFORT.todoDefault
    }
  };
}

/* ---------- Rapports ---------- */
const watchParamNames = rep => [
  ...new Set(rep.entries.flatMap(x => x.queries.flatMap(q => (q.parameters || []).map(p => p.name))))
];
const watchState = x => (x.skipped ? 'sans objet' : x.active ? 'active' : 'désactivée');
const watchCron = x => (x.schedule && x.schedule.cron.length ? x.schedule.cron.join(' ; ') : '');
const WATCH_TIME_PARAMS = {
  scheduled_time: 'l’heure prévue de l’exécution',
  triggered_time: 'l’heure du déclenchement',
  execution_time: 'l’heure réelle de l’exécution'
};
function watchRunHelp(rep) {
  const ps = watchParamNames(rep);
  if (!ps.length) return '';
  const times = ps.filter(p => WATCH_TIME_PARAMS[p]);
  const others = ps.filter(p => !WATCH_TIME_PARAMS[p]);
  const first = times[0] || ps[0];
  const parts = [];
  if (times.length)
    parts.push(
      `Les requêtes attendent ${times.map(p => `{${p}:String}, ${WATCH_TIME_PARAMS[p]}`).join(' ; ')}, connue${times.length > 1 ? 's' : ''} à l’exécution seulement. Le planificateur la fournit à chaque passage : \`--param_${first}="$(date -u +%Y-%m-%dT%H:%M:%SZ)"\` avec clickhouse-client, \`param_${first}=…\` dans l’URL de l’interface HTTP.`
    );
  if (others.length)
    parts.push(
      `${others.map(p => `{${p}:String}`).join(', ')} : valeur${others.length > 1 ? 's' : ''} lue${others.length > 1 ? 's' : ''} dans le résultat d’une entrée précédente, à fournir par l’outil qui enchaîne les requêtes.`
    );
  return parts.join(' ');
}
function watcherReportMarkdown(rep) {
  const L = [];
  const s = rep.summary;
  const cell = v => kbFlat(v).replace(/\|/g, '\\|');
  L.push('# Migration des watches Elasticsearch vers ClickHouse', '');
  if (rep.source.origin) L.push(`Source : ${kbFlat(rep.source.origin)}.`, '');
  L.push(
    `${s.watches} watch${s.watches > 1 ? 'es' : ''} à migrer${s.inactive ? ` (dont ${s.inactive} désactivée${s.inactive > 1 ? 's' : ''})` : ''}, ${s.queries} requête${s.queries > 1 ? 's' : ''} traduite${s.queries > 1 ? 's' : ''}, ${s.conditions} condition${s.conditions > 1 ? 's' : ''} traduite${s.conditions > 1 ? 's' : ''} en décision SQL. Effort estimé : **${frHours(s.effort.hours)}**, soit **${frNum(s.effort.days)} jour${s.effort.days > 1 ? 's' : ''}** à ${rep.effortScale.hoursPerDay} h.`,
    ''
  );
  if (s.skipped)
    L.push(
      `${s.skipped} watch${s.skipped > 1 ? 'es' : ''} de Stack Monitoring, sans objet après la migration : non comptée${s.skipped > 1 ? 's' : ''}.`,
      ''
    );
  if (rep.source.errors.length)
    L.push(
      `Éléments illisibles : ${rep.source.errors.length} (${rep.source.errors.slice(0, 3).map(kbFlat).join(' ; ')}${rep.source.errors.length > 3 ? ' ; …' : ''}).`,
      ''
    );
  L.push(
    '## Synthèse',
    '',
    '| Watches | Prêtes | À vérifier | À reprendre | Non reconnues | Effort |',
    '|---:|---:|---:|---:|---:|---:|'
  );
  L.push(
    `| ${s.watches} | ${s.byVerdict.ready} | ${s.byVerdict.review} | ${s.byVerdict.todo} | ${s.byVerdict.unrecognized} | ${frHours(s.effort.hours)} |`,
    ''
  );
  L.push(
    '*Prête* : requête et condition traduites directement. *À vérifier* : traduites, avec un écart de comportement à confirmer. *À reprendre* : une partie ne se traduit pas et s’écrit à la main. Dans tous les cas, la planification et les notifications se recréent dans l’outil d’alerte cible.',
    ''
  );
  const acts = Object.entries(s.actions);
  if (acts.length) L.push(`Actions à recréer : ${acts.map(([k, n]) => `${n} ${k}`).join(', ')}.`, '');
  if (rep.prerequisites.length) {
    L.push('## Prérequis', '');
    for (const p of rep.prerequisites)
      L.push(`- **${p.label}** (${p.objects} watch${p.objects > 1 ? 'es' : ''}) : ${kbFlat(p.detail)}`);
    L.push('');
  }
  if (rep.blockers.length) {
    L.push('## Principaux points à reprendre', '', '| Point | Watches | Effort |', '|---|---:|---:|');
    for (const b of rep.blockers) L.push(`| ${cell(b.label)} | ${b.objects} | ${frHours(b.hours)} |`);
    L.push('');
  }
  L.push(
    '## Watches',
    '',
    '| Watch | État | Planification | Condition | Actions | Verdict | Effort |',
    '|---|---|---|---|---|---|---:|'
  );
  for (const x of rep.entries)
    L.push(
      `| ${cell(x.title)} | ${watchState(x)} | ${cell(x.schedule ? x.schedule.text : '')} | ${cell(x.condition)} | ${cell(x.actions.map(a => a.label).join(', ') || '—')} | ${x.skipped ? 'sans objet' : kbVerdict(x.verdict)} | ${frHours(x.effort)} |`
    );
  L.push('');
  const help = watchRunHelp(rep);
  if (help) L.push('## Exécuter les requêtes', '', help, '');
  L.push('## Détail par watch', '');
  for (const x of rep.entries) {
    L.push(`### ${kbFlat(x.title)}`, '');
    L.push(
      `${x.skipped ? 'Sans objet' : `${kbVerdict(x.verdict).replace(/^./, c => c.toUpperCase())}, ${frHours(x.effort)}`}. ${x.kindLabel.replace(/^./, c => c.toUpperCase())}, ${watchState(x)}. Identifiant : \`${x.id}\`.${x.views.length ? ` Index : ${x.views.join(', ')}.` : ''}${x.tables.length ? ` Table : ${x.tables.join(', ')}.` : ''}`,
      ''
    );
    if (x.schedule)
      L.push(
        `- **Planification** : ${kbFlat(x.schedule.text)}${x.schedule.cron.length ? ` — cron \`${x.schedule.cron.join('` ; `')}\`` : ''}.`
      );
    if (!x.skipped) {
      L.push(`- **Entrée** : ${x.inputs.join(', ') || 'aucune'}.`);
      L.push(`- **Condition** : ${kbFlat(x.condition)}.`);
      if (x.status && x.status.last_met_condition)
        L.push(`- **Condition remplie pour la dernière fois** : ${x.status.last_met_condition}.`);
    }
    L.push('');
    for (const [kind, head] of [
      ['todo', 'À reprendre'],
      ['review', 'À vérifier'],
      ['info', 'À noter']
    ]) {
      const list = x.issues.filter(i => i.kind === kind);
      if (list.length) {
        L.push(`${head} :`);
        for (const i of list) L.push(`- **${kbFlat(i.label)}** : ${kbFlat(i.detail)}`);
        L.push('');
      }
    }
    for (const q of x.queries) {
      L.push(
        `**${kbFlat(q.title)}** — ${q.derived ? 'décision' : kbVerdict(q.verdict)}${q.coverage && !q.derived ? `, couverture ${q.coverage.percent} %` : ''}. ${kbFlat(q.sentence)}`,
        ''
      );
      const notes = q.notes.filter(n => n.level === 'err' || n.level === 'warn');
      for (const n of notes)
        L.push(`- ${n.level === 'err' ? 'À reprendre' : 'À vérifier'} : **${kbFlat(n.title)}** — ${kbFlat(n.detail)}`);
      if (notes.length) L.push('');
      if (q.sql) L.push('```sql', q.sql, '```', '');
      else if (q.error) L.push(`> ${kbFlat(q.error)}`, '');
    }
    if (x.effortDetail.length > 1)
      L.push(
        `<details><summary>Calcul de l’effort</summary>\n\n${x.effortDetail.map(l => `- ${kbFlat(l.label)} : ${frHours(l.hours)}`).join('\n')}\n\n</details>`,
        ''
      );
  }
  const sc = rep.effortScale;
  L.push(
    '## Barème de l’effort',
    '',
    `Recréer une alerte (planification, condition, notifications) : ${frHours(sc.base)}, plus ${frHours(sc.action)} par action. Vérifier une requête : ${frHours(sc.query.review)} si elle est à vérifier, ${frHours(sc.query.todo)} si elle est à reprendre, plus ${frHours(sc.review)} par point à vérifier. Point à reprendre : ${sc.todo.map(t => `${t.label} ${frHours(t.hours)}`).join(' ; ')} ; ${frHours(sc.todoDefault)} pour une clause ou un paramètre. Total arrondi au quart d’heure supérieur par watch ; un jour vaut ${sc.hoursPerDay} h.`,
    ''
  );
  return L.join('\n');
}
function watcherReportCSV(rep) {
  const q = v => {
    const s = kbFlat(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    [
      'Identifiant',
      'Nom',
      'Nature',
      'État',
      'Planification',
      'Cron',
      'Index',
      'Table',
      'Condition',
      'Actions',
      'Verdict',
      'Effort (h)',
      'Points à reprendre',
      'Points à vérifier'
    ]
  ];
  for (const x of rep.entries) {
    const notesOf = lvl => [...new Set(x.queries.flatMap(r => r.notes.filter(n => n.level === lvl).map(n => n.title)))];
    rows.push([
      x.id,
      x.title,
      x.kindLabel,
      watchState(x),
      x.schedule ? x.schedule.text : '',
      watchCron(x),
      x.views.join(', '),
      x.tables.join(', '),
      x.condition,
      x.actions.map(a => `${a.label}${a.target ? ` (${a.target})` : ''}`).join(', '),
      x.skipped ? 'sans objet' : kbVerdict(x.verdict),
      frNum(x.effort),
      x.issues
        .filter(i => i.kind === 'todo')
        .map(i => i.label)
        .concat(notesOf('err'))
        .join(' ; '),
      x.issues
        .filter(i => i.kind === 'review')
        .map(i => i.label)
        .concat(notesOf('warn'))
        .join(' ; ')
    ]);
  }
  return '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n') + '\r\n';
}
function watcherReportHTML(rep, title) {
  const s = rep.summary;
  const h = kbHtml;
  const badge = x =>
    x.skipped
      ? '<span class="v v-unrecognized">sans objet</span>'
      : `<span class="v v-${x.verdict}">${h(kbVerdict(x.verdict))}</span>`;
  const anchor = x => `w-${h(String(x.id).replace(/[^A-Za-z0-9_-]/g, '-'))}`;
  const bar = ['ready', 'review', 'todo', 'unrecognized']
    .filter(v => s.byVerdict[v])
    .map(
      v =>
        `<span class="seg v-${v}" style="flex:${s.byVerdict[v]}" title="${h(kbVerdict(v))} : ${s.byVerdict[v]}"></span>`
    )
    .join('');
  const rows = rep.entries
    .map(
      x =>
        `<tr data-v="${x.skipped ? 'skipped' : x.verdict}"><td><a href="#${anchor(x)}">${h(x.title)}</a></td><td>${h(watchState(x))}</td><td>${h(x.schedule ? x.schedule.text : '')}</td><td>${h(x.condition)}</td><td>${h(x.actions.map(a => a.label).join(', ') || '—')}</td><td>${badge(x)}</td><td class="n">${h(frHours(x.effort))}</td></tr>`
    )
    .join('');
  const list = (items, cls) =>
    items.length
      ? `<ul class="${cls}">${items.map(i => `<li><b>${h(i.label)}</b> : ${h(i.detail)}</li>`).join('')}</ul>`
      : '';
  const details = rep.entries
    .map(x => {
      const qs = x.queries
        .map(
          q =>
            `<div class="q"><div class="qh"><b>${h(q.title)}</b> ${q.derived ? '<span class="muted">décision</span>' : `<span class="v v-${q.verdict}">${h(kbVerdict(q.verdict))}</span>`}</div>${q.sentence ? `<p class="muted">${h(q.sentence)}</p>` : ''}${
              q.notes.filter(n => n.level === 'err' || n.level === 'warn').length
                ? `<ul>${q.notes
                    .filter(n => n.level === 'err' || n.level === 'warn')
                    .map(n => `<li class="${n.level}"><b>${h(n.title)}</b> : ${h(n.detail)}</li>`)
                    .join('')}</ul>`
                : ''
            }${q.sql ? `<pre><code>${h(q.sql)}</code></pre>` : q.error ? `<p class="err">${h(q.error)}</p>` : ''}</div>`
        )
        .join('');
      const eff = x.effortDetail.length
        ? `<details class="eff"><summary>Effort : ${h(frHours(x.effort))}</summary><ul>${x.effortDetail.map(l => `<li>${h(l.label)} : ${h(frHours(l.hours))}</li>`).join('')}</ul></details>`
        : '';
      const facts = `<ul><li><b>Planification</b> : ${h(x.schedule ? x.schedule.text : '')}${x.schedule && x.schedule.cron.length ? ` — cron <code>${h(x.schedule.cron.join(' ; '))}</code>` : ''}</li>${x.skipped ? '' : `<li><b>Entrée</b> : ${h(x.inputs.join(', ') || 'aucune')}</li><li><b>Condition</b> : ${h(x.condition)}</li>`}</ul>`;
      return `<section class="obj" id="${anchor(x)}"><h3>${h(x.title)} ${badge(x)}</h3><p class="muted">${h(x.kindLabel)}, ${h(watchState(x))} — <code>${h(x.id)}</code>${x.views.length ? ` — index ${h(x.views.join(', '))}` : ''}${x.tables.length ? ` → ${h(x.tables.join(', '))}` : ''}</p>${facts}${list(
        x.issues.filter(i => i.kind === 'todo'),
        'todo'
      )}${list(
        x.issues.filter(i => i.kind === 'review'),
        'review'
      )}${list(
        x.issues.filter(i => i.kind === 'info'),
        'info'
      )}${qs}${eff}</section>`;
    })
    .join('');
  const prereq = rep.prerequisites.length
    ? `<h2>Prérequis</h2><ul>${rep.prerequisites.map(p => `<li><b>${h(p.label)}</b> (${p.objects}) : ${h(p.detail)}</li>`).join('')}</ul>`
    : '';
  const blockers = rep.blockers.length
    ? `<h2>Principaux points à reprendre</h2><div class="tw"><table><thead><tr><th>Point</th><th class="n">Watches</th><th class="n">Effort</th></tr></thead><tbody>${rep.blockers.map(b => `<tr><td>${h(b.label)}</td><td class="n">${b.objects}</td><td class="n">${h(frHours(b.hours))}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const help = watchRunHelp(rep);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title || 'Watches Elasticsearch')}</title>
<style>
${KB_CSS}
</style></head><body><main>
<h1>Migration des watches Elasticsearch vers ClickHouse</h1>
<p class="muted">${rep.source.origin ? `${h(rep.source.origin)}. ` : ''}${s.watches} watches à migrer, ${s.queries} requêtes et ${s.conditions} conditions traduites.${s.skipped ? ` ${s.skipped} watch(es) de Stack Monitoring, sans objet.` : ''}</p>
<div class="tiles"><div class="tile"><b>${h(frHours(s.effort.hours))}</b><span class="muted">effort estimé, ${h(frNum(s.effort.days))} j à ${rep.effortScale.hoursPerDay} h</span></div><div class="tile"><b class="v-ready">${s.byVerdict.ready}</b><span class="muted">prêtes</span></div><div class="tile"><b class="v-review">${s.byVerdict.review}</b><span class="muted">à vérifier</span></div><div class="tile"><b class="v-todo">${s.byVerdict.todo}</b><span class="muted">à reprendre</span></div></div>
<div class="bar" aria-label="Répartition des verdicts sur ${s.watches || 1} watches">${bar}</div>
${prereq}${blockers}
<h2>Watches</h2><div class="filters" role="group" aria-label="Filtrer par verdict"><button data-f="all" aria-pressed="true">Toutes</button><button data-f="ready" aria-pressed="false">Prêtes</button><button data-f="review" aria-pressed="false">À vérifier</button><button data-f="todo" aria-pressed="false">À reprendre</button></div>
<div class="tw"><table id="objs"><thead><tr><th>Watch</th><th>État</th><th>Planification</th><th>Condition</th><th>Actions</th><th>Verdict</th><th class="n">Effort</th></tr></thead><tbody>${rows}</tbody></table></div>
${help ? `<h2>Exécuter les requêtes</h2><p>${h(help).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>` : ''}
<h2>Détail par watch</h2>${details}
</main><script>
document.querySelectorAll('.filters button').forEach(function(b){b.addEventListener('click',function(){var f=b.getAttribute('data-f');document.querySelectorAll('.filters button').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false')});document.querySelectorAll('#objs tbody tr').forEach(function(r){r.style.display=f==='all'||r.getAttribute('data-v')===f?'':'none'})})});
</script></body></html>
`;
}
// Fichiers SQL, un par watch qui a une requête : nom lisible et unique
function watcherSQLFiles(rep) {
  const used = new Set();
  const files = [];
  const slugOf = s =>
    String(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'watch';
  for (const x of rep.entries) {
    if (!x.queries.some(q => q.sql)) continue;
    const base = slugOf(x.id);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}-${i++}`;
    used.add(name);
    const head = `-- Watch : ${kbFlat(x.title)} (${x.id})\n-- Verdict : ${kbVerdict(x.verdict)}, effort estimé ${frHours(x.effort)}\n-- Planification : ${kbFlat(x.schedule ? x.schedule.text : '')}${watchCron(x) ? ` — cron ${watchCron(x)}` : ''}\n-- Condition : ${kbFlat(x.condition)}\n`;
    files.push({
      name: `${name}.sql`,
      content:
        head +
        x.queries
          .filter(q => q.sql)
          .map(q => `\n-- ===== ${kbFlat(q.title)}${q.derived ? '' : ` (${kbVerdict(q.verdict)})`}\n${q.sql}\n`)
          .join('')
    });
  }
  return files;
}
