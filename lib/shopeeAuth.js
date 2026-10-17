// Login OTP ShopeePay Partner Portal (tidak resmi, hanya untuk akun merchant milik sendiri).
// Alurnya mengikuti klien open-source QrisMerchantID / merchantid (MIT) yang menirukan portal web.
// Semua langkah stateless: tiap fungsi menerima & mengembalikan objek JSON biasa.
const axios = require('axios');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

const ACCOUNT = 'https://partner.business.accounts.shopee.co.id';
const PARTNER = 'https://partner.shopee.co.id';
const PARTNER_API = 'https://api.partner.shopee.co.id';
const FP_URL = 'https://df.infra.sz.shopee.co.id/v2/shpsec/web/report';
const SZ_SDK = '1.12.26-user.1';
const ACCOUNT_CLIENT_ID = '5', BUSINESS_CLIENT_ID = '1', LOGIN_FROM = '12';
const OTP_OP = 50001, NEED_OTP = 48401102, NOT_LOGIN = 48500102;
const COOKIE_TOKEN = '__shopee_partner_website_x_token_live';
const UA = process.env.SHOPEE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';
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

class ShopeeError extends Error {
  constructor(msg, { status = 400, code = null, payload = null } = {}) { super(msg); this.status = status; this.code = code; this.payload = payload; }
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

async function send(jar, method, url, headers, body) {
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
      if (attempt >= 2 || e.response) throw e;
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
const hashPw = pw => crypto.createHash('sha256').update(crypto.createHash('md5').update(pw, 'utf8').digest('hex'), 'utf8').digest('hex');
const q = encodeURIComponent;
const partnerState = () => `${PARTNER}/?business_next=${q(PARTNER + '/login/auth')}&business_state=${q(PARTNER)}&business_client_id=${BUSINESS_CLIENT_ID}`;
const loginReferer = () => `${ACCOUNT}/authenticate/login/?lang=${LANG}&should_hide_back=true&state=${q(partnerState())}&client_id=${ACCOUNT_CLIENT_ID}&next=${q(PARTNER + '/account/login/auth')}`;

const baseHeaders = () => ({ Accept: 'application/json, text/plain, */*', 'User-Agent': UA, 'Accept-Language': AL, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site' });

function accountHeaders(jar, risk) {
  const h = { ...baseHeaders(), Origin: ACCOUNT, Referer: loginReferer(), 'X-App-Type': '2', 'Sec-Fetch-Site': 'same-origin', Priority: 'u=0', 'Content-Type': 'application/json' };
  if (risk) { h['af-ac-enc-sz-token'] = risk; h['x-sz-sdk-version'] = SZ_SDK; }
  const csrf = jar.get('csrftoken', ACCOUNT); if (csrf) h['X-CSRFToken'] = csrf;
  return h;
}

async function account(jar, path, body, risk) {
  const r = await send(jar, 'POST', ACCOUNT + path, accountHeaders(jar, risk), JSON.stringify(body));
  const d = parse(r, path);
  if ((d.data && d.data.captcha_required === true) || /captcha/i.test(String(d.error_msg || '')))
    throw new ShopeeError('Shopee minta captcha. Selesaikan dulu di browser lalu coba lagi.', { status: 429, code: d.error, payload: d });
  if (d.error !== 0 || d.data == null || typeof d.data !== 'object')
    throw new ShopeeError(`Shopee menolak di ${path} (error ${d.error}) ${d.error_msg || ''}`.trim(), { status: 400, code: d.error, payload: d });
  return d.data;
}

async function partner(path, body, token = '', nonce = null) {
  const h = {
    Accept: 'application/json, text/plain, */*', 'User-Agent': UA, 'Accept-Language': AL, 'Content-Type': 'application/json',
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

async function fingerprint(jar, deviceReport) {
  const h = { ...baseHeaders(), Origin: ACCOUNT, Referer: ACCOUNT + '/' };
  let body = '{}';
  if (deviceReport) { h['Content-Type'] = 'text/plain;charset=UTF-8'; h.szdet = String(now()); body = deviceReport; }
  else h['Content-Type'] = 'application/json';
  const r = await send(jar, 'POST', FP_URL, h, body);
  const d = parse(r, 'device-risk');
  const tok = d.data && d.data.riskToken;
  if (d.code !== 0 || !tok) throw new ShopeeError('Layanan device-risk Shopee tidak memberi risk token', { status: 502, code: d.code, payload: d });
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

// ---------- langkah publik ----------
async function requestOtp(phone, { password, channel, deviceReport } = {}) {
  const e164 = parseMobile(phone).e164;
  const jar = new Jar();
  await send(jar, 'GET', `${ACCOUNT}/login?lang=${LANG}`, { ...baseHeaders(), Accept: 'text/html' });
  const risk = await fingerprint(jar, deviceReport);
  await account(jar, EP.pwMigrate, { phone: e164 }, risk);
  // cek akun: balasan non-zero memang normal, jadi tidak divalidasi
  await send(jar, 'POST', ACCOUNT + EP.exists, accountHeaders(jar, risk), JSON.stringify({ phone: e164, password: password ? hashPw(password) : '' }));
  // password step
  const pr = await send(jar, 'POST', ACCOUNT + EP.byPassword, accountHeaders(jar, risk),
    JSON.stringify({ phone: e164, password: password ? hashPw(password) : '', security_device_fingerprint: risk }));
  const pd = parse(pr, EP.byPassword);
  let hasPassword = false;
  const needPw = new ShopeeError('Akun Shopee ini pakai password. Isi password dulu supaya OTP bisa dikirim.', { status: 400 });
  if (pd.error === NEED_OTP) { if (!password) throw needPw; hasPassword = true; }
  else if (pd.error !== 0) {
    if (pd.data && pd.data.toc_account && pd.data.toc_account.has_password === true) throw needPw;
    throw new ShopeeError(`Shopee menolak password sebelum kirim OTP (error ${pd.error})`, { status: 400, code: pd.error, payload: pd });
  }
  const st = await account(jar, EP.otpSettings, { operation: OTP_OP, phone: e164, security_device_fingerprint: risk, support_session: false, supported_channels: [1, 2, 3, 5] }, risk);
  const avail = (st.available_channel_list || []).filter(Number.isInteger);
  const ch = channel != null ? Number(channel) : (Number.isInteger(st.default_channel) ? st.default_channel : 3);
  if (avail.length && !avail.includes(ch)) throw bad('Channel OTP yang diminta tidak tersedia');
  await account(jar, EP.sendOtp, { operation: OTP_OP, phone: e164, security_device_fingerprint: risk, support_session: false, supported_channels: [1, 2, 3, 5, 4], channel: ch, captcha_signature: '' }, risk);
  return { v: 1, phone: e164, channel: ch, channels: avail, risk, hasPassword, cookies: jar.snapshot(), at: now() };
}

async function verifyOtp(ch, otp) {
  if (!ch || ch.v !== 1) throw bad('Challenge OTP tidak valid, kirim OTP lagi');
  const code = String(otp || '').trim();
  if (!/^\d{4,10}$/.test(code)) throw bad('OTP harus 4 sampai 10 digit');
  const jar = new Jar(ch.cookies), risk = ch.risk;
  const v = await account(jar, EP.verifyOtp, { operation: OTP_OP, otp: code, phone: phoneForVerify(ch.phone), security_device_fingerprint: risk, support_session: false }, risk);
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
  const lg = await account(jar, EP.loginToc, { toc_nonce: nonce, tob_userid: staffUid, security_device_fingerprint: risk }, risk);
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
  const r = await send(jar, 'POST', ACCOUNT + EP.loginStatus, accountHeaders(jar), '{}');
  let d; try { d = JSON.parse(r.data); } catch { d = {}; }
  return { alive: d.error === 0, code: d.error };
}

// perpanjang token tanpa OTP baru (selama sesi akun Shopee masih hidup)
async function refreshSession(session) {
  if (!session || session.v !== 1 || !session.renew) throw bad('Sesi Shopee belum ada, login OTP dulu');
  const st = await accountAlive(session);
  if (!st.alive) throw new ShopeeError('Sesi akun Shopee sudah habis, login OTP lagi', { status: 401, code: st.code || NOT_LOGIN });
  const ver = { nonce: session.renew.nonce, clientId: session.renew.clientId, risk: session.renew.risk, cookies: session.cookies, merchants: session.merchants };
  const { jar, cred } = await completeBase(ver, session.merchant.id);
  return { ...session, cookies: jar.snapshot(), token: cred.token, expires_at: cred.expires_at || session.expires_at };
}

module.exports = { requestOtp, verifyOtp, completeLogin, refreshSession, accountAlive, usable, singleMerchant, ShopeeError, _Jar: Jar, _readCredential: readCredential, _parseMobile: parseMobile };
