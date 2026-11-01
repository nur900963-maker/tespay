// Bungkus data sementara (challenge OTP) jadi string terenkripsi + kedaluwarsa,
// supaya tidak perlu disimpan di server dan tidak bisa dibaca/diubah browser.
//
// PERBAIKAN REVIEW: dulu kuncinya `SESSION_SECRET || ADMIN_PASSWORD || 'vincent-pay'`.
// Konstanta 'vincent-pay' itu publik (ada di repo), jadi siapa pun bisa memalsukan
// blob challenge. Sekarang TIDAK ADA fallback konstanta:
//   - kunci dari SESSION_SECRET / ADMIN_PASSWORD, atau
//   - kunci acak yang dibuat sekali dan disimpan di lib/kv.js (Redis di Vercel,
//     file di VPS) dengan izin 600.
//
// v4: kunci disimpan di kv, bukan /tmp, supaya challenge yang dibuat di satu
// instance Vercel tetap bisa dibuka instance lain (retry captcha & verify).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const kv = require('./kv');

const KEY = 'seal:secret:v1';
const ON_VERCEL = process.env.VERCEL === '1';
const SECRET_FILE = process.env.SECRET_PATH || (ON_VERCEL ? '' : path.join(__dirname, '..', 'data', 'secret.key'));

let cached = null;
let ready = null;

function envSecret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
  return String(s).trim().length >= 8 ? String(s).trim() : '';
}

function fileSecret() {
  if (!SECRET_FILE) return '';
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* belum ada */ }
  const s = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch (e) { console.error('[seal] gagal menyimpan secret', SECRET_FILE, e.message); }
  return s;
}

// Muat / buat kunci sekali saat boot. Aman dipanggil berkali-kali.
function init() {
  if (ready) return ready;
  ready = (async () => {
    const fromEnv = envSecret();
    if (fromEnv) { cached = fromEnv; return cached; }
    let s = '';
    try { s = (await kv.get(KEY)) || ''; } catch (e) { console.error('[seal] gagal membaca kv:', e.message); }
    if (!s || s.length < 32) {
      s = crypto.randomBytes(48).toString('base64url');
      try { await kv.set(KEY, s); } catch (e) { console.error('[seal] gagal menyimpan kunci:', e.message); }
    }
    cached = s;
    return cached;
  })();
  return ready;
}

function secret() {
  if (cached) return cached;
  const fromEnv = envSecret();
  if (fromEnv) { cached = fromEnv; return cached; }
  cached = fileSecret() || crypto.randomBytes(48).toString('base64url');
  return cached;
}

const key = () => crypto.createHash('sha256').update('seal:v2:' + secret()).digest();

exports.init = init;
exports.secretSource = () => (process.env.SESSION_SECRET ? 'SESSION_SECRET'
  : process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'kv:' + kv.backend);

exports.seal = (obj, ttlMs = 10 * 60 * 1000) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ exp: Date.now() + ttlMs, d: obj }), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
};

exports.unseal = str => {
  try {
    const b = Buffer.from(String(str), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const out = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
    return out.exp > Date.now() ? out.d : null;
  } catch { return null; }
};
