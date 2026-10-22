'use strict';
const db = require('../db');

const DEFAULTS = {
  qris_fee: 250, qris_fee_percent: 0, deposit_min: 1000, deposit_max: 10000000,
  withdrawal_fee_dana: 250, withdrawal_fee_gopay: 250, withdrawal_fee_shopeepay: 250,
  withdrawal_fee_manual: 250, withdrawal_min: 10000, withdrawal_max: 5000000,
  withdrawals_enabled: 1
};
async function getPricingConfig() {
  const values = await db.getSettings();
  return { ...DEFAULTS, ...values };
}
async function depositFee(amount) {
  const c = await getPricingConfig();
  const fixed = Math.max(0, Number(c.qris_fee) || 0);
  const percent = Math.max(0, Number(c.qris_fee_percent) || 0);
  return Math.round(fixed + amount * percent / 100);
}
async function withdrawFee(channel) {
  const c = await getPricingConfig();
  const key = `withdrawal_fee_${String(channel || '').toLowerCase()}`;
  return Object.prototype.hasOwnProperty.call(c, key) ? Math.max(0, Number(c[key]) || 0) : null;
}
async function pricingPayload() {
  const c = await getPricingConfig();
  return {
    deposit: [{ min: Number(c.deposit_min), max: Number(c.deposit_max), fee: Number(c.qris_fee), fee_percent: Number(c.qris_fee_percent) }],
    withdrawal: ['DANA','GOPAY','SHOPEEPAY','MANUAL'].map((code) => ({
      code, name: code === 'GOPAY' ? 'GoPay' : code === 'SHOPEEPAY' ? 'ShopeePay' : code === 'DANA' ? 'DANA' : 'Manual',
      fee: Number(c[`withdrawal_fee_${code.toLowerCase()}`] ?? c.withdrawal_fee_manual), min: Number(c.withdrawal_min), max: Number(c.withdrawal_max)
    })),
    deposit_min: Number(c.deposit_min), deposit_max: Number(c.deposit_max), qris_fee: Number(c.qris_fee),
    qris_fee_percent: Number(c.qris_fee_percent), withdrawal_min: Number(c.withdrawal_min),
    withdrawal_max: Number(c.withdrawal_max), withdrawals_enabled: !!Number(c.withdrawals_enabled),
    notes: {
      settlement: 'Status lunas diubah hanya setelah status pembayaran dikonfirmasi provider.',
      deposit: 'Biaya transaksi sesuai pengaturan admin. Total tagihan = nominal + biaya QRIS.',
      withdrawal: 'Permintaan penarikan masuk antrean admin. Saldo ditahan sampai permintaan disetujui atau dikembalikan jika ditolak.'
    }
  };
}
module.exports = { DEFAULTS, getPricingConfig, depositFee, withdrawFee, pricingPayload };
