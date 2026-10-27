#!/usr/bin/env node
/*
 * Banc des analyseurs : pour chaque analyseur et chaque texte, l’aperçu (ce qu’Elasticsearch produit, voir
 * src/engine/analysis.js) est comparé aux mots que l’expression ClickHouse du plan produit réellement.
 * Une étape déclarée « exacte » ne doit jamais différer ; une différence sur une étape « à vérifier » est
 * affichée, sans faire échouer le banc.
 *
 *   CLICKHOUSE_LOCAL=./clickhouse local node tests/clickhouse/analyseurs.mjs [--verbose]
 *
 * Les attendus d’Elasticsearch du fichier tests/clickhouse/analyseurs.cas.mjs viennent de la documentation
 * d’Elasticsearch (API _analyze) : ils sont comparés à l’aperçu par scripts/test.mjs, sans ClickHouse.
 */
import { execFileSync } from 'node:child_process';
import { loadEngine } from '../../scripts/engine.mjs';
import { CAS, TEXTES } from './analyseurs.cas.mjs';

const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const VERBOSE = process.argv.includes('--verbose');
const E = loadEngine();
const lit = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
function ch(expr) {
  const out = execFileSync(CH_BIN, [...CH_PRE, '--allow_experimental_nlp_functions=1', '--query', `SELECT ${expr} FORMAT JSONEachRow`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return Object.values(JSON.parse(out.trim()))[0];
}
let ko = 0, same = 0, diffs = 0, todo = 0;
for (const c of CAS) {
  for (const text of TEXTES) {
    const preview = E.anAnalyze(c.spec, text);
    const plan = E.anPlan(c.spec, lit(text));
    if (!plan.expr) { todo++; continue; }
    if (preview.error) continue;
    let got;
    try { got = ch(plan.expr); } catch (e) { ko++; console.log(`✗ ${c.nom} — ${JSON.stringify(text)} : ClickHouse refuse l’expression\n    ${String(e.stderr || e.message).split('\n')[0].slice(0, 300)}`); continue; }
    const want = preview.tokens.map(x => x.t);
    // Les mots sont comparés comme des suites ; « unique » et les synonymes peuvent réordonner à positions égales
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { same++; if (VERBOSE) console.log(`✓ ${c.nom} — ${JSON.stringify(text)}`); continue; }
    const exact = plan.steps.every(s => s.exact);
    if (exact) { ko++; console.log(`✗ ${c.nom} (plan exact) — ${JSON.stringify(text)}\n    Elasticsearch : ${JSON.stringify(want)}\n    ClickHouse    : ${JSON.stringify(got)}`); }
    else { diffs++; console.log(`≈ ${c.nom} (plan à vérifier) — ${JSON.stringify(text)}\n    Elasticsearch : ${JSON.stringify(want)}\n    ClickHouse    : ${JSON.stringify(got)}`); }
  }
}
console.log(`${same} identiques, ${diffs} différences sur des plans à vérifier, ${ko} erreurs, ${todo} analyseurs sans plan.`);
process.exit(ko ? 1 : 0);
