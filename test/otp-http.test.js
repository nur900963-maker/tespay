// Tes integrasi HTTP untuk alur OTP ShopeePay (tanpa views/, tanpa akun asli).
// Memastikan endpoint /api/shopee/otp & /api/shopee/diagnose berperilaku benar,
// error captcha/device sampai ke klien dengan code + hint, rate limit berlapis
// bekerja, challenge tidak bisa dipakai dua kali, dan audit trail terisi.
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
process.env.ADMIN_PASSWORD = 'pw-test';
process.env.SHOPEE_DEVICE_ID = 'device-tetap-untuk-tes';
const TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vp-otp-'));
process.env.DB_PATH = require('path').join(TMP, 'db.json');
process.env.KV_PATH = require('path').join(TMP, 'kv.json');
process.env.IDENTITY_PATH = require('path').join(TMP, 'identity.json');
process.env.AUDIT_PATH = require('path').join(TMP, 'audit.jsonl');

const assert = require('assert');
const { state } = require('./mock');
const app = require('../app');
const guard = require('../lib/guard');
const audit = require('../lib/audit');
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
  let r = await call('POST', '/api/admin/login', { password: 'pw-test' });
  ok(r.success, 'login admin');

  // 1. OTP sukses + trace + bukti pengiriman
  state.migrateError = 1; state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.success && r.challenge, 'POST /api/shopee/otp sukses');
  ok(state.sendOtpCalls === 1, 'send_otp benar-benar dipanggil ke Shopee');
  ok(r.send_verified === true, 'respons menyatakan OTP terverifikasi terkirim');
  ok(r.evidence && r.evidence.otp_token, 'respons membawa bukti pengiriman');
  ok(Array.isArray(r.trace) && r.trace.some(s => s.step === 'send_otp'), 'respons membawa trace langkah');
  ok(!JSON.stringify(r.trace).includes('rahasia'), 'trace tidak membocorkan password');

  // 2. cooldown per nomor: kirim ulang langsung ditolak
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.s === 429 && r.code === 'RATE_LIMITED', 'kirim ulang < 60 detik ditolak (cooldown per nomor)');
  ok(typeof r.retry_after === 'number' && r.retry_after > 0, 'respons rate limit membawa retry_after');

  // 3. captcha -> 429 + code + hint + state retry
  guard.resetAll();
  state.captcha = true;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.s === 429 && r.code === 'CAPTCHA_REQUIRED', 'captcha -> HTTP 429 + code CAPTCHA_REQUIRED');
  ok(typeof r.hint === 'string' && r.hint.length > 10, 'respons captcha membawa hint perbaikan');
  ok(typeof r.retry === 'string' && r.retry.length > 20, 'respons captcha membawa state retry terenkripsi');

  // 4. retry setelah captcha diselesaikan -> sukses tanpa ulang dari nol
  state.captcha = false;
  state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/otp/retry', { retry: r.retry, captcha_signature: 'SIG-OK', phone: '0812-3456-789' });
  ok(r.success && r.send_verified === true, 'retry setelah captcha berhasil & terverifikasi');
  ok(state.sendOtpCalls === 1, 'retry hanya memanggil send_otp sekali');
  ok(state.lastSendOtp.captcha_signature === 'SIG-OK', 'retry memakai captcha_signature yang ditempel');

  // 4b. captcha dengan GAMBAR: server harus meneruskan gambar + token ke UI,
  //     dan jawaban captcha harus ikut terkirim ke send_otp.
  guard.resetAll();
  state.captcha = true; state.captchaImage = true;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.s === 429 && r.code === 'CAPTCHA_REQUIRED', 'captcha bergambar -> CAPTCHA_REQUIRED');
  ok(r.captcha && r.captcha.has_image === true, 'respons membawa gambar captcha untuk ditampilkan UI');
  ok(/^data:image\/png;base64,/.test(r.captcha.image), 'gambar captcha dinormalisasi jadi data URI PNG');
  ok(r.captcha.token === 'CAPTOK' && r.captcha.scene_id === 'scene-1', 'token & scene captcha ikut dikirim');
  ok(typeof r.captcha.instruction === 'string' && r.captcha.instruction.length > 20, 'ada instruksi captcha untuk user');
  const retryImg = r.retry;
  state.captcha = false; state.captchaImage = false; state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/otp/retry', { retry: retryImg, captcha_answer: 'AB12', captcha_token: 'CAPTOK', captcha_scene_id: 'scene-1', phone: '0812-3456-789' });
  ok(r.success && r.send_verified === true, 'retry dengan jawaban captcha berhasil');
  ok(state.lastSendOtp.captcha === 'AB12' && state.lastSendOtp.captcha_code === 'AB12', 'jawaban captcha diteruskan ke send_otp');
  ok(state.lastSendOtp.captcha_token === 'CAPTOK', 'captcha_token diteruskan ke send_otp');
  ok(!('captcha_signature' in state.lastSendOtp), 'captcha_signature kosong TIDAK dikirim sebagai string kosong');

  // 5. diagnose tidak memicu OTP
  guard.resetAll();
  state.sendOtpCalls = 0;
  r = await call('POST', '/api/shopee/diagnose', { phone: '0812-3456-789', password: 'rahasia' });
  ok(r.success && Array.isArray(r.steps), 'POST /api/shopee/diagnose mengembalikan langkah');
  ok(state.sendOtpCalls === 0, 'diagnose tidak memicu send_otp');
  ok(r.steps.some(s => s.step === 'device_risk' && s.ok), 'diagnose: device_risk OK');
  ok(r.identity && r.identity.deviceId, 'diagnose melaporkan identitas perangkat');
  ok(typeof r.verdict === 'string', 'diagnose memberi verdict');

  // 6. verify penuh lewat HTTP
  guard.resetAll();
  state.migrateError = 0;
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789', password: 'rahasia' });
  const ch = r.challenge;
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '1234', phone: '0812-3456-789' });
  ok(r.success && r.merchant === 'Toko Uji' && r.token, 'verify OTP -> token merchant');

  // 7. anti-replay: challenge yang sama tidak bisa dipakai lagi
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '1234', phone: '0812-3456-789' });
  ok(!r.success && r.s === 409, 'challenge yang sudah dipakai ditolak (anti-replay)');

  // 8. identitas perangkat bisa di-capture dari browser
  r = await call('GET', '/api/shopee/identity');
  ok(r.success && r.identity.deviceId === 'device-tetap-untuk-tes', 'GET identitas perangkat');
  r = await call('POST', '/api/shopee/identity', { device_report: '{"device_id":"abc","events":[{"type":"page_view"}]}', szdet: 'SZDET-ASLI', captcha_signature: 'CAP-ASLI' });
  ok(r.success && r.identity.hasDeviceReport && r.identity.hasSzdet, 'capture device report + szdet tersimpan');
  r = await call('POST', '/api/shopee/identity', { device_report: 'bukan json' });
  ok(!r.success, 'device_report bukan JSON ditolak');
  r = await call('POST', '/api/shopee/identity/reset');
  ok(r.success && !r.identity.hasDeviceReport, 'reset identitas kembali ke turunan');

  // 9. audit trail terisi & tidak membocorkan rahasia
  r = await call('GET', '/api/shopee/audit?limit=100');
  ok(r.success && r.events.length > 0, 'audit trail berisi event');
  ok(r.events.some(e => e.action === 'request' && e.outcome === 'ok'), 'audit mencatat request OTP sukses');
  ok(r.events.some(e => e.action === 'retry' && e.outcome === 'ok'), 'audit mencatat retry captcha');
  ok(r.events.some(e => e.action === 'verify' && e.outcome === 'ok'), 'audit mencatat verifikasi');
  const raw = JSON.stringify(r.events);
  ok(!raw.includes('rahasia') && !raw.includes('SIG-OK') && !raw.includes('AB12'), 'audit tidak menyimpan password / captcha / OTP');
  ok(raw.includes('6281'), 'audit menyimpan nomor dalam bentuk disamarkan');
  ok(r.stats && r.stats.backend, 'audit melaporkan backend penyimpanan yang dipakai');

  console.log('\nSEMUA TES HTTP OTP LULUS (' + n + ')');
  srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); srv.close(); process.exit(1); });
