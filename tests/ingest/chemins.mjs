#!/usr/bin/env node
/*
 * Accès aux champs : messages d’erreur et index de liste, comme IngestDocument d’Elasticsearch.
 * Chaque processeur rate sur un parent qui n’est pas une table (chaîne, nombre, null, liste) ; son on_failure
 * recopie _ingest.on_failure_message dans errs. Les attendus suivent IngestDocument.java (resolve, setFieldValue,
 * removeField, Errors.*) : « cannot resolve », « cannot set … with null parent », « is not an integer »,
 * « is out of bounds », clés numériques d’une table (sc.200) et index d’une liste (u.parts.0).
 *
 *   VECTOR_BIN=… node tests/ingest/chemins.mjs
 */
import { E, play } from './commun.mjs';

const CASES = [
  {
    name: "clés et index de liste",
    pipeline: `processors:
  - set: { field: a.b.c, value: 1, on_failure: [ { append: { field: errs, value: "set {{{_ingest.on_failure_message}}}" } } ] }
  - set: { field: u.first, copy_from: u.parts.0, on_failure: [ { append: { field: errs, value: "copy {{{_ingest.on_failure_message}}}" } } ] }
  - set: { field: sc.200, value: 5, on_failure: [ { append: { field: errs, value: "sc {{{_ingest.on_failure_message}}}" } } ] }
  - remove: { field: x.y, on_failure: [ { append: { field: errs, value: "rm {{{_ingest.on_failure_message}}}" } } ] }
  - remove: { field: l.1, on_failure: [ { append: { field: errs, value: "rml {{{_ingest.on_failure_message}}}" } } ] }
  - lowercase: { field: r.s.t, on_failure: [ { append: { field: errs, value: "lc {{{_ingest.on_failure_message}}}" } } ] }
`,
    docs: [
      {"id": 1, "a": "str", "u": {"parts": ["X", "y"]}, "x": "s", "l": [1, 2, 3], "r": {"s": "T"}},
      {"id": 2, "a": {"b": 5}, "u": {"parts": []}, "x": {}, "l": [1], "r": null},
      {"id": 3, "a": null, "sc": [0], "x": null, "l": {"1": "un"}, "r": {"s": [1]}},
      {"id": 4, "a": {"b": null}, "u": {"parts": {"0": "zero"}}, "x": {"y": 1}, "r": {"s": {"t": "ABC"}}},
      {"id": 5, "a": [1, 2], "sc": {"200": 1}, "r": {"s": {"t": null}}}
    ],
    expected: [
      {"a": "str", "errs": ["set cannot resolve [b] from object of type [java.lang.String] as part of path [a.b.c]", "rm cannot remove [y] from object of type [java.lang.String] as part of path [x.y]", "lc cannot resolve [t] from object of type [java.lang.String] as part of path [r.s.t]"], "id": 1, "l": [1, 3], "r": {"s": "T"}, "sc": {"200": 5}, "u": {"first": "X", "parts": ["X", "y"]}, "x": "s"},
      {"a": {"b": 5}, "errs": ["set cannot set [c] with parent object of type [java.lang.Integer] as part of path [a.b.c]", "copy [0] is out of bounds for array with length [0] as part of path [u.parts.0]", "rm field [y] not present as part of path [x.y]", "rml [1] is out of bounds for array with length [1] as part of path [l.1]", "lc cannot resolve [s] from null as part of path [r.s.t]"], "id": 2, "l": [1], "r": null, "sc": {"200": 5}, "u": {"parts": []}, "x": {}},
      {"a": null, "errs": ["set cannot resolve [b] from null as part of path [a.b.c]", "copy field [u] not present as part of path [u.parts.0]", "sc [200] is out of bounds for array with length [1] as part of path [sc.200]", "rm cannot remove [y] from null as part of path [x.y]", "lc [t] is not an integer, cannot be used as an index as part of path [r.s.t]"], "id": 3, "l": {}, "r": {"s": [1]}, "sc": [0], "x": null},
      {"a": {"b": null}, "errs": ["set cannot set [c] with null parent as part of path [a.b.c]", "rml field [l] not present as part of path [l.1]"], "id": 4, "r": {"s": {"t": "abc"}}, "sc": {"200": 5}, "u": {"first": "zero", "parts": {"0": "zero"}}, "x": {}},
      {"a": [1, 2], "errs": ["set [b] is not an integer, cannot be used as an index as part of path [a.b.c]", "copy field [u] not present as part of path [u.parts.0]", "rm field [x] not present as part of path [x.y]", "rml field [l] not present as part of path [l.1]", "lc field [r.s.t] is null, cannot process it."], "id": 5, "r": {"s": {"t": null}}, "sc": {"200": 5}}
    ]
  },
  {
    name: "clés seulement",
    pipeline: `processors:
  - set: { field: a.b.c, value: 1, on_failure: [ { append: { field: errs, value: "set {{{_ingest.on_failure_message}}}" } } ] }
  - set: { field: u.first, copy_from: u.parts.x, on_failure: [ { append: { field: errs, value: "copy {{{_ingest.on_failure_message}}}" } } ] }
  - remove: { field: x.y, on_failure: [ { append: { field: errs, value: "rm {{{_ingest.on_failure_message}}}" } } ] }
  - remove: { field: l.k.m, on_failure: [ { append: { field: errs, value: "rml {{{_ingest.on_failure_message}}}" } } ] }
  - lowercase: { field: r.s.t, on_failure: [ { append: { field: errs, value: "lc {{{_ingest.on_failure_message}}}" } } ] }
`,
    docs: [
      {"id": 1, "a": "str", "u": {"parts": ["X"]}, "x": "s", "l": {"k": [1]}, "r": {"s": "T"}},
      {"id": 2, "a": {"b": 5}, "u": {"parts": {}}, "x": {}, "l": {"k": null}, "r": null},
      {"id": 3, "a": null, "x": null, "l": 7.5, "r": {"s": [1]}},
      {"id": 4, "a": {"b": null}, "u": {"parts": {"x": "ok"}}, "x": {"y": 1}, "l": {"k": {"m": 1}}, "r": {"s": {"t": "ABC"}}},
      {"id": 5, "a": [1, 2], "u": 5000000000, "l": {"k": true}, "r": {"s": {}}}
    ],
    expected: [
      {"a": "str", "errs": ["set cannot resolve [b] from object of type [java.lang.String] as part of path [a.b.c]", "copy [x] is not an integer, cannot be used as an index as part of path [u.parts.x]", "rm cannot remove [y] from object of type [java.lang.String] as part of path [x.y]", "rml [m] is not an integer, cannot be used as an index as part of path [l.k.m]", "lc cannot resolve [t] from object of type [java.lang.String] as part of path [r.s.t]"], "id": 1, "l": {"k": [1]}, "r": {"s": "T"}, "u": {"parts": ["X"]}, "x": "s"},
      {"a": {"b": 5}, "errs": ["set cannot set [c] with parent object of type [java.lang.Integer] as part of path [a.b.c]", "copy field [x] not present as part of path [u.parts.x]", "rm field [y] not present as part of path [x.y]", "rml cannot remove [m] from null as part of path [l.k.m]", "lc cannot resolve [s] from null as part of path [r.s.t]"], "id": 2, "l": {"k": null}, "r": null, "u": {"parts": {}}, "x": {}},
      {"a": null, "errs": ["set cannot resolve [b] from null as part of path [a.b.c]", "copy field [u] not present as part of path [u.parts.x]", "rm cannot remove [y] from null as part of path [x.y]", "rml cannot resolve [k] from object of type [java.lang.Double] as part of path [l.k.m]", "lc [t] is not an integer, cannot be used as an index as part of path [r.s.t]"], "id": 3, "l": 7.5, "r": {"s": [1]}, "x": null},
      {"a": {"b": null}, "errs": ["set cannot set [c] with null parent as part of path [a.b.c]"], "id": 4, "l": {"k": {}}, "r": {"s": {"t": "abc"}}, "u": {"first": "ok", "parts": {"x": "ok"}}, "x": {}},
      {"a": [1, 2], "errs": ["set [b] is not an integer, cannot be used as an index as part of path [a.b.c]", "copy cannot resolve [parts] from object of type [java.lang.Long] as part of path [u.parts.x]", "rm field [x] not present as part of path [x.y]", "rml cannot remove [m] from object of type [java.lang.Boolean] as part of path [l.k.m]", "lc field [t] not present as part of path [r.s.t]"], "id": 5, "l": {"k": true}, "r": {"s": {}}, "u": 5000000000}
    ]
  }
];

// Tri des clés : la comparaison ne dépend pas de l’ordre d’écriture
const norm = v => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v);
let failed = 0;
for (const c of CASES) {
  const r = E.translateIngest([{ name: 'chemins', text: c.pipeline }], E.DEFAULT_CONFIG);
  if (r.error) { console.log(`✗ ${c.name} : ${r.error}`); failed++; continue; }
  const got = Object.fromEntries(play(r, c.docs).map(d => [d.id, norm(d)]));
  for (const e of c.expected) {
    const a = JSON.stringify(norm(e)); const b = JSON.stringify(got[e.id]);
    if (a === b) console.log(`✓ ${c.name}, document ${e.id}`);
    else { failed++; console.log(`✗ ${c.name}, document ${e.id}\n  attendu ${a}\n  obtenu  ${b}`); }
  }
}
console.log(failed ? `\n${failed} écart(s).` : '\nTous les accès se comportent comme dans Elasticsearch.');
process.exit(failed ? 1 : 0);
