// Penjaga alur OTP: rate limit berlapis + anti-replay challenge.
//
// Review sebelumnya menemukan:
//   - tidak ada rate limit  -> 12 send_otp berturut-turut dari 1 IP lolos (WhatsApp bombing)
//   - challenge OTP bisa dipakai 3x -> OTP yang sama bisa diverifikasi berulang
//
// v4: hitungan disimpan di lib/kv.js (Redis di Vercel), jadi rate limit TIDAK
//     lagi per-instance. Di Vercel lama, tiap instance punya hitungan sendiri
//     sehingga batasnya bisa dikali jumlah instance.
//
//   RATE LIMIT:
//     - per nomor : cooldown 60 detik, maks 3 / 15 menit, maks 5 / jam
//     - per IP    : maks 10 / 15 menit
//     - global    : maks 30 / jam  (melindungi akun Shopee dari pemblokiran)
//     - verify    : maks 5 percobaan per challenge, maks 10 / 15 menit per nomor
//   ANTI-REPLAY:
//     - setiap challenge punya jti unik; sekali dipakai langsung di-claim
//     - verification (pilih merchant) juga sekali pakai
const crypto = require('crypto');
const kv = require('./kv');

const WINDOW = { short: 15 * 60 * 1000, long: 60 * 60 * 1000 };
const digits = p => String(p || '').replace(/\D+/g, '');

// Satu lapisan: naikkan counter, tolak kalau sudah lewat batas.
async function layer(key, max, windowMs, label) {
  const ttlSec = Math.ceil(windowMs / 1000);
  const n = await kv.incr('rl:' + key, ttlSec);
  if (n > max) {
    const wait = (await kv.ttl('rl:' + key)) || Math.ceil(windowMs / 1000);
    return { ok: false, wait, used: n, max, label };
  }
  return { ok: true, used: n, max, label };
}

function deny(r, hint) {
  return {
    ok: false, code: 'RATE_LIMITED', retryAfter: r.wait,
    error: `Terlalu banyak permintaan OTP (${r.label}). Coba lagi dalam ${r.wait} detik.`,
    hint: hint || 'Mengirim berulang membuat Shopee memblokir nomor ini. Tunggu, lalu coba sekali lagi.',
  };
}

// Cek semua lapisan. Mengembalikan { ok:true } atau { ok:false, code, error, hint, retryAfter }.
async function checkSendOtp({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'cd:hp:' + hp, max: 1, win: 60 * 1000, label: 'cooldown 60 detik per nomor' },
    { key: 'hp15:' + hp, max: 3, win: WINDOW.short, label: 'maks 3 OTP / 15 menit per nomor' },
    { key: 'hp60:' + hp, max: 5, win: WINDOW.long, label: 'maks 5 OTP / jam per nomor' },
    { key: 'ip15:' + ip, max: 10, win: WINDOW.short, label: 'maks 10 OTP / 15 menit per IP' },
    { key: 'global60', max: 30, win: WINDOW.long, label: 'maks 30 OTP / jam (global)' },
  ];
  for (const l of layers) {
    const r = await layer(l.key, l.max, l.win, l.label);
    if (!r.ok) return deny(r);
  }
  return { ok: true };
}

// Retry setelah captcha tidak kena cooldown 60 detik (itu bagian dari alur yang sama),
// tapi tetap dihitung ke kuota 15 menit / jam supaya tidak bisa dipakai untuk spam.
async function checkRetry({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'hp15:' + hp, max: 3, win: WINDOW.short, label: 'maks 3 OTP / 15 menit per nomor' },
    { key: 'hp60:' + hp, max: 5, win: WINDOW.long, label: 'maks 5 OTP / jam per nomor' },
    { key: 'ip15:' + ip, max: 10, win: WINDOW.short, label: 'maks 10 OTP / 15 menit per IP' },
    { key: 'global60', max: 30, win: WINDOW.long, label: 'maks 30 OTP / jam (global)' },
  ];
  for (const l of layers) {
    const r = await layer(l.key, l.max, l.win, l.label);
    if (!r.ok) return deny(r, 'Tunggu sebelum kirim ulang.');
  }
  return { ok: true };
}

async function checkVerify({ phone, ip }) {
  const hp = digits(phone);
  const layers = [
    { key: 'vhp15:' + hp, max: 10, win: WINDOW.short, label: 'maks 10 percobaan verifikasi / 15 menit' },
    { key: 'vip15:' + ip, max: 20, win: WINDOW.short, label: 'maks 20 percobaan verifikasi / 15 menit per IP' },
  ];
  for (const l of layers) {
    const r = await layer(l.key, l.max, l.win, l.label);
    if (!r.ok) return deny(r, 'Kalau kode terus salah, kirim OTP baru setelah cooldown.');
  }
  return { ok: true };
}

// ---------- anti-replay ----------
function newJti() { return crypto.randomUUID(); }

async function consume(jti, kind = 'ch') {
  if (!jti) return false;
  return kv.claim(`otp:${kind}:${jti}`, 3600);
}

// Percobaan OTP salah per challenge: maks 5, supaya tidak bisa brute-force 6 digit.
async function verifyAttempt(jti) {
  if (!jti) return { ok: true, left: 5 };
  const n = await kv.incr('va:' + jti, 600);
  if (n > 5) {
    const wait = (await kv.ttl('va:' + jti)) || 600;
    return { ok: false, left: 0, wait };
  }
  return { ok: true, left: 5 - n };
}

// Dipakai tes: bersihkan hitungan di backend yang sedang aktif.
async function resetAll() {
  if (kv.useRedis) return;   // jangan hapus data produksi dari tes
  await kv.clearPrefix('rl:').catch(() => {});
  await kv.clearPrefix('va:').catch(() => {});
}

module.exports = { checkSendOtp, checkRetry, checkVerify, newJti, consume, verifyAttempt, resetAll };
