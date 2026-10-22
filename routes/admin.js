'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getSettings, setSetting, seedAdminAudit } = db;
const { listProviderSummaries, saveProviderConfig, getProviderSummary } = require('../utils/secrets');
const { testProvider } = require('../utils/providers');
const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/overview', async (req, res) => {
  const totals = await db.one(`SELECT
    (SELECT COUNT(*) FROM users WHERE role<>'admin') AS users,
    (SELECT COUNT(*) FROM transactions) AS transactions,
    (SELECT COUNT(*) FROM transactions WHERE status='pending') AS pending_transactions,
    (SELECT COUNT(*) FROM transactions WHERE type='withdrawal' AND status IN ('pending','processing')) AS pending_withdrawals,
    (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit' AND status='paid') AS paid_volume,
    (SELECT COALESCE(SUM(fee),0) FROM transactions WHERE type='deposit' AND status='paid') AS qris_fee_volume`);
  // PostgreSQL and SQLite differ on date() syntax; calculate today's figures in portable JavaScript.
  const paidTodayRows = await db.all("SELECT created_at FROM transactions WHERE type='deposit' AND status='paid'");
  const today = new Date().toISOString().slice(0, 10);
  const paidToday = paidTodayRows.filter((r) => String(r.created_at).slice(0, 10) === today).length;
  const recent = await db.all(`SELECT t.id,t.reference,t.type,t.amount,t.fee,t.total,t.status,t.channel,t.created_at,u.username
    FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 10`);
  res.json({ success: true, totals: { ...totals, users: Number(totals.users), transactions: Number(totals.transactions), pending_transactions: Number(totals.pending_transactions), pending_withdrawals: Number(totals.pending_withdrawals), paid_volume: Number(totals.paid_volume), qris_fee_volume: Number(totals.qris_fee_volume), paid_today: paidToday }, recent });
});

router.get('/settings', async (_req, res) => res.json({ success: true, settings: await getSettings(), providers: await listProviderSummaries() }));
router.put('/settings', async (req, res) => {
  const allowed = ['brand_name','qris_fee','qris_fee_percent','deposit_min','deposit_max','withdrawal_fee_dana','withdrawal_fee_gopay','withdrawal_fee_shopeepay','withdrawal_fee_manual','withdrawal_min','withdrawal_max','invoice_expiry_minutes','default_provider','public_api_enabled','withdrawals_enabled'];
  const input = req.body?.settings || {};
  const updated = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    let value = input[key];
    if (['brand_name','default_provider'].includes(key)) value = String(value || '').trim();
    else value = Number(value);
    if (['qris_fee','qris_fee_percent','deposit_min','deposit_max','withdrawal_fee_dana','withdrawal_fee_gopay','withdrawal_fee_shopeepay','withdrawal_fee_manual','withdrawal_min','withdrawal_max','invoice_expiry_minutes'].includes(key) && (!Number.isFinite(value) || value < 0)) {
      return res.status(422).json({ success: false, message: `Nilai ${key} harus angka positif.` });
    }
    if (['public_api_enabled','withdrawals_enabled'].includes(key)) value = value ? 1 : 0;
    if (key === 'default_provider' && !['dana','shopeepay','gopay'].includes(value)) return res.status(422).json({ success: false, message: 'Default provider tidak valid.' });
    updated[key] = value;
  }
  const current = await getSettings();
  const merged = { ...current, ...updated };
  if (Number(merged.deposit_min) >= Number(merged.deposit_max)) return res.status(422).json({ success: false, message: 'Batas deposit maksimum harus lebih besar dari minimum.' });
  if (Number(merged.withdrawal_min) >= Number(merged.withdrawal_max)) return res.status(422).json({ success: false, message: 'Batas withdrawal maksimum harus lebih besar dari minimum.' });
  for (const [key,value] of Object.entries(updated)) await setSetting(key, value, req.user.id);
  await seedAdminAudit(req.user.id, 'settings.update', 'settings', null, updated);
  res.json({ success: true, message: 'Pengaturan disimpan.', settings: await getSettings() });
});

router.get('/providers', async (_req, res) => res.json({ success: true, providers: await listProviderSummaries() }));
router.put('/providers/:provider', async (req, res) => {
  try {
    const summary = await saveProviderConfig(req.params.provider, req.body || {}, req.user.id);
    await seedAdminAudit(req.user.id, 'provider.config.update', 'provider', req.params.provider, { enabled: !!req.body?.enabled, mode: req.body?.mode || 'sandbox' });
    res.json({ success: true, message: 'Konfigurasi provider disimpan terenkripsi.', provider: summary });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
router.post('/providers/:provider/test', async (req, res) => {
  const result = await testProvider(req.params.provider);
  await seedAdminAudit(req.user.id, 'provider.test', 'provider', req.params.provider, { success: result.success, message: result.message });
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/transactions', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = req.query.status ? String(req.query.status) : null;
  const params = []; let where = '';
  if (status && ['creating','pending','paid','success','processing','expired','failed','cancelled'].includes(status)) { where = 'WHERE t.status=?'; params.push(status); }
  const rows = await db.all(`SELECT t.id,t.reference,t.user_id,t.type,t.amount,t.fee,t.total,t.status,t.channel,t.account_number,t.account_name,t.provider_ref,t.payment_link,t.created_at,t.completed_at,u.username,u.email
    FROM transactions t JOIN users u ON u.id=t.user_id ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ success: true, data: rows, limit, offset });
});
router.get('/withdrawals', async (req, res) => {
  const status = String(req.query.status || 'open');
  const where = status === 'all' ? "t.type='withdrawal'" : status === 'pending' || status === 'processing' || status === 'success' || status === 'failed' ? "t.type='withdrawal' AND t.status=?" : "t.type='withdrawal' AND t.status IN ('pending','processing')";
  const params = status === 'pending' || status === 'processing' || status === 'success' || status === 'failed' ? [status] : [];
  const rows = await db.all(`SELECT t.id,t.reference,t.user_id,t.amount,t.fee,t.total,t.status,t.channel,t.account_number,t.account_name,t.created_at,t.completed_at,u.username,u.email
    FROM transactions t JOIN users u ON u.id=t.user_id WHERE ${where} ORDER BY t.created_at DESC LIMIT 150`, params);
  res.json({ success: true, data: rows });
});
router.post('/withdrawals/:id/review', async (req, res) => {
  const action = String(req.body?.action || '').toLowerCase();
  if (!['approve','reject','paid'].includes(action)) return res.status(422).json({ success: false, message: 'Action harus approve, reject, atau paid.' });
  let updated = null;
  try {
    await db.transaction(async (tx) => {
      const lock = db.mode === 'postgres' ? 'SELECT * FROM transactions WHERE id=? FOR UPDATE' : 'SELECT * FROM transactions WHERE id=?';
      const trx = await tx.one(lock, [req.params.id]);
      if (!trx || trx.type !== 'withdrawal') throw new Error('Permintaan penarikan tidak ditemukan.');
      const userLock = db.mode === 'postgres' ? 'SELECT * FROM users WHERE id=? FOR UPDATE' : 'SELECT * FROM users WHERE id=?';
      const user = await tx.one(userLock, [trx.user_id]);
      const at = db.now();
      if (action === 'approve') {
        if (trx.status !== 'pending') throw new Error('Hanya permintaan pending yang dapat disetujui.');
        await tx.run("UPDATE transactions SET status='processing',updated_at=?,meta=? WHERE id=?", [at, JSON.stringify({ payout: 'approved_manual_transfer', reviewed_by: req.user.id }), trx.id]);
      } else if (action === 'paid') {
        if (trx.status !== 'processing') throw new Error('Setujui permintaan terlebih dahulu sebelum menandai paid.');
        // Owner harus benar-benar menyelesaikan transfer sebelum menekan tombol ini.
        await tx.run("UPDATE transactions SET status='success',completed_at=?,updated_at=?,meta=? WHERE id=?", [at, at, JSON.stringify({ payout: 'manual_transfer_confirmed', confirmed_by: req.user.id }), trx.id]);
        await tx.run('UPDATE users SET pending_balance=CASE WHEN pending_balance>? THEN pending_balance-? ELSE 0 END WHERE id=?', [Number(trx.total), Number(trx.total), user.id]);
        const latestUser = await tx.one('SELECT * FROM users WHERE id=?', [trx.user_id]);
        await tx.run('UPDATE transactions SET balance_after=? WHERE id=?', [Number(latestUser.balance), trx.id]);
      } else {
        if (!['pending','processing'].includes(trx.status)) throw new Error('Hanya permintaan pending/processing yang bisa ditolak.');
        const amountRefund = Number(trx.amount) + Number(trx.fee);
        const before = Number(user.balance);
        const after = before + amountRefund;
        await tx.run('UPDATE users SET balance=?, pending_balance=CASE WHEN pending_balance>? THEN pending_balance-? ELSE 0 END WHERE id=?', [after, amountRefund, amountRefund, user.id]);
        await tx.run("UPDATE transactions SET status='failed',completed_at=?,updated_at=?,balance_after=?,meta=? WHERE id=?", [at, at, after, JSON.stringify({ payout: 'rejected', rejected_by: req.user.id, reason: String(req.body?.reason || '').slice(0, 250) }), trx.id]);
        await tx.run(`INSERT INTO ledger_entries (id,user_id,transaction_id,direction,amount,fee,balance_before,balance_after,source,note,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transaction_id,direction,source) DO NOTHING`, [db.genId('LED'), user.id, trx.id, 'credit', amountRefund, 0, before, after, 'withdrawal_refund', 'Saldo dikembalikan setelah withdrawal ditolak', at]);
      }
      updated = await tx.one('SELECT * FROM transactions WHERE id=?', [trx.id]);
    });
    await seedAdminAudit(req.user.id, `withdrawal.${action}`, 'transaction', req.params.id, { action });
    res.json({ success: true, message: action === 'paid' ? 'Penarikan ditandai berhasil setelah konfirmasi transfer.' : action === 'approve' ? 'Penarikan disetujui; lakukan transfer di kanal merchant lalu tandai Paid.' : 'Penarikan ditolak dan saldo dikembalikan.', transaction: updated });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

router.get('/users', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const rows = await db.all(`SELECT id,username,email,balance,pending_balance,role,status,created_at FROM users ORDER BY created_at DESC LIMIT ?`, [limit]);
  res.json({ success: true, data: rows });
});
router.post('/users/:id/status', async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active','suspended'].includes(status)) return res.status(422).json({ success: false, message: 'Status tidak valid.' });
  const target = await db.one('SELECT id,role FROM users WHERE id=?', [req.params.id]);
  if (!target) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  if (target.role === 'admin') return res.status(400).json({ success: false, message: 'Tidak dapat menonaktifkan admin melalui halaman ini.' });
  await db.run('UPDATE users SET status=? WHERE id=?', [status, target.id]);
  await seedAdminAudit(req.user.id, 'user.status.update', 'user', target.id, { status });
  res.json({ success: true, message: 'Status user diperbarui.' });
});
router.get('/audit-logs', async (_req, res) => {
  const rows = await db.all('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 100');
  res.json({ success: true, data: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : {} })) });
});
module.exports = router;
