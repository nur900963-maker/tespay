// Isi di sini kalau Environment Variables Vercel tidak mau terbaca.
// Nilai yang diisi di file ini MENANG atas env. Dikosongkan = pakai env biasa (atau default).
// PENTING: file ini berisi rahasia, jadi repo GitHub-nya harus PRIVATE.
module.exports = {
  // Kunci khusus bot. Bot kirim header x-api-key dengan isi yang sama (SHOPEE_BOT_API_KEY di config.js bot).
  // Kalau kosong, route /api/bot/* mati dan bot memakai route publik /api/*.
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
  SESSION_SECRET: '',       // kosong = dipakai ADMIN_PASSWORD
  CRON_SECRET: '',
  DB_PATH: '',              // jangan diisi di Vercel
  AUTO_LOOP: '',            // '0' = matikan loop auto refresh di server
  GOBIZ_AUTH_URL: '',
  GOBIZ_APP_VERSION: '',

  // --- Shopee device-check / anti-fraud (lihat documents/shopee-otp-audit/) ---
  // Blob telemetri asli dari request POST .../v2/shpsec/web/report di browser yang
  // sudah pernah login sukses. Kosong = dipakai telemetri minimal dari lib/device.js.
  SHOPEE_DEVICE_REPORT: '',
  // Device id stabil. Kosong = acak per proses (berubah tiap restart/deploy).
  SHOPEE_DEVICE_ID: '',
  // captcha_signature dari request send_otp yang sukses di browser.
  SHOPEE_CAPTCHA_SIGNATURE: '',
  // Skema hash password: md5sha256 (default, seperti portal) | sha256 | plain
  SHOPEE_PW_HASH: '',
  // UA yang dipakai semua panggilan Shopee (login OTP + daftar transaksi).
  SHOPEE_UA: '',
};
