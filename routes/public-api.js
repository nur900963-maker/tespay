'use strict';
const express = require('express');
const db = require('../db');
const { apiKeyAuth } = require('../middleware/auth');
const { pricingPayload } = require('../utils/pricing');
const transactionsModule = require('./transactions');
const router = express.Router();

router.use(async (req, res, next) => {
  if (!['/profile','/createinvoice','/checkinvoice'].includes(req.path)) return next();
  const enabled = await db.getSetting('public_api_enabled', 1);
  if (!Number(enabled)) return res.status(503).json({ success: false, message: 'Public API sementara dinonaktifkan oleh owner.' });
  next();
});

router.get('/profile', apiKeyAuth, (req, res) => res.json({ username: req.user.username, email: req.user.email, balance: Number(req.user.balance), pending_balance: Number(req.user.pending_balance) }));
router.post('/createinvoice', apiKeyAuth, async (req, res) => {
  const result = await transactionsModule.createInvoice(req.user, req.body?.amount ?? req.query.amount, { provider: req.body?.provider || req.query.provider, note: req.body?.note, idempotencyKey: req.headers['idempotency-key'] || req.body?.idempotency_key });
  if (result.error) return res.status(result.code || 400).json({ success: false, message: result.error });
  const t = result.trx;
  res.status(201).json({ success: true, invoice_id: t.id, reference: t.reference, amount: t.amount, fee: t.fee, total: t.total, qris_image: t.qris_image, payment_link: t.payment_link, expired_at: t.expired_at, provider: t.channel });
});
router.get('/checkinvoice', apiKeyAuth, async (req, res) => {
  const id = req.query.id || req.query.invoice_id;
  if (!id) return res.status(422).json({ success: false, message: 'Parameter id wajib diisi.' });
  let t = await db.one('SELECT * FROM transactions WHERE (id=? OR reference=?) AND user_id=?', [String(id), String(id), req.user.id]);
  if (!t) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan.' });
  if (['pending','creating','expired'].includes(t.status)) t = await transactionsModule.refreshInvoiceStatus(t);
  res.json({ invoice_id: t.id, reference: t.reference, amount: Number(t.amount), fee: Number(t.fee), total: Number(t.total), status: t.status, qris_image: t.qris_image, payment_link: t.payment_link, expired_at: t.expired_at, created_at: t.created_at, balance_after: t.balance_after, completed_at: t.completed_at, provider: t.channel });
});
router.get('/pricing', async (_req, res) => res.json({ success: true, ...await pricingPayload() }));
router.get('/stats', async (_req, res) => {
  const users = await db.one("SELECT COUNT(*) AS c FROM users WHERE role<>'admin' AND status='active'");
  const trx = await db.one(`SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN type='deposit' AND status='paid' THEN amount ELSE 0 END),0) AS volume,
    COALESCE(SUM(CASE WHEN type='withdrawal' AND status='success' THEN amount ELSE 0 END),0) AS withdraw FROM transactions`);
  res.json({ success: true, users: Number(users.c), transactions: Number(trx.c), volume: Number(trx.volume), withdrawal_volume: Number(trx.withdraw) });
});
router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'vincent-pay', time: new Date().toISOString() }));
module.exports = router;
