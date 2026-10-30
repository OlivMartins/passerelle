#!/usr/bin/env node
/*
 * TLS des sources qui écoutent (pipelines d’ingestion et entrées beats de Logstash) : Vector accepte la configuration
 * générée, la source répond au handshake TLS avec le certificat donné et refuse une connexion en clair.
 *
 *   VECTOR_BIN=vector node tests/ingest/tls.mjs     (openssl est nécessaire pour créer un certificat de test)
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import net from 'node:net';
import { E, VECTOR, WORK } from './commun.mjs';

const dir = join(WORK, 'tls');
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'data'), { recursive: true });
let failed = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'a.key'),
    '-out',
    join(dir, 'a.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=localhost'
  ],
  { stdio: 'ignore' }
);
const PORT = 15044;

function final(cfgObj, name) {
  const c = JSON.parse(JSON.stringify(cfgObj));
  c.api = { enabled: false };
  c.data_dir = join(dir, 'data');
  c.sinks = {
    out: {
      type: 'console',
      inputs: [c.transforms && c.transforms.bilan ? 'bilan._unmatched' : Object.keys(c.sources)[0]],
      encoding: { codec: 'json' }
    }
  };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(c));
  return file;
}
const validate = file => {
  try {
    execFileSync(VECTOR, ['--color', 'never', 'validate', '--skip-healthchecks', file], {
      stdio: 'pipe',
      maxBuffer: 64e6
    });
    return '';
  } catch (e) {
    return String(e.stdout || e.message).slice(-600);
  }
};

// Pipeline d’ingestion
const cfg = JSON.parse(JSON.stringify(E.DEFAULT_CONFIG));
cfg.vector.ingest_source = {
  address: `127.0.0.1:${PORT}`,
  tls: { crt_file: join(dir, 'a.crt'), key_file: join(dir, 'a.key'), ca_file: '', verify_client: false }
};
const ig = E.translateIngest([{ name: 'p', text: 'processors:\n  - set: { field: a, value: 1 }' }], cfg);
const f1 = final(ig.config, 'ingest');
let err = validate(f1);
check(!err, 'ingestion : Vector accepte la source avec TLS', err);

// Entrée beats de Logstash
const ls = E.translateLogstash(
  `input { beats { port => ${PORT + 1} ssl_enabled => true ssl_certificate => "${join(dir, 'a.crt')}" ssl_key => "${join(dir, 'a.key')}" } }\noutput { stdout { } }`,
  E.DEFAULT_CONFIG,
  {}
);
ls.config.sources.beats_in.address = `127.0.0.1:${PORT + 1}`;
const f2 = final(ls.config, 'beats');
err = validate(f2);
check(!err, 'beats : Vector accepte l’entrée avec TLS', err);

// Source en marche : handshake avec le certificat, refus du clair
const vec = spawn(VECTOR, ['--quiet', '--config', f1], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
vec.stderr.on('data', d => {
  log += d;
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const up = async () => {
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise(r => {
      const s = net.connect(PORT, '127.0.0.1', () => {
        s.destroy();
        r(true);
      });
      s.on('error', () => r(false));
    });
    if (ok) return true;
    await wait(250);
  }
  return false;
};
if (await up()) {
  let shown = '';
  try {
    shown = execFileSync('openssl', ['s_client', '-connect', `127.0.0.1:${PORT}`], {
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10000
    });
  } catch (e) {
    shown = String(e.stdout || '');
  }
  check(
    /subject=.*CN\s*=\s*localhost/.test(shown) && /TLSv1\.[23]/.test(shown),
    'ingestion : la source répond au handshake TLS avec le certificat donné',
    shown.slice(0, 200)
  );
  await new Promise(r => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(Buffer.from('2W\0\0\0\0'));
      setTimeout(() => {
        s.destroy();
        r();
      }, 500);
    });
    s.on('error', r);
  });
  await wait(500);
  check(/TLS handshake failed/.test(log), 'ingestion : une connexion en clair est refusée', log.slice(-300));
} else check(false, 'ingestion : la source démarre', log.slice(-400));
vec.kill();
if (failed) {
  console.error(`\n${failed} vérification(s) en échec`);
  process.exit(1);
}
console.log('\nTLS : tout passe.');
