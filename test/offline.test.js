// Tes offline: semua panggilan keluar (Shopee/GoBiz) dialihkan ke server tiruan, jadi aman dijalankan tanpa akun asli.
// Jalankan: npm test
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
process.env.ADMIN_PASSWORD = 'pw-test';
process.env.CRON_SECRET = 'cron-test';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'vp-test-' + process.pid, 'db.json');
const assert = require('assert');
const axios = require('axios');

const state = { txs: [], listCalls: 0, killToken: null, tokenSeq: 1, otpOk: '1234' };
const jwt = (tok, uid) => 'h.' + Buffer.from(JSON.stringify({ token: tok, userid: uid, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.s';
const J = (o, extra = {}) => ({ status: 200, headers: { ...extra }, data: JSON.stringify(o) });

function mock(cfg) {
  const u = new URL(cfg.url), p = u.pathname, h = cfg.headers || {};
  const body = typeof cfg.data === 'string' && cfg.data.startsWith('{') ? JSON.parse(cfg.data) : {};
  if (u.host === 'partner.business.accounts.shopee.co.id') {
    if (p === '/login') return { status: 200, headers: { 'set-cookie': ['csrftoken=csrf1; Path=/'] }, data: '<html>' };
    if (p.endsWith('check_password_migrate')) return J({ error: 0, data: {} });
    if (p.endsWith('check_account_exist_by_password')) return J({ error: 1, data: null });
    if (p.endsWith('authenticate_toc_by_password')) return J({ error: 0, data: {} });
    if (p.endsWith('get_otp_settings')) return J({ error: 0, data: { available_channel_list: [1, 3], default_channel: 3 } });
    if (p.endsWith('send_otp')) return J({ error: 0, data: {} });
    if (p.endsWith('verify_otp')) {
      assert.strictEqual(body.phone, '(+62) 812 3456 789');
      return body.otp === state.otpOk ? J({ error: 0, data: { otp_token: 'OT' } }) : J({ error: 1, error_msg: 'wrong otp', data: null });
    }
    if (p.endsWith('authenticate_toc_by_otp')) return J({ error: 0, data: { toc_nonce: 'NONCE', toc_account: { userid: 111 } } }, { 'set-cookie': ['SPC_CLIENTID=cid1; Path=/'] });
    if (p.startsWith('/authenticate/login/token')) return { status: 200, headers: {}, data: 'ok' };
    if (p.endsWith('login_toc')) return J({ error: 0, data: { nonce: 'CODE' } });
    if (p.endsWith('login_status')) return J({ error: state.accountDead ? 48500102 : 0, data: {} });
  }
  if (u.host === 'df.infra.sz.shopee.co.id') return J({ code: 0, data: { riskToken: 'RISK' } });
  if (u.host === 'partner.shopee.co.id') {
    if (p === '/account/login/auth' && !u.searchParams.get('hop')) return { status: 302, headers: { location: '/account/login/auth?hop=1' }, data: '' };
    if (p === '/account/login/auth') return { status: 200, headers: {}, data: 'ok' };
    if (p === '/account/login/tob/auth') {
      assert.strictEqual(u.searchParams.get('code'), 'CODE');
      return { status: 200, headers: { 'set-cookie': [`__shopee_partner_website_x_token_live=${jwt('B:LIVE' + state.tokenSeq++, 222)}; Path=/`] }, data: 'ok' };
    }
  }
  if (u.host === 'api.partner.shopee.co.id') {
    assert.ok(!h.Cookie, 'API partner tidak boleh kirim cookie');
    if (p.endsWith('MerchantDetect')) { assert.strictEqual(h['X-Merchant-ToC-Nonce'], 'NONCE'); return J({ errorCode: 0, data: { selectMerchant: { merchantList: [{ merchantId: 777, merchantName: 'Toko Uji', staffTobUid: 222, isActive: true, isBanned: false, isCurrentLoginUser: true }] } } }); }
    if (p.endsWith('GetUserInfo')) return J({ errorCode: 0, data: { merchantId: 777, merchantName: 'Toko Uji' } });
  }
  if (u.host === 'shopeepay.shopee.co.id') {
    state.listCalls++;
    const tok = body.data.metadata.token;
    if (tok === state.killToken) return J({ code: 200020, msg: 'invalid token', data: null });
    return J({ code: 0, data: { list: state.txs } });
  }
  throw new Error('request tidak terduga: ' + cfg.url);
}
axios.defaults.adapter = async cfg => { const r = mock(cfg); return { ...r, statusText: 'OK', config: cfg, request: {} }; };

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
  const STATIC = '00020101021126570011ID.CO.TEST0118936000000000000001520400005303360' + '5802ID5910TOKO UJI6007JAKARTA6304ABCD';
  let r = await call('GET', '/api/admin/status'); ok(r.s === 401, 'status tanpa login ditolak');
  r = await call('POST', '/api/admin/login', { password: 'salah' }); ok(r.s === 401, 'password salah ditolak');
  r = await call('POST', '/api/admin/login', { password: 'pw-test' }); ok(r.success && cookie.startsWith('vp='), 'login admin berhasil');

  r = await call('POST', '/api/shopee/otp', { phone: '12' }); ok(!r.success, 'nomor HP salah ditolak');
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789' }); ok(r.success && r.challenge && r.channel === 3, 'OTP ShopeePay terkirim, challenge terenkripsi');
  const ch = r.challenge;
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '9999' }); ok(!r.success, 'OTP salah ditolak');
  r = await call('POST', '/api/shopee/verify', { challenge: 'ngawur', otp: '1234' }); ok(!r.success, 'challenge palsu ditolak');
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '1234' }); ok(r.success && r.merchant === 'Toko Uji', 'verifikasi OTP + login merchant berhasil');
  r = await call('GET', '/api/admin/status'); ok(r.shopee.token && r.shopee.otp && r.shopee.merchant === 'Toko Uji', 'status: token & sesi OTP tersimpan');

  r = await call('POST', '/api/admin/config', { provider: 'shopee', qris: STATIC }); ok(r.success, 'QRIS statis ShopeePay disimpan');
  r = await call('POST', '/api/admin/config', { provider: 'gopay', qris: STATIC }); ok(r.success, 'QRIS statis GoMerch disimpan');

  r = await call('POST', '/api/pay/create', { provider: 'shopee', amount: 15000 }); ok(r.success && r.image.startsWith('data:image/png'), 'QRIS dinamis dibuat');
  const created = r.created_at;
  r = await call('POST', '/api/pay/check', { provider: 'shopee', amount: 15000, created_at: created }); ok(r.status === 'PENDING', 'belum bayar = PENDING');
  state.txs = [{ transactionId: '239706725649854541', amount: '15.000', status: 3, createTime: Math.floor(Date.now() / 1000) + 2 }];
  r = await call('POST', '/api/pay/check', { provider: 'shopee', amount: 15000, created_at: created }); ok(r.status === 'PAID' && r.data.id === '239706725649854541', 'sudah bayar = PAID, ID 18 digit utuh');
  r = await call('POST', '/api/pay/check', { provider: 'shopee', amount: 15000, created_at: created }); ok(r.status === 'PENDING', 'struk yang sama tidak bisa diklaim dua kali');
  r = await call('POST', '/api/pay/check', { provider: 'shopee', amount: 15000, created_at: new Date(Date.now() - 3600e3).toISOString() }); ok(r.status === 'EXPIRED', 'created_at dimundurin ditolak');

  const t1 = (await call('GET', '/api/admin/status')).success; state.killToken = 'B:LIVE1'; state.txs = [{ transactionId: '1', amount: '20.000', status: 3, createTime: Math.floor(Date.now() / 1000) }];
  r = await call('GET', '/api/pay/history?provider=shopee'); ok(r.success && r.data.length === 1, 'token mati -> otomatis diperpanjang tanpa OTP baru, riwayat tetap jalan');
  const db = JSON.parse(require('fs').readFileSync(process.env.DB_PATH, 'utf8'));
  ok(db.kv['cfg:shopee'].token === 'B:LIVE2', 'token baru tersimpan di file database');
  state.accountDead = true; state.killToken = 'B:LIVE2';
  r = await call('GET', '/api/pay/history?provider=shopee'); ok(!r.success && /login OTP/i.test(r.error), 'sesi akun mati -> pesan jelas minta login OTP lagi');
  state.accountDead = false;

  r = await call('GET', '/api/cron/refresh'); ok(r.s === 401, 'cron tanpa secret ditolak');
  const cr = await fetch(base() + '/api/cron/refresh', { headers: { authorization: 'Bearer cron-test' } }); ok(cr.status === 200, 'cron dengan secret jalan');

  r = await call('POST', '/api/shopee/logout'); ok(r.success, 'logout ShopeePay');
  r = await call('GET', '/api/admin/status'); ok(!r.shopee.otp && !r.shopee.token, 'sesi & token terhapus');
  const mode = require('fs').statSync(process.env.DB_PATH).mode & 0o777; ok(mode === 0o600, 'file database izin 600');

  for (let i = 0; i < 7; i++) r = await call('POST', '/api/admin/login', { password: 'x' + i });
  ok(r.s === 429, 'brute-force password kena batas');

  console.log('\nSEMUA TES LULUS (' + n + ')'); srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
