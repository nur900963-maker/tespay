'use strict';
const app = require('../server');
const { initDb } = require('../db');
let ready;
module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ success: false, message: 'Konfigurasi server: DATABASE_URL PostgreSQL wajib diisi di Vercel. SQLite lokal tidak persisten pada serverless.' });
  }
  try {
    if (!ready) ready = initDb();
    await ready;
    return app(req, res);
  } catch (error) {
    console.error('[Vincent Pay Vercel] startup/database error:', error && (error.stack || error.message || error));
    return res.status(500).json({ success: false, message: 'Vincent Pay belum siap. Periksa environment database dan secret deployment.' });
  }
};
