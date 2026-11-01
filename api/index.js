// Entry point Vercel (serverless function).
//
// Vercel memanggil file ini untuk SEMUA route (lihat rewrites di vercel.json).
// Express app-nya sama persis dengan yang dipakai `npm start`, jadi tidak ada
// dua jalur kode yang bisa berbeda perilaku.
//
// Catatan penting:
//   - `views/` ikut di-bundle lewat `includeFiles` di vercel.json. Tanpa itu,
//     EJS gagal render dan `/` balas 500.
//   - `config.js` di-require secara literal oleh lib/loadConfig.js, jadi ikut
//     terdeteksi Vercel.
//   - State (device_id, rate limit, audit, kunci seal) disimpan lewat lib/kv.js:
//     Upstash Redis kalau env-nya diisi, kalau tidak memori instance.
const app = require('../app');

module.exports = async (req, res) => {
  // Pastikan init (kunci seal + identitas perangkat) selesai sebelum request
  // pertama dilayani. Di cold start ini yang membuat device_id stabil.
  if (app._boot) await app._boot;
  return app(req, res);
};
