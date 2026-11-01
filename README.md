# Vincent Pay × GoMerch × ShopeePay

Pengecek pembayaran QRIS untuk **GoPay Merchant (GoMerch)** dan **ShopeePay Partner** dalam satu web.
Bikin QRIS dinamis dari QRIS statis tokomu, lalu status bayarnya dicek otomatis ke akun merchant.

## Isi project

| File | Fungsi |
|---|---|
| `app.js` | Server Express: halaman, kasir (`/api/pay/*`), login OTP, konfigurasi |
| `GoMerchant.js` | Klien GoBiz: OTP, refresh token, riwayat, bikin QRIS dinamis |
| `lib/shopee.js` | Klien ShopeePay Partner: ambil daftar transaksi |
| `lib/shopeeAuth.js` | Login OTP ShopeePay + perpanjang token tanpa OTP |
| `lib/store.js` | Database file JSON (token, QRIS, struk yang sudah dipakai) |
| `lib/seal.js` | Enkripsi data OTP sementara |
| `views/index.ejs` | Dashboard (Beranda, GoMerch, ShopeePay, Auto Refresh, API). Ikon GoMerch dan ShopeePay berupa SVG sederhana di bagian atas file ini (`#i-go`, `#i-sh`), ganti dengan logo resmi kalau mau |
| `bot/payment.js` | Modul untuk bot Telegram (ESM), cuma manggil API server ini |
| `test/` | Tes otomatis tanpa akun asli (`npm test`) |

## config.js (pengganti env di Vercel)

Kalau Environment Variables Vercel tidak mau terbaca (biasanya karena belum Redeploy), isi saja `config.js` di root project: `BOT_API_KEY`, `ADMIN_PASSWORD`, dan lainnya. **Nilai di `config.js` menang atas env**; kosong = pakai env biasa. File ini berisi rahasia, jadi repo GitHub-nya harus **private**. Contoh mengunci route bot:

```js
module.exports = { BOT_API_KEY: 'kunci-panjang-acak-buatanmu' };
```

Di bot, isi `SHOPEE_BOT_API_KEY` di `config.js` bot dengan nilai yang sama.

## Env

**Tidak ada yang wajib.** Deploy ke Vercel, buka URL-nya, langsung bisa dipakai. Semua menu terbuka (mode publik).
Daftar env opsional ada di `.env.example`:

| Variable | Fungsi |
|---|---|
| `ADMIN_PASSWORD` | Kalau diisi, menu admin (login OTP, QRIS, riwayat) minta login. Kosong = terbuka |
| `BOT_API_KEY` | Kalau diisi, bot boleh pakai `/api/bot/pay/*` dengan header `x-api-key` |
| `DB_PATH` | Lokasi file database. Kosong = `./data/db.json` (Vercel: `/tmp`) |
| `GOPAY_*`, `SHOPEE_*` | Cadangan token/QRIS kalau database kosong |
| `GOBIZ_AUTH_URL`, `GOBIZ_APP_VERSION` | Kalau OTP GoMerch mendadak gagal karena GoBiz pindah host/versi |
| `SHOPEE_DEVICE_REPORT` | Lihat bagian ShopeePay di bawah |

## Pasang

**Vercel**: push ke GitHub, import di Vercel, deploy. Selesai.

**VPS / Pterodactyl / lokal**: `npm install` lalu `npm start` (port `PORT`, default 3015). Data permanen di `data/db.json`.

### Database file di Vercel

Vercel tidak punya disk permanen. File database cuma ada di `/tmp` dan hilang kalau instance baru dibuat. Kalau token atau QRIS hilang, tinggal login OTP dan isi QRIS lagi. Mau stabil: jalankan di VPS/panel, kodenya sama.

## Pakai dari bot Telegram

Taruh `bot/payment.js` di folder bot (sesuaikan import `../config.js` dan `../utils/emoji.js`). Ada dua mode, dipilih otomatis dari `config.js` bot.

**Mode langsung (disarankan, banyak bot satu server)**: token dan QRIS statis ada di `config.js` bot masing-masing, seperti GoMerch. Server Vercel cuma perantara dan **tidak menyimpan apa pun**, jadi satu deploy bisa dipakai banyak bot dengan akun Shopee yang berbeda-beda. Aktif kalau `SHOPEE_STATIC_QR` diisi.

```js
export const SHOPEE_API_URL = 'https://url-vercel-kamu.vercel.app';
export const SHOPEE_BOT_API_KEY = '';          // isi kalau server memakai BOT_API_KEY
export const SHOPEE_STATIC_QR = '000201010211...';   // QRIS statis toko
export const SHOPEE_TOKEN = 'B:xxxx';          // dari dashboard > ShopeePay > Login OTP > Salin
export const SHOPEE_SESSION = '{"v":1,...}';   // opsional, juga dari kotak hasil Login OTP; tanpa ini token tidak bisa diperpanjang otomatis
export const SHOPEE_REFRESH_MINUTES = 60;      // opsional
```

Cara ambil `SHOPEE_TOKEN` dan `SHOPEE_SESSION`: buka dashboard > ShopeePay > Login OTP, biarkan "Simpan di server" tidak dicentang, lalu salin token dan session yang muncul ke `config.js` bot.
Token terbaru, sesi, hitungan refresh, dan struk yang sudah dipakai disimpan di file `data/shopee-state.json` milik bot itu sendiri (bukan di server). Kalau isi `SHOPEE_TOKEN` di `config.js` diganti, nilai yang baru menang atas isi file.

**Mode server**: kalau `SHOPEE_STATIC_QR` tidak diisi, bot memakai token dan QRIS yang tersimpan di server lewat dashboard ("Simpan di server"). Cocok untuk satu pemilik saja.

Bentuk dan daftar export-nya sama dengan payment.js GoPay: `tokenManager` (`getStatus()`, `refreshAccessToken()`, `ensureValidToken()`), `startTokenRefreshLoop()` (panggil sekali waktu bot start), `createPayment(amount, userId, expiredMinutes, paket)`, `checkStatusOnce(total_bayar, qris_jam_wib, createdAtMs)`, dan lainnya. `tokenManager.getStatus()` aman buat owner menu karena tidak pernah berisi token.

## Auto refresh token

Menu **Auto Refresh** di dashboard: per provider ada status (terakhir refresh, jadwal berikutnya, masa berlaku token, error terakhir), saklar aktif/nonaktif, interval (5 sampai 720 menit, default GoMerch 15 dan ShopeePay 60), dan tombol **Refresh sekarang**.

- **VPS / panel / lokal**: server punya loop sendiri, refresh jalan tanpa halaman dibuka. Matikan dengan `AUTO_LOOP=0`.
- **Vercel**: tidak ada proses yang hidup terus, jadi refresh jalan lewat `POST /api/auto/tick` yang dipanggil dashboard (selama terbuka) dan loop bot (`startTokenRefreshLoop`). Di luar itu token tetap diperpanjang saat dipakai dan ketahuan mati.
- GoMerch diperpanjang pakai refresh token. ShopeePay memakai sesi dari login OTP, token manual tidak bisa diperpanjang. Gagal 3x berturut-turut ditandai "kemungkinan perlu login OTP ulang".

## Ambil token langsung (tanpa simpan)

Di menu GoMerch dan ShopeePay, setelah OTP berhasil token langsung muncul di halaman dengan tombol **Salin**. Secara default **tidak disimpan di server**. Centang "Simpan juga di server" kalau token mau dipakai Kasir dan Auto Refresh.

## Statistik token

Menu Auto Refresh juga mencatat: sudah berapa kali di-refresh, sudah berapa lama sesi aktif, dan token terakhir bertahan berapa lama sebelum ketahuan mati (batas atas, karena baru ketahuan saat dipakai). Angka itu dipakai buat refresh lebih awal: kalau token sudah mendekati 80% dari umur terakhir yang terukur, atau waktu kedaluwarsanya terbaca dan tinggal kurang dari 10 menit, server tidak menunggu interval. Di bot, `tokenManager.getStatus()` ikut membawa `refreshCount`, `sessionAgeMs`, `tokenAgeMs`, `lastLifetimeMs`, `deadCount`, dan `botRefreshCount`.

## Login OTP

**GoMerch**: menu GoMerch, Login OTP, isi nomor HP merchant, Kirim OTP, masukkan kode. Token tersimpan dan diperpanjang otomatis kalau kena 401.

**ShopeePay**: menu ShopeePay, Login OTP, isi nomor HP akun Partner (password hanya kalau akunmu pakai password), Kirim OTP, masukkan kode. Kalau akunmu punya beberapa merchant, muncul pilihan merchant tanpa OTP baru. Token diperpanjang tanpa OTP selama sesi akun Shopee masih hidup. Kalau sesi habis, muncul pesan minta login OTP lagi.

Catatan jujur soal ShopeePay: alur loginnya menirukan portal web Shopee Partner (mengikuti klien open-source QrisMerchantID, MIT). Sudah dites lengkap terhadap server tiruan, **belum pernah dites ke Shopee asli**. Shopee punya pengecekan anti-fraud (device risk).

### Kalau OTP tidak sampai (audit v2)

Versi lama punya dua bug yang membuat `send_otp` **tidak pernah dipanggil** — jadi OTP memang tidak mungkin sampai, bukan masalah jaringan/WhatsApp:

1. `check_password_migrate` divalidasi ketat. Endpoint itu membalas `error != 0` untuk akun yang tidak perlu migrasi password (normal), dan kode lama melempar error di situ.
2. Telemetri device-risk dikirim sebagai `{}` tanpa header `szdet`, dan device id acak tiap request. Shopee membaca itu sebagai perangkat tanpa jejak → captcha / device-check.

Keduanya sudah diperbaiki (lihat `documents/shopee-otp-audit/`). Langkah pakai:

1. **Diagnosa dulu** — `POST /api/shopee/diagnose {phone, password}`. Endpoint ini berhenti **sebelum** `send_otp`, jadi tidak memicu OTP atau rate limit, dan memberi tahu langkah mana yang gagal (`device_risk`, `authenticate_by_password`, `get_otp_settings`).
2. Kalau `device_risk` gagal atau captcha muncul: login manual sekali di browser, buka DevTools → Network, salin body request `POST .../v2/shpsec/web/report` ke `SHOPEE_DEVICE_REPORT`, dan `device_id` dari situ ke `SHOPEE_DEVICE_ID`. Kalau `send_otp` di browser membawa `captcha_signature`, isi `SHOPEE_CAPTCHA_SIGNATURE`.
3. Kalau password ditolak padahal benar, coba `SHOPEE_PW_HASH=sha256` atau `plain` (default `md5sha256` = `sha256(md5(pw))`).
4. Jalan pintas yang selalu berhasil: login sekali di browser lalu pakai **Isi token manual** (token `B:...` dari DevTools).

Env baru: `SHOPEE_DEVICE_ID`, `SHOPEE_DEVICE_REPORT`, `SHOPEE_CAPTCHA_SIGNATURE`, `SHOPEE_PW_HASH`, `SHOPEE_UA`.

Token manual tetap tersedia di kedua provider.

## API publik /api/v1 (stateless)

Menu **API** di dashboard adalah playground: isi parameter, klik Execute Request, hasilnya muncul di bawahnya (isian antar langkah terisi otomatis). Semua endpoint bisa **GET** (query) atau **POST** (JSON), tidak ada data yang disimpan di server. Nomor HP boleh `08...`, `628...`, atau `+628...`, selalu diproses sebagai `+628...`. Kalau `BOT_API_KEY` diisi, kirim `apikey` (query/body) atau header `x-api-key`.

| Provider | Endpoint | Parameter |
|---|---|---|
| ShopeePay | `/api/v1/shopee/otp` | phone, password?, channel? |
| | `/api/v1/shopee/verify` | challenge, otp, merchant_id? (atau verification + merchant_id kalau diminta pilih merchant), include_session? |
| | `/api/v1/shopee/refresh` | session (JSON dari verify dengan `include_session=1`), pakai POST |
| | `/api/v1/shopee/check-token` | token |
| | `/api/v1/shopee/create` | amount, static_qr |
| | `/api/v1/shopee/mutasi` | token, start_time?, end_time? (epoch detik, default 30 hari) |
| GoMerch | `/api/v1/gopay/otp` | phone |
| | `/api/v1/gopay/verify` | otp, otp_token |
| | `/api/v1/gopay/check-token` | token (access token) |
| | `/api/v1/gopay/refresh` | refresh_token |
| | `/api/v1/gopay/create` | amount, static_qr |
| | `/api/v1/gopay/mutasi` | token, start_time? |

## Endpoint dashboard (stateful)

- `POST /api/pay/create` `{provider:'gopay'|'shopee', amount}` → QRIS (base64), `created_at`, `expires_in`
- `POST /api/pay/check` `{provider, amount, created_at}` → `PAID` / `PENDING` / `EXPIRED`. Satu struk hanya bisa diklaim sekali
- `GET /api/pay/history?provider=`
- `POST /api/gopay/otp`, `/api/gopay/verify`
- `POST /api/shopee/otp`, `/api/shopee/verify`, `/api/shopee/select`, `/api/shopee/logout`
- `GET /api/token/status`, `POST /api/refresh {provider}`, `POST /api/auto/tick`, `POST /api/auto/config {provider, enabled, minutes}`: status dan jadwal auto refresh (token tidak pernah ikut dikirim). Versi bot: `/api/bot/token/status`, `/api/bot/refresh`, `/api/bot/auto/tick`
- `POST /api/bot/pay/create`, `/api/bot/pay/check`: sama seperti `/api/pay/*` tapi wajib `x-api-key` (hanya aktif kalau `BOT_API_KEY` diisi)
- `POST /api/admin/config`, `GET /api/health`

## Tes

```
npm test
```
Menjalankan 120 pengecekan offline (mode terkunci dan mode publik tanpa env): login OTP ShopeePay (server tiruan), bikin QRIS, deteksi bayar, struk tidak bisa diklaim dua kali, token mati otomatis diperpanjang, file database, batas percobaan login.

## Yang perlu kamu tahu

- **Mode publik**: siapa pun yang tahu URL-nya bisa membuka dashboard, melihat riwayat, bahkan mengganti QRIS/token. Aman selama URL tidak tersebar. Kalau URL ikut tertulis di source bot yang dijual, isi `ADMIN_PASSWORD` di Vercel (satu env, tanpa kode tambahan) dan menu langsung terkunci.
- Pembayaran dicocokkan lewat **nominal + waktu**. Di bot sudah ada kode unik 10-200, di dashboard kasir belum. Kalau toko ramai, tambahkan kode unik sebelum bikin QRIS.
