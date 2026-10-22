'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db');
const { signToken, publicUser, requireAuth } = require('../middleware/auth');
const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_]{3,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, confirm_password, referralCode } = req.body || {};
    const uname = String(username || '').trim();
    const mail = String(email || '').trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) return res.status(422).json({ success: false, message: 'Username 3–15 karakter; huruf, angka, dan underscore.' });
    if (!EMAIL_RE.test(mail)) return res.status(422).json({ success: false, message: 'Alamat email tidak valid.' });
    if (String(password || '').length < 8) return res.status(422).json({ success: false, message: 'Password minimal 8 karakter.' });
    if (password !== confirm_password) return res.status(422).json({ success: false, message: 'Konfirmasi password tidak sama.' });
    const exists = await db.one('SELECT id, username, email FROM users WHERE lower(username)=lower(?) OR lower(email)=?', [uname, mail]);
    if (exists) return res.status(409).json({ success: false, message: exists.username.toLowerCase() === uname.toLowerCase() ? 'Username sudah digunakan.' : 'Email sudah terdaftar.' });
    let referredBy = null;
    if (referralCode) {
      const ref = await db.one('SELECT id FROM users WHERE referral_code=?', [String(referralCode).trim().toUpperCase()]);
      if (!ref) return res.status(422).json({ success: false, message: 'Kode referral tidak ditemukan.' });
      referredBy = ref.id;
    }
    const id = db.genId('USR'); const key = db.genApiKey(); const created = db.now();
    await db.transaction(async (tx) => {
      await tx.run(`INSERT INTO users (id,username,email,password_hash,balance,pending_balance,api_key,referral_code,referred_by,role,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, uname, mail, await bcrypt.hash(String(password), 12), 0, 0, key, db.genReferral(uname), referredBy, 'user', 'active', created]);
      await tx.run('INSERT INTO api_keys (id,user_id,label,key,created_at) VALUES (?,?,?,?,?)', [db.genId('KEY'), id, 'Default', key, created]);
    });
    const user = await db.one('SELECT * FROM users WHERE id=?', [id]);
    return res.status(201).json({ success: true, message: 'Registrasi berhasil.', token: signToken(user), user: publicUser(user) });
  } catch (e) {
    console.error('[register]', e.message);
    return res.status(500).json({ success: false, message: 'Pendaftaran gagal. Coba lagi.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const login = String(req.body?.login || req.body?.email || req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!login || !password) return res.status(422).json({ success: false, message: 'Email/username dan password wajib diisi.' });
    const user = await db.one('SELECT * FROM users WHERE lower(email)=lower(?) OR lower(username)=lower(?)', [login, login]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ success: false, message: 'Email/username atau password salah.' });
    if (user.status !== 'active') return res.status(403).json({ success: false, message: 'Akun tidak aktif.' });
    return res.json({ success: true, message: 'Login berhasil.', token: signToken(user), user: publicUser(user) });
  } catch (e) { console.error('[login]', e.message); res.status(500).json({ success: false, message: 'Login sedang bermasalah.' }); }
});

router.get('/me', requireAuth, (req, res) => res.json({ success: true, user: publicUser(req.user) }));

router.post('/forgot-password', async (req, res) => {
  const login = String(req.body?.login || req.body?.email || '').trim();
  if (!login) return res.status(422).json({ success: false, message: 'Email atau username wajib diisi.' });
  const generic = { success: true, message: 'Jika akun terdaftar, instruksi reset akan dikirim melalui kanal pemulihan yang terhubung.' };
  const user = await db.one('SELECT * FROM users WHERE lower(email)=lower(?) OR lower(username)=lower(?)', [login, login]);
  if (!user) return res.json(generic);
  const smtpReady = ['SMTP_HOST','SMTP_USER','SMTP_PASS','SMTP_FROM'].every((key) => String(process.env[key] || '').trim());
  if (!smtpReady) {
    // Avoid creating an unusable token: production password recovery requires SMTP credentials.
    return res.json(generic);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
  await db.run('INSERT INTO password_resets (token,user_id,expires_at,used,created_at) VALUES (?,?,?,?,?)', [token, user.id, expiresAt, 0, db.now()]);
  const resetUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transport.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: 'Reset password Vincent Pay', text: `Gunakan tautan ini dalam 30 menit untuk mengganti password Vincent Pay: ${resetUrl}`, html: `<p>Permintaan reset password Vincent Pay.</p><p><a href="${resetUrl}">Reset password</a></p><p>Tautan berlaku 30 menit. Abaikan email ini jika kamu tidak meminta reset.</p>` });
  } catch (error) {
    await db.run('UPDATE password_resets SET used=1 WHERE token=?', [token]);
    console.error('[forgot-password SMTP]', error.message);
    return res.json(generic);
  }
  res.json(generic);
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token || ''); const password = String(req.body?.password || '');
  if (!token) return res.status(422).json({ success: false, message: 'Token reset tidak valid.' });
  if (password.length < 8) return res.status(422).json({ success: false, message: 'Password minimal 8 karakter.' });
  if (req.body?.confirm_password !== password) return res.status(422).json({ success: false, message: 'Konfirmasi password tidak sama.' });
  const row = await db.one('SELECT * FROM password_resets WHERE token=?', [token]);
  if (!row || Number(row.used) || new Date(row.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'Link reset sudah tidak berlaku.' });
  await db.transaction(async (tx) => {
    await tx.run('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), row.user_id]);
    await tx.run('UPDATE password_resets SET used=1 WHERE token=?', [token]);
  });
  res.json({ success: true, message: 'Password berhasil diubah. Silakan login.' });
});

module.exports = router;
