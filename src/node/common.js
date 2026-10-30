/*
 * Passerelle — éléments communs au serveur et à la ligne de commande : version, journal, sortie en erreur,
 * références ${VAR}, erreur HTTP, compteur de validations, processus externes, lecture de dossiers.
 * Ne dépend de rien d'autre que de Node.js : les autres fichiers de src/node en dépendent.
 */

const VERSION = '1.7.1';
function log(level, msg, extra) {
  const line = Object.assign({ ts: new Date().toISOString(), level, msg }, extra || {});
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
function fail(msg, code) {
  process.stderr.write(`passerelle : ${msg}\n`);
  process.exit(code || 1);
}
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
function expand(s) {
  return String(s || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => process.env[v] || '');
}
// Validations en cours : le serveur en limite le nombre, l'exploitation le publie (métrique passerelle_validation_jobs_running)
const jobs = { running: 0 };
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
function runProcess(bin, args, env, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT')
        return reject(
          new HttpError(503, `binaire introuvable : ${bin}. Installez Vector ou définissez PASSERELLE_VECTOR_BIN.`)
        );
      if (err && err.killed) return reject(new HttpError(504, 'validation interrompue : délai dépassé'));
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      });
    });
  });
}
function collect(inputs, exts) {
  const out = [];
  const walk = p => {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      fail(`introuvable : ${p}`);
    }
    if (st.isDirectory())
      fs.readdirSync(p)
        .sort()
        .forEach(n => walk(path.join(p, n)));
    else if (exts.test(p) || inputs.includes(p)) out.push(p);
  };
  inputs.forEach(walk);
  return out;
}
// Dossier de sortie (--out) : une erreur lisible plutôt qu’une pile Node.js
function outDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    fail(
      `--out : impossible de créer le dossier ${dir} (${e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'un fichier porte ce nom' : e.code || e.message})`
    );
  }
}
// Les pipelines d’un même dossier s’appellent entre eux (processeur pipeline) : ils sont lus ensemble. Un fichier
// « .yml.link » d’une intégration Elastic (elastic-package) désigne un pipeline partagé : on lit le fichier désigné.
function ingestInputs(files) {
  return files.map(f => {
    const name = path.basename(f).replace(/\.(ya?ml|json)(\.link)?$/i, '');
    if (!/\.link$/i.test(f)) return { name, text: fs.readFileSync(f, 'utf8') };
    const target = path.resolve(path.dirname(f), fs.readFileSync(f, 'utf8').trim().split(/\s+/)[0] || '');
    if (!fs.existsSync(target)) fail(`${f} désigne ${target}, introuvable`);
    return { name, text: fs.readFileSync(target, 'utf8') };
  });
}
