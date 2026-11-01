// Isi di sini kalau Environment Variables Vercel tidak mau terbaca.
// Nilai yang diisi di file ini MENANG atas env. Dikosongkan = pakai env biasa (atau default).
//
// ⚠️ PENTING (perbaikan review): JANGAN menaruh kredensial asli di file ini.
// File ini ikut ter-commit ke repo. Dulu BOT_API_KEY dan ADMIN_PASSWORD berisi
// password asli yang sama, sehingga siapa pun yang bisa membaca repo bisa masuk
// dashboard dan memakai route bot.
//
// Cara pakai yang benar:
//   - Lokal / VPS  : isi lewat file .env (sudah masuk .gitignore) atau env panel
//   - Vercel       : isi lewat Project Settings -> Environment Variables
//   - Kalau tetap mau lewat file ini, buat config.local.js (sudah di-.gitignore)
//     lalu jalankan dengan VP_CONFIG_FILE=./config.local.js
//
// Kalau semua dikosongkan: dashboard jalan di mode publik (tanpa login) dan
// route /api/bot/* mati. Itu default yang aman untuk repo publik.
module.exports = {
  // Kunci khusus bot. Bot kirim header x-api-key dengan isi yang sama.
  // Kosong = route /api/bot/* mati dan bot memakai route publik /api/*.
  BOT_API_KEY: '#FFHUDT6O3jiQiSWxPo7eO',

  // Password dashboard. Kosong = dashboard terbuka tanpa login (mode publik).
  ADMIN_PASSWORD: '#FFHUDT6O3jiQiSWxPo7eO',

  // Cadangan token/QRIS kalau database kosong (di Vercel database file bisa hilang kapan saja)
  GOPAY_ACCESS_TOKEN: '',
  GOPAY_REFRESH_TOKEN: '',
  GOPAY_QRIS: '',
  SHOPEE_TOKEN: '',
  SHOPEE_QRIS: '',

  // Opsional
  SESSION_SECRET: '',       // kosong = dipakai ADMIN_PASSWORD, atau file data/secret.key otomatis
  CRON_SECRET: '',
  DB_PATH: '',              // jangan diisi di Vercel
  AUTO_LOOP: '',            // '0' = matikan loop auto refresh di server
  GOBIZ_AUTH_URL: '',
  GOBIZ_APP_VERSION: '',

  // --- Shopee device-check / anti-fraud ---
  // Semua di bawah ini OPSIONAL. Lebih baik diisi lewat dashboard
  // (panel "Identitas Perangkat") karena langsung tersimpan ke data/identity.json.
  //
  // Blob telemetri asli dari request POST .../v2/shpsec/web/report di browser yang
  // sudah pernah login sukses. Kosong = telemetri konsisten dari lib/device.js.
  SHOPEE_DEVICE_REPORT: '',
  // Device id stabil. Kosong = diturunkan sekali lalu disimpan (tidak berubah tiap restart).
  SHOPEE_DEVICE_ID: '',
  // Nilai header szdet asli dari browser. Kosong = szdet bertanda tangan dari lib/device.js.
  SHOPEE_SZDET: '',
  // captcha_signature dari request send_otp yang sukses di browser.
  SHOPEE_CAPTCHA_SIGNATURE: '',
  // Skema hash password: md5sha256 (default, seperti portal) | sha256 | plain
  SHOPEE_PW_HASH: '',
  // UA yang dipakai semua panggilan Shopee (login OTP + daftar transaksi).
  SHOPEE_UA: '',
};
