const express = require('express');
const path = require('path');
const crypto = require('crypto');
const GoMerchant = require('./GoMerchant');
const shopee = require('./lib/shopee');
const store = require('./lib/store');
const sauth = require('./lib/shopeeAuth');
const { seal, unseal } = require('./lib/seal');

const app = express();
const go = new GoMerchant();
const SECRET = process.env.SESSION_SECRET || '';
const PROVIDERS = { gopay: 'GoPay Merchant', shopee: 'ShopeePay Partner' };

app.use(express.json({ limit: '200kb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- auth admin: cookie bertanda tangan (stateless, aman untuk serverless) ----------
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const same = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function isAdmin(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('vp='));
  if (!c || !SECRET) return false;
  const [exp, sig] = c.slice(3).split('.');
  return !!(exp && sig && +exp > Date.now() && same(sig, sign(exp)));
}
const secure = req => (req.secure || req.headers['x-forwarded-proto'] === 'https') ? 'Secure; ' : '';
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ success: false, error: 'Login admin dulu' });
const fail = (res, e, code = 400) => res.status(e.status || code).json({ success: false, error: e.response?.data?.message || e.message });
const bad = (status, message) => Object.assign(new Error(message), { status });

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
    const r = await go.refreshToken(c.refreshToken);
    const t = r.data?.access_token;
    if (!t) throw e;
    await store.set('cfg:gopay', { ...c, accessToken: t, refreshToken: r.data.refresh_token || c.refreshToken });
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
  return n.token;
}
async function shopeeList(opts) {
  const { token } = await cfg('shopee');
  if (!token) throw bad(400, 'Token ShopeePay belum diset (menu Admin)');
  try { return await shopee.list(token, opts); } catch (e) {
    if (!DEAD.includes(String(e.code))) throw e;
    const t = await renewShopee().catch(() => null); // token mati: coba perpanjang tanpa OTP baru
    if (!t) throw bad(401, 'Token ShopeePay kedaluwarsa. Login OTP ShopeePay lagi di menu Admin.');
    return shopee.list(t, opts);
  }
}

// ---------- halaman ----------
app.get('/', (req, res) => res.render('index', { admin: isAdmin(req), persistent: store.persistent }));
app.get('/api/health', (req, res) => res.json({ success: true, service: 'Vincent Pay', persistent: store.persistent }));

// ---------- admin ----------
// batasi tebak-tebak password: 6 kali salah per IP per 10 menit (hitungan per instance)
const tries = new Map();
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
app.post('/api/admin/login', (req, res) => {
  const ip = ipOf(req), t = tries.get(ip);
  if (t && t.n >= 6 && Date.now() - t.at < 600000) return res.status(429).json({ success: false, error: 'Kebanyakan percobaan, tunggu 10 menit' });
  if (!process.env.ADMIN_PASSWORD || !SECRET) return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD & SESSION_SECRET belum diset di Vercel' });
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
app.post('/api/pay/create', async (req, res) => {
  try {
    const { provider } = req.body, amount = parseInt(req.body.amount, 10);
    if (!PROVIDERS[provider]) throw bad(400, 'provider tidak dikenal');
    if (!(amount >= 1)) throw bad(400, 'Nominal tidak valid');
    const { qris } = await cfg(provider);
    if (!qris) throw bad(400, `QRIS statis ${PROVIDERS[provider]} belum diset (menu Admin)`);
    const q = await go.createDynamicQRIS(amount, qris);
    res.json({ success: true, provider, amount, created_at: q.created_at, expires_in: 900,
      image: 'data:image/png;base64,' + q.qr_buffer.toString('base64') });
  } catch (e) { fail(res, e); }
});

app.post('/api/pay/check', async (req, res) => {
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
    let ph = String(req.body.phone || '').replace(/\D/g, '');
    if (ph.startsWith('62')) ph = ph.slice(2);
    if (ph.startsWith('0')) ph = ph.slice(1);
    if (ph.length < 8) throw bad(400, 'Nomor HP tidak valid');
    const d = await go.requestOtp(ph);
    res.json({ success: true, otp_token: d.data.otp_token });
  } catch (e) { fail(res, e); }
});
app.post('/api/gopay/verify', needAdmin, async (req, res) => {
  try {
    const d = await go.verifyOtp(req.body.otp, req.body.otp_token);
    const t = d.data || d;
    if (!t.access_token) throw bad(400, 'OTP salah atau kedaluwarsa');
    const c = (await store.get('cfg:gopay')) || {};
    await store.set('cfg:gopay', { ...c, accessToken: t.access_token, refreshToken: t.refresh_token });
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ---------- login ShopeePay via OTP ----------
app.post('/api/shopee/otp', needAdmin, async (req, res) => {
  try {
    const c = await sauth.requestOtp(req.body.phone, { password: req.body.password || undefined, channel: req.body.channel, deviceReport: process.env.SHOPEE_DEVICE_REPORT || undefined });
    res.json({ success: true, challenge: seal(c, 5 * 60 * 1000), channel: c.channel, channels: c.channels });
  } catch (e) { fail(res, e); }
});
async function finishShopee(ver, merchantId) {
  const ses = await sauth.completeLogin(ver, merchantId);
  await store.set('shopee:session', ses);
  const c = (await store.get('cfg:shopee')) || {};
  await store.set('cfg:shopee', { ...c, token: ses.token });
  return ses;
}
app.post('/api/shopee/verify', needAdmin, async (req, res) => {
  try {
    const ch = unseal(req.body.challenge);
    if (!ch) throw bad(400, 'Challenge OTP kedaluwarsa, kirim OTP lagi');
    const ver = await sauth.verifyOtp(ch, req.body.otp);
    if (!sauth.singleMerchant(ver.merchants)) { // lebih dari satu merchant: user pilih dulu, tanpa OTP baru
      return res.json({ success: true, select: true, verification: seal(ver, 10 * 60 * 1000),
        merchants: sauth.usable(ver.merchants).map(m => ({ id: m.id, name: m.name })) });
    }
    const ses = await finishShopee(ver);
    res.json({ success: true, merchant: ses.merchant.name });
  } catch (e) { fail(res, e); }
});
app.post('/api/shopee/select', needAdmin, async (req, res) => {
  try {
    const ver = unseal(req.body.verification);
    if (!ver) throw bad(400, 'Sesi pilih merchant kedaluwarsa, ulangi login OTP');
    const ses = await finishShopee(ver, req.body.merchant_id);
    res.json({ success: true, merchant: ses.merchant.name });
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
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const out = {};
  try { await gopay(t => go.getMe(t)); out.gopay = 'ok'; } catch (e) { out.gopay = e.message; }
  try { out.shopee = (await store.get('shopee:session')) ? ((await renewShopee()) ? 'ok' : 'skip') : 'skip'; } catch (e) { out.shopee = e.message; }
  res.json({ success: true, ...out });
});

if (process.env.VERCEL !== '1') app.listen(process.env.PORT || 3015, () => console.log('Vincent Pay jalan di :' + (process.env.PORT || 3015)));
module.exports = app;
