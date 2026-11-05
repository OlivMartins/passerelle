/*
 * Passerelle — pool de worker_threads pour les routes lourdes du service.
 *
 *   const pool = createPool({ size, memoryMb, timeoutMs, queueMax });
 *   const reply = await pool.run('/v1/inventory/kibana', '?format=md', body, cfg);   // { status, headers, bytes, … }
 *
 * - Les workers naissent à la demande (aucun coût pour un service qui ne reçoit pas de gros export) et restent.
 * - Un worker qui dépasse son délai est terminé, ce que le fil principal ne pouvait pas faire d'un calcul synchrone ;
 *   un worker qui dépasse sa mémoire (resourceLimits) l'est par Node. Dans les deux cas la requête reçoit une erreur
 *   claire, un worker neuf prend la suite et le service continue.
 * - Au-delà de `size` tâches simultanées, les suivantes attendent, jusqu'à `queueMax` ; au-delà : 429.
 * - Si aucun worker ne démarre (environnement sans worker_threads, binaire autonome qui refuse le code en ligne), le
 *   calcul se fait en ligne, avec un avertissement : le service garde ses réponses, il perd seulement l'isolation.
 *
 * Dans le bundle (scripts/bundle.mjs), le code du worker est embarqué comme texte (globalThis.__PASSERELLE_WORKER__) et
 * démarré en « eval » : le binaire autonome n'a pas de fichier à charger. Hors bundle, c'est src/node/worker.js.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError, log } from './common.js';
import { handleHeavy } from './routes.js';

const EMBEDDED = typeof globalThis.__PASSERELLE_WORKER__ === 'string' ? globalThis.__PASSERELLE_WORKER__ : null;

/*
 * Tas d'un worker par octet d'export reçu, mesuré sur l'inventaire Kibana : un export de 30 Mo demande ~770 Mio, soit ~25.
 * On retient 30 pour la marge. Pourquoi refuser a priori plutôt que de compter sur resourceLimits : quand le tas est
 * épuisé pendant une grosse allocation native (JSON.stringify, TextEncoder sur une réponse de plus de 100 Mo), V8 ne peut
 * pas appeler son rappel de fin gracieuse et Node abat tout le processus (mesuré : SIGABRT sous Linux, Node 24).
 * La limite reste en place pour les cas où elle opère proprement.
 */
const HEAP_PER_INPUT_BYTE = 30;

function startWorker(memoryMb) {
  const resourceLimits = { maxOldGenerationSizeMb: memoryMb };
  return EMBEDDED
    ? new Worker(EMBEDDED, { eval: true, resourceLimits })
    : new Worker(path.join(import.meta.dirname, 'worker.js'), { resourceLimits });
}

export function createPool({ size = 1, memoryMb = 1024, timeoutMs = 100000, queueMax = 16 } = {}) {
  const slots = new Set(); // workers vivants : { w, task, timer, ready }
  const queue = []; // tâches en attente : { args, resolve, reject }
  let inline = false; // plus aucun worker ne démarre : calcul en ligne
  let closed = false;

  const settle = (slot, how, value) => {
    const t = slot.task;
    if (!t) return;
    slot.task = null;
    clearTimeout(slot.timer);
    t[how](value);
  };
  const drop = slot => {
    if (!slots.delete(slot)) return;
    slot.w.removeAllListeners();
    slot.w.terminate().catch(() => {});
  };
  const pump = () => {
    while (queue.length && !closed) {
      let slot = [...slots].find(s => s.ready && !s.task);
      if (!slot && slots.size < size) slot = spawn();
      if (!slot || !slot.ready) return; // un worker démarre, ou tous sont occupés : la file attend
      dispatch(slot, queue.shift());
    }
  };
  const dispatch = (slot, task) => {
    slot.task = task;
    const { path: p, search, body, cfg } = task.args;
    slot.timer = setTimeout(() => {
      settle(slot, 'reject', new HttpError(503, `traitement interrompu après ${Math.round(timeoutMs / 1000)} s`));
      drop(slot);
      pump();
    }, timeoutMs);
    try {
      // Les octets d'un gros corps passent au worker sans copie. Un petit Buffer vit dans le tampon partagé de Node
      // (Buffer.poolSize) : le transférer détacherait celui des autres, on le copie.
      const own = typeof body !== 'string' && body.byteOffset === 0 && body.buffer.byteLength === body.length;
      slot.w.postMessage({ id: 0, path: p, search, body, cfg }, own ? [body.buffer] : []);
    } catch (e) {
      // Donnée non clonable : la tâche échoue, le worker reste disponible
      settle(slot, 'reject', e);
    }
  };
  function spawn() {
    let w;
    try {
      w = startWorker(memoryMb);
    } catch (e) {
      fallback(e);
      return null;
    }
    const slot = { w, task: null, timer: null, ready: false };
    slots.add(slot);
    w.on('message', m => {
      if (m.ready) {
        slot.ready = true;
        return pump();
      }
      if (m.error) {
        const e = new Error(m.error.message);
        e.stack = m.error.stack;
        settle(slot, 'reject', e);
      } else settle(slot, 'resolve', m.reply);
      pump();
    });
    w.on('error', e => {
      // Un worker qui n'a jamais été prêt ne démarre pas dans cet environnement : calcul en ligne
      if (!slot.ready) return fallback(e);
      settle(
        slot,
        'reject',
        e && e.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new HttpError(
              413,
              `export trop volumineux pour la mémoire d’un traitement (${memoryMb} Mio, PASSERELLE_WORKER_MEMORY_MB) : découpez-le par espace Kibana ou augmentez cette limite`
            )
          : e
      );
      drop(slot);
      pump();
    });
    w.on('exit', () => {
      // Sortie sans erreur ni réponse (worker tué de l'extérieur) : la tâche en cours est perdue
      if (!slot.ready) return fallback(new Error('worker arrêté au démarrage'));
      settle(slot, 'reject', new Error('le worker s’est arrêté pendant le traitement'));
      drop(slot);
      pump();
    });
    return slot;
  }
  function fallback(e) {
    if (!inline)
      log('warn', 'worker_threads indisponible : les gros exports sont calculés dans le fil principal', {
        error: e && (e.code || e.message)
      });
    inline = true;
    for (const s of [...slots]) {
      settle(s, 'reject', e);
      drop(s);
    }
    while (queue.length) {
      const t = queue.shift();
      runInline(t);
    }
  }
  function runInline(task) {
    // Un tour de boucle d'événements d'abord : la réponse partie de l'appelant précédent n'attend pas ce calcul
    setImmediate(() => {
      try {
        const { path: p, search, body, cfg } = task.args;
        task.resolve(handleHeavy(p, search, body, cfg));
      } catch (e) {
        task.reject(e);
      }
    });
  }

  return {
    run(p, search, body, cfg) {
      if (closed) return Promise.reject(new HttpError(503, 'le service s’arrête'));
      // Refus a priori, avant tout calcul : voir HEAP_PER_INPUT_BYTE
      const need = Math.ceil((body.length * HEAP_PER_INPUT_BYTE) / 1048576);
      if (need > memoryMb)
        return Promise.reject(
          new HttpError(
            413,
            `export trop volumineux pour la mémoire d’un traitement : ${Math.round(body.length / 1048576)} Mio demandent environ ${need} Mio, la limite est ${memoryMb} Mio (PASSERELLE_WORKER_MEMORY_MB) ; découpez l’export par espace Kibana ou augmentez cette limite`
          )
        );
      return new Promise((resolve, reject) => {
        const task = { args: { path: p, search, body, cfg }, resolve, reject };
        if (inline) return runInline(task);
        const busy = [...slots].filter(s => s.task).length + queue.length;
        if (busy >= size + queueMax)
          return reject(new HttpError(429, 'trop de gros traitements en cours, réessayez dans quelques secondes'));
        queue.push(task);
        pump();
      });
    },
    close() {
      closed = true;
      for (const s of [...slots]) {
        settle(s, 'reject', new HttpError(503, 'le service s’arrête'));
        drop(s);
      }
    },
    // Pour l'exploitation et les tests
    stats: () => ({ workers: slots.size, busy: [...slots].filter(s => s.task).length, queued: queue.length, inline })
  };
}
