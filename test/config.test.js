// Tes config.js: nilai di file config menang atas env, nilai kosong tidak menimpa env.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-cfg-'));
const cfgFile = path.join(dir, 'config.js');
fs.writeFileSync(cfgFile, `module.exports = { BOT_API_KEY: '  kunci-dari-config  ', ADMIN_PASSWORD: 'pw-dari-config', CRON_SECRET: '', AUTO_LOOP: 0 };`);
process.env.VP_CONFIG_FILE = cfgFile;
process.env.BOT_API_KEY = 'kunci-dari-env';      // harus kalah dari config.js
process.env.CRON_SECRET = 'cron-dari-env';       // config kosong -> env tetap dipakai
delete process.env.ADMIN_PASSWORD; delete process.env.SESSION_SECRET;
const app = require('../app');
const srv = app.listen(0);
const base = () => 'http://127.0.0.1:' + srv.address().port;
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };
(async () => {
  ok(process.env.BOT_API_KEY === 'kunci-dari-config', 'config.js menang atas env (dan spasi dipotong)');
  ok(process.env.CRON_SECRET === 'cron-dari-env', 'nilai kosong di config.js tidak menimpa env');
  ok(process.env.AUTO_LOOP === '0', 'angka di config.js diubah jadi string');
  let r = await fetch(base() + '/api/bot/token/status', { headers: { 'x-api-key': 'kunci-dari-config' } }); ok(r.status === 200, 'route bot jalan dengan key dari config.js');
  r = await fetch(base() + '/api/bot/token/status', { headers: { 'x-api-key': 'kunci-dari-env' } }); ok(r.status === 401, 'key dari env ditolak (kalah dari config.js)');
  r = await fetch(base() + '/api/token/status'); ok(r.status === 401, 'ADMIN_PASSWORD dari config.js: dashboard terkunci');
  r = await fetch(base() + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-dari-config' }) });
  const ck = r.headers.get('set-cookie').split(';')[0]; ok(r.status === 200, 'login dengan password dari config.js berhasil');
  r = await fetch(base() + '/api/token/status', { headers: { cookie: ck } }); ok(r.status === 200, 'setelah login menu terbuka');
  r = await fetch(base() + '/'); const html = await r.text(); ok(html.includes('LOCKED=true'), 'halaman utama tahu dashboard terkunci');
  console.log('\nCONFIG.JS: SEMUA LULUS (' + n + ')'); srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
