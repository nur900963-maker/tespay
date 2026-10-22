require('dotenv').config();
'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

function validateProductionEnvironment() {
  if (process.env.NODE_ENV !== 'production') return;
  const placeholder = /change.?me|replace|example|placeholder|your.?secret/i;
  for (const key of ['JWT_SECRET','MASTER_ENCRYPTION_KEY']) {
    const value = String(process.env[key] || '');
    if (value.length < 32 || placeholder.test(value)) throw new Error(`${key} harus berupa secret acak minimal 32 karakter; jangan gunakan nilai contoh.`);
  }
  const email = String(process.env.ADMIN_EMAIL || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /example\.com$/i.test(email)) throw new Error('ADMIN_EMAIL produksi wajib diisi dengan alamat owner yang valid.');
  if (password.length < 12 || placeholder.test(password)) throw new Error('ADMIN_PASSWORD produksi harus unik dan minimal 12 karakter.');
  if (!/^https:\/\//i.test(String(process.env.PUBLIC_URL || ''))) throw new Error('PUBLIC_URL produksi harus memakai HTTPS.');
}
validateProductionEnvironment();

// Express 4 does not automatically forward rejected async route handlers.
const originalRouter = express.Router;
function wrapHandlers(handlers) {
  return handlers.map((handler) => {
    if (typeof handler !== 'function') return handler;
    return function asyncSafe(req, res, next) {
      try {
        const result = handler(req, res, next);
        if (result && typeof result.then === 'function') result.catch(next);
      } catch (error) { next(error); }
    };
  });
}
express.Router = function patchedRouter(...args) {
  const router = originalRouter(...args);
  for (const method of ['get','post','put','patch','delete','options','head','all','use']) {
    const original = router[method].bind(router);
    router[method] = (...callArgs) => {
      // Keep the route path; only wrap middleware/handlers. `use()` can omit its path.
      if (method !== 'use') {
        const [routePath, ...handlers] = callArgs;
        return original(routePath, ...wrapHandlers(handlers.flat()));
      }
      const first = callArgs[0];
      const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
      if (hasPath) return original(first, ...wrapHandlers(callArgs.slice(1).flat()));
      return original(...wrapHandlers(callArgs.flat()));
    };
  }
  return router;
};
express.Router.prototype = originalRouter.prototype;
Object.setPrototypeOf(express.Router, originalRouter);

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
const allowedOrigins = String(process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin tidak diizinkan oleh CORS.'));
}, credentials: false, maxAge: 600 }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Basic per-process throttle for authentication endpoints. Use edge/upstream rate limiting too in multi-instance production.
const authHits = new Map();
app.use('/api/auth', (req, res, next) => {
  if (req.method !== 'POST' || !['/login','/register','/forgot-password','/reset-password'].includes(req.path)) return next();
  const key = `${req.ip}:${req.path}`;
  const now = Date.now(); const entry = authHits.get(key);
  if (!entry || now > entry.until) authHits.set(key, { count: 1, until: now + 60_000 });
  else if (++entry.count > 20) return res.status(429).json({ success: false, message: 'Terlalu banyak percobaan. Coba lagi satu menit lagi.' });
  if (authHits.size > 10000) for (const [k,v] of authHits) if (now > v.until) authHits.delete(k);
  next();
});
app.use((req, _res, next) => {
  if (!req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/icon.png')) console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/users'));
app.use('/api/transactions', require('./routes/transactions').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/provider-webhooks', require('./routes/provider-webhooks'));
app.use('/api/webhooks/providers', require('./routes/provider-webhooks'));
app.use('/api', require('./routes/public-api'));
require('./routes/invoice-public').registerInvoiceRoutes(app);

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
const pages = ['pricing','docs','login','register','forgot-password','reset-password','dashboard','transactions','withdraw','deposit','profile','webhook-logs','pay','admin'];
pages.forEach((p) => app.get(`/${p}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${p}.html`))));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});
app.use((err, req, res, _next) => {
  console.error('[Vincent Pay server error]', err && (err.stack || err.message || err));
  if (res.headersSent) return;
  const message = process.env.NODE_ENV === 'production' ? 'Terjadi kesalahan pada server.' : (err.message || 'Terjadi kesalahan pada server.');
  const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(code).json({ success: false, message });
});

if (require.main === module) {
  initDb().then(() => app.listen(PORT, () => console.log(`[Vincent Pay] server berjalan di port ${PORT}; database siap.`)))
    .catch((err) => { console.error('[Vincent Pay] gagal menyiapkan database:', err); process.exit(1); });
}
module.exports = app;
