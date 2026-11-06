// Tes offline: tidak memanggil Shopee/GoBiz sama sekali.
// Fokus: QRIS engine, gerbang API key, validasi input, dan penyajian halaman.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
process.env.DB_PATH = path.join(TMP, 'db.json');
process.env.PORT = '0';

// config.js menang atas env, jadi tes memakai file config sendiri.
const TEST_CONFIG = path.join(TMP, 'config.test.js');
fs.writeFileSync(TEST_CONFIG, 'module.exports = ' + JSON.stringify({
  API_KEY: 'kunci-uji-123',
  SESSION_SECRET: 'rahasia-uji-panjang-sekali',
}) + ';');
process.env.VP_CONFIG_FILE = TEST_CONFIG;

const qris = require('../lib/qris');
const app = require('../app');

const srv = app.listen(0);
const base = () => 'http://127.0.0.1:' + srv.address().port;

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok ' + (++n) + ' ' + msg); };

const tlv = (t, v) => t + String(v.length).padStart(2, '0') + v;
function makeStatic() {
  let s = '000201' + tlv('01', '11')
    + tlv('26', tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', '936000000000000000') + tlv('02', 'ID1024000000001') + tlv('03', 'UMI'))
    + tlv('52', '5812') + tlv('53', '360') + tlv('58', 'ID')
    + tlv('59', 'TOKO UJI') + tlv('60', 'JAKARTA') + tlv('61', '12345');
  return qris.withCRC(s);
}

const post = async (p, body, headers) => {
  const r = await fetch(base() + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

(async () => {
  console.log('\nQRIS engine');
  const STATIC = makeStatic();
  ok(qris.verifyCRC(STATIC), 'CRC QRIS statis valid');
  const info0 = qris.info(STATIC);
  ok(info0.type === 'static' && info0.merchant_name === 'TOKO UJI', 'QRIS statis terbaca, nama merchant utuh');
  ok(info0.nmid === 'ID1024000000001', 'NMID terbaca');

  const dyn = qris.toDynamic(STATIC, 15000);
  ok(qris.verifyCRC(dyn), 'CRC QRIS dinamis valid');
  const info1 = qris.info(dyn);
  ok(info1.type === 'dynamic', 'tag 01 berubah jadi 12 (dinamis)');
  ok(info1.amount === 15000, 'nominal 15000 tertanam di tag 54');
  ok(info1.merchant_name === 'TOKO UJI', 'nama merchant tidak rusak');
  ok(dyn.includes('5802ID'), 'kode negara tetap ada');

  const dyn2 = qris.toDynamic(STATIC, 1);
  ok(qris.info(dyn2).amount === 1, 'nominal 1 rupiah tetap valid');
  const dyn3 = qris.toDynamic(STATIC, 999999999);
  ok(qris.info(dyn3).amount === 999999999, 'nominal besar tetap valid');

  // QRIS yang sudah dinamis -> dibuat ulang dengan nominal lain
  const dyn4 = qris.toDynamic(dyn, 25000);
  ok(qris.info(dyn4).amount === 25000, 'QRIS dinamis bisa dibuat ulang dengan nominal baru');
  ok((dyn4.match(/5405/g) || []).length === 1, 'tag 54 tidak dobel');

  let threw = false;
  try { qris.toDynamic('bukan-qris', 1000); } catch (e) { threw = true; }
  ok(threw, 'payload bukan QRIS ditolak');

  threw = false;
  try { qris.toDynamic(STATIC, 0); } catch (e) { threw = true; }
  ok(threw, 'nominal 0 ditolak');

  console.log('\nHalaman');
  const home = await (await fetch(base() + '/')).text();
  ok(home.includes('Vincent Pay'), 'halaman memuat nama brand');
  ok(home.includes('Gopay x Shoppepay'), 'halaman memuat sub-brand');
  ok(home.includes('2026 Vincent Pay All Right'), 'footer sesuai permintaan');
  ok(home.includes('asset/logo.png'), 'logo dipakai di header');
  ok(!/src="\/(css|js|asset|vendor)\//.test(home), 'aset memakai path relatif (aman di subfolder)');
  ok(!/password/i.test(home.split('<main')[0]), 'tidak ada gerbang password di awal halaman');
  ok(home.includes('id="inApikey"'), 'field API key ada di form, bukan di gerbang awal');

  const css = await (await fetch(base() + '/css/app.css')).text();
  ok(css.includes('--blue') && css.includes('--orange') && css.includes('--green'), 'token warna lengkap');
  const js = await (await fetch(base() + '/js/app.js')).text();
  ok(js.includes('localStorage'), 'penyimpanan sesi memakai localStorage');

  console.log('\nGerbang API key');
  let r = await post('/api/otp/request', { provider: 'shopee', phone: '81234567890' });
  ok(r.status === 401 && r.code === 'API_KEY_REQUIRED', 'tanpa API key ditolak 401');
  r = await post('/api/otp/request', { provider: 'shopee', phone: '81234567890', apikey: 'salah' });
  ok(r.status === 401 && r.code === 'API_KEY_INVALID', 'API key salah ditolak');
  r = await post('/api/qris/create', { amount: 1000, static_qr: STATIC });
  ok(r.status === 401, 'create QRIS juga butuh API key');

  console.log('\nValidasi');
  r = await post('/api/otp/request', { provider: 'shopee', phone: '12', apikey: 'kunci-uji-123' });
  ok(r.status === 400 && !r.success, 'nomor HP tidak valid ditolak');
  r = await post('/api/otp/request', { provider: 'ngawur', phone: '81234567890', apikey: 'kunci-uji-123' });
  ok(r.status === 400, 'provider tidak dikenal ditolak');
  r = await post('/api/otp/verify', { provider: 'shopee', challenge: 'palsu', otp: '1234', apikey: 'kunci-uji-123' });
  ok(r.status === 400 && /kedaluwarsa/i.test(r.error), 'challenge palsu ditolak');

  console.log('\nQRIS API');
  r = await post('/api/qris/inspect', { payload: STATIC });
  ok(r.success && r.merchant_name === 'TOKO UJI', 'inspect mengembalikan data merchant');
  r = await post('/api/qris/inspect', { payload: 'xxx' });
  ok(!r.success, 'inspect menolak payload ngawur');

  r = await post('/api/qris/create', { amount: 15000, static_qr: STATIC, apikey: 'kunci-uji-123' });
  ok(r.success && r.payload && r.image.startsWith('data:image/png;base64,'), 'create QRIS mengembalikan payload + gambar');
  ok(qris.verifyCRC(r.payload), 'payload hasil API punya CRC valid');
  ok(r.info.amount === 15000, 'nominal hasil API benar');

  r = await post('/api/qris/create', { amount: 0, static_qr: STATIC, apikey: 'kunci-uji-123' });
  ok(!r.success, 'nominal 0 ditolak API');
  r = await post('/api/qris/create', { amount: 5000, static_qr: 'bukan qris', apikey: 'kunci-uji-123' });
  ok(!r.success, 'QRIS ngawur ditolak API');

  console.log('\nLain-lain');
  r = await post('/api/qris/check', { provider: 'shopee', amount: 1000, token: '', apikey: 'kunci-uji-123' });
  ok(!r.success && /token/i.test(r.error), 'cek bayar tanpa token ditolak rapi');
  const health = await (await fetch(base() + '/api/health')).json();
  ok(health.success && health.locked === true, 'health melaporkan mode terkunci');
  const nf = await fetch(base() + '/api/tidak-ada');
  ok(nf.status === 404, 'endpoint tidak dikenal -> 404 JSON');

  console.log('\nSemua ' + n + ' pemeriksaan lulus.\n');
  srv.close();
  process.exit(0);
})().catch(e => {
  console.error('\nGAGAL:', e.message);
  srv.close();
  process.exit(1);
});
