/* Passerelle — moteur : modèles d’une requête (Watcher, Kibana, Grafana) → paramètres ClickHouse */
import { isObj } from './base.js';

/*
 * Une requête stockée dans une alerte ou un tableau de bord contient des valeurs remplies à l’exécution :
 * {{ctx.trigger.scheduled_time}} (Watcher, modèles de recherche, alertes Kibana), $__timeFrom, ${service},
 * [[service]] ou $service (Grafana). Traduites comme du texte, elles donnaient un SQL qui échoue ou répond faux.
 * Elles deviennent des paramètres de requête ClickHouse {nom:Type}, fournis à l’exécution
 * (param_nom=… en HTTP, --param_nom=… avec clickhouse-client).
 *
 * Mécanique : avant traduction, chaque modèle est remplacé par un marqueur fait de caractères d’usage privé,
 * que rien d’autre ne produit. Un marqueur traverse la traduction dans un littéral SQL, remplacé ensuite par
 * {nom:String} ; une borne de date le relit avec parseDateTime64BestEffort. Un marqueur qui n’arrive pas
 * intact au SQL (découpé en mots par la recherche plein texte, par exemple) rend la requête « à reprendre ».
 */
const PARAM_SPLIT = /(P\d+)/;
const PARAM_WHOLE = /^P(\d+)$/;
const PARAM_ANY = /P(\d+)/g;
// {{…}} et ses sections, $__macro, ${var}, [[var]], puis $var seul (ni précédé d’un mot, d’un $ ou d’un \)
const TEMPLATE_RE =
  /\{\{\{?\s*([#^\/!>]?)\s*([^{}]*?)\s*\}?\}\}|\$__(\w+)|\$\{(\w+)(?::[\w-]+)?\}|\[\[(\w+)(?::[\w-]+)?\]\]|(?<![\w$\\])\$([A-Za-z_]\w*)/g;
export const isParamMark = v => typeof v === 'string' && PARAM_WHOLE.test(v);

function paramName(raw, used) {
  const path = String(raw).split(/[\s|(]/)[0];
  let base = (path.split('.').pop() || 'param').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'param';
  let name = base,
    i = 2;
  while (used.has(name)) name = `${base}_${i++}`;
  used.add(name);
  return name;
}

// Copie de la requête où chaque modèle est remplacé par son marqueur ; les scripts Painless restent tels quels
export function extractTemplates(dsl) {
  const params = [];
  const bySource = new Map();
  const used = new Set();
  const issues = [];
  const mark = source => {
    if (!bySource.has(source)) {
      const m = /^\{\{\{?\s*([^{}]*?)\s*\}?\}\}$|^\$__(\w+)$|^\$\{(\w+)/.exec(source) || [];
      const raw = m[1] || m[2] || m[3] || source.replace(/^\[\[|\]\]$|^\$/g, '');
      bySource.set(source, params.length);
      params.push({ name: paramName(raw, used), source });
    }
    return `P${bySource.get(source)}`;
  };
  const text = s =>
    s.replace(TEMPLATE_RE, (m, section) => {
      if (section) {
        // Une section s’ouvre ({{#…}}, {{^…}}) et se ferme ({{/…}}) : une seule remarque, à l’ouverture
        if ('#^>'.includes(section) && !issues.some(i => i.label.includes(m)))
          issues.push({
            kind: 'todo',
            label: `modèle « ${m} »`,
            detail:
              'Les sections et inclusions Mustache décident de la forme de la requête : elles se traduisent à la main.'
          });
        return m;
      }
      return mark(m);
    });
  const walk = v => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === 'script' ? x : walk(x);
      return o;
    }
    return v;
  };
  return { dsl: walk(dsl), params, issues };
}

// Texte affiché (résumé, remarques, messages d’erreur) : le marqueur redevient le modèle d’origine
export function restoreTemplates(s, params) {
  return params.length && typeof s === 'string'
    ? s.replace(PARAM_ANY, (m, i) => (params[+i] ? params[+i].source : m))
    : s;
}

export function restoreDeep(v, params) {
  if (!params.length) return v;
  if (typeof v === 'string') return restoreTemplates(v, params);
  if (Array.isArray(v)) return v.map(x => restoreDeep(x, params));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, params)]));
  return v;
}

// Littéraux SQL qui portent un marqueur → {nom:String}, seul ou dans un concat()
export function bindParams(sql, params) {
  if (!params.length) return sql;
  return sql.replace(/'(?:[^'\\]|\\.)*'/g, lit => {
    if (!lit.includes('')) return lit;
    const parts = lit
      .slice(1, -1)
      .split(PARAM_SPLIT)
      .filter(Boolean)
      .map(p => {
        const m = PARAM_WHOLE.exec(p);
        return m && params[+m[1]] ? `{${params[+m[1]].name}:String}` : `'${p}'`;
      });
    return parts.length === 1 ? parts[0] : `concat(${parts.join(', ')})`;
  });
}

/*
 * Tableau de bord Grafana (opts.grafana) : les modèles sont des variables du tableau de bord, interpolées par Grafana
 * avant l’envoi au plugin ClickHouse, pas des paramètres de requête. Un littéral qui ne porte qu’une variable devient
 * ${var:singlequote}, qui donne 'a' ou 'a','b' : une égalité devient donc une liste (IN), et une variable qui propose
 * « All » passe par $__conditionalAll, remplacé par 1=1 quand tout est sélectionné, comme le fait le plugin.
 */
const GRAFANA_VAR = /^\$\{([A-Za-z_]\w*)(?::[\w-]+)?\}$|^\[\[([A-Za-z_]\w*)(?::[\w-]+)?\]\]$|^\$([A-Za-z_]\w*)$/;
function grafanaVar(source) {
  const m = GRAFANA_VAR.exec(String(source));
  return m ? m[1] || m[2] || m[3] : null;
}
// Début et fin de la période du tableau de bord : macros du plugin ClickHouse
const GRAFANA_TIME = { __from: '$__fromTime_ms', __to: '$__toTime_ms' };
export const grafanaTime = source => {
  const v = grafanaVar(source);
  return v && GRAFANA_TIME[v] ? GRAFANA_TIME[v] : null;
};
export function bindGrafana(sql, params, vars) {
  if (!params.length) return sql;
  const varOf = i => params[i] && grafanaVar(params[i].source);
  let out = sql.replace(/'(?:[^'\\]|\\.)*'/g, lit => {
    if (!lit.includes('\uE000')) return lit;
    const parts = lit
      .slice(1, -1)
      .split(PARAM_SPLIT)
      .filter(Boolean)
      .map(p => {
        const m = PARAM_WHOLE.exec(p);
        const v = m && varOf(+m[1]);
        return v ? `\${${v}:singlequote}` : `'${p}'`;
      });
    return parts.length === 1 ? parts[0] : `concat(${parts.join(', ')})`;
  });
  const all = name => !!(vars && vars[name] && vars[name].includeAll);
  // Liste réduite à la variable (terms) : tout sélectionné, la condition disparaît
  out = out.replace(/(\S+) IN \((\$\{(\w+):singlequote\})\)/g, (m, lhs, v, name) =>
    lhs !== 'NOT' && all(name) ? `$__conditionalAll(${m}, $${name})` : m
  );
  // Égalité avec une variable : une variable à plusieurs valeurs donne une liste. L’exclusion n’est jamais levée :
  // « tout sauf toutes les valeurs » ne garde rien, comme dans Elasticsearch.
  out = out.replace(/(\S+) (=|!=) (\$\{(\w+):singlequote\})(?!\w)/g, (m, lhs, op, v, name) => {
    const c = `${lhs} ${op === '=' ? 'IN' : 'NOT IN'} (${v})`;
    return op === '=' && all(name) ? `$__conditionalAll(${c}, $${name})` : c;
  });
  return out;
}
// Variables Grafana présentes dans le SQL ; les autres sont perdues
export function grafanaParamsInSQL(sqls, params) {
  const seen = new Set();
  for (const sql of sqls) for (const m of sql.matchAll(/\$\{(\w+):singlequote\}/g)) seen.add(m[1]);
  const found = params
    .filter(p => grafanaVar(p.source) && seen.has(grafanaVar(p.source)))
    .map(p => ({ name: grafanaVar(p.source), source: p.source, types: ['variable Grafana'] }));
  const lost = params.filter(p => !(grafanaVar(p.source) && seen.has(grafanaVar(p.source))));
  return { found, lost };
}

// Paramètres réellement présents dans le SQL, avec leurs types ; les autres sont perdus
export function paramsInSQL(sqls, params) {
  const types = new Map();
  for (const sql of sqls)
    for (const m of sql.replace(/'(?:[^'\\]|\\.)*'/g, "''").matchAll(/\{([A-Za-z_]\w*):([A-Za-z0-9_(), ]+)\}/g)) {
      if (!types.has(m[1])) types.set(m[1], new Set());
      types.get(m[1]).add(m[2]);
    }
  const found = params
    .filter(p => types.has(p.name))
    .map(p => ({ name: p.name, source: p.source, types: [...types.get(p.name)] }));
  const lost = params.filter(p => !types.has(p.name));
  return { found, lost };
}

// Modèle d’une valeur marquée, et modèle consommé par la traduction sans figurer dans le SQL (intervalle Grafana)
export function paramSource(ctx, mark) {
  const m = PARAM_WHOLE.exec(String(mark));
  return m && ctx.params[+m[1]] ? ctx.params[+m[1]].source : '';
}
export function consumeParam(ctx, mark) {
  const m = PARAM_WHOLE.exec(String(mark));
  if (m && ctx.params[+m[1]]) ctx.params[+m[1]].consumed = true;
}
