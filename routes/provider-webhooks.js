'use strict';
const express = require('express');
const db = require('../db');
const { queryProviderPayment } = require('../utils/providers');
const { settleInvoice } = require('./transactions');
const router = express.Router();

router.post('/:provider', async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!['dana','shopeepay','gopay'].includes(provider)) return res.status(404).json({ success: false, message: 'Provider tidak dikenal.' });
  const body = req.body || {};
  const reference = String(body.originalPartnerReferenceNo || body.partnerReferenceNo || body.order_id || body.orderId || body.reference || body.transaction_details?.order_id || body.data?.order_id || body.data?.partnerReferenceNo || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'Reference transaksi tidak ada di callback.' });
  const trx = await db.one('SELECT * FROM transactions WHERE reference=? AND lower(channel)=?', [reference, provider]);
  if (!trx) return res.status(404).json({ success: false, message: 'Transaksi tidak dikenal.' });
  // Callback hanya sebagai pemicu. Status dibaca ulang langsung dari API provider dengan credential merchant.
  const current = await queryProviderPayment(trx);
  if (current.verified && current.status === 'paid') {
    await settleInvoice(trx.id, current);
    return res.json({ success: true, message: 'Status pembayaran diverifikasi oleh provider.' });
  }
  res.status(202).json({ success: true, message: 'Callback diterima; status belum terverifikasi final.', status: current.status || 'pending' });
});
module.exports = router;
