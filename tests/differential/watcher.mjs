#!/usr/bin/env node
/*
 * Banc Watcher : chaque watch de watches.mjs est jouée par Elasticsearch, sans être enregistrée
 * (POST _watcher/watch/_execute, actions ignorées), et sa traduction par ClickHouse, à plusieurs heures prévues.
 * La condition d’Elasticsearch (watch_record.result.condition.met) doit valoir la décision de ClickHouse
 * (colonne declenchee), sauf écart connu annoncé dans watches.mjs.
 *
 *   node tests/differential/watcher.mjs [--es=URL] [--verbose] [--clickhouse-seul]
 *
 *   --clickhouse-seul  sans Elasticsearch : chaque watch a une décision traduite, qui s’exécute sur ClickHouse
 *
 *   ES_URL             adresse d’Elasticsearch (défaut http://127.0.0.1:9200 ; voir es.sh, qui active la licence d’essai
 *                      dont Watcher a besoin)
 *   CLICKHOUSE_LOCAL   commande ClickHouse locale (défaut clickhouse-local ; « clickhouse local » convient)
 *   PASSERELLE_DIFF_WORK   dossier de travail, sur un système de fichiers Linux
 *
 * Code de sortie : 0 si chaque watch donne la même décision des deux côtés, 1 sinon.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataset, ES_INDEX, INDEX, clickhouseDDL, clickhouseRow, esDocument, configOverride } from './dataset.mjs';
import { WATCHES, TIMES } from './watches.mjs';
import { loadEngine } from '../../scripts/engine.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const ES = (args.es || process.env.ES_URL || 'http://127.0.0.1:9200').replace(/\/+$/, '');
const [CH_BIN, ...CH_PRE] = (process.env.CLICKHOUSE_LOCAL || 'clickhouse-local').split(' ');
const WORK = join(process.env.PASSERELLE_DIFF_WORK || join(tmpdir(), 'passerelle-diff'), 'watcher');
const E = loadEngine();
const CH_ONLY = !!args['clickhouse-seul'];

async function es(path, body, method) {
  const bulk = typeof body === 'string';
  const r = await fetch(ES + path, {
    method: method || 'POST',
    headers: { 'content-type': bulk ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : bulk ? body : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function clickhouse(dir, argv) {
  return execFileSync(CH_BIN, [...CH_PRE, '--path', dir, ...argv], {
    encoding: 'utf8',
    maxBuffer: 64e6,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TZ: 'UTC' })
  });
}

/* ---------- Données : le jeu du banc différentiel, dans les deux moteurs ---------- */
const info = CH_ONLY ? null : await es('/', undefined, 'GET').catch(() => null);
if (!CH_ONLY && (!info || info.status !== 200)) {
  console.error(`Elasticsearch injoignable sur ${ES}. Lancez « tests/differential/es.sh up » ou définissez ES_URL.`);
  process.exit(1);
}
const license = CH_ONLY ? { body: { license: { type: 'trial' } } } : await es('/_license', undefined, 'GET');
const type = license.body && license.body.license && license.body.license.type;
if (!['trial', 'platinum', 'enterprise'].includes(type)) {
  console.error(
    `Watcher demande une licence d’essai ou payante (trouvé : ${type || 'aucune'}) : es.sh démarre Elasticsearch avec xpack.license.self_generated.type=trial.`
  );
  process.exit(1);
}
console.log(
  `${CH_ONLY ? 'Sans Elasticsearch' : `Elasticsearch ${info.body.version.number} (licence ${type})`} / ${execFileSync(CH_BIN, [...CH_PRE, '--version'], { encoding: 'utf8' }).trim()}\n`
);

const docs = dataset();
if (!CH_ONLY) {
  await es(`/${INDEX}`, undefined, 'DELETE');
  const created = await es(`/${INDEX}`, ES_INDEX, 'PUT');
  if (created.status !== 200) {
    console.error(`création de l’index : ${E.eqEsError(created)}`);
    process.exit(1);
  }
  const loaded = await es(
    '/_bulk?refresh=true',
    docs
      .map(d => JSON.stringify({ index: { _index: INDEX, _id: d._id } }) + '\n' + JSON.stringify(esDocument(d)) + '\n')
      .join('')
  );
  if (loaded.status !== 200 || loaded.body.errors) {
    console.error(`chargement Elasticsearch : ${JSON.stringify(loaded.body).slice(0, 300)}`);
    process.exit(1);
  }
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const file = join(WORK, 'rows.jsonl');
writeFileSync(file, docs.map(d => JSON.stringify(clickhouseRow(d))).join('\n') + '\n');
clickhouse(WORK, [
  '--multiquery',
  '--query',
  `SET date_time_input_format = 'best_effort';\n${clickhouseDDL('N')}\nINSERT INTO logs.events FROM INFILE '${file}' FORMAT JSONEachRow;`
]);
const cfg = E.mergeConfig(E.DEFAULT_CONFIG, configOverride('N'));

/* ---------- Chaque watch, à chaque heure prévue ---------- */
let failures = 0;
let same = 0;
let known = 0;
for (const c of WATCHES) {
  const rep = E.watcherTranslate(JSON.stringify({ watches: [{ _id: 'banc', watch: c.watch }] }), cfg, {});
  const entry = rep.entries[0];
  const q = entry && entry.queries.find(x => x.title === 'Condition');
  if (!q) {
    failures++;
    console.log(
      `✗ ${c.name} : pas de décision traduite (${
        entry
          ? entry.issues
              .filter(i => i.kind !== 'info')
              .map(i => i.label)
              .join(', ')
          : 'watch illisible'
      })`
    );
    continue;
  }
  for (const T of TIMES) {
    if (CH_ONLY) {
      try {
        const row = JSON.parse(
          clickhouse(WORK, [
            '--format=JSONEachRow',
            '--output_format_json_quote_64bit_integers=0',
            `--param_scheduled_time=${T}`,
            '--query',
            q.sql.replace(/;\s*$/, '')
          ])
            .split('\n')
            .filter(Boolean)[0] || 'null'
        );
        same++;
        if (args.verbose) console.log(`· ${c.name} @ ${T} : ${JSON.stringify(row)}`);
      } catch (e) {
        failures++;
        console.log(
          `✗ ${c.name} @ ${T} : ClickHouse — ${
            String(e.stderr || e.message)
              .split('\n')
              .find(l => /Code: \d+/.test(l)) || e.message
          }`
        );
      }
      continue;
    }
    const r = await es('/_watcher/watch/_execute', {
      watch: c.watch,
      trigger_data: { scheduled_time: T, triggered_time: T },
      action_modes: { _all: 'skip' }
    });
    const rec = r.body && r.body.watch_record;
    const input = rec && rec.result && rec.result.input;
    if (r.status !== 200 || !rec || !rec.result || !rec.result.condition || (input && input.status === 'failure')) {
      failures++;
      console.log(`✗ ${c.name} @ ${T} : Elasticsearch — ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      continue;
    }
    const met = rec.result.condition.met === true;
    let row;
    try {
      row = JSON.parse(
        clickhouse(WORK, [
          '--format=JSONEachRow',
          '--output_format_json_quote_64bit_integers=0',
          `--param_scheduled_time=${T}`,
          '--query',
          q.sql.replace(/;\s*$/, '')
        ])
          .split('\n')
          .filter(Boolean)[0] || 'null'
      );
    } catch (e) {
      failures++;
      console.log(
        `✗ ${c.name} @ ${T} : ClickHouse — ${
          String(e.stderr || e.message)
            .split('\n')
            .find(l => /Code: \d+/.test(l)) || e.message
        }`
      );
      continue;
    }
    const decided = !!(row && row.declenchee);
    const payload =
      input && input.payload
        ? JSON.stringify(input.payload.hits ? { total: input.payload.hits.total } : input.payload).slice(0, 160)
        : '';
    if (c.es !== undefined) {
      // Écart connu : Elasticsearch donne la valeur annoncée, la traduction suit l’intention
      if (met === c.es) {
        known++;
        if (args.verbose) console.log(`~ ${c.name} @ ${T} : Elasticsearch ${met} comme annoncé, ClickHouse ${decided}`);
      } else {
        failures++;
        console.log(`✗ ${c.name} @ ${T} : Elasticsearch ${met}, l’écart annoncé (${c.es}) n’a pas lieu — ${payload}`);
      }
      continue;
    }
    if (met === decided) {
      same++;
      if (args.verbose) console.log(`✓ ${c.name} @ ${T} : ${met} ${JSON.stringify(row)}`);
    } else {
      failures++;
      console.log(
        `✗ ${c.name} @ ${T} : Elasticsearch ${met}, ClickHouse ${decided} ${JSON.stringify(row)} — ${payload}`
      );
    }
  }
}
rmSync(WORK, { recursive: true, force: true });
if (CH_ONLY) {
  console.log(
    `\nBilan sans Elasticsearch : ${same} décisions exécutées sur ClickHouse, ${failures} échec(s), sur ${WATCHES.length} watches × ${TIMES.length} heures.`
  );
  process.exit(failures ? 1 : 0);
}
console.log(
  `\nBilan : ${same} décisions identiques, ${known} écart(s) connu(s) confirmé(s), ${failures} échec(s), sur ${WATCHES.length} watches × ${TIMES.length} heures.`
);
process.exit(failures ? 1 : 0);
