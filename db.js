'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let sqlite = null;
let pool = null;
let mode = 'sqlite';
let initPromise = null;

function genId(prefix = 'VP') {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
function genApiKey() { return `vp_live_${crypto.randomBytes(32).toString('hex')}`; }
function genReferral(username = 'VIN') {
  return `${String(username).replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'VIN'}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function now() { return new Date().toISOString(); }

function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, pending_balance INTEGER NOT NULL DEFAULT 0,
 api_key TEXT UNIQUE, webhook_url TEXT, webhook_enabled INTEGER NOT NULL DEFAULT 0, webhook_secret TEXT,
 referral_code TEXT UNIQUE, referred_by TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL, FOREIGN KEY(referred_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'Default', key TEXT NOT NULL UNIQUE,
 last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS transactions (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, type TEXT NOT NULL,
 amount INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, status TEXT NOT NULL,
 channel TEXT, account_number TEXT, account_name TEXT, qris_image TEXT, payment_link TEXT, expired_at TEXT,
 created_at TEXT NOT NULL, completed_at TEXT, balance_after INTEGER, meta TEXT, provider_ref TEXT,
 idempotency_key TEXT, updated_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS webhook_logs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT, event TEXT NOT NULL, url TEXT NOT NULL,
 payload TEXT NOT NULL, status_code INTEGER, attempt INTEGER NOT NULL DEFAULT 1, response TEXT,
 state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS password_resets (
 token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS app_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS provider_configs (
 provider TEXT PRIMARY KEY, config_enc TEXT NOT NULL, configured INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0, last_test_at TEXT, last_test_status TEXT, last_test_message TEXT,
 updated_at TEXT NOT NULL, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL, direction TEXT NOT NULL,
 amount INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, balance_before INTEGER NOT NULL, balance_after INTEGER NOT NULL,
 source TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, UNIQUE(transaction_id, direction, source),
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
 id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
 details TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trx_user_time ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trx_status_time ON transactions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trx_provider_ref ON transactions(provider_ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trx_user_idempotency ON transactions(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wh_user_time ON webhook_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(user_id, created_at DESC);
`;

const pgSchema = `
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0, pending_balance BIGINT NOT NULL DEFAULT 0,
 api_key TEXT UNIQUE, webhook_url TEXT, webhook_enabled INTEGER NOT NULL DEFAULT 0, webhook_secret TEXT,
 referral_code TEXT UNIQUE, referred_by TEXT REFERENCES users(id), role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT 'Default', key TEXT NOT NULL UNIQUE,
 last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
 amount BIGINT NOT NULL, fee BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL, status TEXT NOT NULL,
 channel TEXT, account_number TEXT, account_name TEXT, qris_image TEXT, payment_link TEXT, expired_at TEXT,
 created_at TEXT NOT NULL, completed_at TEXT, balance_after BIGINT, meta TEXT, provider_ref TEXT,
 idempotency_key TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_logs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, transaction_id TEXT, event TEXT NOT NULL, url TEXT NOT NULL,
 payload TEXT NOT NULL, status_code INTEGER, attempt INTEGER NOT NULL DEFAULT 1, response TEXT,
 state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
 token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS provider_configs (
 provider TEXT PRIMARY KEY, config_enc TEXT NOT NULL, configured INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
 last_test_at TEXT, last_test_status TEXT, last_test_message TEXT, updated_at TEXT NOT NULL, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, direction TEXT NOT NULL,
 amount BIGINT NOT NULL, fee BIGINT NOT NULL DEFAULT 0, balance_before BIGINT NOT NULL, balance_after BIGINT NOT NULL,
 source TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, UNIQUE(transaction_id, direction, source)
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
 id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trx_user_time ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trx_status_time ON transactions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trx_provider_ref ON transactions(provider_ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trx_user_idempotency ON transactions(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wh_user_time ON webhook_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(user_id, created_at DESC);
`;

async function initDb() {
  if (initPromise) return initPromise;
  initPromise = Promise.resolve().then(async () => {
    if (process.env.DATABASE_URL) {
      mode = 'postgres';
      const { Pool, types } = require('pg');
      types.setTypeParser(20, (v) => Number(v));
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 2 : 10)),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined)
      });
      await pool.query(pgSchema);
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_secret TEXT');
    } else {
      mode = 'sqlite';
      const Database = require('better-sqlite3');
      const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      sqlite = new Database(path.join(dataDir, 'vincent-pay.db'));
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(sqliteSchema);
      try { sqlite.exec('ALTER TABLE users ADD COLUMN webhook_secret TEXT'); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    await seedAdmin();
    await seedSettings();
    console.log(`[Vincent Pay] database ready (${mode})`);
  }).catch((err) => { initPromise = null; throw err; });
  return initPromise;
}

async function query(sql, params = [], client = null) {
  if (!initPromise) await initDb();
  if (mode === 'postgres') {
    const executor = client || pool;
    const result = await executor.query(pgSql(sql), params);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  const stmt = sqlite.prepare(sql);
  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: stmt.all(...params), rowCount: 0 };
  const result = stmt.run(...params);
  return { rows: [], rowCount: result.changes, lastInsertRowid: result.lastInsertRowid };
}
async function one(sql, params = [], client = null) {
  const result = await query(sql, params, client);
  return result.rows[0] || null;
}
async function all(sql, params = [], client = null) {
  const result = await query(sql, params, client);
  return result.rows;
}
async function run(sql, params = [], client = null) { return query(sql, params, client); }

async function transaction(fn) {
  if (!initPromise) await initDb();
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query: (s, p = []) => query(s, p, client),
        one: (s, p = []) => one(s, p, client),
        all: (s, p = []) => all(s, p, client),
        run: (s, p = []) => run(s, p, client)
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  const tx = {
    query: (s, p = []) => query(s, p), one: (s, p = []) => one(s, p),
    all: (s, p = []) => all(s, p), run: (s, p = []) => run(s, p)
  };
  try { const result = await fn(tx); sqlite.exec('COMMIT'); return result; }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || /example\.com$/i.test(email) || password.length < 12 || /change.?me|replace|example|placeholder|your.?secret/i.test(password)) {
    console.warn('[Vincent Pay] ADMIN_EMAIL/ADMIN_PASSWORD belum diset. Admin awal tidak dibuat; set kredensial kuat sebelum produksi.');
    return;
  }
  const existing = await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return;
  const username = String(process.env.ADMIN_USERNAME || 'vincentadmin').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 15) || 'vincentadmin';
  const id = genId('USR');
  const created = now();
  const apiKey = genApiKey();
  await run(`INSERT INTO users (id,username,email,password_hash,balance,pending_balance,api_key,role,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, username, email, bcrypt.hashSync(password, 12), 0, 0, apiKey, 'admin', 'active', created]);
  await run('INSERT INTO api_keys (id,user_id,label,key,created_at) VALUES (?,?,?,?,?)', [genId('KEY'), id, 'Default', apiKey, created]);
  console.log('[Vincent Pay] admin pertama dibuat dari environment variables.');
}

const DEFAULT_SETTINGS = {
  brand_name: 'Vincent Pay', currency: 'IDR', qris_fee: 250, qris_fee_percent: 0,
  deposit_min: 1000, deposit_max: 10000000, withdrawal_fee_dana: 250, withdrawal_fee_gopay: 250,
  withdrawal_fee_shopeepay: 250, withdrawal_fee_manual: 250, withdrawal_min: 10000,
  withdrawal_max: 5000000, invoice_expiry_minutes: 30, default_provider: 'dana',
  public_api_enabled: 1, withdrawals_enabled: 1
};
async function seedSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING', [key, JSON.stringify(value), now()]);
  }
}
async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
async function getSettings() {
  const rows = await all('SELECT key,value FROM app_settings');
  const output = { ...DEFAULT_SETTINGS };
  for (const row of rows) { try { output[row.key] = JSON.parse(row.value); } catch { output[row.key] = row.value; } }
  return output;
}
async function setSetting(key, value, updatedBy = null) {
  await run(`INSERT INTO app_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  [key, JSON.stringify(value), now(), updatedBy]);
}
async function seedAdminAudit(adminId, action, targetType = null, targetId = null, details = {}) {
  await run('INSERT INTO admin_audit_logs (id,admin_id,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?,?)',
    [genId('AUD'), adminId, action, targetType, targetId, JSON.stringify(details), now()]);
}

module.exports = {
  initDb, query, one, all, run, transaction, getSetting, getSettings, setSetting,
  seedAdminAudit, genId, genApiKey, genReferral, now, get mode() { return mode; }
};
