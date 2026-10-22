'use strict';
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { getProviderConfig, getProviderSummary, updateProviderTest } = require('./secrets');

const PROVIDER_NAMES = { dana: 'DANA Merchant', shopeepay: 'ShopeePay Merchant', gopay: 'GoPay / GoBiz Merchant' };
function requireFields(config, fields) {
  const missing = fields.filter((field) => !config[field]);
  if (missing.length) throw new Error(`Lengkapi pengaturan ${missing.join(', ')} di panel admin terlebih dahulu.`);
}
function isoJakarta(date = new Date()) {
  // API timestamps are Jakarta local time in RFC3339 format, without milliseconds.
  return new Date(date.getTime() + 7 * 3600000).toISOString().replace(/\.\d{3}Z$/, '+07:00');
}
function asAmount(amount) { return `${Number(amount).toFixed(2)}`; }
function sha256hex(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function signRsa(text, privateKey) { return crypto.sign('RSA-SHA256', Buffer.from(text), privateKey).toString('base64'); }
function safeUrl(base, path) {
  const u = new URL(path, base);
  if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('Provider API wajib menggunakan HTTPS.');
  return u;
}
async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.PROVIDER_TIMEOUT_MS || 12000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 400) }; }
    if (!response.ok) {
      const message = data.message || data.responseMessage || data.error_description || data.error || `Provider membalas HTTP ${response.status}`;
      const error = new Error(`${message}`);
      error.status = response.status;
      error.providerResponse = sanitizeResponse(data);
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Provider timeout. Status transaksi harus dicek ulang sebelum mencoba membuat ulang invoice.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function sanitizeResponse(data) {
  if (!data || typeof data !== 'object') return {};
  const out = { ...data };
  for (const key of Object.keys(out)) if (/token|secret|signature|private|authorization/i.test(key)) out[key] = '[redacted]';
  return out;
}
async function gobizToken(c) {
  requireFields(c, ['client_id', 'client_secret', 'scope', 'oauth_base_url']);
  const url = safeUrl(c.oauth_base_url, '/oauth2/token');
  const auth = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: c.scope }).toString();
  const data = await requestJson(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!data.access_token) throw new Error('Token OAuth GoBiz tidak ditemukan dalam respons.');
  return data.access_token;
}
function shopeeTimestamp() { return isoJakarta().replace(/\.\d{3}/, ''); }
async function shopeeToken(c) {
  requireFields(c, ['api_base_url', 'client_id', 'private_key_pem']);
  const timestamp = shopeeTimestamp();
  const signature = signRsa(`${c.client_id}|${timestamp}`, c.private_key_pem);
  const body = JSON.stringify({ grantType: 'client_credentials' });
  const data = await requestJson(safeUrl(c.api_base_url, '/v1.0/access-token/b2b'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TIMESTAMP': timestamp, 'X-CLIENT-KEY': c.client_id, 'X-SIGNATURE': signature }, body
  });
  if (data.responseCode && !String(data.responseCode).startsWith('200')) throw new Error(`ShopeePay token: ${data.responseMessage || data.responseCode}`);
  if (!data.accessToken) throw new Error(data.responseMessage || 'Token ShopeePay tidak ditemukan. Periksa base URL dan credential merchant.');
  return data.accessToken;
}
function shopeeRequestSignature(method, path, token, body, timestamp, clientSecret) {
  const stringToSign = `${method.toUpperCase()}:${path}:${token}:${sha256hex(body)}:${timestamp}`;
  return crypto.createHmac('sha512', clientSecret).update(stringToSign).digest('base64');
}
async function shopeeRequest(c, path, bodyObj, method = 'POST') {
  requireFields(c, ['api_base_url', 'client_id', 'client_secret', 'merchant_id', 'store_id']);
  const token = await shopeeToken(c);
  const timestamp = shopeeTimestamp();
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const signature = shopeeRequestSignature(method, path, token, body, timestamp, c.client_secret);
  const extId = crypto.randomBytes(16).toString('hex').slice(0, 32);
  const headers = {
    'Content-Type': 'application/json', 'X-TIMESTAMP': timestamp, Authorization: `Bearer ${token}`,
    'X-SIGNATURE': signature, 'X-PARTNER-ID': c.client_id, 'X-EXTERNAL-ID': extId,
    'CHANNEL-ID': String(c.channel_id || 'WEB').slice(0, 5)
  };
  if (c.origin) headers.ORIGIN = c.origin;
  const data = await requestJson(safeUrl(c.api_base_url, path), { method, headers, ...(method === 'GET' ? {} : { body }) });
  if (data.responseCode && !String(data.responseCode).startsWith('200')) throw new Error(`ShopeePay: ${data.responseMessage || data.responseCode}`);
  return data;
}
function danaSign(method, path, body, timestamp, privateKey) {
  const hash = sha256hex(body);
  return signRsa(`${method.toUpperCase()}:${path}:${hash}:${timestamp}`, privateKey);
}
async function danaRequest(c, path, bodyObj) {
  requireFields(c, ['api_base_url', 'partner_id', 'merchant_id', 'store_id', 'private_key_pem', 'channel_id']);
  const timestamp = isoJakarta();
  const body = JSON.stringify(bodyObj);
  const signature = danaSign('POST', path, body, timestamp, c.private_key_pem);
  const headers = {
    'Content-Type': 'application/json', Accept: 'application/json', 'X-TIMESTAMP': timestamp,
    'X-SIGNATURE': signature, 'X-PARTNER-ID': c.partner_id,
    'X-EXTERNAL-ID': String(Date.now()) + crypto.randomBytes(5).toString('hex'),
    'CHANNEL-ID': String(c.channel_id).slice(0, 5)
  };
  if (c.origin) headers.ORIGIN = c.origin;
  const data = await requestJson(safeUrl(c.api_base_url, path), { method: 'POST', headers, body });
  if (data.responseCode && !String(data.responseCode).startsWith('200')) {
    throw new Error(`DANA: ${data.responseMessage || data.responseCode}`);
  }
  return data;
}

async function createProviderPayment(provider, reference, total, opts = {}) {
  const id = String(provider || '').toLowerCase();
  const c = await getProviderConfig(id);
  if (!c.enabled) throw new Error(`${PROVIDER_NAMES[id] || id} belum diaktifkan oleh admin.`);
  let data;
  if (id === 'gopay') {
    requireFields(c, ['api_base_url', 'outlet_id']);
    const token = await gobizToken(c);
    const payload = {
      payment_type: 'qris',
      transaction_details: { order_id: reference, gross_amount: Number(total), currency: 'IDR' }
    };
    data = await requestJson(safeUrl(c.api_base_url, `/integrations/payment/outlets/${encodeURIComponent(c.outlet_id)}/v2/transactions`), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': reference.slice(0, 32) }, body: JSON.stringify(payload)
    });
    const trx = data.data?.transaction || data.transaction || data.data || data;
    const qrisData = trx.qris_string || trx.qrisString || data.qris_string;
    if (!qrisData) throw new Error('GoBiz menerima request tetapi tidak mengembalikan qris_string. Periksa izin payment/outlet di akun merchant.');
    return { provider: id, provider_ref: trx.id || trx.transaction_id || reference, qr_data: qrisData, qr_image: await QRCode.toDataURL(qrisData, { width: 420, margin: 1 }), raw: sanitizeResponse(data) };
  }
  if (id === 'shopeepay') {
    const path = '/v1.0/qr/qr-mpm-generate';
    const validUntil = isoJakarta(new Date(Date.now() + (Number(c.validity_minutes || 30) * 60000)));
    const payload = {
      partnerReferenceNo: reference.slice(0, 64),
      amount: { value: asAmount(total), currency: 'IDR' },
      feeAmount: { value: '0.00', currency: 'IDR' },
      merchantId: c.merchant_id,
      ...(c.terminal_id ? { terminalId: c.terminal_id } : {}),
      validityPeriod: validUntil,
      additionalInfo: { externalStoreId: c.store_id, convenienceFeeIndicator: '01', promoIds: '' }
    };
    data = await shopeeRequest(c, path, payload, 'POST');
    const qrisData = data.qrContent || data.qrString || data.qrCode || data.qrData || data.qr_code || data.data?.qrContent || data.data?.qrString;
    const image64 = data.qrImage || data.data?.qrImage;
    if (!qrisData && !image64 && !(data.qrUrl || data.qrURL)) throw new Error(data.responseMessage || 'ShopeePay belum mengembalikan data QR. Cek kredensial dan kontrak MPM.');
    const qrImage = image64 ? (String(image64).startsWith('data:') ? image64 : `data:image/png;base64,${image64}`) : qrisData ? await QRCode.toDataURL(qrisData, { width: 420, margin: 1 }) : null;
    return { provider: id, provider_ref: data.referenceNo || data.originalReferenceNo || reference, qr_data: qrisData || null, qr_image: qrImage || data.qrUrl || data.qrURL || data.data?.qrUrl || null, raw: sanitizeResponse(data) };
  }
  if (id === 'dana') {
    const path = '/v1.0/qr/qr-mpm-generate.htm';
    const payload = {
      merchantId: c.merchant_id,
      partnerReferenceNo: reference.slice(0, 25),
      amount: { value: asAmount(total), currency: 'IDR' },
      storeId: c.store_id,
      ...(c.terminal_id ? { terminalId: c.terminal_id } : {}),
      validityPeriod: isoJakarta(new Date(Date.now() + (Number(c.validity_minutes || 30) * 60000))),
      additionalInfo: { terminalSource: 'MER', envInfo: { sourcePlatform: 'IPG', terminalType: 'WEB', orderTerminalType: 'WEB' } }
    };
    data = await danaRequest(c, path, payload);
    const qrisData = data.qrContent || data.data?.qrContent;
    const image64 = data.qrImage || data.data?.qrImage;
    if (!qrisData && !image64 && !(data.qrUrl || data.data?.qrUrl)) throw new Error('DANA tidak mengembalikan QRIS. Pastikan produk QRIS Acquirer MPM telah diaktifkan untuk credential ini.');
    const qrImage = image64 ? (String(image64).startsWith('data:') ? image64 : `data:image/png;base64,${image64}`) : qrisData ? await QRCode.toDataURL(qrisData, { width: 420, margin: 1 }) : null;
    return { provider: id, provider_ref: data.referenceNo || reference, qr_data: qrisData || null, qr_image: qrImage || data.qrUrl || data.qrURL || data.data?.qrUrl || null, raw: sanitizeResponse(data) };
  }
  throw new Error('Provider tidak didukung.');
}

async function queryProviderPayment(trx) {
  const id = String(trx.channel || '').toLowerCase();
  const c = await getProviderConfig(id);
  if (!c.enabled || !trx.provider_ref) return { status: 'pending', verified: false };
  try {
    let data;
    if (id === 'gopay') {
      const token = await gobizToken(c);
      const url = safeUrl(c.api_base_url, `/integrations/payment/outlets/${encodeURIComponent(c.outlet_id)}/v1/transactions/${encodeURIComponent(trx.provider_ref)}`);
      data = await requestJson(url, { headers: { Authorization: `Bearer ${token}` } });
      const t = data.data?.transaction || data.transaction || data.data || data;
      if (Number(t.gross_amount ?? t.transaction_details?.gross_amount ?? trx.total) !== Number(trx.total)) return { status: 'amount_mismatch', verified: false };
      const s = String(t.status || '').toLowerCase();
      if (['paid','success','successful','settlement','settled','completed'].includes(s)) return { status: 'paid', verified: true, raw: sanitizeResponse(data) };
      if (['expire','expired','cancel','cancelled','failed','deny'].includes(s)) return { status: 'failed', verified: true, raw: sanitizeResponse(data) };
      return { status: 'pending', verified: true, raw: sanitizeResponse(data) };
    }
    if (id === 'shopeepay') {
      const path = '/v1.0/qr/qr-mpm-query';
      const payload = {
        originalPartnerReferenceNo: trx.reference,
        originalReferenceNo: trx.provider_ref,
        merchantId: c.merchant_id,
        externalStoreId: c.store_id,
        amount: { value: asAmount(trx.total), currency: 'IDR' }
      };
      data = await shopeeRequest(c, path, payload, 'POST');
      const amountVal = Number(String(data.amount?.value || data.data?.amount?.value || trx.total).replace(/,/g, ''));
      if (Number.isFinite(amountVal) && amountVal !== Number(trx.total)) return { status: 'amount_mismatch', verified: false };
      const s = String(data.latestTransactionStatus || data.transactionStatus || data.data?.latestTransactionStatus || '').toLowerCase();
      if (['00','success','paid','settlement','settled'].includes(s)) return { status: 'paid', verified: true, raw: sanitizeResponse(data) };
      if (['01','02','failed','expired','cancelled'].includes(s)) return { status: 'failed', verified: true, raw: sanitizeResponse(data) };
      return { status: 'pending', verified: true, raw: sanitizeResponse(data) };
    }
    if (id === 'dana') {
      const path = '/v1.0/qr/qr-mpm-query.htm';
      const payload = {
        originalPartnerReferenceNo: trx.reference,
        originalReferenceNo: trx.provider_ref,
        serviceCode: '47',
        amount: { value: asAmount(trx.total), currency: 'IDR' },
        merchantId: c.merchant_id,
        externalStoreId: c.store_id,
        storeId: c.store_id,
        additionalInfo: {}
      };
      data = await danaRequest(c, path, payload);
      const amountVal = Number(String(data.amount?.value || data.data?.amount?.value || trx.total).replace(/,/g, ''));
      if (Number.isFinite(amountVal) && amountVal !== Number(trx.total)) return { status: 'amount_mismatch', verified: false };
      const s = String(data.latestTransactionStatus || data.transactionStatus || data.data?.latestTransactionStatus || '').toLowerCase();
      if (['00','success','paid','settlement','settled','completed'].includes(s)) return { status: 'paid', verified: true, raw: sanitizeResponse(data) };
      if (['01','02','failed','expired','cancelled','cancel'].includes(s)) return { status: 'failed', verified: true, raw: sanitizeResponse(data) };
      // responseCode acknowledges the query request; it is not proof that the customer paid.
      return { status: 'pending', verified: true, raw: sanitizeResponse(data) };
    }
  } catch (error) {
    return { status: 'pending', verified: false, error: error.message };
  }
  return { status: 'pending', verified: false };
}

async function testProvider(provider) {
  const id = String(provider).toLowerCase();
  const c = await getProviderConfig(id);
  try {
    if (!c.enabled) throw new Error('Provider belum diaktifkan. Simpan konfigurasi dengan status Aktif terlebih dahulu.');
    if (id === 'gopay') {
      await gobizToken(c);
      await updateProviderTest(id, true, 'Token OAuth GoBiz berhasil diterbitkan.');
      return { success: true, message: 'Autentikasi OAuth GoBiz berhasil. Lanjutkan dengan transaksi sandbox untuk menguji QRIS dan status.' };
    }
    if (id === 'shopeepay') {
      await shopeeToken(c);
      await updateProviderTest(id, true, 'Token ShopeePay berhasil diterbitkan.');
      return { success: true, message: 'Token API ShopeePay berhasil diterbitkan. Lanjutkan dengan transaksi sandbox untuk menguji QRIS dan status.' };
    }
    if (id === 'dana') {
      requireFields(c, ['api_base_url','partner_id','merchant_id','store_id','channel_id','private_key_pem']);
      // This only tests local key parsing/signing; it is not remote credential validation.
      signRsa(`vincent-pay-credential-test|${isoJakarta()}`, c.private_key_pem);
      await updateProviderTest(id, 'unverified', 'Format key valid lokal; credential DANA belum diuji ke API tanpa membuat invoice.');
      return { success: false, message: 'Format private key valid untuk signing lokal, tetapi credential belum diverifikasi oleh API DANA. Gunakan invoice sandbox untuk pengujian end-to-end.' };
    }
    throw new Error('Provider tidak didukung.');
  } catch (error) {
    await updateProviderTest(id, false, error.message);
    return { success: false, message: error.message };
  }
}

module.exports = { createProviderPayment, queryProviderPayment, testProvider, PROVIDER_NAMES };
