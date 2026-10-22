'use strict';
const crypto = require('crypto');
const db = require('../db');
const TIMEOUT_MS = 10000;
function sign(body, secret) { return crypto.createHmac('sha256', secret).update(body).digest('hex'); }
async function deliver(log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const user = await db.one('SELECT webhook_secret FROM users WHERE id = ?', [log.user_id]).catch(() => null);
    const secret = user?.webhook_secret || process.env.WEBHOOK_SIGNING_SECRET || process.env.JWT_SECRET || '';
    const res = await fetch(log.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VincentPay-Event': log.event,
        'X-VincentPay-Id': log.id, 'X-VincentPay-Signature': sign(log.payload, secret), 'User-Agent': 'VincentPay-Webhook/1.0' },
      body: log.payload, signal: controller.signal
    });
    const body = (await res.text()).slice(0, 800);
    const ok = res.status >= 200 && res.status < 300;
    await db.run('UPDATE webhook_logs SET status_code=?,response=?,attempt=attempt+1,state=? WHERE id=?', [res.status, body, ok ? 'success' : 'failed', log.id]);
    return { ok, status: res.status, response: body };
  } catch (error) {
    await db.run("UPDATE webhook_logs SET response=?,attempt=attempt+1,state='failed' WHERE id=?", [String(error.message || error).slice(0, 500), log.id]);
    return { ok: false, status: 0, response: String(error.message || error) };
  } finally { clearTimeout(timer); }
}
async function dispatchWebhook(user, transaction, event = 'payment.paid') {
  if (!user || !user.webhook_enabled || !user.webhook_url) return { skipped: true };
  const payload = JSON.stringify({ event, created_at: db.now(), data: {
    id: transaction.id, reference: transaction.reference, type: transaction.type, amount: transaction.amount,
    fee: transaction.fee, total: transaction.total, status: transaction.status, channel: transaction.channel,
    payment_link: transaction.payment_link, created_at: transaction.created_at, completed_at: transaction.completed_at,
    balance_after: transaction.balance_after
  }});
  const log = { id: db.genId('WH'), user_id: user.id, transaction_id: transaction.id, event, url: user.webhook_url, payload };
  await db.run(`INSERT INTO webhook_logs (id,user_id,transaction_id,event,url,payload,status_code,attempt,response,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [log.id, log.user_id, log.transaction_id, log.event, log.url, log.payload, null, 0, null, 'pending', db.now()]);
  setImmediate(() => { deliver(log).catch((e) => console.error('[webhook]', e.message)); });
  return { queued: true, log_id: log.id };
}
async function retryWebhookLog(logId, userId) {
  const log = await db.one('SELECT * FROM webhook_logs WHERE id = ? AND user_id = ?', [logId, userId]);
  if (!log) return null;
  return deliver(log);
}
async function testWebhook(user) {
  const fake = { id: 'TEST-WEBHOOK', reference: 'TEST-WEBHOOK', type: 'deposit', amount: 1000, fee: 250,
    total: 1250, status: 'test', channel: 'test', payment_link: null, created_at: db.now(), completed_at: db.now(), balance_after: user.balance };
  const payload = JSON.stringify({ event: 'webhook.test', test: true, created_at: db.now(), data: fake });
  const log = { id: db.genId('WH'), user_id: user.id, event: 'webhook.test', url: user.webhook_url, payload };
  if (!user.webhook_url) return { ok: false, message: 'URL webhook belum diisi.' };
  return deliver(log);
}
module.exports = { dispatchWebhook, retryWebhookLog, testWebhook };
