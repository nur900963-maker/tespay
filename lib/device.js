// Identitas perangkat untuk Shopee (anti-fraud / device risk).
//
// MASALAH LAMA: setiap request OTP membuat "perangkat" baru (device id acak,
// body telemetri kosong `{}`, header `szdet` tidak dikirim). Bagi sistem risk
// Shopee itu = perangkat tanpa riwayat + telemetri kosong -> skor risiko tinggi
// -> captcha_required / OTP tidak pernah dikirim.
//
// Perbaikan: satu device id yang STABIL selama proses hidup (atau dari env),
// UA yang sama untuk semua host Shopee, dan body telemetri yang selalu terisi.
const crypto = require('crypto');

// Satu UA untuk semua panggilan Shopee. Dulu shopeeAuth memakai Firefox 153 dan
// lib/shopee.js memakai Chrome 126 -> dua "perangkat" berbeda dalam satu sesi.
const UA = process.env.SHOPEE_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Stabil per proses. Isi SHOPEE_DEVICE_ID kalau mau stabil antar-restart/deploy
// (disarankan: ambil dari browser yang sudah pernah login sukses).
const DEVICE_ID = process.env.SHOPEE_DEVICE_ID || crypto.randomUUID();

const SZ_SDK = process.env.SHOPEE_SZ_SDK || '1.12.26-user.1';

// Body untuk POST /v2/shpsec/web/report.
// Kalau SHOPEE_DEVICE_REPORT diisi (blob asli dari DevTools browser), blob itu
// yang dipakai apa adanya — itu yang paling akurat. Kalau tidak, kita kirim
// struktur minimal yang konsisten, bukan `{}`.
function buildDeviceReport(deviceId = DEVICE_ID, extra = {}) {
  const ts = Date.now();
  return JSON.stringify({
    sdk_version: SZ_SDK,
    platform: 'web',
    device_id: deviceId,
    deviceId,
    ts,
    timestamp: ts,
    events: [{ type: 'page_view', ts, path: '/login' }],
    ...extra,
  });
}

module.exports = { UA, DEVICE_ID, SZ_SDK, buildDeviceReport };
