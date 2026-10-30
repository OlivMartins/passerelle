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
  const out = execFileSync(
    CH_BIN,
    [...CH_PRE, '--allow_experimental_nlp_functions=1', '--query', `SELECT ${expr} FORMAT JSONEachRow`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return Object.values(JSON.parse(out.trim()))[0];
}
let ko = 0,
  same = 0,
  diffs = 0,
  todo = 0;
for (const c of CAS) {
  for (const text of TEXTES) {
    const preview = E.anAnalyze(c.spec, text);
    const plan = E.anPlan(c.spec, lit(text));
    if (!plan.expr) {
      todo++;
      continue;
    }
    if (preview.error) continue;
    let got;
    try {
      got = ch(plan.expr);
    } catch (e) {
      ko++;
      console.log(
        `✗ ${c.nom} — ${JSON.stringify(text)} : ClickHouse refuse l’expression\n    ${String(e.stderr || e.message)
          .split('\n')[0]
          .slice(0, 300)}`
      );
      continue;
    }
    const want = preview.tokens.map(x => x.t);
    // Les mots sont comparés comme des suites ; « unique » et les synonymes peuvent réordonner à positions égales
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) {
      same++;
      if (VERBOSE) console.log(`✓ ${c.nom} — ${JSON.stringify(text)}`);
      continue;
    }
    const exact = plan.steps.every(s => s.exact);
    if (exact) {
      ko++;
      console.log(
        `✗ ${c.nom} (plan exact) — ${JSON.stringify(text)}\n    Elasticsearch : ${JSON.stringify(want)}\n    ClickHouse    : ${JSON.stringify(got)}`
      );
    } else {
      diffs++;
      console.log(
        `≈ ${c.nom} (plan à vérifier) — ${JSON.stringify(text)}\n    Elasticsearch : ${JSON.stringify(want)}\n    ClickHouse    : ${JSON.stringify(got)}`
      );
    }
  }
}

// De bout en bout : les DDL du plan sur une table réelle, puis les requêtes du plan (le texte cherché passe par la même expression que la colonne)
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-an-'));
  const run = sql =>
    execFileSync(
      CH_BIN,
      [
        ...CH_PRE,
        '--path',
        dir + '/',
        '--allow_experimental_nlp_functions=1',
        '--allow_experimental_full_text_index=1',
        '--multiquery',
        '--output-format',
        'JSONEachRow'
      ],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  try {
    const r = E.schemaFromElastic(
      fs.readFileSync(new URL('../../examples/analyseurs/catalogue.txt', import.meta.url), 'utf8').trim(),
      E.DEFAULT_CONFIG,
      {}
    );
    run('CREATE DATABASE IF NOT EXISTS logs;\n' + r.sql.replace(/^--.*\n/gm, ''));
    run(
      "INSERT INTO logs.catalogue (timestamp, titre, reference, tags, description) VALUES (now(), 'Le Téléviseur d\\'été', 'ab-12_x', ['TV','Télé'], '<p>Running dogs</p>'), (now(), 'Une radio', 'cd-34', ['radio'], 'cats')"
    );
    const checks = [
      ['tags', 'télé', 1, 'synonymes : « télé » retrouve la ligne taguée TV'],
      ['tags', 'Téléviseur', 1, 'synonymes : « téléviseur » aussi'],
      ['tags', 'radio', 2, 'synonymes : un mot sans synonyme'],
      ['titre', 'L’été', 1, 'elision et asciifolding : « L’été » retrouve « d’été »'],
      ['description', 'run dog', 1, 'stemmer : « run dog » retrouve « Running dogs »'],
      ['reference', 'AB 12 X', 1, 'pattern_replace et keyword : « AB 12 X » retrouve « ab-12_x »']
    ];
    const rep = E.anReport(r.tables, undefined);
    for (const p of rep.plans) run(p.plan.ddl.join('\n') + '\n');
    for (const [field, sample, wantRow, label] of checks) {
      const plan = rep.plans.find(p => p.plan.field === field).plan;
      const q = E.anFieldPlan(plan.table, field, r.tables[0].profile.analyzers[field], sample, {
        column: field,
        type: field === 'tags' ? 'Array(String)' : 'String'
      }).query;
      const rows = JSON.parse(
        '[' +
          run(`SELECT timestamp, titre FROM logs.catalogue WHERE ${q.match_and} ORDER BY titre FORMAT JSONEachRow`)
            .trim()
            .split('\n')
            .filter(Boolean)
            .join(',') +
          ']'
      );
      const ok =
        rows.length === 1 && (wantRow === 1 ? /Téléviseur/.test(rows[0].titre) : rows[0].titre === 'Une radio');
      if (!ok) {
        ko++;
        console.log(`✗ requête du plan — ${label} : ${rows.length} ligne(s) au lieu d’une`);
      } else {
        same++;
        if (VERBOSE) console.log(`✓ requête du plan — ${label}`);
      }
    }
  } catch (e) {
    ko++;
    console.log(
      `✗ requêtes du plan sur une table réelle : ${String(e.stderr || e.message)
        .split('\n')
        .slice(0, 3)
        .join(' ')}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  `${same} identiques, ${diffs} différences sur des plans à vérifier, ${ko} erreurs, ${todo} analyseurs sans plan.`
);
process.exit(ko ? 1 : 0);
