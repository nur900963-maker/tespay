// Identitas perangkat Shopee yang PERSISTEN.
//
// Kenapa ini ada:
// Sistem anti-fraud Shopee menilai sebuah "perangkat" dari kombinasi
// device_id + telemetri + szdet + UA. Kalau tiap request OTP memakai device_id
// baru (atau telemetri kosong), perangkat itu selalu terlihat "baru tanpa
// riwayat" -> skor risiko tinggi -> captcha_required / OTP tidak dikirim.
//
// Jadi identitas harus:
//   1. STABIL antar request, antar restart, antar deploy  -> disimpan ke file
//   2. KONSISTEN isinya (UA, layar, timezone, dsb tidak berubah-ubah)
//   3. BISA DIGANTI dengan data asli dari browser yang sudah pernah login sukses
//      (device report + szdet + captcha_signature) lewat dashboard / env.
//
// Urutan prioritas nilai:
//   env (SHOPEE_DEVICE_ID / SHOPEE_DEVICE_REPORT / SHOPEE_SZDET / SHOPEE_CAPTCHA_SIGNATURE)
//   > file data/identity.json (hasil capture dari dashboard)
//   > nilai turunan yang dibuat sekali lalu disimpan
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ON_VERCEL = process.env.VERCEL === '1';
const FILE = process.env.IDENTITY_PATH
  || (ON_VERCEL ? '/tmp/vincent-identity.json' : path.join(__dirname, '..', 'data', 'identity.json'));

const FIELDS = ['deviceId', 'deviceReport', 'szdet', 'captchaSignature', 'ua', 'sdkVersion', 'source', 'note'];

let cache = null;

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeFile(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.error('[identity] gagal menyimpan', FILE, e.message);
    return false;
  }
}

// device id turunan: stabil, tidak acak, dan tidak mengandung data pribadi.
function deriveDeviceId() {
  const seed = [process.env.SHOPEE_DEVICE_SEED || '', process.env.HOSTNAME || '', 'vincent-pay'].join('|');
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  // bentuk menyerupai id perangkat browser (32 hex)
  return h.slice(0, 32);
}

function load() {
  if (cache) return cache;
  const file = readFile();
  const env = process.env;
  const out = {};
  for (const k of FIELDS) {
    const envKey = 'SHOPEE_' + k.replace(/[A-Z]/g, c => '_' + c).toUpperCase();
    const v = env[envKey];
    if (v !== undefined && String(v).trim() !== '') out[k] = String(v).trim();
    else if (file[k] !== undefined && String(file[k]).trim() !== '') out[k] = String(file[k]).trim();
  }
  if (!out.deviceId) out.deviceId = deriveDeviceId();
  if (!out.ua) out.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  if (!out.sdkVersion) out.sdkVersion = '1.12.26-user.1';
  if (!out.source) out.source = file.deviceId ? 'file' : 'derived';
  cache = out;
  // simpan sekali supaya device id tidak berubah saat proses restart
  if (!file.deviceId) writeFile({ ...file, ...out, createdAt: file.createdAt || Date.now(), updatedAt: Date.now() });
  return cache;
}

// Simpan data capture dari browser (device report / szdet / captcha signature).
function update(patch = {}) {
  const cur = load();
  const next = { ...cur };
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
  const file = readFile();
  writeFile({ ...file, ...next, createdAt: file.createdAt || Date.now() });
  return next;
}

function reset() {
  cache = null;
  try { fs.unlinkSync(FILE); } catch { /* sudah tidak ada */ }
  return load();
}

// Ringkasan aman untuk dikirim ke browser: tidak membocorkan blob penuh.
function snapshot() {
  const d = load();
  const has = k => !!(d[k] && String(d[k]).trim());
  return {
    deviceId: d.deviceId,
    deviceIdShort: String(d.deviceId).slice(0, 8) + '…',
    ua: d.ua,
    sdkVersion: d.sdkVersion,
    source: d.source,
    hasDeviceReport: has('deviceReport'),
    deviceReportBytes: has('deviceReport') ? String(d.deviceReport).length : 0,
    hasSzdet: has('szdet'),
    hasCaptchaSignature: has('captchaSignature'),
    updatedAt: d.updatedAt || null,
    file: FILE,
    persistent: !ON_VERCEL || !!process.env.IDENTITY_PATH,
  };
}

module.exports = { load, update, reset, snapshot, FILE, FIELDS };
