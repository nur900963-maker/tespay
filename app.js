require('./lib/loadConfig')();   // config.js -> env (harus paling awal)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const GoMerchant = require('./GoMerchant');
const shopee = require('./lib/shopee');
const store = require('./lib/store');
const sauth = require('./lib/shopeeAuth');
const { seal, unseal } = require('./lib/seal');
const guard = require('./lib/guard');
const audit = require('./lib/audit');
const identity = require('./lib/identity');
const device = require('./lib/device');

const app = express();
const go = new GoMerchant();
const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
// Mode publik: kalau ADMIN_PASSWORD tidak diisi, semua menu terbuka tanpa login (tidak ada env wajib).
// Mau dikunci? Isi ADMIN_PASSWORD di env, otomatis semua menu admin minta login.
const locked = () => !!process.env.ADMIN_PASSWORD;
const PROVIDERS = { gopay: 'GoPay Merchant', shopee: 'ShopeePay Partner' };

app.set('trust proxy', 1);   // percayai 1 hop proxy (Vercel) supaya req.ip tidak bisa dipalsukan via X-Forwarded-For
app.use(express.json({ limit: '200kb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- auth admin: cookie bertanda tangan (stateless, aman untuk serverless) ----------
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const same = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function isAdmin(req) {
  if (!locked()) return true;
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('vp='));
  if (!c || !SECRET) return false;
  const [exp, sig] = c.slice(3).split('.');
  return !!(exp && sig && +exp > Date.now() && same(sig, sign(exp)));
}
const secure = req => req.secure ? 'Secure; ' : '';
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ success: false, error: 'Login admin dulu' });
// hint + code ikut dikirim supaya UI bisa menampilkan langkah perbaikan (captcha / device-check).
const fail = (res, e, code = 400) => res.status(e.status || code).json({
  success: false,
  error: e.response?.data?.message || e.message,
  code: e.code ?? null,
  hint: e.hint || null,
  // detail captcha (gambar / token / instruksi) supaya UI bisa menampilkannya
  captcha: e.captcha || null,
});
const bad = (status, message) => Object.assign(new Error(message), { status });

// ---------- rate limit kirim OTP ----------
// Tanpa ini, satu skrip bisa membanjiri send_otp dan menghabiskan kuota Shopee —
// lalu akun asli ikut kena RATE_LIMITED. Sekarang berlapis (lib/guard.js):
// cooldown per nomor, kuota per nomor (15 menit & 1 jam), per IP, dan global.
const otpGate = async (req, res, next) => {
  const r = await guard.checkSendOtp({ phone: req.body.phone, ip: ipOf(req) });
  if (!r.ok) return res.status(429).json({ success: false, code: r.code, error: r.error, hint: r.hint, retry_after: r.retryAfter });
  next();
};
const retryGate = async (req, res, next) => {
  const r = await guard.checkRetry({ phone: req.body.phone, ip: ipOf(req) });
  if (!r.ok) return res.status(429).json({ success: false, code: r.code, error: r.error, hint: r.hint, retry_after: r.retryAfter });
  next();
};
const verifyGate = async (req, res, next) => {
  const r = await guard.checkVerify({ phone: req.body.phone, ip: ipOf(req) });
  if (!r.ok) return res.status(429).json({ success: false, code: r.code, error: r.error, hint: r.hint, retry_after: r.retryAfter });
  next();
};

// ---------- config per provider (store dulu, env sebagai cadangan) ----------
async function cfg(p) {
  const s = (await store.get('cfg:' + p)) || {};
  const e = process.env;
  return p === 'gopay'
    ? { accessToken: s.accessToken || e.GOPAY_ACCESS_TOKEN, refreshToken: s.refreshToken || e.GOPAY_REFRESH_TOKEN, qris: s.qris || e.GOPAY_QRIS }
    : { token: s.token || e.SHOPEE_TOKEN, qris: s.qris || e.SHOPEE_QRIS };
}

// Panggil GoPay; kalau 401 otomatis refresh token lalu ulangi (pengganti setInterval yang tidak jalan di Vercel)
async function gopay(fn) {
  const c = await cfg('gopay');
  if (!c.accessToken) throw bad(400, 'Token GoPay belum diset (menu Admin)');
  try { return await fn(c.accessToken); } catch (e) {
    if (e.response?.status !== 401 || !c.refreshToken) throw e;
    await markDead('gopay').catch(() => {});
    const r = await go.refreshToken(c.refreshToken);
    const t = r.data?.access_token;
    if (!t) throw e;
    await store.set('cfg:gopay', { ...c, accessToken: t, refreshToken: r.data.refresh_token || c.refreshToken });
    await markOk('gopay', { expiresAt: expiryOf(r.data) });
    return fn(t);
  }
}
const gopayJournals = start => gopay(async t => {
  const me = await go.getMe(t);
  return go.getJournals(t, me.user.merchant_id, start);
});
const DEAD = ['200020', '2010000'];
async function renewShopee() {
  const ses = await store.get('shopee:session');
  if (!ses) return null;
  const n = await sauth.refreshSession(ses);
  await store.set('shopee:session', n);
  const c = (await store.get('cfg:shopee')) || {};
  await store.set('cfg:shopee', { ...c, token: n.token });
  await markOk('shopee', { expiresAt: n.expires_at || null });
  return n.token;
}
async function shopeeList(opts) {
  const { token } = await cfg('shopee');
  if (!token) throw bad(400, 'Token ShopeePay belum diset (menu Admin)');
  try { return await shopee.list(token, opts); } catch (e) {
    if (!DEAD.includes(String(e.code))) throw e;
    await markDead('shopee').catch(() => {});
    const t = await renewShopee().catch(() => null); // token mati: coba perpanjang tanpa OTP baru
    if (!t) throw bad(401, 'Token ShopeePay kedaluwarsa. Login OTP ShopeePay lagi di menu Admin.');
    return shopee.list(t, opts);
  }
}

// ---------- halaman ----------
app.get('/', (req, res) => res.render('index', { admin: isAdmin(req), locked: locked(), persistent: store.persistent }));
app.get('/api/health', (req, res) => res.json({
  success: true, service: 'Vincent Pay', version: require('./package.json').version,
  persistent: store.persistent, backend: store.backend,
  vercel: process.env.VERCEL === '1',
}));

// ---------- admin ----------
// batasi tebak-tebak password: 6 kali salah per IP per 10 menit (hitungan per instance)
const tries = new Map();
// JANGAN baca x-forwarded-for langsung: header itu dikendalikan klien, jadi rate limit
// bisa di-bypass hanya dengan mengganti nilainya tiap request. Pakai req.ip (trust proxy).
const ipOf = req => req.ip || req.socket.remoteAddress || 'unknown';
app.post('/api/admin/login', (req, res) => {
  const ip = ipOf(req), t = tries.get(ip);
  if (t && t.n >= 6 && Date.now() - t.at < 600000) return res.status(429).json({ success: false, error: 'Kebanyakan percobaan, tunggu 10 menit' });
  if (!locked()) return res.json({ success: true });
  if (!same(sha(req.body.password || ''), sha(process.env.ADMIN_PASSWORD))) {
    tries.set(ip, { n: (t && Date.now() - t.at < 600000 ? t.n : 0) + 1, at: Date.now() });
    return res.status(401).json({ success: false, error: 'Password salah' });
  }
  tries.delete(ip);
  const exp = String(Date.now() + 12 * 3600 * 1000);
  res.setHeader('Set-Cookie', `vp=${exp}.${sign(exp)}; Path=/; HttpOnly; ${secure(req)}SameSite=Strict; Max-Age=43200`);
  res.json({ success: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `vp=; Path=/; HttpOnly; ${secure(req)}SameSite=Strict; Max-Age=0`);
  res.json({ success: true });
});
app.get('/api/admin/status', needAdmin, async (req, res) => {
  const g = await cfg('gopay'), s = await cfg('shopee');
  const ses = await store.get('shopee:session');
  res.json({ success: true, persistent: store.persistent, gopay: { token: !!g.accessToken, qris: !!g.qris },
    shopee: { token: !!s.token, qris: !!s.qris, merchant: ses?.merchant?.name || null, otp: !!ses } });
});
app.post('/api/admin/config', needAdmin, async (req, res) => {
  try {
    const { provider, accessToken, refreshToken, token, qris } = req.body;
    if (!PROVIDERS[provider]) throw bad(400, 'provider tidak dikenal');
    const cur = (await store.get('cfg:' + provider)) || {};
    const next = { ...cur };
    if (qris) next.qris = qris.trim();
    if (provider === 'gopay' && accessToken) {
      await go.getMe(accessToken).catch(() => { throw bad(400, 'Access token GoPay tidak valid'); });
      next.accessToken = accessToken.trim();
      if (refreshToken) next.refreshToken = refreshToken.trim();
    }
    if (provider === 'shopee' && token) {
      const now = Math.floor(Date.now() / 1000);
      await shopee.list(token.trim(), { startTime: now - 3600, endTime: now, pageSize: 1 }).catch(e => { throw bad(400, 'Token ShopeePay ditolak: ' + e.message); });
      next.token = token.trim();
    }
    await store.set('cfg:' + provider, next);
    res.json({ success: true, persistent: store.persistent });
  } catch (e) { fail(res, e); }
});

// ---------- pembayaran (satu sistem untuk dua provider) ----------
const payCreate = async (req, res) => {
  try {
    const { provider } = req.body, amount = parseInt(req.body.amount, 10);
    if (!PROVIDERS[provider]) throw bad(400, 'provider tidak dikenal');
    if (!(amount >= 1)) throw bad(400, 'Nominal tidak valid');
    const { qris } = await cfg(provider);
    if (!qris) throw bad(400, `QRIS statis ${PROVIDERS[provider]} belum diset (menu Admin)`);
    const q = await go.createDynamicQRIS(amount, qris);
    res.json({ success: true, provider, amount, created_at: q.created_at, expires_in: 900,
      qr_string: q.qr_string, image: 'data:image/png;base64,' + q.qr_buffer.toString('base64') });
  } catch (e) { fail(res, e); }
};

const payCheck = async (req, res) => {
  try {
    const { provider } = req.body, amount = parseInt(req.body.amount, 10);
    const from = new Date(req.body.created_at).getTime();
    if (!PROVIDERS[provider] || !(amount >= 1) || isNaN(from)) throw bad(400, 'provider, amount, created_at wajib valid');
    // created_at harus dari QRIS yang baru dibuat; kalau dipalsukan mundur, struk lama bisa ikut ke-claim
    if (from < Date.now() - 20 * 60 * 1000 || from > Date.now() + 60 * 1000) return res.json({ success: true, status: 'EXPIRED' });
    let hits;
    if (provider === 'gopay') {
      const r = await gopayJournals(new Date(from).toISOString());
      hits = (r.hits || []).filter(h => h.amount === amount * 100 && new Date(h.time).getTime() >= from)
        .map(h => ({ id: h.id, amount, time: new Date(h.time).getTime() }));
    } else {
      const list = await shopeeList({ startTime: Math.floor(from / 1000), endTime: Math.floor(Date.now() / 1000) + 60, pageSize: 50 });
      hits = list.filter(t => t.status === 'success' && t.amount === amount && t.time * 1000 >= from)
        .map(t => ({ id: t.id, amount, time: t.time * 1000 }));
    }
    for (const h of hits) { // satu struk hanya boleh dipakai satu pembeli
      if (await store.claim(`paid:${provider}:${h.id}`)) return res.json({ success: true, status: 'PAID', data: h });
    }
    res.json({ success: true, status: 'PENDING' });
  } catch (e) { fail(res, e); }
};

// route untuk bot: wajib header x-api-key = BOT_API_KEY (kalau env ini kosong, route bot mati)
const botAuth = (req, res, next) => {
  const k = process.env.BOT_API_KEY, got = String(req.headers['x-api-key'] || '');
  if (!k || !same(sha(got), sha(k))) return res.status(401).json({ success: false, error: 'API key salah' });
  next();
};
app.post('/api/pay/create', payCreate);
app.post('/api/pay/check', payCheck);
app.post('/api/bot/pay/create', botAuth, payCreate);
app.post('/api/bot/pay/check', botAuth, payCheck);

// ---------- auto refresh token ----------
// Interval per provider bisa diatur di dashboard (menu Auto Refresh).
// - Server yang jalan terus (VPS/panel/lokal): loop sendiri tiap menit, refresh kalau sudah waktunya.
// - Vercel tidak punya proses yang hidup terus: refresh jalan lewat /api/auto/tick, yang dipanggil
//   dashboard (selama terbuka) dan loop di bot (startTokenRefreshLoop di bot/payment.js).
const AUTO_DEFAULT = { gopay: { enabled: true, minutes: 15 }, shopee: { enabled: true, minutes: 60 } };
const expiryOf = d => (d && Number(d.expires_in) > 0) ? Date.now() + Number(d.expires_in) * 1000 : null;
async function autoCfg(p) { const all = (await store.get('cfg:auto')) || {}; return { ...AUTO_DEFAULT[p], ...(all[p] || {}) }; }
async function getMeta(p) { return { lastRefreshAt: null, lastError: null, failCount: 0, expiresAt: null, refreshCount: 0, sessionSince: null, lastLifetimeMs: null, deadCount: 0, ...((await store.get('meta:' + p)) || {}) }; }
async function setMeta(p, patch) { await store.set('meta:' + p, { ...(await getMeta(p)), ...patch }); }
// login=true: login OTP baru (awal sesi, hitungan refresh mulai dari 0). login=false: refresh biasa (hitungan +1).
async function markOk(p, extra = {}, login = false) {
  const m = await getMeta(p), now = Date.now();
  await setMeta(p, { lastRefreshAt: now, lastError: null, failCount: 0, refreshCount: login ? 0 : m.refreshCount + 1, sessionSince: login ? now : (m.sessionSince || now), ...extra });
}
// Token ketahuan mati: catat berapa lama token itu bertahan (batas atas, karena baru ketahuan saat dipakai)
async function markDead(p) {
  const m = await getMeta(p);
  if (m.lastRefreshAt) await setMeta(p, { lastLifetimeMs: Date.now() - m.lastRefreshAt, deadCount: m.deadCount + 1 });
}
async function markFail(p, e) { const m = await getMeta(p); await setMeta(p, { lastError: String(e.message || e).slice(0, 200), failCount: m.failCount + 1 }); }

const inflight = {};
function doRefresh(p) {
  return inflight[p] || (inflight[p] = (async () => {
    try {
      if (p === 'gopay') {
        const c = await cfg('gopay');
        if (!c.refreshToken) throw bad(400, 'Refresh token GoPay belum ada. Login OTP dulu.');
        const r = await go.refreshToken(c.refreshToken);
        const t = r.data?.access_token;
        if (!t) throw bad(502, 'GoBiz tidak mengembalikan access token');
        await store.set('cfg:gopay', { ...c, accessToken: t, refreshToken: r.data.refresh_token || c.refreshToken });
        await markOk('gopay', { expiresAt: expiryOf(r.data) });
      } else {
        if (!(await store.get('shopee:session'))) throw bad(400, 'Belum login OTP ShopeePay. Token manual tidak bisa diperpanjang otomatis.');
        await renewShopee();
      }
      return { ok: true };
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      await markFail(p, msg).catch(() => {});
      return { ok: false, error: msg };
    } finally { delete inflight[p]; }
  })());
}

async function tokenStatus(p) {
  const c = await cfg(p), m = await getMeta(p), a = await autoCfg(p), now = Date.now();
  const ses = p === 'shopee' ? await store.get('shopee:session') : null;
  const expiresAt = m.expiresAt || (ses && ses.expires_at) || null;
  return {
    hasToken: !!(p === 'gopay' ? c.accessToken : c.token), canRefresh: p === 'gopay' ? !!c.refreshToken : !!ses,
    merchant: ses?.merchant?.name || null, expiresAt, msLeft: expiresAt ? expiresAt - now : null,
    lastRefreshAt: m.lastRefreshAt, ageMs: m.lastRefreshAt ? now - m.lastRefreshAt : null,
    lastError: m.lastError, failCount: m.failCount, likelyExpired: m.failCount >= 3,
    refreshCount: m.refreshCount, sessionSince: m.sessionSince, sessionAgeMs: m.sessionSince ? now - m.sessionSince : null,
    lastLifetimeMs: m.lastLifetimeMs, deadCount: m.deadCount,
    auto: a, nextRefreshAt: (a.enabled && m.lastRefreshAt) ? m.lastRefreshAt + a.minutes * 60000 : null,
  };
}

// Refresh provider yang sudah waktunya. force=true: abaikan jadwal.
async function tick(force = false) {
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const s = await tokenStatus(p);
    if (!s.canRefresh) { out[p] = 'tidak bisa (belum login OTP)'; continue; }
    if (!force && !s.auto.enabled) { out[p] = 'nonaktif'; continue; }
    if (!force && s.lastRefreshAt) {
      const now = Date.now();
      // jatuh tempo: sudah lewat interval, ATAU token mau habis (expiry terbaca), ATAU sudah dekat umur token terakhir yang terukur
      const due = now - s.lastRefreshAt >= s.auto.minutes * 60000
        || (s.expiresAt && s.expiresAt - now < 10 * 60000)
        || (s.lastLifetimeMs && now - s.lastRefreshAt >= 0.8 * s.lastLifetimeMs);
      if (!due) { out[p] = 'belum waktunya'; continue; }
    }
    const r = await doRefresh(p);
    out[p] = r.ok ? 'ok' : 'gagal: ' + r.error;
  }
  return out;
}

const serverLoop = process.env.VERCEL !== '1' && process.env.AUTO_LOOP !== '0';
if (serverLoop) setInterval(() => tick().catch(e => console.error('[auto-refresh]', e.message)), 60000).unref();

const statusAll = async (req, res) => {
  try { res.json({ success: true, loop: serverLoop, persistent: store.persistent, gopay: await tokenStatus('gopay'), shopee: await tokenStatus('shopee') }); } catch (e) { fail(res, e); }
};
const refreshNow = async (req, res) => {
  try {
    const p = req.body.provider;
    if (!PROVIDERS[p]) throw bad(400, 'provider tidak dikenal');
    const r = await doRefresh(p);
    res.status(r.ok ? 200 : 400).json({ success: r.ok, error: r.error, status: await tokenStatus(p) });
  } catch (e) { fail(res, e); }
};
const tickRoute = async (req, res) => {
  try { const result = await tick(); res.json({ success: true, result, gopay: await tokenStatus('gopay'), shopee: await tokenStatus('shopee') }); } catch (e) { fail(res, e); }
};
app.get('/api/token/status', needAdmin, statusAll);
app.post('/api/refresh', needAdmin, refreshNow);
app.post('/api/auto/tick', needAdmin, tickRoute);
app.get('/api/bot/token/status', botAuth, statusAll);
app.post('/api/bot/refresh', botAuth, refreshNow);
app.post('/api/bot/auto/tick', botAuth, tickRoute);
app.post('/api/auto/config', needAdmin, async (req, res) => {
  try {
    const { provider, enabled, minutes } = req.body;
    if (!PROVIDERS[provider]) throw bad(400, 'provider tidak dikenal');
    const all = (await store.get('cfg:auto')) || {};
    const cur = { ...AUTO_DEFAULT[provider], ...(all[provider] || {}) };
    if (enabled !== undefined) cur.enabled = !!enabled;
    if (minutes !== undefined) cur.minutes = Math.min(720, Math.max(5, Math.round(Number(minutes)) || cur.minutes));
    await store.set('cfg:auto', { ...all, [provider]: cur });
    res.json({ success: true, auto: cur });
  } catch (e) { fail(res, e); }
});

app.get('/api/pay/history', needAdmin, async (req, res) => {
  try {
    const { provider } = req.query;
    const now = Date.now();
    let data;
    if (provider === 'gopay') {
      const r = await gopayJournals(new Date(now - 7 * 864e5).toISOString());
      data = (r.hits || []).filter(h => h.metadata?.transaction?.payment_type === 'qris').map(h => {
        const a = h.metadata?.provider_metadata?.aspi;
        return { id: h.id, amount: a?.data?.amount || h.amount / 100 || 0, status: h.status, time: new Date(h.time).getTime(), issuer: a?.issuer || null };
      });
    } else if (provider === 'shopee') {
      const l = await shopeeList({ startTime: Math.floor(now / 1000) - 7 * 86400, endTime: Math.floor(now / 1000), pageSize: 30 });
      data = l.map(t => ({ ...t, time: t.time * 1000 }));
    } else throw bad(400, 'provider tidak dikenal');
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});

// ---------- login GoPay via OTP (token otomatis tersimpan) ----------
app.post('/api/gopay/otp', needAdmin, async (req, res) => {
  try {
    const d = await go.requestOtp(require('./lib/phone')(req.body.phone).national);   // 08xx / 628xx / +628xx semua diterima, dikirim sebagai +62
    res.json({ success: true, otp_token: d.data.otp_token });
  } catch (e) { fail(res, e); }
});
app.post('/api/gopay/verify', needAdmin, async (req, res) => {
  try {
    const d = await go.verifyOtp(req.body.otp, req.body.otp_token);
    const t = d.data || d;
    if (!t.access_token) throw bad(400, 'OTP salah atau kedaluwarsa');
    // save:false = token cuma ditampilkan ke browser (untuk disalin), TIDAK disimpan di server
    const save = req.body.save !== false;
    if (save) {
      const c = (await store.get('cfg:gopay')) || {};
      await store.set('cfg:gopay', { ...c, accessToken: t.access_token, refreshToken: t.refresh_token });
      await markOk('gopay', { expiresAt: expiryOf(t) }, true);
    }
    res.json({ success: true, saved: save, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiryOf(t) });
  } catch (e) { fail(res, e); }
});

// ---------- login ShopeePay via OTP ----------
// Challenge diberi jti unik -> sekali pakai (anti-replay).
const sealChallenge = (c, ttl = 5 * 60 * 1000) => seal({ ...c, jti: guard.newJti() }, ttl);

app.post('/api/shopee/otp', needAdmin, otpGate, async (req, res) => {
  const t0 = Date.now();
  try {
    const c = await sauth.requestOtp(req.body.phone, {
      password: req.body.password || undefined,
      channel: req.body.channel,
      deviceReport: req.body.device_report || undefined,
      captchaSignature: req.body.captcha_signature || undefined,
      captchaAnswer: req.body.captcha_answer || undefined,
      captchaToken: req.body.captcha_token || undefined,
      captchaSceneId: req.body.captcha_scene_id || undefined,
    });
    audit.otp({ action: 'request', phone: c.phone, ip: ipOf(req), outcome: 'ok', ms: Date.now() - t0,
      detail: { channel: c.channel, channels: c.channels, sendVerified: c.sendVerified, evidence: c.sendEvidence }, trace: c.trace });
    // trace = jejak langkah (tanpa kode OTP), berguna saat OTP tidak sampai
    res.json({ success: true, challenge: sealChallenge(c), channel: c.channel, channels: c.channels,
      send_verified: c.sendVerified, evidence: c.sendEvidence, trace: c.trace });
  } catch (e) {
    audit.otp({ action: 'request', phone: req.body.phone, ip: ipOf(req), outcome: 'fail', code: e.code, message: e.message, ms: Date.now() - t0, trace: e.retry && e.retry.trace });
    // captcha / device-block: kirim state retry supaya user tidak perlu ulang dari nol
    const body = { success: false, error: e.response?.data?.message || e.message, code: e.code ?? null, hint: e.hint || null, captcha: e.captcha || null };
    if (e.retry) body.retry = seal(e.retry, 5 * 60 * 1000);
    res.status(e.status || 400).json(body);
  }
});

// Kirim ulang OTP memakai state dari error captcha/device — tanpa login page,
// device-risk, dan password lagi (itu justru menaikkan skor risiko Shopee).
app.post('/api/shopee/otp/retry', needAdmin, retryGate, async (req, res) => {
  const t0 = Date.now();
  try {
    const st = unseal(req.body.retry);
    if (!st) throw bad(400, 'State retry kedaluwarsa, kirim OTP dari awal');
    const c = await sauth.retrySendOtp(st, {
      captchaSignature: req.body.captcha_signature || undefined,
      captchaAnswer: req.body.captcha_answer || undefined,
      captchaToken: req.body.captcha_token || undefined,
      captchaSceneId: req.body.captcha_scene_id || undefined,
    });
    audit.otp({ action: 'retry', phone: c.phone, ip: ipOf(req), outcome: 'ok', ms: Date.now() - t0,
      detail: { channel: c.channel, sendVerified: c.sendVerified, evidence: c.sendEvidence }, trace: c.trace });
    res.json({ success: true, challenge: sealChallenge(c), channel: c.channel, channels: c.channels,
      send_verified: c.sendVerified, evidence: c.sendEvidence, trace: c.trace });
  } catch (e) {
    audit.otp({ action: 'retry', phone: req.body.phone, ip: ipOf(req), outcome: 'fail', code: e.code, message: e.message, ms: Date.now() - t0 });
    const body = { success: false, error: e.response?.data?.message || e.message, code: e.code ?? null, hint: e.hint || null, captcha: e.captcha || null };
    if (e.retry) body.retry = seal(e.retry, 5 * 60 * 1000);
    res.status(e.status || 400).json(body);
  }
});

// ---------- identitas perangkat (device-check Shopee) ----------
// GET: ringkasan identitas yang sedang dipakai (tanpa membocorkan blob penuh).
app.get('/api/shopee/identity', needAdmin, (req, res) => {
  res.json({ success: true, identity: identity.snapshot(), secret_source: require('./lib/seal').secretSource(), backend: store.backend });
});
// POST: tempel data asli dari browser yang sudah pernah login sukses.
// Ini yang membuat device-check lolos: device report + szdet + captcha_signature asli.
app.post('/api/shopee/identity', needAdmin, async (req, res) => {
  try {
    const { device_id, device_report, szdet, captcha_signature, ua, sdk_version, note } = req.body || {};
    if (device_report) {
      const s = String(device_report).trim();
      if (s.length < 20) throw bad(400, 'device_report terlalu pendek — tempel body JSON lengkap dari request /v2/shpsec/web/report');
      try { JSON.parse(s); } catch { throw bad(400, 'device_report harus JSON valid (body request /v2/shpsec/web/report)'); }
    }
    const next = await identity.update({ deviceId: device_id, deviceReport: device_report, szdet, captchaSignature: captcha_signature, ua, sdkVersion: sdk_version, note, source: 'capture' });
    audit.otp({ action: 'identity', phone: null, ip: ipOf(req), outcome: 'ok', detail: { source: 'capture', hasReport: !!next.deviceReport, hasSzdet: !!next.szdet, hasCaptcha: !!next.captchaSignature } });
    res.json({ success: true, identity: identity.snapshot() });
  } catch (e) { fail(res, e); }
});
// POST /api/shopee/identity/reset: kembali ke identitas turunan (kalau capture salah).
app.post('/api/shopee/identity/reset', needAdmin, async (req, res) => {
  await identity.reset();
  audit.otp({ action: 'identity', phone: null, ip: ipOf(req), outcome: 'ok', detail: { source: 'reset' } });
  res.json({ success: true, identity: identity.snapshot() });
});

// ---------- audit trail ----------
app.get('/api/shopee/audit', needAdmin, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ success: true, stats: await audit.stats(), events: await audit.read({ limit, phone: req.query.phone || null, outcome: req.query.outcome || null }) });
});

// Diagnostik: jalankan alur sampai SEBELUM send_otp, jadi tidak memicu OTP/rate limit.
// Dipakai untuk memastikan apakah hambatannya di device-risk, password, atau captcha.
app.post('/api/shopee/diagnose', needAdmin, async (req, res) => {
  const t0 = Date.now();
  try {
    const d = await sauth.diagnose(req.body.phone, {
      password: req.body.password || undefined,
      deviceReport: req.body.device_report || undefined,
    });
    audit.otp({ action: 'diagnose', phone: d.phone, ip: ipOf(req), outcome: d.steps.every(s => s.ok) ? 'ok' : 'fail', ms: Date.now() - t0, detail: { verdict: d.verdict } });
    res.json({ success: true, ...d });
  } catch (e) { fail(res, e); }
});
async function finishShopee(ver, merchantId, save = true) {
  const ses = await sauth.completeLogin(ver, merchantId);
  if (save) { // save:false = token cuma ditampilkan ke browser, sesi dan token TIDAK disimpan di server
    await store.set('shopee:session', ses);
    const c = (await store.get('cfg:shopee')) || {};
    await store.set('cfg:shopee', { ...c, token: ses.token });
    await markOk('shopee', { expiresAt: ses.expires_at || null }, true);
  }
  return ses;
}
const shopeeDone = (ses, save) => ({ success: true, saved: save, merchant: ses.merchant.name, token: ses.token, session: ses, expires_at: ses.expires_at || null });
app.post('/api/shopee/verify', needAdmin, verifyGate, async (req, res) => {
  const t0 = Date.now();
  try {
    const ch = unseal(req.body.challenge);
    if (!ch) throw bad(400, 'Challenge OTP kedaluwarsa, kirim OTP lagi');
    // anti-replay: challenge sekali pakai
    if (!(await guard.consume(ch.jti, 'ch'))) throw bad(409, 'Challenge OTP ini sudah dipakai. Kirim OTP baru.');
    const att = await guard.verifyAttempt(ch.jti);
    if (!att.ok) throw Object.assign(bad(429, `Terlalu banyak percobaan OTP untuk challenge ini. Tunggu ${att.wait} detik atau kirim OTP baru.`), { code: 'RATE_LIMITED' });
    const ver = await sauth.verifyOtp(ch, req.body.otp);
    if (!sauth.singleMerchant(ver.merchants)) { // lebih dari satu merchant: user pilih dulu, tanpa OTP baru
      audit.otp({ action: 'verify', phone: ch.phone, ip: ipOf(req), outcome: 'ok', ms: Date.now() - t0, detail: { select: true, merchants: ver.merchants.length } });
      return res.json({ success: true, select: true, verification: seal({ ...ver, jti: guard.newJti() }, 10 * 60 * 1000),
        merchants: sauth.usable(ver.merchants).map(m => ({ id: m.id, name: m.name })) });
    }
    const save = req.body.save !== false;
    const ses = await finishShopee(ver, undefined, save);
    audit.otp({ action: 'verify', phone: ch.phone, ip: ipOf(req), outcome: 'ok', ms: Date.now() - t0, detail: { merchant: ses.merchant.name, saved: save } });
    res.json(shopeeDone(ses, save));
  } catch (e) {
    audit.otp({ action: 'verify', phone: req.body.phone, ip: ipOf(req), outcome: 'fail', code: e.code, message: e.message, ms: Date.now() - t0 });
    fail(res, e);
  }
});
app.post('/api/shopee/select', needAdmin, async (req, res) => {
  try {
    const ver = unseal(req.body.verification);
    if (!ver) throw bad(400, 'Sesi pilih merchant kedaluwarsa, ulangi login OTP');
    if (!(await guard.consume(ver.jti, 'ver'))) throw bad(409, 'Sesi pilih merchant ini sudah dipakai. Ulangi login OTP.');
    const save = req.body.save !== false;
    const ses = await finishShopee(ver, req.body.merchant_id, save);
    audit.otp({ action: 'select', phone: null, ip: ipOf(req), outcome: 'ok', detail: { merchant: ses.merchant.name, saved: save } });
    res.json(shopeeDone(ses, save));
  } catch (e) { fail(res, e); }
});
app.post('/api/shopee/logout', needAdmin, async (req, res) => {
  await store.del('shopee:session');
  const c = (await store.get('cfg:shopee')) || {};
  delete c.token;
  await store.set('cfg:shopee', c);
  res.json({ success: true });
});

// Vercel Cron: jaga token GoPay tetap segar
app.get('/api/cron/refresh', async (req, res) => {
  // fail-closed: tanpa CRON_SECRET endpoint ini tidak boleh terbuka untuk umum
  if (!process.env.CRON_SECRET) return res.status(503).json({ success: false, error: 'CRON_SECRET belum diset' });
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const out = {};
  try { await gopay(t => go.getMe(t)); out.gopay = 'ok'; } catch (e) { out.gopay = e.message; }
  try { out.shopee = (await store.get('shopee:session')) ? ((await renewShopee()) ? 'ok' : 'skip') : 'skip'; } catch (e) { out.shopee = e.message; }
  res.json({ success: true, ...out });
});

// ---------- peringatan startup (kredensial) ----------
// Review sebelumnya: kredensial asli ter-commit di config.js dan BOT_API_KEY sama
// dengan ADMIN_PASSWORD. Sekarang config.js kosong, tapi kalau user mengisinya lagi
// (atau memakai env yang sama untuk dua hal) kita peringatkan dengan jelas.
function startupWarnings() {
  const w = [];
  const bot = process.env.BOT_API_KEY, adm = process.env.ADMIN_PASSWORD;
  if (bot && adm && bot === adm) w.push('BOT_API_KEY sama dengan ADMIN_PASSWORD — pakai nilai berbeda (kalau bot bocor, dashboard ikut bocor).');
  if (adm && String(adm).length < 12) w.push('ADMIN_PASSWORD kurang dari 12 karakter — pakai password yang lebih panjang.');
  if (!adm) w.push('ADMIN_PASSWORD kosong: dashboard berjalan di MODE PUBLIK (tanpa login). Isi ADMIN_PASSWORD kalau ini server produksi.');
  if (!process.env.SESSION_SECRET && !adm) w.push('SESSION_SECRET kosong: kunci seal dibuat otomatis dan disimpan di backend ' + store.backend + '.');
  if (process.env.VERCEL === '1' && !store.persistent) {
    w.push('Vercel tanpa Redis: state (device_id, rate limit, audit) hanya di memori instance. Isi UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN supaya bertahan.');
  }
  return w;
}
const WARNINGS = startupWarnings();

// Siapkan backend penyimpanan + kunci seal + identitas perangkat sebelum melayani request.
// Di Vercel, init ini jalan sekali per instance (cold start).
const boot = (async () => {
  await require('./lib/seal').init();
  await identity.init();
  return true;
})();
app._boot = boot;

if (process.env.VERCEL !== '1') boot.then(() => app.listen(process.env.PORT || 3015, () => {
  console.log('Vincent Pay jalan di :' + (process.env.PORT || 3015));
  console.log('Penyimpanan: ' + store.backend + (store.persistent ? ' (persisten)' : ' (sementara)'));
  console.log('Identitas Shopee: device ' + identity.snapshot().deviceIdShort + ' (' + identity.snapshot().source + ')');
  for (const w of WARNINGS) console.warn('[peringatan] ' + w);
}));
app._warnings = WARNINGS;
require('./lib/v1')({ app, go, shopee, sauth, seal, unseal, bad, fail });   // API publik stateless /api/v1/*
app._tick = tick; // dipakai tes
module.exports = app;
