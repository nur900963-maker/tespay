'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, publicUser } = require('../middleware/auth');
const router = express.Router();

router.get('/profile', requireAuth, async (req, res) => {
  const stats = await db.one(`SELECT COUNT(*) AS total_transactions,
    COALESCE(SUM(CASE WHEN type='deposit' AND status='paid' THEN amount ELSE 0 END),0) AS deposit_total,
    COALESCE(SUM(CASE WHEN type='withdrawal' AND status='success' THEN amount ELSE 0 END),0) AS withdraw_total
    FROM transactions WHERE user_id=?`, [req.user.id]);
  res.json({ success: true, user: publicUser(req.user), stats });
});

router.put('/profile', requireAuth, async (req, res) => {
  const { username, email, webhook_url, webhook_enabled } = req.body || {};
  const updates = []; const params = [];
  if (username !== undefined) {
    const value = String(username).trim();
    if (!/^[a-zA-Z0-9_]{3,15}$/.test(value)) return res.status(422).json({ success: false, message: 'Username 3–15 karakter (huruf, angka, underscore).' });
    if (await db.one('SELECT id FROM users WHERE lower(username)=lower(?) AND id<>?', [value, req.user.id])) return res.status(409).json({ success: false, message: 'Username sudah digunakan.' });
    updates.push('username=?'); params.push(value);
  }
  if (email !== undefined) {
    const value = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return res.status(422).json({ success: false, message: 'Alamat email tidak valid.' });
    if (await db.one('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?', [value, req.user.id])) return res.status(409).json({ success: false, message: 'Email sudah terdaftar.' });
    updates.push('email=?'); params.push(value);
  }
  if (webhook_url !== undefined) {
    const url = String(webhook_url || '').trim();
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { return res.status(422).json({ success: false, message: 'URL webhook tidak valid.' }); }
      if (!['https:', ...(process.env.NODE_ENV !== 'production' ? ['http:'] : [])].includes(parsed.protocol) || parsed.username || parsed.password) {
        return res.status(422).json({ success: false, message: 'Webhook wajib memakai HTTPS di produksi.' });
      }
    }
    updates.push('webhook_url=?'); params.push(url || null);
  }
  if (webhook_enabled !== undefined) { updates.push('webhook_enabled=?'); params.push(webhook_enabled ? 1 : 0); }
  if (updates.length) { params.push(req.user.id); await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, params); }
  const user = await db.one('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.json({ success: true, message: 'Profil berhasil diperbarui.', user: publicUser(user) });
});

router.post('/webhook-secret/rotate', requireAuth, async (req, res) => {
  const secret = crypto.randomBytes(32).toString('hex');
  await db.run('UPDATE users SET webhook_secret=? WHERE id=?', [secret, req.user.id]);
  res.json({ success: true, message: 'Webhook signing secret baru dibuat. Simpan sekarang karena tidak akan ditampilkan lagi.', webhook_secret: secret });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const current = String(req.body?.current_password || ''); const password = String(req.body?.new_password || '');
  if (!current || !password) return res.status(422).json({ success: false, message: 'Password lama dan baru wajib diisi.' });
  if (password.length < 8) return res.status(422).json({ success: false, message: 'Password baru minimal 8 karakter.' });
  if (!(await bcrypt.compare(current, req.user.password_hash))) return res.status(400).json({ success: false, message: 'Password lama salah.' });
  await db.run('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), req.user.id]);
  res.json({ success: true, message: 'Password berhasil diubah.' });
});

router.get('/api-keys', requireAuth, async (req, res) => {
  const rows = await db.all('SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
  res.json({ success: true, data: rows.map((k) => ({ id: k.id, label: k.label, key: k.key, last_used_at: k.last_used_at, revoked: !!k.revoked, created_at: k.created_at })) });
});
router.post('/api-keys', requireAuth, async (req, res) => {
  const label = String(req.body?.label || 'Key Baru').trim().slice(0, 40) || 'Key Baru';
  const key = db.genApiKey(); const id = db.genId('KEY'); const created = db.now();
  await db.run('INSERT INTO api_keys (id,user_id,label,key,created_at) VALUES (?,?,?,?,?)', [id, req.user.id, label, key, created]);
  await db.run('UPDATE users SET api_key=? WHERE id=?', [key, req.user.id]);
  res.status(201).json({ success: true, message: 'API key dibuat. Simpan key ini dengan aman.', api_key: key, id });
});
router.post('/api-keys/regenerate', requireAuth, async (req, res) => {
  const key = db.genApiKey(); const id = db.genId('KEY'); const created = db.now();
  await db.transaction(async (tx) => {
    await tx.run('UPDATE api_keys SET revoked=1 WHERE user_id=?', [req.user.id]);
    await tx.run('UPDATE users SET api_key=? WHERE id=?', [key, req.user.id]);
    await tx.run('INSERT INTO api_keys (id,user_id,label,key,created_at) VALUES (?,?,?,?,?)', [id, req.user.id, 'Rotated Default', key, created]);
  });
  res.json({ success: true, message: 'API key lama dicabut. Simpan key baru.', api_key: key });
});
router.delete('/api-keys/:id', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM api_keys WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ success: false, message: 'API key tidak ditemukan.' });
  await db.run('UPDATE api_keys SET revoked=1 WHERE id=?', [row.id]);
  await db.run('UPDATE users SET api_key=NULL WHERE id=? AND api_key=?', [req.user.id, row.key]);
  res.json({ success: true, message: 'API key dicabut.' });
});
router.get('/stats', requireAuth, async (req, res) => {
  const row = await db.one(`SELECT COUNT(*) AS transactions,
    COALESCE(SUM(CASE WHEN status='paid' AND type='deposit' THEN amount ELSE 0 END),0) AS paid_in,
    COALESCE(SUM(CASE WHEN status='success' AND type='withdrawal' THEN amount ELSE 0 END),0) AS withdrawals,
    COALESCE(SUM(CASE WHEN status IN ('pending','processing','creating') THEN 1 ELSE 0 END),0) AS pending
    FROM transactions WHERE user_id=?`, [req.user.id]);
  const items = await db.all('SELECT created_at, type, status, amount FROM transactions WHERE user_id=?', [req.user.id]);
  const today = new Date().toISOString().slice(0,10);
  const todayItems = items.filter(x => String(x.created_at).slice(0,10) === today);
  const payload = {
    today_count: todayItems.length,
    today_total: todayItems.filter(x => x.type === 'deposit' && x.status === 'paid').reduce((sum,x)=>sum+Number(x.amount||0),0),
    total_transactions: Number(row.transactions), pending_count: Number(row.pending),
    deposit_total: Number(row.paid_in), withdraw_total: Number(row.withdrawals),
    stats: row
  };
  res.json({ success: true, ...payload });
});
module.exports = router;
