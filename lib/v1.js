// API publik "stateless" (/api/v1/...): semua data dikirim lewat parameter, tidak ada yang disimpan di server.
// Bisa dipanggil GET (query) atau POST (JSON). Kalau BOT_API_KEY diisi, wajib kirim apikey.
const crypto = require('crypto');
const normPhone = require('./phone');

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const DEAD = ['200020', '2010000'];

module.exports = function mountV1({ app, go, shopee, sauth, seal, unseal, bad, fail }) {
  const P = req => ({ ...req.query, ...(req.body || {}) });

  const gate = (req, res, next) => {
    const key = process.env.BOT_API_KEY;
    if (!key) return next();                               // mode publik
    const got = P(req).apikey || req.headers['x-api-key'] || '';
    if (!crypto.timingSafeEqual(sha(got), sha(key))) return res.status(401).json({ success: false, error: 'apikey salah atau belum dikirim' });
    next();
  };
  // methods default POST: endpoint yang mengubah state (kirim OTP, verify, create) tidak
  // boleh bisa dipicu lewat GET — crawler/prefetch bisa jadi OTP bombing, dan password
  // di query string ikut tercatat di access log.
  const route = (p, fn, { methods = ['post'] } = {}) => {
    const m = methods.length === 1 ? methods[0] : 'all';
    app[m](p, gate, async (req, res) => { try { res.json(await fn(P(req))); } catch (e) { fail(res, e); } });
  };
  const need = (p, ...names) => { for (const n of names) if (p[n] === undefined || String(p[n]).trim() === '') throw bad(400, `parameter ${n} wajib diisi`); };
  const expiryOf = d => (d && Number(d.expires_in) > 0) ? Date.now() + Number(d.expires_in) * 1000 : null;

  async function createQr(p) {
    need(p, 'amount', 'static_qr');
    const amount = parseInt(p.amount, 10);
    if (!(amount >= 1)) throw bad(400, 'amount tidak valid');
    const q = String(p.static_qr).trim();
    if (!q.includes('010211') || !q.includes('5802ID')) throw bad(400, 'static_qr tidak valid (harus QRIS statis, diawali 000201...)');
    const r = await go.createDynamicQRIS(amount, q);
    return { success: true, amount, qr_string: r.qr_string, qr_buffer: r.qr_buffer.toString('base64'), created_at: r.created_at, expires_in: 900 };
  }

  // ---------------- ShopeePay ----------------
  route('/api/v1/shopee/otp', async p => {
    need(p, 'phone');
    const ph = normPhone(p.phone);
    const c = await sauth.requestOtp(ph.plus, { password: p.password || undefined, channel: p.channel === undefined || p.channel === '' ? undefined : Number(p.channel), deviceReport: process.env.SHOPEE_DEVICE_REPORT || undefined });
    return { success: true, phone: ph.plus, challenge: seal(c, 5 * 60 * 1000), channel: c.channel, channels: c.channels };
  });

  route('/api/v1/shopee/verify', async p => {
    let ver;
    if (p.verification) {                                   // langkah lanjutan: pilih merchant (tanpa OTP baru)
      ver = unseal(p.verification);
      if (!ver) throw bad(400, 'verification kedaluwarsa, ulangi dari Get OTP');
    } else {
      need(p, 'challenge', 'otp');
      const ch = unseal(p.challenge);
      if (!ch) throw bad(400, 'challenge kedaluwarsa, ulangi dari Get OTP');
      ver = await sauth.verifyOtp(ch, p.otp);
    }
    const mid = p.merchant_id ? String(p.merchant_id) : undefined;
    if (!mid && !sauth.singleMerchant(ver.merchants)) {
      return { success: true, select: true, verification: seal(ver, 10 * 60 * 1000), merchants: sauth.usable(ver.merchants).map(m => ({ id: m.id, name: m.name })),
        note: 'Ada beberapa merchant. Panggil verify lagi dengan verification + merchant_id (tanpa otp).' };
    }
    const ses = await sauth.completeLogin(ver, mid);
    const out = { success: true, token: ses.token, merchant: { id: ses.merchant.id, name: ses.merchant.name }, expires_at: ses.expires_at || null };
    if (['1', 'true'].includes(String(p.include_session))) out.session = ses;   // disimpan di sisi pemanggil, server tidak menyimpan
    return out;
  });

  // Perpanjang token tanpa OTP baru. Sesi dikirim pemanggil, server tidak menyimpan apa pun.
  route('/api/v1/shopee/refresh', async p => {
    need(p, 'session');
    let ses;
    try { ses = typeof p.session === 'string' ? JSON.parse(p.session) : p.session; } catch { throw bad(400, 'session bukan JSON yang valid'); }
    const n = await sauth.refreshSession(ses);
    return { success: true, token: n.token, session: n, expires_at: n.expires_at || null };
  });

  route('/api/v1/shopee/check-token', async p => {
    need(p, 'token');
    const n = Math.floor(Date.now() / 1000);
    try { await shopee.list(String(p.token).trim(), { startTime: n - 3600, endTime: n, pageSize: 1 }); return { success: true, valid: true, message: 'Token valid' }; } catch (e) {
      if (e.code !== undefined) return { success: true, valid: false, expired: DEAD.includes(String(e.code)), message: e.message };
      throw bad(502, 'Tidak bisa menghubungi Shopee: ' + e.message);
    }
  }, { methods: ['get', 'post'] });

  route('/api/v1/shopee/create', createQr);

  route('/api/v1/shopee/mutasi', async p => {
    need(p, 'token');
    const end = p.end_time ? parseInt(p.end_time, 10) : Math.floor(Date.now() / 1000);
    const start = p.start_time ? parseInt(p.start_time, 10) : end - 30 * 86400;
    if (!(start > 0 && end >= start)) throw bad(400, 'start_time / end_time harus epoch detik dan start <= end');
    try {
      const l = await shopee.list(String(p.token).trim(), { startTime: start, endTime: end, pageSize: 50 });
      return { success: true, count: l.length, data: l.map(t => ({ ...t, time: t.time * 1000 })) };
    } catch (e) {
      if (e.code !== undefined) throw bad(401, 'Token ditolak Shopee: ' + e.message);
      throw e;
    }
  }, { methods: ['get', 'post'] });

  // ---------------- GoMerch ----------------
  route('/api/v1/gopay/otp', async p => {
    need(p, 'phone');
    const ph = normPhone(p.phone);
    const d = await go.requestOtp(ph.national);
    return { success: true, phone: ph.plus, otp_token: d.data.otp_token };
  });

  route('/api/v1/gopay/verify', async p => {
    need(p, 'otp', 'otp_token');
    const d = await go.verifyOtp(String(p.otp).trim(), p.otp_token);
    const t = d.data || d;
    if (!t.access_token) throw bad(400, 'OTP ditolak GoBiz');
    return { success: true, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiryOf(t) };
  });

  route('/api/v1/gopay/check-token', async p => {
    need(p, 'token');
    try { const me = await go.getMe(String(p.token).trim()); return { success: true, valid: true, message: 'Token valid', merchant_id: me.user?.merchant_id || null }; } catch (e) {
      if (e.response?.status === 401) return { success: true, valid: false, expired: true, message: 'Token tidak valid atau sudah kedaluwarsa' };
      throw bad(502, 'Tidak bisa menghubungi GoBiz: ' + (e.response?.data?.message || e.message));
    }
  }, { methods: ['get', 'post'] });

  route('/api/v1/gopay/refresh', async p => {
    need(p, 'refresh_token');
    const r = await go.refreshToken(String(p.refresh_token).trim());
    const t = r.data;
    if (!t?.access_token) throw bad(400, 'refresh_token ditolak GoBiz');
    return { success: true, access_token: t.access_token, refresh_token: t.refresh_token || p.refresh_token, expires_at: expiryOf(t) };
  });

  route('/api/v1/gopay/create', createQr);

  route('/api/v1/gopay/mutasi', async p => {
    need(p, 'token');
    const token = String(p.token).trim();
    let start = null;
    if (p.start_time) { const n = Number(p.start_time); start = new Date(n > 1e12 ? n : n * 1000).toISOString(); if (start === 'Invalid Date') throw bad(400, 'start_time tidak valid'); }
    try {
      const me = await go.getMe(token);
      const r = await go.getJournals(token, me.user.merchant_id, start);
      const data = (r.hits || []).filter(h => h.metadata?.transaction?.payment_type === 'qris').map(h => {
        const a = h.metadata?.provider_metadata?.aspi;
        return { id: h.id, amount: a?.data?.amount || h.amount / 100 || 0, status: h.status, time: new Date(h.time).getTime(), issuer: a?.issuer || null };
      });
      return { success: true, count: data.length, data };
    } catch (e) {
      if (e.response?.status === 401) throw bad(401, 'Token ditolak GoBiz atau sudah kedaluwarsa');
      throw e;
    }
  }, { methods: ['get', 'post'] });
};
