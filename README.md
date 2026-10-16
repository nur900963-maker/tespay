# Vincent Pay × GoMerch × ShopeePay

Pengecek pembayaran QRIS untuk **GoPay Merchant (GoMerch)** dan **ShopeePay Partner** dalam satu web.
Bikin QRIS dinamis dari QRIS statis tokomu, lalu status bayarnya dicek otomatis ke akun merchant.

Unofficial. Pakai untuk akun merchant milikmu sendiri.

## Isi project

| File | Fungsi |
|---|---|
| `app.js` | Server Express: halaman, login admin, kasir (`/api/pay/*`), login OTP, cron |
| `GoMerchant.js` | Klien GoBiz: OTP, refresh token, riwayat, bikin QRIS dinamis |
| `lib/shopee.js` | Klien ShopeePay Partner: ambil daftar transaksi |
| `lib/shopeeAuth.js` | Login OTP ShopeePay + perpanjang token tanpa OTP |
| `lib/store.js` | Database file JSON (token, QRIS, struk yang sudah dipakai) |
| `lib/seal.js` | Enkripsi data OTP sementara supaya tidak disimpan di server |
| `views/index.ejs` | Tampilan web (Beranda, GoMerch, ShopeePay, API) |
| `test/offline.test.js` | Tes otomatis tanpa akun asli (`npm test`) |

## Isi .env

| Variable | Wajib | Penjelasan |
|---|---|---|
| `ADMIN_PASSWORD` | ya | Password login Admin di web |
| `SESSION_SECRET` | ya | String acak 32+ karakter. Menandatangani cookie admin dan mengenkripsi data OTP. Ganti = semua admin ke-logout |
| `DB_PATH` | tidak | Lokasi file database. Kosong = `./data/db.json` (Vercel: `/tmp/vincent-pay.json`) |
| `CRON_SECRET` | disarankan | Pengaman `/api/cron/refresh`. Di Vercel, isi lalu cron harian otomatis memperpanjang token GoPay dan ShopeePay |
| `GOPAY_*`, `SHOPEE_*` | tidak | Cadangan kalau database kosong. Normalnya diisi lewat menu Admin |
| `GOBIZ_AUTH_URL`, `GOBIZ_APP_VERSION` | tidak | Kosong = bawaan lama. Isi kalau OTP GoMerch mendadak gagal karena GoBiz pindah host/versi login |
| `SHOPEE_DEVICE_REPORT` | tidak | Lihat bagian ShopeePay di bawah |

Bikin `SESSION_SECRET`:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Pasang

**Vercel**: push ke GitHub, import di Vercel, isi `ADMIN_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`. Selesai, tidak perlu layanan lain.

**VPS / Pterodactyl / lokal**: `npm install` lalu `npm start` (port `PORT`, default 3015). Cocok kalau mau data permanen.

### Soal database file di Vercel (penting)

Vercel tidak punya disk permanen. File database di Vercel cuma ada di `/tmp`, hidup selama instance-nya hidup, dan **hilang saat instance baru dibuat** (biasanya setelah beberapa menit sampai jam tidak ada trafik, atau tiap deploy). Efeknya:

- Token GoMerch/ShopeePay dan QRIS statis bisa hilang, tinggal login OTP / isi lagi. Kalau `GOPAY_*`/`SHOPEE_*`/QRIS diisi di Environment Variables, itu jadi cadangan otomatis.
- Daftar struk yang sudah dipakai ikut hilang. Pengaman waktu (QRIS hanya berlaku 15 menit) tetap jalan.

Kalau mau stabil, jalankan di VPS/panel. Kodenya sama, tidak ada yang diubah.

## Login OTP

**GoMerch**: menu GoMerch, Login OTP, isi nomor HP merchant, Kirim OTP, masukkan kode. Token tersimpan dan diperpanjang otomatis kalau kena 401.

**ShopeePay**: menu ShopeePay, Login OTP, isi nomor HP akun Partner (password hanya kalau akunmu pakai password), Kirim OTP, masukkan kode. Kalau akunmu punya beberapa merchant, muncul pilihan merchant tanpa OTP baru. Token diperpanjang tanpa OTP selama sesi akun Shopee masih hidup. Kalau sesi habis, muncul pesan minta login OTP lagi.

Catatan jujur soal ShopeePay: alur loginnya menirukan portal web Shopee Partner (mengikuti klien open-source QrisMerchantID, MIT). Sudah dites lengkap terhadap server tiruan, **belum pernah dites ke Shopee asli**. Shopee punya pengecekan anti-fraud (device risk). Kalau OTP tidak pernah sampai atau muncul pesan captcha, itu penyebab paling mungkin. Dua jalan keluar: login sekali di browser lalu pakai **Isi token manual** (token `B:...` dari DevTools), atau isi `SHOPEE_DEVICE_REPORT` dengan blob telemetri dari request `.../v2/shpsec/web/report` di browsermu sendiri.

Token manual tetap tersedia di kedua provider.

## Endpoint

- `POST /api/pay/create` `{provider:'gopay'|'shopee', amount}` → QRIS (base64), `created_at`, `expires_in`
- `POST /api/pay/check` `{provider, amount, created_at}` → `PAID` / `PENDING` / `EXPIRED`. Satu struk hanya bisa diklaim sekali
- `GET /api/pay/history?provider=` (admin)
- `POST /api/gopay/otp`, `/api/gopay/verify` (admin)
- `POST /api/shopee/otp`, `/api/shopee/verify`, `/api/shopee/select`, `/api/shopee/logout` (admin)
- `POST /api/admin/config` (admin), `GET /api/health`

## Tes

```
npm test
```
25 pengecekan offline: login admin, OTP ShopeePay (server tiruan), bikin QRIS, deteksi bayar, struk tidak bisa diklaim dua kali, token mati otomatis diperpanjang, file database, batas percobaan login.

## Batasan yang perlu kamu tahu

- `/api/pay/create` dan `/api/pay/check` sengaja publik (dipanggil dari halaman kasir). Pembayaran dicocokkan lewat **nominal + waktu**, jadi dua pembeli dengan nominal sama di waktu berdekatan bisa tertukar. Kalau toko ramai, tambahkan kode unik di nominal (misal 15.017) sebelum bikin QRIS.
- Integrasi tidak resmi: bisa kena rate limit atau akun dibatasi oleh Gojek/Shopee. Risiko ditanggung sendiri.
