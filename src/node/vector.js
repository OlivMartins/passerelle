/* Passerelle — validation d’une configuration Vector par « vector validate » */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './common.js';
import { opsWithSpan } from './ops.js';

export async function validateVector(text, format) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'passerelle-'));
  try {
    const dataDir = path.join(dir, 'data');
    await fsp.mkdir(dataDir);
    const ext = format === 'toml' ? 'toml' : format === 'json' ? 'json' : 'yaml';
    let body = String(text);
    if (ext === 'yaml')
      body = /^data_dir:/m.test(body)
        ? body.replace(/^data_dir:.*$/m, `data_dir: ${dataDir}`)
        : `data_dir: ${dataDir}\n${body}`;
    if (ext === 'toml')
      body = /^data_dir\s*=/m.test(body)
        ? body.replace(/^data_dir\s*=.*$/m, `data_dir = ${JSON.stringify(dataDir)}`)
        : `data_dir = ${JSON.stringify(dataDir)}\n${body}`;
    const file = path.join(dir, `vector.${ext}`);
    await fsp.writeFile(file, body, { mode: 0o600 });
    // Vector ne reçoit aucun secret du service : sa sortie revient au client, et la configuration soumise
    // peut lire un fichier (remap « file: /proc/self/environ »). Les variables ${…} reçoivent une valeur factice :
    // on valide la structure, pas les secrets.
    const env = {};
    for (const [k, v] of Object.entries(process.env))
      if (k === 'PATH' || k === 'HOME' || k === 'TZ' || k.startsWith('VECTOR_')) env[k] = v;
    for (const m of body.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) env[m[1]] = 'validation';
    // Vector 0.57 et suivants : l’interpolation que demande l’en-tête des configurations générées (sauf réglage contraire du service)
    if (env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION === undefined)
      env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION = 'true';
    const bin = process.env.PASSERELLE_VECTOR_BIN || 'vector';
    const r = await opsWithSpan('vector.validate', 1, { 'process.executable.name': path.basename(bin) }, () =>
      runProcess(bin, ['--color', 'never', 'validate', '--skip-healthchecks', file], env, 90000)
    );
    const output = (r.stdout + '\n' + r.stderr)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .filter(l => l.trim() && !/librdkafka|rdkafka::|base_producer|Log level is enabled/.test(l))
      .join('\n')
      .replaceAll(dir, '<tmp>');
    return { valid: r.code === 0, exit_code: r.code, output };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
