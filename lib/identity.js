// Identitas perangkat Shopee yang PERSISTEN.
//
// Kenapa ini ada:
// Sistem anti-fraud Shopee menilai sebuah "perangkat" dari kombinasi
// device_id + telemetri + szdet + UA. Kalau tiap request OTP memakai device_id
// baru (atau telemetri kosong), perangkat itu selalu terlihat "baru tanpa
// riwayat" -> skor risiko tinggi -> captcha_required / OTP tidak dikirim.
//
// Jadi identitas harus:
//   1. STABIL antar request, antar restart, antar deploy  -> disimpan ke kv
//   2. KONSISTEN isinya (UA, layar, timezone, dsb tidak berubah-ubah)
//   3. BISA DIGANTI dengan data asli dari browser yang sudah pernah login sukses
//      (device report + szdet + captcha_signature) lewat dashboard / env.
//
// v4: penyimpanan lewat lib/kv.js (Redis di Vercel, file di VPS), bukan /tmp.
//     `load()` tetap sinkron (cache di memori) supaya lib/device.js tidak perlu
//     diubah jadi async; `init()` dipanggil sekali saat boot untuk mengisi cache.
//
// Urutan prioritas nilai:
//   env (SHOPEE_DEVICE_ID / SHOPEE_DEVICE_REPORT / SHOPEE_SZDET / SHOPEE_CAPTCHA_SIGNATURE)
//   > kv (hasil capture dari dashboard)
//   > nilai turunan yang dibuat sekali lalu disimpan
const crypto = require('crypto');
const kv = require('./kv');

const KEY = 'identity:v1';
const FIELDS = ['deviceId', 'deviceReport', 'szdet', 'captchaSignature', 'ua', 'sdkVersion', 'source', 'note'];

let cache = null;
let ready = null;

// device id turunan: stabil, tidak acak, dan tidak mengandung data pribadi.
function deriveDeviceId() {
  const seed = [process.env.SHOPEE_DEVICE_SEED || '', process.env.HOSTNAME || '', 'vincent-pay'].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

function fromEnv() {
  const out = {};
  for (const k of FIELDS) {
    const envKey = 'SHOPEE_' + k.replace(/[A-Z]/g, c => '_' + c).toUpperCase();
    const v = process.env[envKey];
    if (v !== undefined && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

function withDefaults(obj) {
  const out = { ...obj };
  if (!out.deviceId) out.deviceId = deriveDeviceId();
  if (!out.ua) out.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  if (!out.sdkVersion) out.sdkVersion = '1.12.26-user.1';
  if (!out.source) out.source = 'derived';
  return out;
}

// Muat dari kv sekali. Aman dipanggil berkali-kali.
function init() {
  if (ready) return ready;
  ready = (async () => {
    let stored = {};
    try {
      const raw = await kv.get(KEY);
      if (raw) stored = JSON.parse(raw) || {};
    } catch (e) { console.error('[identity] gagal membaca kv:', e.message); }
    const merged = withDefaults({ ...stored, ...fromEnv() });
    if (fromEnv().deviceId) merged.source = 'env';
    cache = merged;
    // simpan sekali supaya device id tidak berubah saat instance baru dibuat
    if (!stored.deviceId) {
      try { await kv.set(KEY, JSON.stringify({ ...merged, createdAt: Date.now(), updatedAt: Date.now() })); } catch { /* offline */ }
    }
    return cache;
  })();
  return ready;
}

// Sinkron: dipakai lib/device.js. Kalau init() belum selesai, pakai env/turunan
// (nilainya sama, karena device id turunan deterministik).
function load() {
  if (cache) return cache;
  cache = withDefaults(fromEnv());
  return cache;
}

// Simpan data capture dari browser (device report / szdet / captcha signature).
async function update(patch = {}) {
  await init();
  const next = { ...load() };
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] === null ? '' : patch[k]).trim();
    if (v === '') delete next[k];
    else next[k] = v;
  }
  if (patch.deviceId) next.deviceId = String(patch.deviceId).trim();
  if (!next.deviceId) next.deviceId = deriveDeviceId();
  next.source = patch.source || 'capture';
  next.updatedAt = Date.now();
  cache = next;
  await kv.set(KEY, JSON.stringify(next));
  return next;
}

async function reset() {
  cache = null;
  ready = null;
  await kv.del(KEY);
  return init();
}

// Ringkasan aman untuk dikirim ke browser: tidak membocorkan blob penuh.
function snapshot() {
  const d = load();
  const has = k => !!(d[k] && String(d[k]).trim());
  return {
    deviceId: d.deviceId,
    deviceIdShort: String(d.deviceId).slice(0, 8) + '\u2026',
    ua: d.ua,
    sdkVersion: d.sdkVersion,
    source: d.source,
    hasDeviceReport: has('deviceReport'),
    deviceReportBytes: has('deviceReport') ? String(d.deviceReport).length : 0,
    hasSzdet: has('szdet'),
    hasCaptchaSignature: has('captchaSignature'),
    updatedAt: d.updatedAt || null,
    backend: kv.backend,
    persistent: kv.persistent,
  };
}

module.exports = { init, load, update, reset, snapshot, FIELDS, KEY };
