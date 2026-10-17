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
| `views/index.ejs` | Dashboard (Beranda, GoMerch, ShopeePay, API) |
| `bot/payment.js` | Modul untuk bot Telegram (ESM), cuma manggil API server ini |
| `test/` | Tes otomatis tanpa akun asli (`npm test`) |

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

Taruh `bot/payment.js` di folder bot (sesuaikan import `../config.js` dan `../utils/emoji.js`), lalu isi di `config.js`:

```js
export const SHOPEE_API_URL = 'https://url-vercel-kamu.vercel.app';
// export const SHOPEE_BOT_API_KEY = '...';   // hanya kalau BOT_API_KEY di server diisi
```

Bentuk dan daftar export-nya sama dengan payment.js GoPay: `tokenManager` (`getStatus()`, `refreshAccessToken()`, `ensureValidToken()`), `startTokenRefreshLoop()`, `createPayment(amount, userId, expiredMinutes, paket)`, `checkStatusOnce(total_bayar, qris_jam_wib, createdAtMs)`, dan lainnya. Panggil `startTokenRefreshLoop()` sekali waktu bot start. `tokenManager.getStatus()` aman buat owner menu karena tidak pernah berisi token. Token Shopee dan pengecekan struk ada di server, bot tidak menyimpan apa-apa soal Shopee.

## Auto refresh token

Menu **Auto Refresh** di dashboard: per provider ada status (terakhir refresh, jadwal berikutnya, masa berlaku token, error terakhir), saklar aktif/nonaktif, interval (5 sampai 720 menit, default GoMerch 15 dan ShopeePay 60), dan tombol **Refresh sekarang**.

- **VPS / panel / lokal**: server punya loop sendiri, refresh jalan tanpa halaman dibuka. Matikan dengan `AUTO_LOOP=0`.
- **Vercel**: tidak ada proses yang hidup terus, jadi refresh jalan lewat `POST /api/auto/tick` yang dipanggil dashboard (selama terbuka) dan loop bot (`startTokenRefreshLoop`). Di luar itu token tetap diperpanjang saat dipakai dan ketahuan mati.
- GoMerch diperpanjang pakai refresh token. ShopeePay memakai sesi dari login OTP, token manual tidak bisa diperpanjang. Gagal 3x berturut-turut ditandai "kemungkinan perlu login OTP ulang".

## Login OTP

**GoMerch**: menu GoMerch, Login OTP, isi nomor HP merchant, Kirim OTP, masukkan kode. Token tersimpan dan diperpanjang otomatis kalau kena 401.

**ShopeePay**: menu ShopeePay, Login OTP, isi nomor HP akun Partner (password hanya kalau akunmu pakai password), Kirim OTP, masukkan kode. Kalau akunmu punya beberapa merchant, muncul pilihan merchant tanpa OTP baru. Token diperpanjang tanpa OTP selama sesi akun Shopee masih hidup. Kalau sesi habis, muncul pesan minta login OTP lagi.

Catatan jujur soal ShopeePay: alur loginnya menirukan portal web Shopee Partner (mengikuti klien open-source QrisMerchantID, MIT). Sudah dites lengkap terhadap server tiruan, **belum pernah dites ke Shopee asli**. Shopee punya pengecekan anti-fraud (device risk). Kalau OTP tidak pernah sampai atau muncul pesan captcha, itu penyebab paling mungkin. Dua jalan keluar: login sekali di browser lalu pakai **Isi token manual** (token `B:...` dari DevTools), atau isi `SHOPEE_DEVICE_REPORT` dengan blob telemetri dari request `.../v2/shpsec/web/report` di browsermu sendiri.

Token manual tetap tersedia di kedua provider.

## Endpoint

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
Menjalankan 55 pengecekan offline (mode terkunci dan mode publik tanpa env): login OTP ShopeePay (server tiruan), bikin QRIS, deteksi bayar, struk tidak bisa diklaim dua kali, token mati otomatis diperpanjang, file database, batas percobaan login.

## Yang perlu kamu tahu

- **Mode publik**: siapa pun yang tahu URL-nya bisa membuka dashboard, melihat riwayat, bahkan mengganti QRIS/token. Aman selama URL tidak tersebar. Kalau URL ikut tertulis di source bot yang dijual, isi `ADMIN_PASSWORD` di Vercel (satu env, tanpa kode tambahan) dan menu langsung terkunci.
- Pembayaran dicocokkan lewat **nominal + waktu**. Di bot sudah ada kode unik 10-200, di dashboard kasir belum. Kalau toko ramai, tambahkan kode unik sebelum bikin QRIS.
