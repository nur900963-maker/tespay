'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPricingConfig, depositFee, withdrawFee } = require('../utils/pricing');
const { createProviderPayment, queryProviderPayment } = require('../utils/providers');
const { dispatchWebhook, retryWebhookLog, testWebhook } = require('../utils/webhook');
const router = express.Router();

function publicTrx(t) {
  return { id: t.id, reference: t.reference, type: t.type, amount: Number(t.amount), fee: Number(t.fee), total: Number(t.total),
    status: t.status, channel: t.channel, account_number: t.account_number, account_name: t.account_name,
    qris_image: t.qris_image, payment_link: t.payment_link, created_at: t.created_at, expired_at: t.expired_at,
    completed_at: t.completed_at, balance_after: t.balance_after === null ? null : Number(t.balance_after) };
}

async function createInvoice(user, amount, opts = {}) {
  const amt = Number(amount);
  const pricing = await getPricingConfig();
  if (!Number.isSafeInteger(amt) || amt < Number(pricing.deposit_min)) return { error: `Nominal minimal Rp ${Number(pricing.deposit_min).toLocaleString('id-ID')}.`, code: 422 };
  if (amt > Number(pricing.deposit_max)) return { error: `Nominal maksimal Rp ${Number(pricing.deposit_max).toLocaleString('id-ID')}.`, code: 422 };
  const provider = String(opts.provider || opts.channel || pricing.default_provider || 'dana').toLowerCase();
  const idempotencyKey = String(opts.idempotencyKey || '').trim().slice(0, 120) || null;
  if (idempotencyKey) {
    const previous = await db.one('SELECT * FROM transactions WHERE user_id=? AND idempotency_key=?', [user.id, idempotencyKey]);
    if (previous) return previous.status === 'failed' ? { error: 'Permintaan invoice dengan Idempotency-Key ini sebelumnya gagal. Gunakan key baru setelah memeriksa status merchant.', code: 409 } : { trx: previous };
  }
  if (!['dana','shopeepay','gopay'].includes(provider)) return { error: 'Pilih provider QRIS yang didukung.', code: 422 };
  const fee = await depositFee(amt);
  const total = amt + fee;
  const id = db.genId('TRX');
  const reference = db.genId('INV').slice(0, 24);
  const now = db.now();
  const expires = new Date(Date.now() + Number(pricing.invoice_expiry_minutes || 30) * 60000).toISOString();
  const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const paymentLink = `${base.replace(/\/$/, '')}/pay?id=${encodeURIComponent(id)}`;
  await db.run(`INSERT INTO transactions (id,reference,user_id,type,amount,fee,total,status,channel,qris_image,payment_link,expired_at,created_at,meta,provider_ref,idempotency_key,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, user.id, 'deposit', amt, fee, total, 'creating', provider, null, paymentLink, expires, now, JSON.stringify({ provider, note: String(opts.note || '').slice(0, 200) }), null, idempotencyKey, now]);
  try {
    const providerResult = await createProviderPayment(provider, reference, total, { email: user.email });
    const qrisImage = providerResult.qr_image || (providerResult.qr_data ? await QRCode.toDataURL(providerResult.qr_data, { width: 420, margin: 1 }) : null);
    await db.run(`UPDATE transactions SET status='pending', provider_ref=?, qris_image=?, meta=?, updated_at=? WHERE id=?`,
      [providerResult.provider_ref || reference, qrisImage, JSON.stringify({ provider, provider_result: providerResult.raw || {}, note: String(opts.note || '').slice(0, 200) }), db.now(), id]);
    const trx = await db.one('SELECT * FROM transactions WHERE id=?', [id]);
    return { trx };
  } catch (error) {
    await db.run(`UPDATE transactions SET status='failed', meta=?, updated_at=? WHERE id=?`,
      [JSON.stringify({ provider, provider_error: String(error.message || error).slice(0, 400) }), db.now(), id]);
    return { error: `Gagal membuat QRIS melalui ${provider.toUpperCase()}: ${error.message}`, code: 502 };
  }
}

async function settleInvoice(invoiceId, verifiedProvider = {}) {
  let updated = null;
  await db.transaction(async (tx) => {
    const lockSql = db.mode === 'postgres' ? 'SELECT * FROM transactions WHERE id=? FOR UPDATE' : 'SELECT * FROM transactions WHERE id=?';
    const trx = await tx.one(lockSql, [invoiceId]);
    if (!trx || trx.type !== 'deposit' || trx.status === 'paid' || ['failed','cancelled'].includes(trx.status)) return;
    const userLockSql = db.mode === 'postgres' ? 'SELECT * FROM users WHERE id=? FOR UPDATE' : 'SELECT * FROM users WHERE id=?';
    const user = await tx.one(userLockSql, [trx.user_id]);
    if (!user) return;
    const newBalance = Number(user.balance || 0) + Number(trx.amount);
    const timestamp = db.now();
    await tx.run(`UPDATE transactions SET status='paid',completed_at=?,balance_after=?,updated_at=? WHERE id=? AND status<>'paid'`, [timestamp, newBalance, timestamp, trx.id]);
    await tx.run('UPDATE users SET balance=? WHERE id=?', [newBalance, user.id]);
    await tx.run(`INSERT INTO ledger_entries (id,user_id,transaction_id,direction,amount,fee,balance_before,balance_after,source,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transaction_id,direction,source) DO NOTHING`,
      [db.genId('LED'), user.id, trx.id, 'credit', Number(trx.amount), Number(trx.fee), Number(user.balance || 0), newBalance, 'deposit_paid', 'Kredit setelah status provider terverifikasi', timestamp]);
    updated = await tx.one('SELECT * FROM transactions WHERE id=?', [trx.id]);
  });
  if (updated) {
    const user = await db.one('SELECT * FROM users WHERE id=?', [updated.user_id]);
    await dispatchWebhook(user, updated, 'payment.paid');
  }
  return updated;
}

async function refreshInvoiceStatus(trx) {
  if (!trx || trx.type !== 'deposit' || !['pending','expired'].includes(trx.status)) return trx;
  // Always query the merchant first; an invoice that expired locally may still be settled late.
  const result = await queryProviderPayment(trx);
  if (result.verified && result.status === 'paid') return (await settleInvoice(trx.id, result)) || await db.one('SELECT * FROM transactions WHERE id=?', [trx.id]);
  if (result.verified && result.status === 'failed' && ['pending','expired'].includes(trx.status)) {
    await db.run("UPDATE transactions SET status='failed',updated_at=? WHERE id=? AND status IN ('pending','expired')", [db.now(), trx.id]);
    return db.one('SELECT * FROM transactions WHERE id=?', [trx.id]);
  }
  if (trx.status === 'pending' && trx.expired_at && new Date(trx.expired_at) < new Date()) {
    await db.run("UPDATE transactions SET status='expired',updated_at=? WHERE id=? AND status='pending'", [db.now(), trx.id]);
    return db.one('SELECT * FROM transactions WHERE id=?', [trx.id]);
  }
  return trx;
}

router.post('/', requireAuth, async (req, res) => {
  const result = await createInvoice(req.user, req.body?.amount, { note: req.body?.note, provider: req.body?.provider || req.body?.channel, idempotencyKey: req.headers['idempotency-key'] || req.body?.idempotency_key });
  if (result.error) return res.status(result.code || 400).json({ success: false, message: result.error });
  res.status(201).json({ success: true, message: 'Invoice QRIS berhasil dibuat.', transaction: publicTrx(result.trx) });
});

router.get('/', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit; const where = ['user_id=?']; const params = [req.user.id];
  if (['deposit','withdrawal'].includes(req.query.type)) { where.push('type=?'); params.push(req.query.type); }
  if (req.query.status && ['creating','pending','paid','success','processing','expired','failed','cancelled'].includes(req.query.status)) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(id LIKE ? OR reference LIKE ?)'); params.push(`%${String(req.query.q).slice(0,80)}%`, `%${String(req.query.q).slice(0,80)}%`); }
  const clause = where.join(' AND ');
  const count = await db.one(`SELECT COUNT(*) AS c FROM transactions WHERE ${clause}`, params);
  const rows = await db.all(`SELECT * FROM transactions WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const sums = await db.one(`SELECT COALESCE(SUM(CASE WHEN type='deposit' AND status='paid' THEN amount ELSE 0 END),0) AS deposit_total,
    COALESCE(SUM(CASE WHEN type='withdrawal' AND status='success' THEN amount ELSE 0 END),0) AS withdraw_total, COUNT(*) AS count_all
    FROM transactions WHERE user_id=?`, [req.user.id]);
  res.json({ success: true, data: rows.map(publicTrx), pagination: { page, limit, total: Number(count.c), pages: Math.max(1, Math.ceil(Number(count.c) / limit)) },
    summary: { deposit_total: Number(sums.deposit_total), withdraw_total: Number(sums.withdraw_total), count: Number(sums.count_all), balance: Number(req.user.balance), pending_balance: Number(req.user.pending_balance) } });
});

router.get('/withdrawals/create', (_req, res) => res.status(405).json({ success: false, message: 'Gunakan POST untuk membuat permintaan penarikan.' }));
router.post('/withdrawals/create', requireAuth, async (req, res) => {
  const amount = Math.round(Number(req.body?.amount));
  const channel = String(req.body?.channel || '').toUpperCase();
  const accountNumber = String(req.body?.account_number || '').trim();
  const accountName = String(req.body?.account_name || '').trim();
  const pricing = await getPricingConfig();
  if (!Number(pricing.withdrawals_enabled)) return res.status(403).json({ success: false, message: 'Penarikan sementara dinonaktifkan oleh admin.' });
  if (!['DANA','GOPAY','SHOPEEPAY','MANUAL'].includes(channel)) return res.status(422).json({ success: false, message: 'Channel penarikan tidak dikenal.' });
  if (!Number.isSafeInteger(amount) || amount < Number(pricing.withdrawal_min)) return res.status(422).json({ success: false, message: `Minimal penarikan Rp ${Number(pricing.withdrawal_min).toLocaleString('id-ID')}.` });
  if (amount > Number(pricing.withdrawal_max)) return res.status(422).json({ success: false, message: `Maksimal penarikan Rp ${Number(pricing.withdrawal_max).toLocaleString('id-ID')}.` });
  if (!accountNumber || !accountName || accountNumber.length > 60 || accountName.length > 100) return res.status(422).json({ success: false, message: 'Nomor tujuan dan nama pemilik wajib diisi dengan benar.' });
  const fee = await withdrawFee(channel) ?? Number(pricing.withdrawal_fee_manual || 0);
  const needed = amount + fee; const id = db.genId('WD'); const at = db.now();
  try {
    await db.transaction(async (tx) => {
      const lockSql = db.mode === 'postgres' ? 'SELECT * FROM users WHERE id=? FOR UPDATE' : 'SELECT * FROM users WHERE id=?';
      const user = await tx.one(lockSql, [req.user.id]);
      if (!user || Number(user.balance) < needed) throw new Error(`Saldo tidak cukup. Dibutuhkan Rp ${needed.toLocaleString('id-ID')} termasuk fee.`);
      const newBalance = Number(user.balance) - needed;
      await tx.run(`INSERT INTO transactions (id,reference,user_id,type,amount,fee,total,status,channel,account_number,account_name,created_at,completed_at,balance_after,meta,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, id, user.id, 'withdrawal', amount, fee, needed, 'pending', channel, accountNumber, accountName, at, null, newBalance, JSON.stringify({ payout: 'manual_review' }), at]);
      await tx.run('UPDATE users SET balance=?, pending_balance=pending_balance+? WHERE id=?', [newBalance, needed, user.id]);
      await tx.run(`INSERT INTO ledger_entries (id,user_id,transaction_id,direction,amount,fee,balance_before,balance_after,source,note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [db.genId('LED'), user.id, id, 'debit', amount, fee, Number(user.balance), newBalance, 'withdrawal_hold', 'Saldo ditahan sambil menunggu keputusan admin', at]);
    });
  } catch (e) { return res.status(400).json({ success: false, message: e.message || 'Permintaan penarikan gagal.' }); }
  const trx = await db.one('SELECT * FROM transactions WHERE id=?', [id]);
  const freshUser = await db.one('SELECT * FROM users WHERE id=?', [req.user.id]);
  res.status(201).json({ success: true, message: 'Permintaan penarikan masuk antrean admin; belum berstatus berhasil.', transaction: publicTrx(trx), balance: Number(freshUser.balance) });
});

router.get('/webhooks/logs', requireAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const rows = await db.all('SELECT * FROM webhook_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [req.user.id, limit]);
  res.json({ success: true, data: rows.map((l) => ({ id: l.id, event: l.event, url: l.url, state: l.state, status_code: l.status_code, attempt: l.attempt,
    response: l.response, transaction_id: l.transaction_id, created_at: l.created_at, payload: JSON.parse(l.payload) })) });
});
router.post('/webhooks/:id/retry', requireAuth, async (req, res) => {
  const result = await retryWebhookLog(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ success: false, message: 'Log webhook tidak ditemukan.' });
  res.json({ success: !!result.ok, message: result.ok ? 'Webhook terkirim.' : 'Webhook masih gagal.', status: result.status });
});
router.post('/webhooks/test', requireAuth, async (req, res) => {
  const result = await testWebhook(req.user);
  res.status(result.ok ? 200 : 400).json({ success: !!result.ok, ...result });
});

router.get('/:id/status', requireAuth, async (req, res) => {
  let trx = await db.one('SELECT * FROM transactions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!trx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' });
  trx = await refreshInvoiceStatus(trx);
  res.json({ success: true, transaction: publicTrx(trx) });
});
router.get('/:id', requireAuth, async (req, res) => {
  let trx = await db.one('SELECT * FROM transactions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!trx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' });
  if (trx.type === 'deposit' && ['pending','expired'].includes(trx.status)) trx = await refreshInvoiceStatus(trx);
  const logs = await db.all('SELECT * FROM webhook_logs WHERE transaction_id=? ORDER BY created_at DESC', [trx.id]);
  res.json({ success: true, transaction: publicTrx(trx), webhook_logs: logs.map((l) => ({ id: l.id, event: l.event, state: l.state, status_code: l.status_code, attempt: l.attempt, created_at: l.created_at })) });
});

module.exports = { router, createInvoice, publicTrx, settleInvoice, refreshInvoiceStatus };
