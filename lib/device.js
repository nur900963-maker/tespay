// Telemetri perangkat untuk Shopee (anti-fraud / device risk).
//
// MASALAH LAMA (yang bikin OTP ditolak):
//   1. device_id acak tiap proses  -> perangkat selalu "baru"
//   2. body telemetri `{}`         -> perangkat tanpa jejak
//   3. header `szdet` = timestamp  -> bukan tanda tangan SDK, langsung dicurigai
//   4. UA berbeda antar modul      -> dua "perangkat" dalam satu sesi
//
// SEKARANG:
//   - device id & UA diambil dari lib/identity.js (persisten, satu untuk semua host)
//   - body telemetri selalu terisi dan bentuknya KONSISTEN (field sama, urutan sama)
//   - szdet dibentuk sebagai payload bertanda tangan (HMAC) yang stabil per device,
//     bukan angka waktu mentah
//   - kalau kamu punya blob asli dari browser (SHOPEE_DEVICE_REPORT / capture
//     dashboard), blob itu yang dipakai apa adanya — itu yang paling akurat.
const crypto = require('crypto');
const identity = require('./identity');

const id = () => identity.load();

// UA satu untuk semua panggilan Shopee (login OTP + daftar transaksi).
const UA = () => id().ua;
const DEVICE_ID = () => id().deviceId;
const SZ_SDK = () => id().sdkVersion;

// Profil perangkat yang stabil. Nilai-nilai ini tidak berubah antar request,
// karena perangkat yang "berubah-ubah" justru menaikkan skor risiko.
const PROFILE = {
  platform: 'web',
  os: 'Windows',
  os_version: '10',
  browser: 'Chrome',
  browser_version: '126.0.0.0',
  screen: '1920x1080',
  viewport: '1920x937',
  dpr: 1,
  color_depth: 24,
  timezone: 'Asia/Jakarta',
  timezone_offset: -420,
  language: 'id-ID',
  languages: 'id-ID,id,en-US,en',
  hardware_concurrency: 8,
  device_memory: 8,
  touch_points: 0,
  webgl_vendor: 'Google Inc. (Intel)',
  webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
};

// szdet: di browser nilainya berasal dari SDK anti-fraud (payload + tanda tangan).
// Kita bentuk payload yang sama bentuknya dan tanda tangani dengan kunci turunan
// device id, supaya nilainya STABIL per perangkat (bukan timestamp yang berubah
// tiap request — itu justru pola mencurigakan).
function buildSzdet(deviceId = DEVICE_ID()) {
  const payload = { v: 1, did: deviceId, ts: Date.now(), p: 'web', sdk: SZ_SDK() };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', 'szdet:' + deviceId).update(raw).digest('hex').slice(0, 32);
  return Buffer.from(JSON.stringify({ ...payload, sig }), 'utf8').toString('base64');
}

// Body untuk POST /v2/shpsec/web/report.
// Kalau ada blob asli dari browser, pakai apa adanya.
function buildDeviceReport(deviceId = DEVICE_ID(), extra = {}) {
  const captured = id().deviceReport;
  if (captured) return captured;
  const ts = Date.now();
  return JSON.stringify({
    sdk_version: SZ_SDK(),
    platform: PROFILE.platform,
    device_id: deviceId,
    deviceId,
    ts,
    timestamp: ts,
    ...PROFILE,
    events: [
      { type: 'page_view', ts: ts - 4200, path: '/login', referrer: '' },
      { type: 'focus', ts: ts - 3100, path: '/login' },
      { type: 'input', ts: ts - 1800, path: '/login', field: 'phone' },
      { type: 'click', ts: ts - 600, path: '/login', target: 'submit' },
    ],
    ...extra,
  });
}

// Nilai szdet yang dipakai request: capture browser > turunan stabil.
function szdet() {
  return id().szdet || buildSzdet();
}

// captcha_signature: capture browser > env > kosong.
function captchaSignature() {
  return id().captchaSignature || '';
}

module.exports = {
  UA, DEVICE_ID, SZ_SDK, buildDeviceReport, buildSzdet, szdet, captchaSignature, PROFILE,
};
