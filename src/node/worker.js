/*
 * Passerelle — point d'entrée d'un worker_thread : calcule les routes lourdes (src/node/routes.js) hors du fil
 * principal. Message reçu : { id, path, search, body, cfg }. Réponse : { id, reply } (octets transférés sans copie),
 * ou { id, error } si le calcul lève une exception. Le pool (src/node/pool.js) en décide le sort.
 */
import { parentPort } from 'node:worker_threads';
import { handleHeavy } from './routes.js';

parentPort.on('message', ({ id, path, search, body, cfg }) => {
  try {
    const reply = handleHeavy(path, search, body, cfg);
    parentPort.postMessage({ id, reply }, [reply.bytes.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: { message: e.message, stack: e.stack } });
  }
});
// Le pool distingue un worker qui n'a pas démarré (repli en ligne) d'un worker qui a échoué sur une tâche
parentPort.postMessage({ ready: true });
