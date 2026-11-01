// Penyimpanan key-value yang TIDAK bergantung pada /tmp.
//
// Kenapa ini ada (permintaan "siap Vercel"):
//   Versi lama menyimpan state ke /tmp. Di Vercel /tmp itu per-instance dan
//   hilang begitu instance baru dibuat, jadi:
//     - device_id berubah  -> Shopee melihat "perangkat baru" -> captcha terus
//     - rate limit reset   -> proteksi OTP bombing hilang
//     - audit trail hilang -> tidak ada bukti kalau OTP gagal
//
// Tiga backend, dipilih otomatis:
//   1. redis  -> Upstash Redis REST (UPSTASH_REDIS_REST_URL + _TOKEN, atau
//                KV_REST_API_URL + KV_REST_API_TOKEN dari Vercel KV).
//                Ini yang dipakai di Vercel produksi: state bertahan antar
//                instance dan antar deploy.
//   2. file   -> data/kv.json (VPS / lokal / Pterodactyl). Permanen.
//   3. memory -> proses saja. Dipakai kalau di Vercel tanpa Redis: aplikasi
//                tetap jalan, tapi state tidak bertahan antar instance.
//
// Semua fungsi async supaya satu antarmuka dipakai untuk ketiga backend.
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

const ON_VERCEL = process.env.VERCEL === '1';
const FILE = process.env.KV_PATH || (ON_VERCEL ? '' : path.join(__dirname, '..', 'data', 'kv.json'));

const backend = useRedis ? 'redis' : (FILE ? 'file' : 'memory');

// ---------- Redis (Upstash REST) ----------
async function cmd(...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('redis: ' + (j.error || 'HTTP ' + r.status));
  return j.result;
}

// ---------- file / memory ----------
let mem = null;
let queue = Promise.resolve();

function loadFile() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { mem = {}; }
  return mem;
}

function flush() {
  if (!FILE) return Promise.resolve();
  queue = queue.then(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(loadFile()), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }).catch(e => console.error('[kv] gagal menulis', FILE, e.message));
  return queue;
}

const alive = e => e && (!e.exp || e.exp > Date.now());

// ---------- API ----------
async function get(key) {
  if (useRedis) { const v = await cmd('GET', key); return v == null ? null : String(v); }
  const d = loadFile(), e = d[key];
  if (!e) return null;
  if (!alive(e)) { delete d[key]; await flush(); return null; }
  return e.v == null ? null : String(e.v);
}

async function set(key, value, ttlSec) {
  if (useRedis) {
    if (ttlSec) await cmd('SET', key, String(value), 'EX', String(Math.max(1, Math.ceil(ttlSec))));
    else await cmd('SET', key, String(value));
    return;
  }
  loadFile()[key] = { v: String(value), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 };
  await flush();
}

async function del(key) {
  if (useRedis) { await cmd('DEL', key); return; }
  delete loadFile()[key];
  await flush();
}

// Naikkan counter. TTL dipasang saat key pertama kali dibuat (fixed window).
async function incr(key, ttlSec) {
  if (useRedis) {
    const n = Number(await cmd('INCR', key));
    if (n === 1 && ttlSec) await cmd('EXPIRE', key, String(Math.max(1, Math.ceil(ttlSec))));
    return n;
  }
  const d = loadFile(), now = Date.now();
  let e = d[key];
  if (!alive(e)) { e = { v: '0', exp: ttlSec ? now + ttlSec * 1000 : 0 }; d[key] = e; }
  e.v = String(Number(e.v || 0) + 1);
  await flush();
  return Number(e.v);
}

async function ttl(key) {
  if (useRedis) { const t = Number(await cmd('TTL', key)); return t > 0 ? t : 0; }
  const e = loadFile()[key];
  if (!alive(e) || !e.exp) return 0;
  return Math.max(0, Math.ceil((e.exp - Date.now()) / 1000));
}

// true kalau key baru berhasil diklaim (SET NX). Dipakai anti-replay & struk.
async function claim(key, ttlSec = 3600) {
  if (useRedis) {
    const r = await cmd('SET', key, '1', 'NX', 'EX', String(Math.max(1, Math.ceil(ttlSec))));
    return r === 'OK';
  }
  const d = loadFile(), e = d[key];
  if (alive(e)) return false;
  d[key] = { v: '1', exp: Date.now() + ttlSec * 1000 };
  await flush();
  return true;
}

// Daftar (dipakai audit trail): push ke depan, potong panjangnya.
async function push(key, value, maxLen = 500) {
  if (useRedis) {
    await cmd('LPUSH', key, String(value));
    await cmd('LTRIM', key, '0', String(Math.max(0, maxLen - 1)));
    return;
  }
  const d = loadFile(), e = d[key];
  const arr = (e && Array.isArray(e.arr)) ? e.arr : [];
  arr.unshift(String(value));
  d[key] = { arr: arr.slice(0, maxLen), exp: 0 };
  await flush();
}

async function list(key, limit = 50) {
  if (useRedis) {
    const r = await cmd('LRANGE', key, '0', String(Math.max(0, limit - 1)));
    return Array.isArray(r) ? r.map(String) : [];
  }
  const e = loadFile()[key];
  return (e && Array.isArray(e.arr) ? e.arr : []).slice(0, limit).map(String);
}

// Hapus semua key dengan awalan tertentu. Hanya untuk backend file/memory
// (dipakai tes supaya hitungan rate limit bersih). Redis sengaja ditolak:
// jangan sampai tes menghapus data produksi.
async function clearPrefix(prefix) {
  if (useRedis) throw new Error('clearPrefix tidak diizinkan pada Redis');
  const d = loadFile();
  let n = 0;
  for (const k of Object.keys(d)) if (k.startsWith(prefix)) { delete d[k]; n++; }
  if (n) await flush();
  return n;
}

module.exports = {
  backend, useRedis, file: FILE,
  persistent: useRedis || !!FILE,
  get, set, del, incr, ttl, claim, push, list, clearPrefix,
  _cmd: cmd,
};
