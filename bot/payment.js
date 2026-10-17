'use strict';

import axios from 'axios';
import QRCode from 'qrcode';
import moment from 'moment-timezone';
import * as config from '../config.js';
import { customEmojiHtml } from '../utils/emoji.js';

const TIMEZONE = 'Asia/Jakarta';

// ================= KONFIGURASI API (Vincent Pay x ShopeePay) =================
// Semua logic Shopee (token, login OTP, cek mutasi, anti dobel-klaim struk) ada di server Vercel.
// Bot cuma manggil API-nya, jadi tidak ada token Shopee di source bot.
// Isi di config.js (export const SHOPEE_API_URL / SHOPEE_BOT_API_KEY) atau lewat env.
const API_URL = String(config.SHOPEE_API_URL || process.env.SHOPEE_API_URL || 'https://vincent-pay.vercel.app').replace(/\/+$/, '');
const BOT_KEY = config.SHOPEE_BOT_API_KEY || process.env.SHOPEE_BOT_API_KEY || '';
// Ada key -> pakai route khusus bot (/api/bot/pay/*). Tanpa key -> route publik (/api/pay/*).
const ROOT = BOT_KEY ? `${API_URL}/api/bot` : `${API_URL}/api`;
const BASE = `${ROOT}/pay`;
const HEADERS = BOT_KEY ? { 'x-api-key': BOT_KEY } : {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================= CRC16-CCITT =================
function crc16Ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ================= MAKE QRIS (isi nominal ke payload QRIS statis) =================
// Disediakan biar import lama tetap jalan. createPayment() tidak memakainya:
// QRIS dinamis dibuat di server dari QRIS statis yang tersimpan di dashboard.
function makeQris(qrisString, amount) {
  let qris = qrisString.replace(/6304[A-F0-9]{4}$/, '');
  qris = qris.replace(/54\d{2}\d+/g, '');
  const nominal = String(Math.trunc(amount));
  const field54 = `54${String(nominal.length).padStart(2, '0')}${nominal}`;
  const pos = qris.indexOf('5802ID');
  if (pos !== -1) {
    qris = qris.slice(0, pos) + field54 + qris.slice(pos);
  } else {
    qris = qris + field54;
  }
  const payload = qris + '6304';
  return payload + crc16Ccitt(payload);
}

// ================= KODE UNIK =================
// Range default 10-200, sama seperti payment.js GoPay.
function generateUniqueCode(min = 10, max = 200) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ================= WIB TIME HELPER =================
function getWibHHMM(date = new Date()) {
  const wibMs = date.getTime() + 7 * 60 * 60 * 1000;
  const w = new Date(wibMs);
  return `${String(w.getUTCHours()).padStart(2, '0')}:${String(w.getUTCMinutes()).padStart(2, '0')}`;
}

// ================= FORMAT RUPIAH =================
function toRupiah(angka) {
  return `Rp ${Number(angka).toLocaleString('id-ID')}`;
}
function formatRupiah(n) { return toRupiah(n); }

function formatExpired(expiredAt) {
  return moment(expiredAt)
    .tz(TIMEZONE)
    .format('DD/MM/YYYY HH:mm') + ' WIB';
}

// ================= GENERATE GAMBAR QRIS (NATURAL / POLOS) =================
async function generateQrisImage(qrString, qrisData = {}, nominal = 0) {
  let photoToSend = null;

  if (qrString) {
    try {
      const qrBuffer = await QRCode.toBuffer(qrString, {
        margin: 2,
        width: 600,
        color: { dark: '#000000', light: '#ffffff' },
      });
      photoToSend = { source: qrBuffer };
    } catch (e) {
      console.log(`[QR GENERATE] ❌ Gagal membuat QR: ${e.message}`);
    }
  }

  // cadangan: gambar PNG dari server (data URL base64)
  if (!photoToSend && typeof qrisData.image === 'string' && qrisData.image.includes('base64,')) {
    photoToSend = { source: Buffer.from(qrisData.image.split('base64,')[1], 'base64') };
  }

  return photoToSend;
}

/**
 * @param {object} p
 * @param {string} p.paket       nama paket yang dibeli
 * @param {number} p.nominal     harga paket (belum + kode unik)
 * @param {number} p.kodeUnik    kode unik / fee admin (dari generateUniqueCode, 10-200)
 * @param {Date|number|string} p.expiredAt  waktu expired
 */
function buildInvoiceCaption({ paket, nominal, kodeUnik, expiredAt }) {
  const packageName = String(paket || '')
    .replace(/^[\s\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]+/gu, '')
    .trim();
  return (
`───── ${customEmojiHtml('catatan')} <b>Info Pembayaran</b> ${customEmojiHtml('catatan')} ─────
<blockquote>
<b>Paket</b>      : ${customEmojiHtml('diamond')} ${packageName}
<b>Harga</b>      : ${formatRupiah(nominal)}
<b>Fee Admin</b>  : ${kodeUnik}
<b>Expired</b>    : ${formatExpired(expiredAt)}
</blockquote>`
  );
}

// pesan error dari server (success:false) atau dari axios
function apiError(e) {
  const d = e.response && e.response.data;
  return (d && d.error) || e.message;
}

// ================= TOKEN MANAGER =================
// Token ShopeePay disimpan & diperpanjang di server (dashboard > Auto Refresh). Di bot cuma ada
// cache status, TIDAK PERNAH menyimpan token. Bentuk getStatus() sama dengan TokenManager GoPay.
class TokenManager {
  constructor() {
    this.cache = null;               // status terakhir dari server
    this.loadedAt = 0;
    this.lastRefreshSuccessAt = null;
    this.lastRefreshError = null;
    this.refreshFailCount = 0;
    this.loopRunning = false;
  }

  // Ada demi kompatibilitas. Token Shopee diisi lewat login OTP / dashboard, bukan config bot.
  setInitialTokens() {}

  // Ambil status terbaru dari server (token tidak ikut dikirim)
  async syncStatus() {
    try {
      const r = await axios.get(`${ROOT}/token/status`, { headers: HEADERS, timeout: 8000 });
      if (r.data && r.data.success) {
        this.cache = r.data.shopee;
        this.loadedAt = Date.now();
        return true;
      }
      return false;
    } catch (e) {
      this.lastRefreshError = apiError(e);
      return false;
    }
  }

  // Paksa refresh sekarang. true kalau berhasil.
  async refreshAccessToken() {
    try {
      const r = await axios.post(`${ROOT}/refresh`, { provider: 'shopee' }, { headers: HEADERS, timeout: 30000 });
      if (r.data && r.data.status) { this.cache = r.data.status; this.loadedAt = Date.now(); }
      this.lastRefreshSuccessAt = Date.now();
      this.lastRefreshError = null;
      this.refreshFailCount = 0;
      return true;
    } catch (e) {
      const d = e.response && e.response.data;
      if (d && d.status) { this.cache = d.status; this.loadedAt = Date.now(); }
      this.refreshFailCount++;
      this.lastRefreshError = apiError(e);
      console.log(`[TOKEN] ❌ Error refreshing token: ${this.lastRefreshError}`);
      return false;
    }
  }

  // Minta server refresh kalau sudah jatuh tempo menurut jadwal di dashboard
  async tick() {
    try {
      const r = await axios.post(`${ROOT}/auto/tick`, {}, { headers: HEADERS, timeout: 30000 });
      if (r.data && r.data.shopee) { this.cache = r.data.shopee; this.loadedAt = Date.now(); }
      const res = r.data && r.data.result && r.data.result.shopee;
      if (res === 'ok') {
        this.lastRefreshSuccessAt = Date.now();
        this.refreshFailCount = 0;
        console.log('[TOKEN] ✅ Token ShopeePay diperpanjang oleh server');
      } else if (res && res.startsWith('gagal')) {
        this.refreshFailCount++;
        this.lastRefreshError = res;
        console.log(`[TOKEN] ❌ ${res}`);
      }
      return res || null;
    } catch (e) {
      this.lastRefreshError = apiError(e);
      return null;
    }
  }

  // Status ringkas buat OWNER MENU. TIDAK PERNAH mengembalikan token, cuma metadata.
  getStatus() {
    const now = Date.now();
    const c = this.cache || {};
    const accessMsLeft = c.expiresAt ? (c.expiresAt - now) : null;
    const fails = (c.failCount != null) ? c.failCount : this.refreshFailCount;
    return {
      hasAccessToken: !!c.hasToken,
      accessExpired: c.hasToken ? (accessMsLeft == null ? null : accessMsLeft <= 0) : null,
      accessMsLeft,
      hasRefreshToken: !!c.canRefresh,   // di Shopee: ada sesi login OTP yang bisa dipakai memperpanjang
      refreshTokenSetAt: c.lastRefreshAt || null,
      refreshAgeMs: c.lastRefreshAt ? (now - c.lastRefreshAt) : null,
      lastRefreshSuccessAt: this.lastRefreshSuccessAt || c.lastRefreshAt || null,
      refreshLikelyExpired: !!c.likelyExpired || fails >= 3,
      refreshFailCount: fails,
      lastRefreshError: this.lastRefreshError || c.lastError || null,
      // tambahan khusus Shopee
      merchant: c.merchant || null,
      autoEnabled: c.auto ? !!c.auto.enabled : null,
      autoMinutes: c.auto ? c.auto.minutes : null,
      nextRefreshAt: c.nextRefreshAt || null,
    };
  }

  // Dipanggil sebelum cek mutasi: sinkron status kalau sudah basi, refresh kalau token mau habis
  async ensureValidToken() {
    if (!this.cache || Date.now() - this.loadedAt > 5 * 60 * 1000) await this.syncStatus();
    const c = this.cache;
    if (!c || !c.canRefresh || !c.expiresAt) return;
    if (Date.now() + 60 * 1000 >= c.expiresAt) {
      console.log('[TOKEN] ⚠️ Token expired/mau expired! Refreshing...');
      let ok = await this.refreshAccessToken();
      if (!ok) { await sleep(2000); ok = await this.refreshAccessToken(); }
      console.log(ok ? '[TOKEN] ✅ Token direfresh' : '[TOKEN] ❌ Gagal refresh token!');
    }
  }
}

const tokenManager = new TokenManager();

// ================= CREATE PAYMENT =================
/**
 * @param {number} amount   nominal yang diminta user (belum + kode unik)
 * @param {string|number} userId
 * @param {number} expiredMinutes  lama QRIS berlaku (default 15 menit)
 * @param {string} paket    nama paket yang dibeli (tampil di caption)
 */
async function createPayment(amount, userId, expiredMinutes = 15, paket = 'Top Up Saldo') {
  if (!(Number(amount) >= 1)) return { status: false, error: 'Nominal tidak valid' };
  try {
    const kodeUnik = generateUniqueCode();
    const totalBayar = Number(amount) + kodeUnik;

    // server yang bikin QRIS dinamis dari QRIS statis yang tersimpan di sana
    const resp = await axios.post(`${BASE}/create`, { provider: 'shopee', amount: totalBayar }, { headers: HEADERS, timeout: 15000 });
    const data = resp.data;
    if (!(data && data.success)) {
      return { status: false, error: 'API error: ' + JSON.stringify(data).slice(0, 150) };
    }

    const photo = await generateQrisImage(data.qr_string, data, totalBayar);
    if (!photo) {
      return { status: false, error: 'QR generation failed' };
    }

    const createdAt = new Date(data.created_at);
    const expiredAt = new Date(createdAt.getTime() + expiredMinutes * 60 * 1000);
    const qrisJamWib = getWibHHMM(createdAt);

    const caption = buildInvoiceCaption({
      paket, nominal: amount, kodeUnik, expiredAt,
    });

    return {
      status: true,
      photo,
      caption,
      paket,
      qr_string: data.qr_string || null,
      nominal: amount,
      kode_unik: kodeUnik,
      total_bayar: totalBayar,
      qris_jam_wib: qrisJamWib,
      created_at: createdAt.toISOString(),
      expired_at: expiredAt.toISOString(),
    };
  } catch (e) {
    console.log(`[CREATE PAYMENT] ❌ Error: ${apiError(e)}`);
    return { status: false, error: apiError(e) };
  }
}

// ================= CEK MUTASI — SEKALI CEK (non-blocking, buat poller/tombol) =================
/**
 * @param {number} nominal      WAJIB total_bayar (nominal + kode unik)
 * @param {string} qrisJamWib   "HH:MM" (dari createPayment().qris_jam_wib)
 * @param {number} createdAtMs  epoch ms saat QRIS dibuat (Date.parse(createPayment().created_at)).
 *                              Kalau kosong, ditebak dari qrisJamWib (hari ini / kemarin).
 */
async function checkStatusOnce(nominal, qrisJamWib, createdAtMs = null) {
  await tokenManager.ensureValidToken();
  if (createdAtMs == null) {
    const [h, m] = String(qrisJamWib || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return { status: false, error: 'createdAtMs / qrisJamWib wajib diisi' };
    const wib = new Date(Date.now() + 7 * 3600 * 1000);
    createdAtMs = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), h, m) - 7 * 3600 * 1000;
    if (createdAtMs > Date.now()) createdAtMs -= 24 * 3600 * 1000;
  }

  try {
    const resp = await axios.post(`${BASE}/check`, {
      provider: 'shopee',
      amount: nominal,
      created_at: new Date(createdAtMs).toISOString(),
    }, { headers: HEADERS, timeout: 10000 });
    const data = resp.data;
    if (!(data && data.success)) return { status: false, error: 'API error: ' + JSON.stringify(data).slice(0, 150) };

    if (data.status === 'PAID') {
      const tx = data.data || {};
      return { status: true, transaction: tx, kredit: String(tx.amount || nominal), vincent_tx_id: tx.id };
    }
    if (data.status === 'EXPIRED') return { status: false, error: 'QRIS kedaluwarsa', expired: true };
    return { status: false, error: 'Belum ditemukan' };
  } catch (e) {
    const status429 = e.response?.status === 429;
    return { status: false, error: apiError(e), is429: status429 };
  }
}

// ================= CEK MUTASI OTOMATIS (loop, dipakai kalau butuh nunggu sinkron) =================
async function checkMutasiOtomatis(userId, nominal, qrisJamWib, maxAttempts = 60, createdAtMs = null) {
  let attempt = 0;
  console.log(`[MUTASI] 🔍 Mulai cek mutasi - User: ${userId} | Nominal: Rp ${nominal.toLocaleString('id-ID')} | Jam QRIS: ${qrisJamWib}`);
  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await checkStatusOnce(nominal, qrisJamWib, createdAtMs);
    if (result.status) {
      console.log(`[MUTASI] ✅ MATCH! TX ID: ${result.vincent_tx_id}`);
      return { ...result, user_id: userId };
    }
    if (result.expired) return { ...result, user_id: userId };
    if (attempt < maxAttempts) await sleep(5000);
  }
  console.log(`[MUTASI] ⏱️ Timeout - Pembayaran tidak ditemukan setelah ${maxAttempts} attempt`);
  return { status: false, error: 'Pembayaran tidak ditemukan' };
}

// ================= AUTO CONFIRM PAYMENT =================
async function autoConfirmPayment(userId, nominal, chatId, qrisJamWib, qrisMessageId = null, createdAtMs = null) {
  return checkMutasiOtomatis(userId, nominal, qrisJamWib, 60, createdAtMs);
}

// ================= LOOP REFRESH TOKEN =================
// Dipanggil sekali waktu bot start. Tiap interval, server diminta refresh kalau sudah jatuh tempo
// (jadwalnya diatur di dashboard > Auto Refresh). Berhenti dengan tokenManager.loopRunning = false.
async function startTokenRefreshLoop(intervalMs = 300 * 1000) {
  if (tokenManager.loopRunning) return;
  tokenManager.loopRunning = true;
  while (tokenManager.loopRunning) {
    try {
      await sleep(intervalMs);
      if (!tokenManager.loopRunning) break;
      await tokenManager.tick();
    } catch (e) {
      console.log(`[TOKEN LOOP] Error: ${e.message}`);
    }
  }
}

// ================= STATUS SERVER (buat owner menu) =================
// Cuma ngecek server hidup atau tidak. Token Shopee dikelola di web admin, bukan di bot.
async function getServerStatus() {
  try {
    const r = await axios.get(`${API_URL}/api/health`, { timeout: 8000 });
    return { online: !!(r.data && r.data.success), persistent: r.data?.persistent ?? null, url: API_URL };
  } catch (e) {
    return { online: false, error: e.message, url: API_URL };
  }
}

export {
  tokenManager,
  crc16Ccitt,
  makeQris,
  generateUniqueCode,
  generateQrisImage,
  buildInvoiceCaption,
  createPayment,
  checkStatusOnce,
  checkMutasiOtomatis,
  autoConfirmPayment,
  startTokenRefreshLoop,
  getServerStatus,
  getWibHHMM,
  toRupiah,
};
