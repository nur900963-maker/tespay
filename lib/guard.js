// Penjaga alur OTP: rate limit berlapis + anti-replay challenge.
//
// Review sebelumnya menemukan:
//   - tidak ada rate limit  -> 12 send_otp berturut-turut dari 1 IP lolos (WhatsApp bombing)
//   - challenge OTP bisa dipakai 3x -> OTP yang sama bisa diverifikasi berulang
//
// Sekarang:
//   RATE LIMIT (per proses, cukup untuk 1 instance; di Vercel tiap instance punya
//   hitungan sendiri — lihat catatan di README):
//     - per nomor : cooldown 60 detik, maks 3 / 15 menit, maks 5 / jam
//     - per IP    : maks 10 / 15 menit
//     - global    : maks 30 / jam  (melindungi akun Shopee dari pemblokiran)
//     - verify    : maks 5 percobaan per challenge, maks 10 / 15 menit per nomor
//   ANTI-REPLAY:
//     - setiap challenge punya jti unik; sekali dipakai (verify sukses) langsung
//       di-claim dan tidak bisa dipakai lagi
//     - verification (pilih merchant) juga sekali pakai
const crypto = require('crypto');
const store = require('./store');

const WINDOW = { short: 15 * 60 * 1000, long: 60 * 60 * 1000 };

const hits = new Map();   // key -> { n, reset }

function bump(key, max, windowMs) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  const cur = hits.get(key);
  if (cur && cur.reset > now) {
    if (cur.n >= max) return { ok: false, wait: Math.ceil((cur.reset - now) / 1000), used: cur.n, max };
    cur.n++;
    return { ok: true, used: cur.n, max, wait: 0 };
  }
  hits.set(key, { n: 1, reset: now + windowMs });
  return { ok: true, used: 1, max, wait: 0 };
}

function peek(key) {
  const cur = hits.get(key);
  if (!cur || cur.reset <= Date.now()) return 0;
  return Math.ceil((cur.reset - Date.now()) / 1000);
}

const digits = p => String(p || '').replace(/\D+/g, '');

// Cek semua lapisan. Mengembalikan { ok:true } atau { ok:false, code, error, hint, retryAfter }.
function checkSendOtp({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'cd:hp:' + hp, max: 1, win: 60 * 1000, label: 'cooldown 60 detik per nomor' },
    { key: 'hp15:' + hp, max: 3, win: WINDOW.short, label: 'maks 3 OTP / 15 menit per nomor' },
    { key: 'hp60:' + hp, max: 5, win: WINDOW.long, label: 'maks 5 OTP / jam per nomor' },
    { key: 'ip15:' + ip, max: 10, win: WINDOW.short, label: 'maks 10 OTP / 15 menit per IP' },
    { key: 'global60', max: 30, win: WINDOW.long, label: 'maks 30 OTP / jam (global)' },
  ];
  for (const l of layers) {
    const r = bump(l.key, l.max, l.win);
    if (!r.ok) {
      return {
        ok: false, code: 'RATE_LIMITED', retryAfter: r.wait,
        error: `Terlalu banyak permintaan OTP (${l.label}). Coba lagi dalam ${r.wait} detik.`,
        hint: 'Mengirim berulang membuat Shopee memblokir nomor ini. Tunggu, lalu coba sekali lagi.',
      };
    }
  }
  return { ok: true };
}

// Retry setelah captcha tidak kena cooldown 60 detik (itu bagian dari alur yang sama),
// tapi tetap dihitung ke kuota 15 menit / jam supaya tidak bisa dipakai untuk spam.
function checkRetry({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'hp15:' + hp, max: 3, win: WINDOW.short, label: 'maks 3 OTP / 15 menit per nomor' },
    { key: 'hp60:' + hp, max: 5, win: WINDOW.long, label: 'maks 5 OTP / jam per nomor' },
    { key: 'ip15:' + ip, max: 10, win: WINDOW.short, label: 'maks 10 OTP / 15 menit per IP' },
    { key: 'global60', max: 30, win: WINDOW.long, label: 'maks 30 OTP / jam (global)' },
  ];
  for (const l of layers) {
    const r = bump(l.key, l.max, l.win);
    if (!r.ok) {
      return { ok: false, code: 'RATE_LIMITED', retryAfter: r.wait,
        error: `Terlalu banyak permintaan OTP (${l.label}). Coba lagi dalam ${r.wait} detik.`,
        hint: 'Tunggu sebelum kirim ulang.' };
    }
  }
  return { ok: true };
}

function checkVerify({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'vhp15:' + hp, max: 10, win: WINDOW.short, label: 'maks 10 percobaan verifikasi / 15 menit' },
    { key: 'vip15:' + ip, max: 20, win: WINDOW.short, label: 'maks 20 percobaan verifikasi / 15 menit per IP' },
  ];
  for (const l of layers) {
    const r = bump(l.key, l.max, l.win);
    if (!r.ok) return { ok: false, code: 'RATE_LIMITED', retryAfter: r.wait,
      error: `Terlalu banyak percobaan verifikasi (${l.label}). Coba lagi dalam ${r.wait} detik.`,
      hint: 'Kalau kode terus salah, kirim OTP baru setelah cooldown.' };
  }
  return { ok: true };
}

// ---------- anti-replay ----------
// Setiap challenge diberi jti. Sekali dipakai -> claim permanen (TTL 1 jam).
function newJti() { return crypto.randomUUID(); }

async function consume(jti, kind = 'ch') {
  if (!jti) return false;
  return store.claim(`otp:${kind}:${jti}`, 3600);
}

// Percobaan OTP salah per challenge: maks 5, supaya tidak bisa brute-force 6 digit.
const attempts = new Map();
function verifyAttempt(jti) {
  if (!jti) return { ok: true, left: 5 };
  const now = Date.now();
  const cur = attempts.get(jti);
  if (cur && cur.reset > now) {
    if (cur.n >= 5) return { ok: false, left: 0, wait: Math.ceil((cur.reset - now) / 1000) };
    cur.n++;
    return { ok: true, left: 5 - cur.n };
  }
  attempts.set(jti, { n: 1, reset: now + 10 * 60 * 1000 });
  if (attempts.size > 2000) for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k);
  return { ok: true, left: 4 };
}

function resetAll() { hits.clear(); attempts.clear(); }

module.exports = { checkSendOtp, checkRetry, checkVerify, newJti, consume, verifyAttempt, resetAll, peek };
