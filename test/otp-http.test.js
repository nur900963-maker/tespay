// Tes integrasi HTTP untuk alur OTP ShopeePay (tanpa views/, tanpa akun asli).
// Memastikan endpoint /api/shopee/otp & /api/shopee/diagnose berperilaku benar
// dan error captcha/device sampai ke klien dengan code + hint.
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
process.env.ADMIN_PASSWORD = 'pw-test';
// config.js di repo ini mengisi ADMIN_PASSWORD dan nilainya MENANG atas env.
const PW = require('../config.js').ADMIN_PASSWORD || 'pw-test';
process.env.SHOPEE_DEVICE_ID = 'device-tetap-untuk-tes';
process.env.DB_PATH = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vp-otp-')), 'db.json');

const assert = require('assert');
const { state } = require('./mock');
const app = require('../app');
const srv = app.listen(0);
const base = () => 'http://127.0.0.1:' + srv.address().port;
let cookie = '';
const call = async (m, u, b) => {
  const r = await fetch(base() + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { s: r.status, ...(await r.json().catch(() => ({}))) };
};
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };

(async () => {
  let r = await call('POST', '/api/admin/login', { password: PW });
  ok(r.success, 'login admin');

  // 1. OTP sukses + trace
  state.migrateError = 1; state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.success && r.challenge, 'POST /api/shopee/otp sukses');
  ok(state.sendOtpCalls === 1, 'send_otp benar-benar dipanggil ke Shopee');
  ok(Array.isArray(r.trace) && r.trace.some(s => s.step === 'send_otp'), 'respons membawa trace langkah');
  ok(!JSON.stringify(r.trace).includes('rahasia'), 'trace tidak membocorkan password');

  // 2. captcha -> 429 + code + hint
  state.captcha = true;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.s === 429 && r.code === 'CAPTCHA_REQUIRED', 'captcha -> HTTP 429 + code CAPTCHA_REQUIRED');
  ok(typeof r.hint === 'string' && r.hint.length > 10, 'respons captcha membawa hint perbaikan');
  state.captcha = false;

  // 3. diagnose tidak memicu OTP
  state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/diagnose', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.success && Array.isArray(r.steps), 'POST /api/shopee/diagnose mengembalikan langkah');
  ok(state.sendOtpCalls === 0, 'diagnose tidak memicu send_otp');
  ok(r.steps.some(s => s.step === 'device_risk' && s.ok), 'diagnose: device_risk OK');
  ok(typeof r.verdict === 'string', 'diagnose memberi verdict');

  // 4. verify penuh lewat HTTP
  state.migrateError = 0;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  const ch = r.challenge;
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '1234' });
  ok(r.success && r.merchant === 'Toko Uji' && r.token, 'verify OTP -> token merchant');

  console.log('\nSEMUA TES HTTP OTP LULUS (' + n + ')');
  srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); srv.close(); process.exit(1); });
