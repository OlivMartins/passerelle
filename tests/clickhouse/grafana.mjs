/*
 * Ce que Grafana et le plugin ClickHouse font d’une requête avant de l’envoyer : $__conditionalAll et variables
 * (interface de Grafana), puis macros (plugin, pkg/macros/macros.go). Sert au banc d’exécution : le SQL d’un tableau
 * de bord converti y est exécuté tel que ClickHouse le recevrait.
 */
const quote = v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// Arguments d’une macro, comme le plugin les découpe : virgules au premier niveau de parenthèses
function macroArgs(s, open) {
  let depth = 0;
  let last = open + 1;
  const args = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        args.push(s.slice(last, i));
        return { args, end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      args.push(s.slice(last, i));
      last = i + 1;
    }
  }
  return null;
}
export function grafanaInterpolate(sql, { from, to, intervalSeconds, vars }) {
  let out = sql;
  // $__conditionalAll(condition, $variable) : 1=1 quand « All » est choisi
  for (;;) {
    const i = out.lastIndexOf('$__conditionalAll(');
    if (i < 0) break;
    const m = macroArgs(out, i + '$__conditionalAll'.length);
    const name = /\$\{?(\w+)\}?/.exec(m.args[1])[1];
    const v = vars[name];
    out = out.slice(0, i) + (v === '$__all' || v === '' ? '1=1' : m.args[0]) + out.slice(m.end);
  }
  // Variables : ${v:singlequote}, ${v}, $v
  const values = name => {
    const v = vars[name];
    return v === '$__all' ? [] : [].concat(v);
  };
  out = out.replace(/\$\{(\w+):singlequote\}/g, (m, n) => (n in vars ? values(n).map(quote).join(',') : m));
  out = out.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
    const n = a || b;
    return n in vars ? values(n).join(',') : m;
  });
  // Macros du plugin
  const fs = Math.floor(from / 1000),
    ts = Math.floor(to / 1000);
  out = out.replace(
    /\$__timeFilter_ms\(([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    (m, c) => `${c} >= fromUnixTimestamp64Milli(${from}) AND ${c} <= fromUnixTimestamp64Milli(${to})`
  );
  out = out.replace(
    /\$__timeFilter\(([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    (m, c) => `${c} >= toDateTime(${fs}) AND ${c} <= toDateTime(${ts})`
  );
  out = out
    .replace(/\$__fromTime_ms/g, `fromUnixTimestamp64Milli(${from})`)
    .replace(/\$__toTime_ms/g, `fromUnixTimestamp64Milli(${to})`);
  out = out.replace(/\$__fromTime/g, `toDateTime(${fs})`).replace(/\$__toTime/g, `toDateTime(${ts})`);
  out = out.replace(/\$__interval_s/g, String(Math.max(1, Math.floor(intervalSeconds))));
  return out;
}
