// Audit trail append-only untuk alur OTP Shopee.
//
// Kenapa: review sebelumnya menemukan "audit trail non-existent" — kalau OTP tidak
// sampai, tidak ada bukti apa yang sebenarnya terjadi. Sekarang setiap langkah
// penting dicatat: siapa (IP), nomor (disamarkan), langkah, hasil, kode error,
// dan berapa lama.
//
// Aturan:
//   - APPEND ONLY: tidak ada update/delete.
//   - REDAKSI: password, OTP, token, cookie, risk token, captcha signature TIDAK
//     pernah ditulis. Hanya penanda "ada / tidak ada" + panjangnya.
//   - v4: disimpan di lib/kv.js (Redis di Vercel -> bertahan antar instance,
//     file di VPS). Dulu /tmp, jadi hilang tiap instance baru.
const crypto = require('crypto');
const kv = require('./kv');

const KEY = 'audit:otp:v1';
const MAX = Number(process.env.AUDIT_MAX_EVENTS || 500);

// Kunci yang isinya rahasia -> jangan pernah ditulis apa adanya.
const SECRET_KEYS = /^(password|pass|otp|code|token|access_token|refresh_token|otp_token|challenge|verification|session|cookie|cookies|risk|riskToken|security_device_fingerprint|captcha_signature|szdet|deviceReport|device_report|secret|apikey|api_key)$/i;

function redact(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (depth > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEYS.test(k)) out[k] = (val === null || val === undefined || val === '') ? null : '[redacted:' + String(val).length + ']';
      else out[k] = redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + '\u2026';
  return v;
}

// Nomor HP disamarkan: 62812****789
function maskPhone(p) {
  const d = String(p || '').replace(/\D+/g, '');
  if (d.length < 7) return d ? '***' : '';
  return d.slice(0, 4) + '*'.repeat(Math.max(3, d.length - 7)) + d.slice(-3);
}

async function write(event) {
  const rec = { id: crypto.randomUUID(), at: new Date().toISOString(), ...redact(event) };
  try {
    await kv.push(KEY, JSON.stringify(rec), MAX);
  } catch (e) {
    console.error('[audit] gagal menulis:', e.message);
  }
  return rec;
}

// Catat satu langkah alur OTP. `outcome` = ok | fail | blocked.
function otp({ action, phone, ip, outcome, code = null, message = null, ms = null, detail = null, trace = null }) {
  return write({
    kind: 'otp',
    action,                       // request | retry | verify | select | diagnose | captcha | identity
    phone: maskPhone(phone),
    ip: ip || null,
    outcome,
    code,
    message: message ? String(message).slice(0, 300) : null,
    ms,
    detail: detail || null,
    trace: Array.isArray(trace) ? trace.map(t => ({ step: t.step, error: t.error ?? null, ok: t.ok ?? null })) : null,
  });
}

async function read({ limit = 50, phone = null, outcome = null } = {}) {
  let raw = [];
  try { raw = await kv.list(KEY, Math.min(MAX, Math.max(limit * 4, limit))); } catch { return []; }
  const out = [];
  for (const line of raw) {
    if (out.length >= limit) break;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (phone && rec.phone !== maskPhone(phone)) continue;
    if (outcome && rec.outcome !== outcome) continue;
    out.push(rec);
  }
  return out;
}

async function stats() {
  const all = await read({ limit: MAX });
  const by = { ok: 0, fail: 0, blocked: 0 };
  for (const r of all) if (by[r.outcome] !== undefined) by[r.outcome]++;
  return { total: all.length, ...by, backend: kv.backend, persistent: kv.persistent };
}

module.exports = { write, otp, read, stats, maskPhone, redact, KEY };
