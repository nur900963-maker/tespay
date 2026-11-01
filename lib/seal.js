// Bungkus data sementara (challenge OTP) jadi string terenkripsi + kedaluwarsa,
// supaya tidak perlu disimpan di server dan tidak bisa dibaca/diubah browser.
//
// PERBAIKAN REVIEW: dulu kuncinya `SESSION_SECRET || ADMIN_PASSWORD || 'vincent-pay'`.
// Konstanta 'vincent-pay' itu publik (ada di repo), jadi siapa pun bisa memalsukan
// blob challenge. Sekarang:
//   - kunci WAJIB dari SESSION_SECRET / ADMIN_PASSWORD / file secret yang dibuat
//     otomatis dan disimpan dengan izin 600
//   - TIDAK ADA fallback konstanta
//   - kunci diturunkan dengan salt tetap supaya blob lama tetap bisa dibuka
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ON_VERCEL = process.env.VERCEL === '1';
const SECRET_FILE = process.env.SECRET_PATH
  || (ON_VERCEL ? '/tmp/vincent-secret' : path.join(__dirname, '..', 'data', 'secret.key'));

let cached = null;

function fileSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* belum ada */ }
  const s = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch (e) {
    console.error('[seal] gagal menyimpan secret', SECRET_FILE, e.message);
  }
  return s;
}

function secret() {
  if (cached) return cached;
  const fromEnv = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
  if (fromEnv && String(fromEnv).trim().length >= 8) cached = String(fromEnv).trim();
  else cached = fileSecret();
  return cached;
}

const key = () => crypto.createHash('sha256').update('seal:v2:' + secret()).digest();

exports.secretSource = () => (process.env.SESSION_SECRET ? 'SESSION_SECRET'
  : process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'file:' + SECRET_FILE);

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
