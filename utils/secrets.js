'use strict';
const crypto = require('crypto');
const db = require('../db');
const PROVIDERS = {
  dana: {
    label: 'DANA Merchant QRIS', fields: ['mode','api_base_url','partner_id','merchant_id','store_id','terminal_id','channel_id','origin','private_key_pem','dana_public_key_pem'],
    secretFields: ['private_key_pem','dana_public_key_pem']
  },
  shopeepay: {
    label: 'ShopeePay Merchant QRIS', fields: ['mode','api_base_url','client_id','client_secret','merchant_id','store_id','terminal_id','channel_id','origin','private_key_pem','shopeepay_public_key_pem'],
    secretFields: ['client_secret','private_key_pem','shopeepay_public_key_pem']
  },
  gopay: {
    label: 'GoPay / GoBiz Merchant QRIS', fields: ['mode','api_base_url','oauth_base_url','client_id','client_secret','scope','outlet_id','origin'],
    secretFields: ['client_secret']
  }
};

function encryptionKey() {
  const value = process.env.MASTER_ENCRYPTION_KEY || '';
  if (value.length < 32 || /change.?me|replace|example|placeholder|your.?secret/i.test(value)) {
    throw new Error('MASTER_ENCRYPTION_KEY belum diset. Isi minimal 32 karakter acak di environment server.');
  }
  return crypto.createHash('sha256').update(value).digest();
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}
function decrypt(value) {
  if (!value) return '';
  const [version, iv64, tag64, data64] = String(value).split('.');
  if (version !== 'v1' || !iv64 || !tag64 || !data64) throw new Error('Format secret terenkripsi tidak valid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}
async function getProviderConfig(provider) {
  const id = String(provider || '').toLowerCase();
  if (!PROVIDERS[id]) throw new Error('Provider tidak dikenal.');
  const row = await db.one('SELECT * FROM provider_configs WHERE provider = ?', [id]);
  if (!row) return { provider: id, enabled: false, mode: 'sandbox' };
  try {
    return { provider: id, enabled: !!row.enabled, ...(JSON.parse(decrypt(row.config_enc)) || {}) };
  } catch (error) {
    throw new Error(`Gagal membaca konfigurasi ${id}: ${error.message}`);
  }
}
async function saveProviderConfig(provider, input, updatedBy) {
  const id = String(provider || '').toLowerCase();
  const spec = PROVIDERS[id];
  if (!spec) throw new Error('Provider tidak dikenal.');
  const previous = await getProviderConfig(id).catch(() => ({ provider: id }));
  const clean = { ...previous };
  for (const field of spec.fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (spec.secretFields.includes(field) && (value === '' || value === null || value === undefined)) continue;
      clean[field] = typeof value === 'string' ? value.trim() : value;
    }
  }
  clean.provider = id;
  clean.enabled = input.enabled === true || input.enabled === 1 || input.enabled === 'true';
  const required = { dana: ['api_base_url','partner_id','merchant_id','store_id','channel_id','private_key_pem'], shopeepay: ['api_base_url','client_id','client_secret','merchant_id','store_id','private_key_pem'], gopay: ['api_base_url','oauth_base_url','client_id','client_secret','scope','outlet_id'] }[id];
  const missing = required.filter((k) => !clean[k]);
  const configured = missing.length === 0;
  const stored = encrypt(JSON.stringify(clean));
  await db.run(`INSERT INTO provider_configs (provider,config_enc,configured,enabled,updated_at,updated_by)
    VALUES (?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET config_enc=excluded.config_enc,
    configured=excluded.configured, enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  [id, stored, configured ? 1 : 0, clean.enabled ? 1 : 0, db.now(), updatedBy || null]);
  return getProviderSummary(id);
}
async function getProviderSummary(provider) {
  const id = String(provider || '').toLowerCase();
  const row = await db.one('SELECT * FROM provider_configs WHERE provider = ?', [id]);
  if (!row) return { provider: id, label: PROVIDERS[id]?.label, enabled: false, configured: false, secret_fields: [] };
  let config = {};
  try { config = JSON.parse(decrypt(row.config_enc)); } catch (_) {}
  const spec = PROVIDERS[id];
  return {
    provider: id, label: spec.label, enabled: !!row.enabled, configured: !!row.configured,
    mode: config.mode || 'sandbox', base_url: config.api_base_url || '',
    last_test_at: row.last_test_at, last_test_status: row.last_test_status, last_test_message: row.last_test_message,
    fields: Object.fromEntries(spec.fields.map((k) => [k, spec.secretFields.includes(k) ? Boolean(config[k]) : (k === 'mode' ? (config[k] || 'sandbox') : (config[k] || ''))]))
  };
}
async function listProviderSummaries() {
  return Promise.all(Object.keys(PROVIDERS).map(getProviderSummary));
}
async function updateProviderTest(provider, status, message) {
  const label = status === true ? 'success' : status === false ? 'failed' : String(status || 'unverified');
  await db.run('UPDATE provider_configs SET last_test_at=?, last_test_status=?, last_test_message=? WHERE provider=?',
    [db.now(), label, String(message || '').slice(0, 250), provider]);
}
module.exports = { PROVIDERS, encrypt, decrypt, getProviderConfig, saveProviderConfig, getProviderSummary, listProviderSummaries, updateProviderTest };
