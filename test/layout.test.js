// Tes layout: memastikan struktur yang diminta benar-benar ada di views/index.ejs.
//
// Yang diminta user:
//   1. panel respons challenge dipindah ke SAMPING KANAN (bukan ke bawah)
//   2. bagian ambil token / real-time di BAWAH panel kanan, dengan tombol Copy
//
// Tes ini membaca HTML hasil render dari server (bukan file mentah), supaya
// kalau EJS error / view hilang, tes ikut gagal.
process.env.ADMIN_PASSWORD = '';
process.env.SESSION_SECRET = 'rahasia-test-rahasia-test-rahasia';
const TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vp-lay-'));
process.env.DB_PATH = require('path').join(TMP, 'db.json');
process.env.IDENTITY_PATH = require('path').join(TMP, 'identity.json');
process.env.AUDIT_PATH = require('path').join(TMP, 'audit.jsonl');

const assert = require('assert');
const app = require('../app');
const srv = app.listen(0);
const base = () => 'http://127.0.0.1:' + srv.address().port;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok', ++n, m); };

(async () => {
  const html = await (await fetch(base() + '/')).text();

  // --- 1. struktur dua kolom: alur di kiri, panel challenge di kanan ---
  ok(html.includes('class="otp-layout"'), 'ada container dua kolom .otp-layout');
  ok(html.includes('class="steps otp-main"'), 'alur OTP ada di kolom utama (kiri)');
  ok(html.includes('class="otp-side"'), 'ada kolom samping .otp-side (kanan)');
  ok(html.includes('id="challengePanel"'), 'panel respons challenge ada');

  // urutan DOM: panel kanan harus SETELAH kolom utama (jadi benar-benar di kanan)
  const iMain = html.indexOf('class="steps otp-main"');
  const iSide = html.indexOf('class="otp-side"');
  ok(iMain > 0 && iSide > iMain, 'panel challenge berada setelah kolom alur (grid kanan)');

  // --- 2. token & real-time di BAWAH panel challenge (dalam kolom kanan) ---
  const iAsideEnd = html.indexOf('</aside>');
  const iToken = html.indexOf('id="tokenPanel"');
  const iRT = html.indexOf('id="realtimePanel"');
  ok(iToken > iSide && iToken < iAsideEnd, 'panel token ada di dalam kolom kanan, di bawah panel challenge');
  ok(iRT > iSide && iRT < iAsideEnd, 'panel real-time ada di dalam kolom kanan, di bawah panel challenge');
  ok(iRT < iToken, 'real-time tampil sebelum token (token paling bawah)');
  ok(html.includes('id="outToken"'), 'field token ada');
  ok(html.includes('id="outSession"'), 'field session ada');

  // --- 3. tombol Copy ---
  ['#btnCopyToken', '#btnCopySession', '#btnCopyAll', '#btnCopyChallenge', '#btnCopyTrace'].forEach(sel => {
    ok(html.includes('id="' + sel.slice(1) + '"'), 'tombol ' + sel.slice(1) + ' ada');
  });
  ok(/id="btnCopyToken"[^>]*>Copy</.test(html), 'tombol Copy untuk token berlabel "Copy"');
  ok(/id="btnCopySession"[^>]*>Copy</.test(html), 'tombol Copy untuk session berlabel "Copy"');

  // --- 4. panel pendukung device-check & captcha ---
  ok(html.includes('id="identityPanel"'), 'panel identitas perangkat ada');
  ok(html.includes('id="captchaPanel"'), 'panel captcha (retry) ada');
  ok(html.includes('id="btnRetryOtp"'), 'tombol kirim ulang OTP setelah captcha ada');
  ok(html.includes('id="auditPanel"'), 'panel audit trail ada');

  // --- 5. responsif: media query yang menumpuk kolom di layar kecil ---
  ok(/@media\(max-width:900px\)[^}]*\.otp-layout\{grid-template-columns:1fr/.test(html.replace(/\n/g, '')),
    'di layar < 900px kolom ditumpuk jadi satu');

  // --- 6. CSS grid dua kolom benar-benar didefinisikan ---
  ok(/\.otp-layout\{[\s\S]{0,200}grid-template-columns:minmax\(0,1fr\) 340px/.test(html),
    'CSS mendefinisikan grid 1fr + 340px (kiri alur, kanan panel)');

  console.log('\nSEMUA TES LAYOUT LULUS (' + n + ')');
  srv.close(); process.exit(0);
})().catch(e => { console.error('GAGAL:', e); srv.close(); process.exit(1); });
