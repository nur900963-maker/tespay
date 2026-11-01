// Login OTP ShopeePay Partner Portal (tidak resmi, hanya untuk akun merchant milik sendiri).
// Alurnya mengikuti klien open-source QrisMerchantID / merchantid (MIT) yang menirukan portal web.
// Semua langkah stateless: tiap fungsi menerima & mengembalikan objek JSON biasa.
//
// ============================ CATATAN PERBAIKAN ============================
// v3 (perbaikan "OTP tidak pernah sampai"):
//  1. IDENTITAS PERANGKAT PERSISTEN (lib/identity.js). device_id tidak lagi acak
//     per proses — disimpan ke data/identity.json, jadi perangkat punya riwayat
//     dan tidak dinilai "baru" tiap request.
//  2. TELEMETRI SELALU TERISI + `szdet` bertanda tangan (lib/device.js), bukan
//     timestamp mentah. Body `{}` adalah penyebab utama captcha/device-block.
//  3. `send_otp` DIVERIFIKASI. Dulu `allowNullData:true` membuat balasan kosong
//     dianggap sukses padahal OTP tidak dikirim. Sekarang balasan harus punya
//     bukti (otp_token / expire / channel / next_send_time). Tanpa bukti ->
//     OTP_UNVERIFIED, bukan "sukses palsu".
//  4. RETRY CAPTCHA TANPA ULANG DARI NOL. Kalau Shopee minta captcha, state
//     (cookie + risk token + channel) dikembalikan sebagai `retry`, jadi user
//     cukup mengisi captcha_signature lalu kirim ulang — tidak perlu login page
//     + device-risk + password lagi (yang justru menaikkan skor risiko).
//  5. check_password_migrate TIDAK divalidasi ketat (error != 0 itu normal).
//  6. Error captcha / device-check dipetakan ke kode yang bisa ditindaklanjuti
//     (CAPTCHA_REQUIRED, DEVICE_BLOCKED, RATE_LIMITED, OTP_UNVERIFIED) + hint.
//  7. refreshSession mengambil risk token baru, tidak memakai token lama.
// ==========================================================================
const axios = require('axios');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const device = require('./device');
const identity = require('./identity');
const captcha = require('./captcha');

const ACCOUNT = 'https://partner.business.accounts.shopee.co.id';
const PARTNER = 'https://partner.shopee.co.id';
const PARTNER_API = 'https://api.partner.shopee.co.id';
const FP_URL = 'https://df.infra.sz.shopee.co.id/v2/shpsec/web/report';
const ACCOUNT_CLIENT_ID = '5', BUSINESS_CLIENT_ID = '1', LOGIN_FROM = '12';
const OTP_OP = 50001, NEED_OTP = 48401102, NOT_LOGIN = 48500102;
const COOKIE_TOKEN = '__shopee_partner_website_x_token_live';
const LANG = 'id', AL = 'id,en-US;q=0.9,en;q=0.8';
const EP = {
  pwMigrate: '/api/v4/account/business/check_password_migrate',
  exists: '/api/v4/account/business/check_account_exist_by_password',
  byPassword: '/api/v4/account/business/authenticate_toc_by_password',
  otpSettings: '/api/v4/account/business/get_otp_settings',
  sendOtp: '/api/v4/account/business/send_otp',
  verifyOtp: '/api/v4/account/business/verify_otp',
  byOtp: '/api/v4/account/business/authenticate_toc_by_otp',
  loginToc: '/api/v4/account/business/login_toc',
  loginStatus: '/api/v4/account/business/login_status',
  detect: '/nb/mss/mer-detect-api/PartnerMerchantDetectServer/MerchantDetect',
  userInfo: '/nb/mss/web-api/PartnerAccountServer/GetUserInfo',
};

// Kode error yang kita pakai sendiri supaya UI bisa memberi instruksi tepat.
const E_CAPTCHA = 'CAPTCHA_REQUIRED';
const E_DEVICE = 'DEVICE_BLOCKED';
const E_RATE = 'RATE_LIMITED';
const E_UNVERIFIED = 'OTP_UNVERIFIED';

class ShopeeError extends Error {
  constructor(msg, { status = 400, code = null, payload = null, hint = null, retry = null, captcha = null } = {}) {
    super(msg); this.status = status; this.code = code; this.payload = payload; this.hint = hint; this.retry = retry; this.captcha = captcha;
  }
}
const bad = m => new ShopeeError(m, { status: 400 });

// ---------- cookie jar mini ----------
class Jar {
  constructor(list = []) { this.c = list.map(x => ({ ...x })); }
  static match(c, host) { const d = c.domain.replace(/^\./, ''); return c.hostOnly ? host === d : (host === d || host.endsWith('.' + d)); }
  header(url) {
    const u = new URL(url);
    return this.c.filter(c => Jar.match(c, u.hostname) && u.pathname.startsWith(c.path)).map(c => `${c.name}=${c.value}`).join('; ');
  }
  store(url, setCookie) {
    const host = new URL(url).hostname;
    for (const line of [].concat(setCookie || [])) {
      const [kv, ...attrs] = line.split(';').map(s => s.trim());
      const i = kv.indexOf('='); if (i < 1) continue;
      const ck = { name: kv.slice(0, i), value: kv.slice(i + 1), domain: host, path: '/', hostOnly: true };
      let gone = false;
      for (const a of attrs) {
        const [k, ...v] = a.split('='); const val = v.join('=');
        const kk = k.toLowerCase();
        if (kk === 'domain' && val) { ck.domain = val.replace(/^\./, '').toLowerCase(); ck.hostOnly = false; }
        else if (kk === 'path' && val) ck.path = val;
        else if (kk === 'max-age' && Number(val) <= 0) gone = true;
        else if (kk === 'expires' && new Date(val).getTime() < Date.now()) gone = true;
      }
      this.c = this.c.filter(x => !(x.name === ck.name && x.domain === ck.domain && x.path === ck.path));
      if (!gone) this.c.push(ck);
    }
  }
  get(name, url) {
    const host = new URL(url).hostname;
    const same = this.c.filter(c => c.name === name);
    return (same.find(c => Jar.match(c, host)) || same[0] || {}).value || null;
  }
  snapshot() { return this.c.map(x => ({ ...x })); }
}

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// retry hanya untuk request idempoten. send_otp / verify_otp / login_toc TIDAK boleh
// diulang: timeout di tengah jalan berarti OTP sudah terkirim, mengulang = OTP ganda
// + kuota rate limit terbakar.
async function send(jar, method, url, headers, body, { retry = method === 'GET' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const h = { ...headers };
      if (jar) { const ck = jar.header(url); if (ck) h.Cookie = ck; }
      const r = await axios.request({
        method, url, headers: h, data: body, maxRedirects: 0, timeout: 20000,
        validateStatus: () => true, responseType: 'text', transformResponse: [x => x],
      });
      if (jar) jar.store(url, r.headers['set-cookie']);
      return r;
    } catch (e) {
      if (!retry || attempt >= 2 || e.response) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}
function parse(r, what) {
  let b; try { b = JSON.parse(r.data); } catch { throw new ShopeeError(`Shopee ${what} membalas HTTP ${r.status} dengan JSON tidak valid`, { status: 502 }); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ShopeeError(`Shopee ${what} membalas bukan objek`, { status: 502 });
  return b;
}

// ---------- helper ----------
function parseMobile(n) {
  let d = String(n || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('62')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (!d.startsWith('8') || d.length < 9 || d.length > 13) throw bad('Nomor HP Indonesia tidak valid');
  return { e164: '62' + d };
}
function phoneForVerify(e164) {
  const s = e164.startsWith('62') ? e164.slice(2) : e164;
  return `(+62) ${[s.slice(0, 3), s.slice(3, 7), s.slice(7)].filter(Boolean).join(' ')}`;
}

// Hash password: portal Shopee memakai sha256(md5(pw)) — hex md5 dulu, lalu sha256.
// Kalau ternyata Shopee mengubah skema, bisa diganti lewat env tanpa ubah kode.
const PW_HASH = String(process.env.SHOPEE_PW_HASH || 'md5sha256').toLowerCase();
function hashPw(pw) {
  if (PW_HASH === 'plain') return String(pw);
  if (PW_HASH === 'sha256') return crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex');
  return crypto.createHash('sha256').update(crypto.createHash('md5').update(String(pw), 'utf8').digest('hex'), 'utf8').digest('hex');
}

const q = encodeURIComponent;
const partnerState = () => `${PARTNER}/?business_next=${q(PARTNER + '/login/auth')}&business_state=${q(PARTNER)}&business_client_id=${BUSINESS_CLIENT_ID}`;
const loginReferer = () => `${ACCOUNT}/authenticate/login/?lang=${LANG}&should_hide_back=true&state=${q(partnerState())}&client_id=${ACCOUNT_CLIENT_ID}&next=${q(PARTNER + '/account/login/auth')}`;

const baseHeaders = () => ({ Accept: 'application/json, text/plain, */*', 'User-Agent': device.UA(), 'Accept-Language': AL, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site' });

function accountHeaders(jar, risk) {
  const h = { ...baseHeaders(), Origin: ACCOUNT, Referer: loginReferer(), 'X-App-Type': '2', 'Sec-Fetch-Site': 'same-origin', Priority: 'u=0', 'Content-Type': 'application/json' };
  if (risk) { h['af-ac-enc-sz-token'] = risk; h['x-sz-sdk-version'] = device.SZ_SDK(); }
  // szdet juga dikirim di request akun, bukan hanya di device-report: browser asli
  // mengirimnya di SEMUA request, dan perangkat yang hanya sesekali membawa szdet
  // terlihat tidak konsisten di mata risk engine.
  const sz = device.szdet();
  if (sz) h.szdet = sz;
  const csrf = jar.get('csrftoken', ACCOUNT); if (csrf) h['X-CSRFToken'] = csrf;
  return h;
}

// Petakan balasan Shopee ke error yang bisa ditindaklanjuti.
function classify(d, path) {
  const msg = String(d.error_msg || d.msg || '');
  const data = d.data || {};
  if (captcha.isCaptcha(d)) {
    // Bawa detail captcha (gambar / token / instruksi) supaya UI bisa menampilkannya.
    const info = captcha.extract(d);
    return new ShopeeError(
      `Shopee minta captcha di ${path}. OTP tidak akan dikirim sampai captcha diselesaikan.`,
      { status: 429, code: E_CAPTCHA, payload: d, captcha: info,
        hint: info.instruction });
  }
  if (/\b(device|risk|unusual|mencurigakan|tidak dikenal)\b|verify.{0,20}browser/i.test(msg) || data.need_verify === true) {
    return new ShopeeError(
      `Shopee menolak karena device-check di ${path}: ${msg || 'perangkat tidak dipercaya'}`,
      { status: 403, code: E_DEVICE, payload: d,
        hint: 'Identitas perangkat harus stabil. Buka panel Identitas Perangkat, tempel device report + szdet asli dari browser yang pernah login sukses, lalu ulangi.' });
  }
  // word boundary wajib: tanpa \b, "corporate" dan "separate" ikut cocok ke /rate/i
  if (/\b(too many|terlalu banyak|frequent|rate.?limit)\b/i.test(msg)) {
    return new ShopeeError(`Shopee membatasi permintaan OTP: ${msg}`, { status: 429, code: E_RATE, payload: d });
  }
  return null;
}

async function account(jar, path, body, risk, { allowNullData = false, allowError = false, retry = true } = {}) {
  const r = await send(jar, 'POST', ACCOUNT + path, accountHeaders(jar, risk), JSON.stringify(body), { retry });
  const d = parse(r, path);
  const cls = classify(d, path);
  if (cls) throw cls;
  if (d.error !== 0) {
    if (allowError) return { error: d.error, data: d.data, raw: d };
    throw new ShopeeError(`Shopee menolak di ${path} (error ${d.error}) ${d.error_msg || ''}`.trim(), { status: 400, code: d.error, payload: d });
  }
  if (d.data == null && !allowNullData) {
    throw new ShopeeError(`Shopee membalas data kosong di ${path}`, { status: 502, code: d.error, payload: d });
  }
  return d.data;
}

async function partner(path, body, token = '', nonce = null) {
  const h = {
    Accept: 'application/json, text/plain, */*', 'User-Agent': device.UA(), 'Accept-Language': AL, 'Content-Type': 'application/json',
    Origin: PARTNER, Referer: PARTNER + '/', 'X-Merchant-ToB-Clientid': 'undefined', 'X-Merchant-Login-From': LOGIN_FROM, 'X-Merchant-From': LOGIN_FROM,
    'X-Merchant-Language': LANG, 'X-Merchant-Timezone': 'Asia/Jakarta', 'X-Merchant-RequestId': randomUUID(), 'shopee-baggage': 'PFB=undefined', 'X-Merchant-Token': token,
  };
  if (nonce != null) h['X-Merchant-ToC-Nonce'] = nonce;
  const r = await send(null, 'POST', PARTNER_API + path, h, JSON.stringify(body)); // header-only: tanpa cookie
  const d = parse(r, path);
  if (d.errorCode !== 0 || d.data == null || typeof d.data !== 'object')
    throw new ShopeeError(`Shopee partner API gagal di ${path} (error ${d.errorCode}) ${d.errorMsg || ''}`.trim(), { status: 400, code: d.errorCode, payload: d });
  return d.data;
}

async function followGet(jar, url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const r = await send(jar, 'GET', cur, baseHeaders());
    if (r.status < 300 || r.status >= 400) return;
    const loc = r.headers.location;
    if (!loc) throw new ShopeeError('Redirect Shopee tanpa location', { status: 502 });
    cur = new URL(loc, cur).toString();
  }
  throw new ShopeeError('Redirect Shopee terlalu banyak', { status: 508 });
}

// Ambil risk token dari layanan device-risk Shopee.
// PENTING: body HARUS berisi telemetri. Versi lama mengirim `{}` -> Shopee
// menganggap perangkat tanpa jejak, dan captcha hampir pasti muncul.
async function fingerprint(jar, deviceReport, deviceId) {
  const devId = deviceId || device.DEVICE_ID();
  const h = {
    ...baseHeaders(), Origin: ACCOUNT, Referer: ACCOUNT + '/',
    'Content-Type': 'text/plain;charset=UTF-8',
    szdet: device.szdet(),
    'x-sz-sdk-version': device.SZ_SDK(),
  };
  const body = deviceReport || device.buildDeviceReport(devId);
  const r = await send(jar, 'POST', FP_URL, h, body);
  const d = parse(r, 'device-risk');
  const tok = d.data && (d.data.riskToken || d.data.risk_token);
  if (d.code !== 0 || !tok) {
    throw new ShopeeError('Layanan device-risk Shopee tidak memberi risk token', {
      status: 502, code: d.code, payload: d,
      hint: 'Telemetri perangkat ditolak. Buka panel Identitas Perangkat dan tempel device report asli dari browser yang pernah login sukses (SHOPEE_DEVICE_REPORT).',
    });
  }
  return String(tok);
}

function normalizeMerchant(m) {
  if (!m || !Number.isInteger(m.merchantId) || !Number.isInteger(m.staffTobUid)) return null;
  return { id: String(m.merchantId), name: String(m.merchantName || ''), staff_user_id: m.staffTobUid,
    is_active: m.isActive === true, is_banned: m.isBanned === true, is_current_login_user: m.isCurrentLoginUser === true };
}
const usable = ms => ms.filter(m => m.is_active && !m.is_banned);
function singleMerchant(ms) {
  const u = usable(ms), cur = u.filter(m => m.is_current_login_user);
  if (cur.length === 1) return cur[0];
  return u.length === 1 ? u[0] : null;
}

function readCredential(cookies) {
  const jwt = (cookies.find(c => c.name === COOKIE_TOKEN) || {}).value || '';
  if (!jwt) throw new ShopeeError('Login Shopee tidak mengembalikan token sesi merchant', { status: 502 });
  try {
    const seg = jwt.split('.');
    if (seg.length !== 3 || !seg[1]) throw 0;
    const p = JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'));
    if (typeof p.token !== 'string' || !p.token || p.userid == null) throw 0;
    return { token: p.token, account_id: String(p.userid), expires_at: typeof p.exp === 'number' ? p.exp * 1000 : null };
  } catch { throw new ShopeeError('Token sesi merchant dari Shopee tidak bisa dibaca', { status: 502 }); }
}

// ---------- bukti bahwa send_otp BENAR-BENAR terkirim ----------
// Shopee membalas error 0 dengan data berisi jejak pengiriman. Kalau data kosong
// atau tidak punya satu pun jejak, OTP TIDAK terkirim — dulu ini dianggap sukses
// (allowNullData:true) sehingga user menunggu kode yang tidak pernah datang.
const EVIDENCE_KEYS = [
  'otp_token', 'otpToken', 'expire', 'expire_time', 'expireTime', 'expired_at',
  'next_send_time', 'nextSendTime', 'retry_after', 'retryAfter', 'send_count',
  'channel', 'otp_channel', 'masked_phone', 'maskedPhone', 'phone_mask', 'ttl',
];
function sendEvidence(data) {
  const d = data && typeof data === 'object' ? data : {};
  const found = {};
  for (const k of EVIDENCE_KEYS) if (d[k] !== undefined && d[k] !== null && d[k] !== '') found[k] = d[k];
  return { verified: Object.keys(found).length > 0, fields: found, keys: Object.keys(d) };
}

// ---------- langkah publik ----------
async function requestOtp(phone, { password, channel, deviceReport, captchaSignature, captchaAnswer, captchaToken, captchaSceneId, deviceId } = {}) {
  const e164 = parseMobile(phone).e164;
  const jar = new Jar();
  const trace = [];   // jejak langkah, dipakai audit & pesan error
  const step = (name, extra = {}) => trace.push({ step: name, at: now(), ...extra });

  await send(jar, 'GET', `${ACCOUNT}/login?lang=${LANG}`, { ...baseHeaders(), Accept: 'text/html' });
  step('login_page', { cookies: jar.snapshot().map(c => c.name) });

  const devId = deviceId || device.DEVICE_ID();
  const risk = await fingerprint(jar, deviceReport || undefined, devId);
  step('device_risk', { riskToken: risk.slice(0, 8) + '…', deviceId: devId.slice(0, 8) + '…' });

  // 1) check_password_migrate — balasan non-zero NORMAL (akun tidak perlu migrasi).
  //    Versi lama memakai account() yang melempar error di sini -> alur mati total.
  const mig = await account(jar, EP.pwMigrate, { phone: e164 }, risk, { allowNullData: true, allowError: true });
  step('check_password_migrate', { error: mig.error });

  // 2) cek akun — balasan non-zero juga normal, jadi tidak divalidasi.
  const ex = await send(jar, 'POST', ACCOUNT + EP.exists, accountHeaders(jar, risk), JSON.stringify({ phone: e164, password: password ? hashPw(password) : '' }));
  try { step('check_account_exist', { error: parse(ex, EP.exists).error }); } catch { step('check_account_exist', { error: 'unparsed' }); }

  // 3) langkah password
  const pr = await send(jar, 'POST', ACCOUNT + EP.byPassword, accountHeaders(jar, risk),
    JSON.stringify({ phone: e164, password: password ? hashPw(password) : '', security_device_fingerprint: risk }));
  const pd = parse(pr, EP.byPassword);
  const cls = classify(pd, EP.byPassword);
  if (cls) throw cls;
  let hasPassword = false;
  const needPw = new ShopeeError('Akun Shopee ini pakai password. Isi password dulu supaya OTP bisa dikirim.', { status: 400, code: 'PASSWORD_REQUIRED' });
  if (pd.error === NEED_OTP) { if (!password) throw needPw; hasPassword = true; }
  else if (pd.error !== 0) {
    if (pd.data && pd.data.toc_account && pd.data.toc_account.has_password === true) throw needPw;
    throw new ShopeeError(`Shopee menolak password sebelum kirim OTP (error ${pd.error}) ${pd.error_msg || ''}`.trim(), { status: 400, code: pd.error, payload: pd });
  }
  step('authenticate_by_password', { error: pd.error, hasPassword });

  // 4) setelan OTP — kalau gagal, jangan matikan alur; pakai channel default.
  let st = {};
  try {
    st = await account(jar, EP.otpSettings, { operation: OTP_OP, phone: e164, security_device_fingerprint: risk, support_session: false, supported_channels: [1, 2, 3, 5] }, risk, { allowNullData: true });
  } catch (e) {
    if (e.code === E_CAPTCHA || e.code === E_DEVICE) throw e;
    step('get_otp_settings_failed', { error: e.message });
  }
  const avail = (st.available_channel_list || []).filter(Number.isInteger);
  const ch = channel != null ? Number(channel) : (Number.isInteger(st.default_channel) ? st.default_channel : 3);
  if (avail.length && !avail.includes(ch)) throw bad(`Channel OTP ${ch} tidak tersedia (tersedia: ${avail.join(', ')})`);
  step('otp_settings', { available: avail, chosen: ch });

  // 5) kirim OTP + VERIFIKASI bukti pengiriman.
  const state = { v: 1, phone: e164, channel: ch, channels: avail, risk, hasPassword, cookies: jar.snapshot(), at: now(), trace, deviceId: devId };
  const sent = await sendOtpStep(state, { captchaSignature, captchaAnswer, captchaToken, captchaSceneId });
  return { ...state, ...sent };
}

// Kirim (atau kirim ulang) send_otp memakai state yang sudah ada.
// Dipakai dua kali: saat request awal, dan saat retry setelah captcha diselesaikan.
//
// captcha_signature TIDAK PERNAH di-hardcode ''. Nilai yang dipakai, berurutan:
//   1. yang dikirim user (dari browser / jawaban captcha gambar)
//   2. yang tersimpan di identitas perangkat (hasil capture sebelumnya)
//   3. tidak dikirim sama sekali (field dihilangkan, bukan dikirim kosong)
// Mengirim string kosong membuat Shopee menganggap captcha "dijawab kosong" dan
// langsung menolak, padahal tanpa field itu ia mungkin masih menerima.
async function sendOtpStep(state, { captchaSignature, captchaAnswer, captchaToken, captchaSceneId } = {}) {
  const jar = new Jar(state.cookies);
  const risk = state.risk;
  const cap = captcha.fields({
    signature: captchaSignature || device.captchaSignature() || '',
    answer: captchaAnswer,
    token: captchaToken,
    sceneId: captchaSceneId,
  });
  let data;
  try {
    data = await account(jar, EP.sendOtp, {
      operation: OTP_OP, phone: state.phone, security_device_fingerprint: risk, support_session: false,
      supported_channels: [1, 2, 3, 5, 4], channel: state.channel, ...cap,
    }, risk, { allowNullData: true, retry: false });
  } catch (e) {
    // captcha / device-block: bawa state supaya bisa retry tanpa ulang dari nol
    if (e.code === E_CAPTCHA || e.code === E_DEVICE) {
      e.retry = { ...state, cookies: jar.snapshot(), stage: 'send_otp' };
    }
    throw e;
  }

  const ev = sendEvidence(data);
  state.trace.push({ step: 'send_otp', at: now(), channel: state.channel, captcha: Object.keys(cap), ok: ev.verified, evidence: ev.keys });

  if (!ev.verified) {
    throw new ShopeeError(
      'Shopee membalas sukses tapi TIDAK ada bukti OTP terkirim (data kosong). OTP kemungkinan tidak pernah dikirim.',
      { status: 502, code: E_UNVERIFIED, payload: { data, evidence: ev },
        hint: 'Biasanya karena device-check/captcha ditolak diam-diam. Buka panel Identitas Perangkat, tempel device report + szdet asli dari browser, lalu kirim ulang. Kalau tetap kosong, cek channel (WhatsApp sering tidak aktif untuk nomor ini).',
        retry: { ...state, cookies: jar.snapshot(), stage: 'send_otp' } });
  }

  return {
    sendEvidence: ev.fields,
    sendVerified: true,
    cookies: jar.snapshot(),
    trace: state.trace,
  };
}

// Retry send_otp memakai state dari error sebelumnya (captcha sudah diselesaikan).
async function retrySendOtp(state, { captchaSignature, captchaAnswer, captchaToken, captchaSceneId } = {}) {
  if (!state || state.v !== 1 || state.stage !== 'send_otp') throw bad('State retry OTP tidak valid, kirim OTP dari awal');
  const out = await sendOtpStep(state, { captchaSignature, captchaAnswer, captchaToken, captchaSceneId });
  return { ...state, ...out };
}

async function verifyOtp(ch, otp) {
  if (!ch || ch.v !== 1) throw bad('Challenge OTP tidak valid, kirim OTP lagi');
  const code = String(otp || '').trim();
  if (!/^\d{4,10}$/.test(code)) throw bad('OTP harus 4 sampai 10 digit');
  const jar = new Jar(ch.cookies), risk = ch.risk;
  const v = await account(jar, EP.verifyOtp, { operation: OTP_OP, otp: code, phone: phoneForVerify(ch.phone), security_device_fingerprint: risk, support_session: false }, risk, { retry: false });
  if (!v.otp_token) throw new ShopeeError('Verifikasi OTP Shopee tidak mengembalikan token', { status: 502 });
  const a = await account(jar, EP.byOtp, { otp_token: v.otp_token, security_device_fingerprint: risk, is_signup: false }, risk);
  const nonce = a.toc_nonce, uid = a.toc_account && a.toc_account.userid;
  if (!nonce || !Number.isInteger(uid)) throw new ShopeeError('Autentikasi OTP Shopee tidak lengkap', { status: 502 });
  const clientId = jar.get('SPC_CLIENTID', ACCOUNT);
  if (!clientId) throw new ShopeeError('Shopee tidak memberi client session id', { status: 502 });
  await followGet(jar, `${PARTNER}/account/login/auth?lang=${LANG}&spc_clientid=${q(clientId)}&state=${q(partnerState())}&toc_nonce=${q(String(nonce))}`);
  const det = await partner(EP.detect, {}, '', String(nonce));
  const list = (det.selectMerchant && det.selectMerchant.merchantList) || [];
  const merchants = list.map(normalizeMerchant).filter(Boolean);
  if (!merchants.length) throw new ShopeeError('Akun Shopee ini tidak punya merchant yang bisa diakses', { status: 400 });
  return { v: 1, nonce: String(nonce), clientId, risk, cookies: jar.snapshot(), merchants };
}

async function ssoExchange(jar, nonce, clientId, risk, staffUid) {
  await followGet(jar, `${ACCOUNT}/authenticate/login/token/?lang=${LANG}&spc_clientid=${q(clientId)}&state=${q(partnerState())}&tob_userid=${staffUid}&next=${q(PARTNER + '/account/login/tob/auth')}&client_id=${ACCOUNT_CLIENT_ID}&toc_nonce=${q(nonce)}`);
  const lg = await account(jar, EP.loginToc, { toc_nonce: nonce, tob_userid: staffUid, security_device_fingerprint: risk }, risk, { retry: false });
  if (!lg.nonce) throw new ShopeeError('Login merchant Shopee tidak memberi authorization code', { status: 502 });
  await followGet(jar, `${PARTNER}/account/login/tob/auth?code=${q(String(lg.nonce))}&lang=${LANG}&spc_clientid=${q(clientId)}&state=${q(partnerState())}`);
}

async function completeBase(ver, merchantId) {
  const jar = new Jar(ver.cookies);
  let m;
  if (merchantId != null) { m = ver.merchants.find(x => x.id === String(merchantId)); if (!m) throw bad('Merchant tidak bisa diakses'); }
  else { m = singleMerchant(ver.merchants); if (!m) throw bad('Ada beberapa merchant, pilih salah satu'); }
  if (!m.is_active || m.is_banned) throw bad('Merchant tidak aktif atau dibanned');
  await ssoExchange(jar, ver.nonce, ver.clientId, ver.risk, m.staff_user_id);
  const cred = readCredential(jar.snapshot());
  if (cred.account_id !== String(m.staff_user_id)) throw new ShopeeError('Shopee mengembalikan token untuk merchant lain', { status: 502 });
  const info = await partner(EP.userInfo, {}, cred.token);
  if (String(info.merchantId) !== m.id) throw new ShopeeError('Shopee mengembalikan profil merchant lain', { status: 502 });
  return { jar, m, cred, info };
}

async function completeLogin(ver, merchantId) {
  if (!ver || ver.v !== 1) throw bad('Verifikasi tidak valid, ulangi login OTP');
  const { jar, m, cred, info } = await completeBase(ver, merchantId);
  return {
    v: 1, cookies: jar.snapshot(), token: cred.token, account_id: cred.account_id,
    merchant: { ...m, name: m.name || String(info.merchantName || '') }, merchants: ver.merchants,
    renew: { nonce: ver.nonce, clientId: ver.clientId, risk: ver.risk }, expires_at: cred.expires_at, created_at: now(),
  };
}

async function accountAlive(session) {
  const jar = new Jar(session.cookies);
  // sertakan risk token: tanpa itu Shopee bisa menilai ini perangkat tanpa jejak dan
  // kita salah menyimpulkan "sesi habis" padahal sesinya masih hidup.
  const r = await send(jar, 'POST', ACCOUNT + EP.loginStatus, accountHeaders(jar, session.renew && session.renew.risk), '{}');
  let d; try { d = JSON.parse(r.data); } catch { d = {}; }
  return { alive: d.error === 0, code: d.error };
}

// perpanjang token tanpa OTP baru (selama sesi akun Shopee masih hidup)
async function refreshSession(session) {
  if (!session || session.v !== 1 || !session.renew) throw bad('Sesi Shopee belum ada, login OTP dulu');
  const st = await accountAlive(session);
  if (!st.alive) throw new ShopeeError('Sesi akun Shopee sudah habis, login OTP lagi', { status: 401, code: st.code || NOT_LOGIN });
  // Risk token berumur pendek: ambil yang baru, jangan pakai token dari login OTP
  // yang bisa sudah kedaluwarsa (dulu ini bikin refresh gagal setelah beberapa jam).
  const jar0 = new Jar(session.cookies);
  let risk = session.renew.risk;
  try { risk = await fingerprint(jar0); } catch { /* pakai token lama */ }
  const ver = { nonce: session.renew.nonce, clientId: session.renew.clientId, risk, cookies: jar0.snapshot(), merchants: session.merchants };
  const { jar, cred } = await completeBase(ver, session.merchant.id);
  return { ...session, cookies: jar.snapshot(), token: cred.token, expires_at: cred.expires_at || session.expires_at, renew: { ...session.renew, risk } };
}

// ---------- diagnostik (dipakai audit & endpoint /api/shopee/diagnose) ----------
// Menjalankan alur sampai SEBELUM send_otp, jadi tidak memicu OTP / rate limit.
async function diagnose(phone, { password, deviceReport } = {}) {
  const e164 = parseMobile(phone).e164;
  const out = { phone: e164, deviceId: device.DEVICE_ID(), ua: device.UA(), identity: identity.snapshot(), steps: [] };
  const jar = new Jar();
  const push = (step, ok, detail) => out.steps.push({ step, ok, detail });
  let risk = null;
  try {
    const r = await send(jar, 'GET', `${ACCOUNT}/login?lang=${LANG}`, { ...baseHeaders(), Accept: 'text/html' });
    push('login_page', r.status === 200, { status: r.status, cookies: jar.snapshot().map(c => c.name) });
  } catch (e) { push('login_page', false, { message: e.message }); return out; }
  try {
    risk = await fingerprint(jar, deviceReport || undefined);
    out.riskToken = risk.slice(0, 8) + '…';
    push('device_risk', true, { riskToken: out.riskToken, telemetryBytes: device.buildDeviceReport().length, szdet: !!device.szdet() });
  } catch (e) { push('device_risk', false, { message: e.message, code: e.code, hint: e.hint }); return out; }
  try {
    const mig = await account(jar, EP.pwMigrate, { phone: e164 }, risk, { allowNullData: true, allowError: true });
    push('check_password_migrate', true, { error: mig.error, note: 'error != 0 normal' });
  } catch (e) { push('check_password_migrate', false, { message: e.message, code: e.code }); }
  try {
    const pr = await send(jar, 'POST', ACCOUNT + EP.byPassword, accountHeaders(jar, risk),
      JSON.stringify({ phone: e164, password: password ? hashPw(password) : '', security_device_fingerprint: risk }));
    const pd = parse(pr, EP.byPassword);
    const cls = classify(pd, EP.byPassword);
    push('authenticate_by_password', !cls && (pd.error === 0 || pd.error === NEED_OTP), { error: pd.error, error_msg: pd.error_msg, captcha: !!cls && cls.code === E_CAPTCHA });
  } catch (e) { push('authenticate_by_password', false, { message: e.message, code: e.code }); }
  try {
    const st = await account(jar, EP.otpSettings, { operation: OTP_OP, phone: e164, security_device_fingerprint: risk, support_session: false, supported_channels: [1, 2, 3, 5] }, risk, { allowNullData: true });
    push('get_otp_settings', true, { available: st.available_channel_list, default: st.default_channel });
  } catch (e) { push('get_otp_settings', false, { message: e.message, code: e.code, hint: e.hint }); }
  out.verdict = out.steps.every(s => s.ok) ? 'SIAP kirim OTP' : 'ADA HAMBATAN — lihat langkah yang gagal';
  return out;
}

module.exports = {
  requestOtp, retrySendOtp, sendOtpStep, verifyOtp, completeLogin, refreshSession, accountAlive, diagnose,
  usable, singleMerchant, ShopeeError, hashPw, sendEvidence,
  E_CAPTCHA, E_DEVICE, E_RATE, E_UNVERIFIED,
  _Jar: Jar, _readCredential: readCredential, _parseMobile: parseMobile, _classify: classify,
};
