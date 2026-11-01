// Baca config.js di root project dan jadikan nilainya "env". Dipanggil paling awal di app.js.
// Nilai di config.js MENANG atas env Vercel; kalau dikosongkan, env biasa tetap dipakai.
module.exports = function loadConfig(file = process.env.VP_CONFIG_FILE) {
  let cfg = {};
  try {
    // require literal supaya Vercel ikut membawa config.js ke deployment (path dinamis tidak ikut terdeteksi)
    cfg = file ? require(file) : require('../config.js');
  } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  for (const [k, v] of Object.entries(cfg || {})) {
    if (v === undefined || v === null) continue;
    const val = String(v).trim();
    if (val !== '') process.env[k] = val;
  }
  return cfg;
};
