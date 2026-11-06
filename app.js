require('./lib/loadConfig')();   // config.js -> env (harus paling awal)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const otp = require('./lib/otp');
const qris = require('./lib/qris');
const shopee = require('./lib/shopee');
const { seal, unseal } = require('./lib/seal');

const app = express();
const PORT = process.env.PORT || 3015;
const API_KEY = String(process.env.API_KEY || '').trim();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => {
  const x = sha(a), y = sha(b);
  return crypto.timingSafeEqual(x, y);
};

// ---------- gerbang API key: hanya untuk aksi (Request OTP / Execute / QRIS) ----------
function requireKey(req, res, next) {
  if (!API_KEY) return next();                       // tidak dikunci
  const got = String(req.body?.apikey || req.headers['x-api-key'] || '').trim();
  if (!got) return res.status(401).json({ success: false, code: 'API_KEY_REQUIRED', error: 'API key diperlukan untuk menjalankan aksi ini.' });
  if (!same(got, API_KEY)) return res.status(401).json({ success: false, code: 'API_KEY_INVALID', error: 'API key tidak cocok.' });
  next();
}

const fail = (res, e) => {
  const status = e.status || 400;
  res.status(status).json({ success: false, code: e.code || null, error: otp.friendly(e) });
};

// ---------- halaman ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/health', (req, res) => res.json({ success: true, service: 'Vincent Pay', locked: !!API_KEY, time: Date.now() }));

// ---------- OTP ----------
app.post('/api/otp/request', requireKey, async (req, res) => {
  const started = Date.now();
  try {
    const provider = String(req.body.provider || 'shopee').toLowerCase();
    if (!['shopee', 'gopay'].includes(provider)) throw bad(400, 'Provider tidak dikenal');
    if (!req.body.phone) throw bad(400, 'Nomor HP wajib diisi');

    const out = await otp.request(provider, {
      phone: req.body.phone,
      password: req.body.password || undefined,
      channel: req.body.channel,
    });

    res.json({
      success: true,
      provider,
      phone: out.phone,
      channel: out.channel,
      channel_label: out.channel_label,
      channels: out.channels,
      has_password: out.has_password,
      expires_in: out.expires_in,
      challenge: seal(out.challenge, 10 * 60 * 1000),
      elapsed_ms: Date.now() - started,
      at: new Date().toISOString(),
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/otp/verify', requireKey, async (req, res) => {
  const started = Date.now();
  try {
    const provider = String(req.body.provider || 'shopee').toLowerCase();
    const challenge = unseal(req.body.challenge);
    if (!challenge) throw bad(400, 'Sesi OTP kedaluwarsa. Kirim ulang OTP.');
    const code = String(req.body.otp || '').trim();
    if (!/^\d{4,10}$/.test(code)) throw bad(400, 'Kode OTP harus 4 sampai 10 digit');

    const out = await otp.verify(provider, challenge, code);
    res.json({
      success: true,
      provider,
      token: out.token,
      refresh_token: out.refresh_token || null,
      account_id: out.account_id || null,
      merchant: out.merchant,
      merchants: out.merchants,
      expires_at: out.expires_at || null,
      elapsed_ms: Date.now() - started,
      at: new Date().toISOString(),
    });
  } catch (e) { fail(res, e); }
});

// ---------- QRIS ----------
app.post('/api/qris/inspect', (req, res) => {
  try {
    const payload = String(req.body.payload || '').trim();
    if (!payload) throw bad(400, 'Payload QRIS kosong');
    const info = qris.info(payload);
    if (!info.valid) throw bad(400, 'Payload bukan QRIS yang valid');
    res.json({ success: true, ...info });
  } catch (e) { fail(res, e); }
});

app.post('/api/qris/create', requireKey, async (req, res) => {
  const started = Date.now();
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!(amount >= 1)) throw bad(400, 'Nominal tidak valid');
    const staticQr = qris.normalizeStatic(req.body.static_qr);
    const payload = qris.toDynamic(staticQr, amount);
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 640,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    const info = qris.info(payload);
    res.json({
      success: true,
      amount,
      payload,
      image: dataUrl,
      info,
      created_at: new Date().toISOString(),
      expires_in: 900,
      elapsed_ms: Date.now() - started,
    });
  } catch (e) { fail(res, e); }
});

// Cek status pembayaran QRIS ke provider (butuh token hasil OTP)
app.post('/api/qris/check', requireKey, async (req, res) => {
  const started = Date.now();
  try {
    const provider = String(req.body.provider || 'shopee').toLowerCase();
    const amount = parseInt(req.body.amount, 10);
    const token = String(req.body.token || '').trim();
    if (!(amount >= 1)) throw bad(400, 'Nominal tidak valid');
    if (!token) throw bad(400, 'Token belum ada. Selesaikan OTP dulu.');

    const from = req.body.created_at ? new Date(req.body.created_at).getTime() : Date.now() - 15 * 60 * 1000;
    if (isNaN(from)) throw bad(400, 'Waktu pembuatan QRIS tidak valid');

    let hits = [];
    if (provider === 'shopee') {
      const list = await shopee.list(token, {
        startTime: Math.floor(from / 1000) - 5,
        endTime: Math.floor(Date.now() / 1000) + 60,
        pageSize: 50,
      });
      hits = list.filter(t => t.status === 'success' && t.amount === amount && t.time * 1000 >= from - 5000)
        .map(t => ({ id: t.id, amount: t.amount, time: t.time * 1000 }));
    } else {
      const me = await otp.go.getMe(token);
      const r = await otp.go.getJournals(token, me.user.merchant_id, new Date(from).toISOString());
      hits = (r.hits || [])
        .filter(h => h.amount === amount * 100 && new Date(h.time).getTime() >= from - 5000)
        .map(h => ({ id: h.id, amount, time: new Date(h.time).getTime() }));
    }

    res.json({
      success: true,
      provider,
      status: hits.length ? 'PAID' : 'PENDING',
      data: hits[0] || null,
      checked_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started,
    });
  } catch (e) { fail(res, e); }
});

// ---------- 404 ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log('Vincent Pay siap di http://localhost:' + PORT));
}

module.exports = app;
