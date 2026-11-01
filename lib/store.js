// Database aplikasi (token, QRIS, struk yang sudah dipakai).
//
// v4: tidak lagi menulis langsung ke /tmp. Semua lewat lib/kv.js, jadi:
//   - VPS / lokal  -> data/kv.json (permanen)
//   - Vercel       -> Upstash Redis kalau env-nya diisi (state bertahan antar instance)
//                     kalau tidak, memory per instance (aplikasi tetap jalan)
const kv = require('./kv');

module.exports = {
  get backend() { return kv.backend; },
  get persistent() { return kv.persistent; },
  get file() { return kv.file; },

  async get(key) {
    const raw = await kv.get('db:' + key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  async set(key, value) {
    await kv.set('db:' + key, JSON.stringify(value));
  },
  async del(key) {
    await kv.del('db:' + key);
  },
  // true kalau key baru berhasil di-claim. Dipakai supaya satu struk tidak dipakai dua pembeli.
  async claim(key, ttlSec = 86400) {
    return kv.claim('claim:' + key, ttlSec);
  },
};
