// Tes regresi khusus alur request OTP ShopeePay (tanpa akun asli, tanpa view).
// Fokus: memastikan send_otp BENAR-BENAR terkirim + TERVERIFIKASI, identitas
// perangkat stabil, dan hambatan captcha/device dilaporkan dengan kode yang bisa
// ditindaklanjuti.
//
// Jalankan: node test/otp.test.js
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
process.env.SHOPEE_DEVICE_ID = 'device-tetap-untuk-tes';
process.env.IDENTITY_PATH = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vp-id-')), 'identity.json');
process.env.KV_PATH = require('path').join(require('path').dirname(process.env.IDENTITY_PATH), 'kv.json');

const assert = require('assert');
const { state } = require('./mock');          // memasang adapter axios tiruan
const sauth = require('../lib/shopeeAuth');
const device = require('../lib/device');
const identity = require('../lib/identity');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };

(async () => {
  // ---------- 1. device identity ----------
  const rep = JSON.parse(device.buildDeviceReport());
  ok(rep.device_id === device.DEVICE_ID() && rep.device_id === 'device-tetap-untuk-tes', 'device_id stabil dari env, bukan acak');
  ok(Array.isArray(rep.events) && rep.events.length > 0, 'body telemetri terisi (bukan {})');
  ok(rep.timezone === 'Asia/Jakarta' && rep.screen === '1920x1080', 'profil perangkat konsisten (timezone, layar)');
  ok(device.szdet() && device.szdet() !== String(Date.now()), 'szdet bukan timestamp mentah');
  ok(device.szdet().length > 20, 'szdet berbentuk payload bertanda tangan');
  ok(identity.snapshot().deviceId === 'device-tetap-untuk-tes', 'identity.snapshot melaporkan device id yang dipakai');

  // ---------- 2. check_password_migrate error != 0 tidak boleh mematikan alur ----------
  state.migrateError = 1;   // akun tidak perlu migrasi password -> Shopee balas error != 0
  state.sendOtpCalls = 0;
  let ch = await sauth.requestOtp('0812-3456-789', { password: 'rahasia' });
  ok(state.sendOtpCalls === 1, 'send_otp tetap dipanggil walau check_password_migrate error != 0');
  ok(ch.channel === 3 && ch.channels.includes(3), 'channel OTP dipilih dari get_otp_settings');
  ok(ch.trace.some(s => s.step === 'send_otp'), 'trace mencatat langkah send_otp');
  ok(ch.trace.some(s => s.step === 'check_password_migrate' && s.error === 1), 'trace mencatat error migrate apa adanya');

  // ---------- 3. bukti pengiriman diverifikasi ----------
  ok(ch.sendVerified === true, 'send_otp diverifikasi: ada bukti pengiriman');
  ok(ch.sendEvidence && ch.sendEvidence.otp_token === 'OTPSEND', 'bukti pengiriman (otp_token) ikut dikembalikan');
  ok(ch.sendEvidence.expire === 300, 'bukti pengiriman membawa masa berlaku');

  // ---------- 4. balasan kosong = OTP TIDAK terkirim (bukan sukses palsu) ----------
  state.emptySendOtp = true;
  let err = null;
  try { await sauth.requestOtp('0812-3456-789', { password: 'rahasia' }); } catch (e) { err = e; }
  ok(err && err.code === sauth.E_UNVERIFIED, 'data kosong -> OTP_UNVERIFIED, bukan sukses palsu');
  ok(err && err.retry && err.retry.stage === 'send_otp', 'error membawa state retry (tidak perlu ulang dari nol)');
  state.emptySendOtp = false;

  // ---------- 5. captcha_signature diteruskan, tidak hardcode '' ----------
  ok(!('captcha_signature' in state.lastSendOtp), 'tanpa captcha: field captcha_signature tidak dikirim (bukan string kosong)');
  state.sendOtpCalls = 0;
  await sauth.requestOtp('0812-3456-789', { password: 'rahasia', captchaSignature: 'SIG-XYZ' });
  ok(state.lastSendOtp.captcha_signature === 'SIG-XYZ', 'captcha_signature dari parameter diteruskan ke send_otp');

  // ---------- 6. security_device_fingerprint terisi di setiap langkah ----------
  ok(state.lastSendOtp.security_device_fingerprint === 'RISK', 'send_otp membawa risk token perangkat');
  ok(state.lastSendOtp.phone === '628123456789', 'nomor dikirim sebagai 62...');

  // ---------- 7. captcha dari Shopee -> error CAPTCHA_REQUIRED + hint + retry ----------
  state.captcha = true;
  err = null;
  try { await sauth.requestOtp('0812-3456-789', { password: 'rahasia' }); } catch (e) { err = e; }
  ok(err && err.code === sauth.E_CAPTCHA, 'captcha_required dipetakan ke CAPTCHA_REQUIRED');
  ok(err && err.status === 429 && /captcha/i.test(err.message), 'status 429 + pesan jelas soal captcha');
  ok(err && typeof err.hint === 'string' && err.hint.length > 10, 'ada hint langkah perbaikan');
  ok(err && err.retry && err.retry.risk === 'RISK', 'state retry membawa risk token yang sudah didapat');
  ok(err && err.captcha && err.captcha.has_image === false, 'captcha tanpa gambar: detail tetap dikirim (has_image=false)');
  ok(err && typeof err.captcha.instruction === 'string' && /DevTools|browser/i.test(err.captcha.instruction), 'instruksi captcha menunjuk ke browser/DevTools');

  // ---------- 8. retry setelah captcha: TIDAK ulang login page / device-risk ----------
  state.captcha = false;
  state.sendOtpCalls = 0;
  const retried = await sauth.retrySendOtp(err.retry, { captchaSignature: 'SIG-CAPTCHA' });
  ok(state.sendOtpCalls === 1, 'retry hanya memanggil send_otp sekali');
  ok(state.lastSendOtp.captcha_signature === 'SIG-CAPTCHA', 'retry memakai captcha_signature baru');
  ok(retried.sendVerified === true, 'retry berhasil dan terverifikasi');
  ok(retried.trace.filter(s => s.step === 'device_risk').length === 1, 'retry tidak mengulang device_risk');

  // ---------- 9. password salah / tidak diisi ----------
  state.migrateError = 0;
  state.needPassword = true;
  err = null;
  try { await sauth.requestOtp('0812-3456-789', {}); } catch (e) { err = e; }
  ok(err && err.code === 'PASSWORD_REQUIRED', 'akun ber-password tanpa password -> PASSWORD_REQUIRED');
  state.needPassword = false;

  // ---------- 10. hash password ----------
  const crypto = require('crypto');
  const expect = crypto.createHash('sha256').update(crypto.createHash('md5').update('rahasia', 'utf8').digest('hex'), 'utf8').digest('hex');
  ok(sauth.hashPw('rahasia') === expect, 'hash password = sha256(md5(pw)) seperti portal Shopee');

  // ---------- 11. diagnose tidak memanggil send_otp ----------
  state.sendOtpCalls = 0;
  const d = await sauth.diagnose('0812-3456-789', { password: 'rahasia' });
  ok(state.sendOtpCalls === 0, 'diagnose berhenti sebelum send_otp (tidak memicu OTP/rate limit)');
  ok(d.steps.some(s => s.step === 'device_risk' && s.ok), 'diagnose melaporkan device_risk OK');
  ok(d.identity && d.identity.deviceId, 'diagnose melaporkan identitas perangkat');
  ok(typeof d.verdict === 'string', 'diagnose memberi verdict');

  // ---------- 12. verifikasi OTP penuh ----------
  ch = await sauth.requestOtp('0812-3456-789', { password: 'rahasia' });
  const ver = await sauth.verifyOtp(ch, '1234');
  ok(ver.merchants.length === 1 && ver.merchants[0].name === 'Toko Uji', 'verify OTP mengembalikan daftar merchant');
  const ses = await sauth.completeLogin(ver);
  ok(ses.token.startsWith('B:LIVE'), 'completeLogin menghasilkan token merchant');
  ok(ses.renew && ses.renew.risk === 'RISK', 'sesi menyimpan data renew untuk perpanjangan tanpa OTP');

  console.log('\nSEMUA TES OTP LULUS (' + n + ')');
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
