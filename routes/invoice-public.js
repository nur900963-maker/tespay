'use strict';
const db = require('../db');
const { refreshInvoiceStatus, publicTrx } = require('./transactions');
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function registerInvoiceRoutes(app) {
  app.get('/api/invoice/:id', asyncRoute(async (req, res) => {
    let trx = await db.one('SELECT * FROM transactions WHERE id=? AND type=?', [req.params.id, 'deposit']);
    if (!trx) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan.' });
    if (['pending','creating','expired'].includes(trx.status)) trx = await refreshInvoiceStatus(trx);
    res.json({ success: true, invoice: { ...publicTrx(trx), qris_image: trx.qris_image, provider: trx.channel } });
  }));
  // Tidak ada endpoint publik yang dapat menandai invoice lunas. Status hanya berubah melalui verifikasi API provider.
  app.post('/api/invoice/:id/pay', (_req, res) => res.status(410).json({ success: false, message: 'Endpoint pembayaran simulasi telah dihapus. Pembayaran dikonfirmasi melalui provider resmi.' }));
}
module.exports = { registerInvoiceRoutes };
