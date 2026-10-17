// Database file JSON lokal. Tanpa layanan luar.
// - Di VPS / Pterodactyl / PC: tersimpan permanen di ./data/db.json (atau DB_PATH).
// - Di Vercel: filesystem cuma /tmp, jadi data bisa hilang waktu instance baru dibuat.
const fs = require('fs');
const path = require('path');

const ON_VERCEL = process.env.VERCEL === '1';
const FILE = process.env.DB_PATH || (ON_VERCEL ? '/tmp/vincent-pay.json' : path.join(__dirname, '..', 'data', 'db.json'));

let data = null;            // { kv: {}, claims: { key: expiredAtMs } }
let queue = Promise.resolve();

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
  data.kv = data.kv || {};
  data.claims = data.claims || {};
  return data;
}

function flush() {
  // tulis ke file sementara dulu lalu rename, biar file tidak setengah rusak kalau proses mati
  queue = queue.then(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }).catch(e => console.error('[store] gagal menulis', FILE, e.message));
  return queue;
}

module.exports = {
  file: FILE,
  persistent: !ON_VERCEL || !!process.env.DB_PATH,
  async get(key) {
    const v = load().kv[key];
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  },
  async set(key, value) {
    load().kv[key] = value;
    await flush();
  },
  async del(key) {
    delete load().kv[key];
    await flush();
  },
  // true kalau key baru berhasil di-claim. Dipakai supaya satu struk tidak dipakai dua pembeli.
  async claim(key, ttlSec = 86400) {
    const d = load(), now = Date.now();
    if (d.claims[key] && d.claims[key] > now) return false;
    for (const k of Object.keys(d.claims)) if (d.claims[k] <= now) delete d.claims[k];
    d.claims[key] = now + ttlSec * 1000;
    await flush();
    return true;
  },
};
