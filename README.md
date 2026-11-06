# Vincent Pay — Gopay x Shoppepay

Console merchant untuk mengirim OTP, menukar token, dan membuat QRIS dinamis.
Satu halaman, dua provider: **ShopeePay Partner** dan **GoPay Merchant**.

## Jalankan

```bash
npm install
npm start
```

Buka `http://localhost:3015`. Tidak ada halaman login di awal — web langsung terbuka.
API key hanya diminta saat kamu menekan **Request OTP**, **Execute**, atau **Buat QRIS**.

## Isi project

| File | Fungsi |
|---|---|
| `app.js` | Server Express: halaman, endpoint OTP, QRIS, cek pembayaran |
| `lib/shopeepay.js` | Klien OTP ShopeePay (dasar dari `shopeepay.js`) |
| `lib/otp.js` | Lapisan layanan: bungkus ShopeePay + GoMerch, pesan error ramah |
| `lib/qris.js` | Mesin QRIS: parse TLV, CRC16, statis → dinamis, baca info merchant |
| `lib/shopee.js` | Daftar transaksi ShopeePay (untuk cek pembayaran) |
| `lib/seal.js` | Bungkus challenge OTP jadi token terenkripsi (stateless) |
| `lib/phone.js` | Normalisasi nomor HP Indonesia |
| `lib/store.js` | Penyimpanan file JSON (opsional, untuk data server) |
| `GoMerchant.js` | Klien GoBiz: OTP, refresh token, jurnal transaksi |
| `public/index.html` | Halaman utama |
| `public/css/app.css` | Seluruh tampilan (token warna, kartu, responsif) |
| `public/js/app.js` | Logika halaman: OTP, QRIS, copy, penyimpanan sesi |
| `public/vendor/jsQR.js` | Pembaca QR dari gambar (scan QRIS) |
| `test/run.js` | Tes offline: QRIS, gerbang API key, validasi, halaman |

## Konfigurasi

Nilai di `config.js` **menang** atas environment variable.

```js
module.exports = {
  API_KEY: '#FFHUDT6O3jiQiSWxPo7eO',   // kunci untuk Request / Execute
  SESSION_SECRET: 'ganti-di-produksi',  // penanda tangan challenge OTP
};
```

Kalau `API_KEY` dikosongkan, tombol aksi terbuka tanpa kunci.

Variabel opsional lain: `PORT`, `DB_PATH`, `SHOPEE_DEVICE_REPORT`,
`GOBIZ_AUTH_URL`, `GOBIZ_APP_VERSION`.

## Endpoint

| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/otp/request` | Kirim OTP (`provider`, `phone`, `password?`, `channel?`) |
| POST | `/api/otp/verify` | Tukar OTP jadi token (`provider`, `challenge`, `otp`) |
| POST | `/api/qris/inspect` | Baca isi payload QRIS |
| POST | `/api/qris/create` | QRIS statis → dinamis (`static_qr`, `amount`) |
| POST | `/api/qris/check` | Cek pembayaran masuk (`provider`, `amount`, `token`) |
| GET | `/api/health` | Status server |

Semua endpoint aksi menerima API key lewat body `apikey` atau header `x-api-key`.

## Penyimpanan sesi

Nomor, API key, password, QRIS statis, dan token disimpan di `localStorage`
browser dengan kunci `vincentpay.session.v1`. Tidak ada masa kedaluwarsa, jadi
tetap ada walau kamu kembali beberapa hari kemudian. Tombol **Hapus** di panel
"Sesi tersimpan" membersihkannya.

## Tes

```bash
npm test
```

Tes berjalan tanpa akun asli: tidak ada panggilan ke Shopee atau GoBiz.

## Catatan

Klien ShopeePay dan GoBiz adalah integrasi tidak resmi untuk akun merchant milik
sendiri. Simpan `config.js` di repo privat.
