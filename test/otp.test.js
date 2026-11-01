// Tes regresi khusus alur request OTP ShopeePay (tanpa akun asli, tanpa view).
// Fokus: memastikan send_otp BENAR-BENAR dipanggil, dan hambatan captcha/device
// dilaporkan dengan kode yang bisa ditindaklanjuti.
//
// Jalankan: node test/otp.test.js
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
process.env.SHOPEE_DEVICE_ID = 'device-tetap-untuk-tes';

const assert = require('assert');
const { state } = require('./mock');          // memasang adapter axios tiruan
const sauth = require('../lib/shopeeAuth');
const { buildDeviceReport, DEVICE_ID } = require('../lib/device');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };

(async () => {
  // ---------- 1. device identity ----------
  const rep = JSON.parse(buildDeviceReport());
  ok(rep.device_id === DEVICE_ID && rep.device_id === 'device-tetap-untuk-tes', 'device_id stabil dari env, bukan acak');
  ok(Array.isArray(rep.events) && rep.events.length > 0, 'body telemetri terisi (bukan {})');

  // ---------- 2. check_password_migrate error != 0 tidak boleh mematikan alur ----------
  state.migrateError = 1;   // akun tidak perlu migrasi password -> Shopee balas error != 0
  state.sendOtpCalls = 0;
  let ch = await sauth.requestOtp('0812-3456-789', { password: 'rahasia' });
  ok(state.sendOtpCalls === 1, 'send_otp tetap dipanggil walau check_password_migrate error != 0');
  ok(ch.channel === 3 && ch.channels.includes(3), 'channel OTP dipilih dari get_otp_settings');
  ok(ch.trace.some(s => s.step === 'send_otp'), 'trace mencatat langkah send_otp');
  ok(ch.trace.some(s => s.step === 'check_password_migrate' && s.error === 1), 'trace mencatat error migrate apa adanya');

  // ---------- 3. captcha_signature diteruskan, tidak hardcode '' ----------
  ok(state.lastSendOtp.captcha_signature === '', 'default captcha_signature kosong');
  state.sendOtpCalls = 0;
  await sauth.requestOtp('0812-3456-789', { password: 'rahasia', captchaSignature: 'SIG-XYZ' });
  ok(state.lastSendOtp.captcha_signature === 'SIG-XYZ', 'captcha_signature dari parameter diteruskan ke send_otp');

  // ---------- 4. security_device_fingerprint terisi di setiap langkah ----------
  ok(state.lastSendOtp.security_device_fingerprint === 'RISK', 'send_otp membawa risk token perangkat');
  ok(state.lastSendOtp.phone === '628123456789', 'nomor dikirim sebagai 62...');

  // ---------- 5. captcha dari Shopee -> error CAPTCHA_REQUIRED + hint ----------
  state.captcha = true;
  let err = null;
  try { await sauth.requestOtp('0812-3456-789', { password: 'rahasia' }); } catch (e) { err = e; }
  ok(err && err.code === sauth.E_CAPTCHA, 'captcha_required dipetakan ke CAPTCHA_REQUIRED');
  ok(err && err.status === 429 && /captcha/i.test(err.message), 'status 429 + pesan jelas soal captcha');
  ok(err && typeof err.hint === 'string' && err.hint.length > 10, 'ada hint langkah perbaikan');
  state.captcha = false;

  // ---------- 6. password salah / tidak diisi ----------
  state.migrateError = 0;
  const origByPw = state.byPasswordError;
  // mock membalas error 0 untuk byPassword; simulasikan NEED_OTP lewat flag
  state.needPassword = true;
  err = null;
  try { await sauth.requestOtp('0812-3456-789', {}); } catch (e) { err = e; }
  ok(err && err.code === 'PASSWORD_REQUIRED', 'akun ber-password tanpa password -> PASSWORD_REQUIRED');
  state.needPassword = false;

  // ---------- 7. hash password ----------
  const crypto = require('crypto');
  const expect = crypto.createHash('sha256').update(crypto.createHash('md5').update('rahasia', 'utf8').digest('hex'), 'utf8').digest('hex');
  ok(sauth.hashPw('rahasia') === expect, 'hash password = sha256(md5(pw)) seperti portal Shopee');

  // ---------- 8. diagnose tidak memanggil send_otp ----------
  state.sendOtpCalls = 0;
  const d = await sauth.diagnose('0812-3456-789', { password: 'rahasia' });
  ok(state.sendOtpCalls === 0, 'diagnose berhenti sebelum send_otp (tidak memicu OTP/rate limit)');
  ok(d.steps.some(s => s.step === 'device_risk' && s.ok), 'diagnose melaporkan device_risk OK');
  ok(typeof d.verdict === 'string', 'diagnose memberi verdict');

  // ---------- 9. verifikasi OTP penuh ----------
  ch = await sauth.requestOtp('0812-3456-789', { password: 'rahasia' });
  const ver = await sauth.verifyOtp(ch, '1234');
  ok(ver.merchants.length === 1 && ver.merchants[0].name === 'Toko Uji', 'verify OTP mengembalikan daftar merchant');
  const ses = await sauth.completeLogin(ver);
  ok(ses.token.startsWith('B:LIVE'), 'completeLogin menghasilkan token merchant');
  ok(ses.renew && ses.renew.risk === 'RISK', 'sesi menyimpan data renew untuk perpanjangan tanpa OTP');

  console.log('\nSEMUA TES OTP LULUS (' + n + ')');
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
