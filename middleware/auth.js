'use strict';
const jwt = require('jsonwebtoken');
const db = require('../db');
function jwtSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (process.env.NODE_ENV === 'production' && (secret.length < 32 || /change.?me|replace|example|placeholder|your.?secret/i.test(secret))) throw new Error('JWT_SECRET wajib berupa secret acak minimal 32 karakter di produksi.');
  return secret || 'dev-only-vincent-pay-secret-change-this-32';
}
function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, jwtSecret(), { expiresIn: process.env.JWT_EXPIRES || '12h', issuer: 'vincent-pay' });
}
function publicUser(user) {
  return {
    id: user.id, username: user.username, email: user.email, balance: Number(user.balance || 0),
    pending_balance: Number(user.pending_balance || 0), api_key: user.api_key,
    webhook_url: user.webhook_url, webhook_enabled: !!user.webhook_enabled,
    referral_code: user.referral_code, role: user.role, created_at: user.created_at
  };
}
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized', message: 'Token tidak ditemukan.' });
  try {
    const payload = jwt.verify(token, jwtSecret(), { issuer: 'vincent-pay' });
    const user = await db.one('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'Unauthorized', message: 'User tidak ditemukan.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Forbidden', message: 'Akun tidak aktif.' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Token tidak valid atau kedaluwarsa.' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ success: false, message: 'Akses khusus owner/admin.' });
  next();
}
async function apiKeyAuth(req, res, next) {
  const key = req.query.apikey || req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.apikey;
  if (!key) return res.status(401).json({ error: 'Unauthorized', message: 'API key diperlukan.' });
  try {
    const row = await db.one('SELECT * FROM api_keys WHERE key = ? AND revoked = 0', [key]);
    if (!row) return res.status(401).json({ error: 'Unauthorized', message: 'API key tidak valid atau telah dicabut.' });
    const user = await db.one('SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user || user.status !== 'active') return res.status(403).json({ error: 'Forbidden', message: 'Akun tidak aktif.' });
    await db.run('UPDATE api_keys SET last_used_at = ? WHERE key = ?', [db.now(), key]);
    req.user = user; req.apiKey = key; next();
  } catch (_) { return res.status(500).json({ success: false, message: 'Gagal memvalidasi API key.' }); }
}
module.exports = { signToken, requireAuth, requireAdmin, apiKeyAuth, publicUser };
