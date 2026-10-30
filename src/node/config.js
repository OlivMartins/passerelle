/* Passerelle — lecture et contrôle du fichier de configuration (passerelle.yaml ou .json) */

function loadConfig(file) {
  let over = {};
  if (file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`configuration illisible (${file}) : ${e.code || e.message}`);
    }
    over = /\.json$/i.test(file) ? JSON.parse(text) : parseYAMLConfig(text);
    if (!isObj(over)) throw new Error(`configuration invalide (${file})`);
    // Une clé mal écrite laisserait la valeur par défaut en place sans que personne ne le voie
    const unknown = unknownKeys(over, Object.assign({ version: 1 }, DEFAULT_CONFIG), '');
    if (unknown.length)
      throw new Error(
        `clé${unknown.length > 1 ? 's' : ''} inconnue${unknown.length > 1 ? 's' : ''} dans ${file} : ${unknown.join(', ')}`
      );
    for (const [t, profile] of Object.entries((over.clickhouse && over.clickhouse.tables) || {})) {
      if (profile.preset !== undefined && !PRESETS[profile.preset])
        throw new Error(
          `préréglage inconnu pour la table ${t} dans ${file} : ${profile.preset} (${Object.keys(PRESETS).join(' ou ')})`
        );
    }
    const out = over.vector && over.vector.elasticsearch_output;
    if (out !== undefined && !['elasticsearch', 'clickhouse'].includes(out))
      throw new Error(`vector.elasticsearch_output attend elasticsearch ou clickhouse, pas « ${out} » (${file})`);
  }
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    clickhouse: over.clickhouse,
    kafka: over.kafka,
    vector: over.vector,
    elasticsearch: over.elasticsearch,
    verify: over.verify,
    assist: over.assist,
    server: over.server
  });
  opsCheckConfig(cfg.server, file);
  return cfg;
}
// Les tables de correspondance ont des clés libres, comme dans mergeConfig
function unknownKeys(src, ref, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(src)) {
    const p = prefix + k;
    if (!Object.hasOwn(ref, k)) out.push(p);
    // Profils de table : le nom de la table est libre, pas les clés du profil
    else if (k === 'tables' && prefix === 'clickhouse.' && isObj(v)) {
      for (const [t, profile] of Object.entries(v)) {
        if (!isObj(profile)) {
          out.push(`${p}.${t}`);
          continue;
        }
        for (const pk of Object.keys(profile)) if (!PROFILE_KEYS.includes(pk)) out.push(`${p}.${t}.${pk}`);
      }
    } else if (isObj(v) && isObj(ref[k]) && !FREE_MAPS.includes(k)) out.push(...unknownKeys(v, ref[k], p + '.'));
  }
  return out;
}
function loadCfgOrFail(o) {
  try {
    return loadConfig(o.config || process.env.PASSERELLE_CONFIG || null);
  } catch (e) {
    return fail(e.message);
  }
}
