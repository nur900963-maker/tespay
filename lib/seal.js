// Bungkus data sementara (challenge OTP) jadi string terenkripsi + kedaluwarsa,
// supaya tidak perlu disimpan di server dan tidak bisa dibaca/diubah browser.
const crypto = require('crypto');
const key = () => crypto.createHash('sha256').update('seal:' + (process.env.SESSION_SECRET || '')).digest();

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
