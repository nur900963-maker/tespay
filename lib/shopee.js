// Client ShopeePay Partner Portal (unofficial, read-only).
const axios = require('axios');
const LIST = 'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const STATUS = { 1: 'pending', 2: 'failed', 3: 'success', 4: 'refunded', 5: 'expired' };

const cleanAmount = v => parseInt(String(v || '0').replace(/[.,]/g, ''), 10) || 0;

async function list(token, { startTime, endTime, pageSize = 20, nextPos = '' }) {
  const { data } = await axios.post(LIST, {
    data: {
      metadata: { token, language: 'id', timezone: 'Asia/Jakarta' },
      pageSize,
      filter: { startTime, endTime, serviceList: [1, 3] },
      sorter: { field: 'createTime', order: 'descend' },
      next_position: nextPos,
    },
  }, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json', Origin: 'https://partner.shopee.co.id', Referer: 'https://partner.shopee.co.id/', 'User-Agent': UA, 'X-Timestamp-Ms': String(Date.now()) },
    // ID transaksi 18 digit: kutip dulu supaya tidak rusak oleh pembulatan JS
    transformResponse: [raw => JSON.parse(String(raw).replace(/("(?:transactionId|displayTransactionId)"\s*:\s*)(\d{15,})/g, '$1"$2"'))],
  });
  if (Number(data.code) !== 0) throw Object.assign(new Error(data.msg || `ShopeePay error code ${data.code}`), { code: data.code });
  return (data.data?.list || []).map(t => ({
    id: String(t.transactionId || t.displayTransactionId),
    amount: cleanAmount(t.amount),
    status: STATUS[t.status] || `unknown_${t.status}`,
    time: Number(t.createTime),
  }));
}

module.exports = { list };
