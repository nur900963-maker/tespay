// Tes mode publik: TIDAK ada env apa pun (tanpa ADMIN_PASSWORD, SESSION_SECRET, CRON_SECRET).
for (const k of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'CRON_SECRET', 'BOT_API_KEY']) delete process.env[k];
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'vp-pub-' + process.pid, 'db.json');
const assert = require('assert');
const { state } = require('./mock');
const app = require('../app');
const srv = app.listen(0);
const base = () => 'http://127.0.0.1:' + srv.address().port;
const call = async (m, u, b, h = {}) => {
  const r = await fetch(base() + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, ...(await r.json().catch(() => ({}))) };
};
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };
const STATIC = '00020101021126570011ID.CO.TEST0118936000000000000001520400005303360' + '5802ID5910TOKO UJI6007JAKARTA6304ABCD';

(async () => {
  const home = await (await fetch(base() + '/')).text();
  ok(home.includes('Vincent Pay') && home.includes('× GoMerch × ShopeePay'), 'halaman utama terbuka tanpa login, ada nama Vincent Pay × GoMerch × ShopeePay');
  ok(!home.includes('id="adm"') && !/tidak resmi/i.test(home) && !/tidak berafiliasi/i.test(home), 'tidak ada tombol admin dan tidak ada tulisan "tidak resmi"');
  ok(home.includes('const ADMIN=true') && home.includes('LOCKED=false'), 'semua menu terbuka (ADMIN=true, LOCKED=false)');

  let r = await call('GET', '/api/admin/status'); ok(r.success, 'status bisa diakses tanpa login');
  r = await call('POST', '/api/shopee/otp', { phone: '0812-3456-789' }); ok(r.success && r.challenge, 'OTP ShopeePay jalan tanpa env apa pun');
  const ch = r.challenge;
  r = await call('POST', '/api/shopee/verify', { challenge: ch, otp: '1234' }); ok(r.success && r.merchant === 'Toko Uji', 'verifikasi OTP berhasil (challenge terenkripsi tanpa SESSION_SECRET)');
  r = await call('POST', '/api/admin/config', { provider: 'shopee', qris: STATIC }); ok(r.success, 'simpan QRIS statis tanpa login');
  r = await call('POST', '/api/admin/config', { provider: 'gopay', qris: STATIC }); ok(r.success, 'QRIS GoMerch juga');
  r = await call('POST', '/api/pay/create', { provider: 'shopee', amount: 12345 }); ok(r.success && r.qr_string && r.image, 'QRIS dibuat (qr_string + gambar)');
  const created = r.created_at;
  state.txs = [{ transactionId: '9001', amount: '12.345', status: 3, createTime: Math.floor(Date.now() / 1000) + 2 }];
  r = await call('POST', '/api/pay/check', { provider: 'shopee', amount: 12345, created_at: created }); ok(r.status === 'PAID', 'pembayaran terdeteksi');
  r = await call('GET', '/api/pay/history?provider=shopee'); ok(r.success && r.data.length === 1, 'riwayat bisa dibuka tanpa login');
  r = await call('POST', '/api/admin/login', { password: 'apa saja' }); ok(r.success, 'endpoint login tidak bikin error di mode publik');
  // ---------- auto refresh ----------
  const page = await (await fetch(base() + '/')).text(); ok(page.includes('data-v="auto">Auto Refresh'), 'menu Auto Refresh ada di dashboard');
  r = await call('GET', '/api/token/status');
  ok(r.success && r.shopee.hasToken && r.shopee.canRefresh && r.shopee.lastRefreshAt && !JSON.stringify(r).includes('B:LIVE'), 'status ShopeePay: token ada, bisa refresh, token TIDAK ikut dikirim');
  ok(r.gopay.hasToken === false && r.gopay.canRefresh === false && r.loop === true, 'status GoMerch kosong; server ini punya loop sendiri');
  const before = (await call('GET', '/api/token/status')).shopee.lastRefreshAt;
  await new Promise(x => setTimeout(x, 15));
  r = await call('POST', '/api/refresh', { provider: 'shopee' }); ok(r.success && r.status.lastRefreshAt > before, 'Refresh sekarang ShopeePay berhasil, waktu refresh maju');
  r = await call('POST', '/api/refresh', { provider: 'gopay' }); ok(r.success === false && /Refresh token GoPay belum ada/.test(r.error), 'GoMerch tanpa login: pesan jelas');
  r = await call('POST', '/api/admin/config', { provider: 'gopay', accessToken: 'GA0', refreshToken: 'GR0' }); ok(r.success, 'token GoMerch manual tersimpan');
  r = await call('POST', '/api/refresh', { provider: 'gopay' }); ok(r.success && r.status.expiresAt > Date.now() && r.status.failCount === 0, 'Refresh sekarang GoMerch berhasil, masa berlaku terbaca');
  state.goRefreshFail = true;
  for (let i = 0; i < 3; i++) r = await call('POST', '/api/refresh', { provider: 'gopay' });
  ok(r.success === false && r.status.failCount === 3 && r.status.likelyExpired && /invalid refresh token/.test(r.status.lastError), 'gagal 3x: ditandai kemungkinan perlu login OTP ulang');
  state.goRefreshFail = false;
  r = await call('POST', '/api/refresh', { provider: 'gopay' }); ok(r.success && r.status.failCount === 0 && r.status.lastError === null, 'berhasil lagi: hitungan gagal direset');
  r = await call('POST', '/api/auto/config', { provider: 'shopee', enabled: true, minutes: 1 }); ok(r.auto.minutes === 5, 'interval dibatasi minimal 5 menit');
  r = await call('POST', '/api/auto/config', { provider: 'shopee', minutes: 99999 }); ok(r.auto.minutes === 720, 'interval dibatasi maksimal 720 menit');
  r = await call('POST', '/api/auto/tick', {}); ok(r.result.shopee === 'belum waktunya' && r.result.gopay === 'belum waktunya', 'tick: belum jatuh tempo = tidak refresh');
  await call('POST', '/api/auto/config', { provider: 'gopay', minutes: 5 });
  const db = require('../lib/store'); await db.set('meta:gopay', { lastRefreshAt: Date.now() - 6 * 60000, lastError: null, failCount: 0, expiresAt: null });
  r = await call('POST', '/api/auto/tick', {}); ok(r.result.gopay === 'ok' && r.result.shopee === 'belum waktunya', 'tick: GoMerch sudah jatuh tempo -> di-refresh, ShopeePay tidak');
  await call('POST', '/api/auto/config', { provider: 'gopay', enabled: false });
  await db.set('meta:gopay', { lastRefreshAt: Date.now() - 600 * 60000, lastError: null, failCount: 0, expiresAt: null });
  r = await call('POST', '/api/auto/tick', {}); ok(r.result.gopay === 'nonaktif', 'tick: dimatikan di dashboard = dilewati');
  r = await call('GET', '/api/bot/token/status', null, { 'x-api-key': 'x' }); ok(r.s === 401, 'route bot status mati kalau BOT_API_KEY tidak diisi');
  const cr = await fetch(base() + '/api/cron/refresh'); ok(cr.status === 200, 'cron refresh terbuka tanpa secret');
  r = await call('POST', '/api/bot/pay/create', { provider: 'shopee', amount: 1000 }, { 'x-api-key': 'x' }); ok(r.s === 401, 'route bot mati kalau BOT_API_KEY tidak diisi (route publik tetap jalan)');
  console.log('\nMODE PUBLIK: SEMUA LULUS (' + n + ')'); srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
