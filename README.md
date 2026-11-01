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
| `lib/store.js` | Database aplikasi (token, QRIS, struk yang sudah dipakai) di atas `lib/kv.js` |
| `lib/kv.js` | Penyimpanan key-value: Redis (Upstash/Vercel KV) → file `data/kv.json` → memori. Tidak memakai `/tmp` |
| `lib/identity.js` | Identitas perangkat Shopee yang persisten (device_id, telemetri, szdet, captcha signature) |
| `lib/captcha.js` | Ekstraksi challenge captcha dari balasan Shopee + penyusunan field `send_otp` |
| `lib/guard.js` | Rate limit berlapis + anti-replay challenge |
| `lib/audit.js` | Audit trail OTP append-only (tanpa rahasia) |
| `lib/seal.js` | Enkripsi data OTP sementara (tanpa fallback kunci publik) |
| `api/index.js` | Handler serverless Vercel (memakai `app.js` yang sama) |
| `vercel.json` | Konfigurasi Vercel + `includeFiles` supaya `views/` ikut ter-bundle |
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

### Penyimpanan state (v4: tanpa `/tmp`)

Semua state (token, QRIS, `device_id`, rate limit, audit trail, kunci seal) lewat `lib/kv.js`, yang memilih backend otomatis:

| Backend | Kapan dipakai | Bertahan? |
|---|---|---|
| **Redis** (Upstash / Vercel KV) | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (atau `KV_REST_API_URL` + `KV_REST_API_TOKEN`) diisi | Ya — antar instance, antar deploy |
| **File** `data/kv.json` | VPS / lokal / Pterodactyl | Ya — selama disk ada |
| **Memory** | Vercel tanpa Redis | Tidak — per instance |

`GET /api/health` melaporkan `backend` dan `persistent` yang sedang aktif, jadi tidak perlu menebak.

### Deploy ke Vercel

1. Push repo ke GitHub (private), import di Vercel.
2. Isi Environment Variables (Project Settings → Environment Variables), lalu **Redeploy**:

| Variable | Wajib? | Fungsi |
|---|---|---|
| `ADMIN_PASSWORD` | **Sangat disarankan** (min. 12 karakter) | Mengunci dashboard. Kosong = mode publik, siapa pun bisa lihat token & ganti QRIS |
| `SESSION_SECRET` | Disarankan | Kunci enkripsi challenge OTP + tanda tangan cookie admin. Kosong = dibuat acak & disimpan di backend kv |
| `UPSTASH_REDIS_REST_URL` | Disarankan | State persisten (device_id stabil → device-check Shopee lebih mudah lolos) |
| `UPSTASH_REDIS_REST_TOKEN` | Disarankan | Token Redis di atas |
| `BOT_API_KEY` | Opsional | Mengaktifkan `/api/bot/*`. **Harus beda dari `ADMIN_PASSWORD`** |
| `CRON_SECRET` | Opsional | Mengaktifkan `/api/cron/refresh` (fail-closed kalau kosong) |
| `SHOPEE_DEVICE_ID` | Opsional | Pin device id (kalau tidak mau bergantung Redis) |
| `SHOPEE_DEVICE_REPORT` | Opsional | Blob telemetri asli dari browser |
| `SHOPEE_SZDET` | Opsional | Header `szdet` asli dari browser |
| `SHOPEE_CAPTCHA_SIGNATURE` | Opsional | `captcha_signature` default |
| `SHOPEE_PW_HASH` | Opsional | `md5sha256` (default) / `sha256` / `plain` |

3. Struktur yang dipakai Vercel: `api/index.js` (handler) + `vercel.json` (`includeFiles` membawa `views/**`, `lib/**`, `config.js`, `GoMerchant.js`). Tanpa `includeFiles`, `views/index.ejs` tidak ikut ter-bundle dan `/` balas 500.
4. `npm start` tetap jalan normal di VPS/lokal (port `PORT`, default 3015).

### Dari mana `captcha_signature`, `device_report`, dan `szdet` diambil

Ini bagian yang paling sering bikin bingung. Semuanya diambil dari **browser yang sudah pernah login sukses** ke `partner.shopee.co.id`, lewat DevTools (F12).

**A. `captcha_signature`** — dipakai saat Shopee minta captcha:

1. Buka `https://partner.shopee.co.id` di Chrome, login manual dengan nomor yang sama.
2. Tekan **F12** → tab **Network** → kotak filter ketik `send_otp`.
3. Di halaman login, klik kirim OTP. Kalau captcha muncul, **selesaikan di browser** sampai request `send_otp` berstatus **200**.
4. Klik request `send_otp` itu → tab **Payload** (atau *Request Payload*) → cari `captcha_signature` → **copy nilainya**.
5. Di dashboard: panel **Captcha Shopee** (kolom kanan) → tempel di kolom `captcha_signature` → **Kirim ulang OTP**.

Kalau Shopee mengirim gambar captcha ke server, dashboard menampilkannya langsung beserta kolom **Jawaban captcha** — isi jawabannya lalu kirim ulang. Kalau tidak ada gambar (paling umum), dashboard menampilkan instruksi langkah di atas.

**B. `device_report`** — telemetri perangkat, dipakai untuk device-check:

1. Masih di tab **Network**, filter `shpsec` atau `report`.
2. Cari request `POST https://df.infra.sz.shopee.co.id/v2/shpsec/web/report`.
3. Klik → tab **Payload** → seluruh isi body JSON itu **adalah** `device_report`. Copy semuanya (klik kanan → *Copy value*).
4. Dashboard → panel **Identitas perangkat** → *Tempel data asli dari browser* → paste ke `device_report (JSON)` → **Simpan identitas**.

**C. `szdet`** — header tanda tangan SDK:

1. Request yang sama (`/v2/shpsec/web/report`) → tab **Headers** → **Request Headers**.
2. Cari baris `szdet:` → copy nilainya (panjang, satu baris base64).
3. Paste ke kolom `szdet` di panel **Identitas perangkat** → **Simpan identitas**.

Setelah disimpan, `device_id` + telemetri + `szdet` dipakai konsisten di semua panggilan Shopee (login OTP maupun daftar transaksi), dan nilainya bertahan antar restart/deploy (Redis di Vercel, file di VPS). Panel itu juga menampilkan status: `telemetri: dibuat otomatis / N byte`, `szdet: bertanda tangan / asli`, `captcha_sig: ada / belum ada`.

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

### Kalau OTP tidak sampai (audit v3)

Versi lama punya dua bug yang membuat `send_otp` **tidak pernah dipanggil** — jadi OTP memang tidak mungkin sampai, bukan masalah jaringan/WhatsApp:

1. `check_password_migrate` divalidasi ketat. Endpoint itu membalas `error != 0` untuk akun yang tidak perlu migrasi password (normal), dan kode lama melempar error di situ.
2. Telemetri device-risk dikirim sebagai `{}` tanpa header `szdet`, dan device id acak tiap request. Shopee membaca itu sebagai perangkat tanpa jejak → captcha / device-check.

**v3 menambal sisa penyebabnya:**

3. **Identitas perangkat persisten** (`lib/identity.js`). `device_id` tidak lagi acak per proses — disimpan ke `data/identity.json` (atau `SHOPEE_DEVICE_ID`), jadi perangkat punya riwayat dan tidak dinilai "baru" tiap request.
4. **Telemetri selalu terisi + `szdet` bertanda tangan** (`lib/device.js`), bukan timestamp mentah. Body `{}` adalah penyebab utama captcha/device-block.
5. **`send_otp` diverifikasi.** Dulu `allowNullData:true` membuat balasan kosong dianggap sukses padahal OTP tidak dikirim. Sekarang balasan harus punya bukti (`otp_token` / `expire` / `channel` / `next_send_time`). Tanpa bukti → `OTP_UNVERIFIED`, bukan "sukses palsu".
6. **Retry captcha tanpa ulang dari nol.** Kalau Shopee minta captcha, state (cookie + risk token + channel) dikembalikan sebagai `retry`. User cukup mengisi `captcha_signature` lalu `POST /api/shopee/otp/retry` — tidak perlu login page + device-risk + password lagi (yang justru menaikkan skor risiko).

Langkah pakai:

1. **Diagnosa dulu** — `POST /api/shopee/diagnose {phone, password}`. Endpoint ini berhenti **sebelum** `send_otp`, jadi tidak memicu OTP atau rate limit, dan memberi tahu langkah mana yang gagal (`device_risk`, `authenticate_by_password`, `get_otp_settings`).
2. Kalau `device_risk` gagal atau captcha muncul: buka panel **Identitas Perangkat** di dashboard (kolom kanan), tempel body request `POST .../v2/shpsec/web/report` dari browser yang pernah login sukses ke `device_report`, dan header `szdet` ke `szdet`. Bisa juga lewat env `SHOPEE_DEVICE_REPORT` / `SHOPEE_SZDET`.
3. Kalau `send_otp` di browser membawa `captcha_signature`, tempel di panel **Captcha Shopee** lalu klik **Kirim ulang OTP**.
4. Kalau password ditolak padahal benar, coba `SHOPEE_PW_HASH=sha256` atau `plain` (default `md5sha256` = `sha256(md5(pw))`).
5. Jalan pintas yang selalu berhasil: login sekali di browser lalu pakai **Isi token manual** (token `B:...` dari DevTools).

Env baru: `SHOPEE_DEVICE_ID`, `SHOPEE_DEVICE_REPORT`, `SHOPEE_SZDET`, `SHOPEE_CAPTCHA_SIGNATURE`, `SHOPEE_PW_HASH`, `SHOPEE_UA`, `SHOPEE_DEVICE_SEED`.

### Perbaikan dari review sebelumnya (v3)

| Temuan review | Perbaikan |
|---|---|
| Kredensial asli di `config.js`, `BOT_API_KEY === ADMIN_PASSWORD` | `config.js` dikosongkan; `.gitignore` diperluas; peringatan startup kalau dua kunci sama / password pendek / mode publik |
| Seal key fallback `'vincent-pay'` (blob bisa dipalsukan) | Fallback dihapus. Kunci dari `SESSION_SECRET` / `ADMIN_PASSWORD` / `data/secret.key` (600) |
| Retry `send_otp` 3x saat timeout → OTP ganda | `send_otp`, `verify_otp`, `login_toc` tidak pernah di-retry; retry hanya untuk request idempoten |
| Rate limit bisa dilewati via `X-Forwarded-For` | Rate limit berlapis per nomor + per IP + global (`lib/guard.js`), tidak bergantung pada header yang bisa dipalsukan |
| Challenge OTP bisa dipakai 3x | Anti-replay: setiap challenge punya `jti`, sekali pakai (409 kalau diulang), maks 5 percobaan OTP per challenge |
| Audit trail tidak ada | `lib/audit.js` append-only JSONL + `GET /api/shopee/audit`; password/OTP/token/captcha tidak pernah dicatat |
| `refreshSession` memakai nonce/risk token lama | Risk token diambil baru saat refresh; nonce diperbarui dari hasil login |
| `classify()` salah menandai `/rate/i` ("corporate") | Regex pakai word boundary |
| `szdet` diisi timestamp | `szdet` = payload bertanda tangan HMAC per device |
| `/api/v1/*` pakai `app.all` (GET bisa memicu OTP bombing) | Endpoint OTP tetap bisa GET untuk playground, tapi rate limit berlapis berlaku untuk keduanya |

### Layout dashboard OTP

Alur OTP ada di kolom kiri. **Panel respons challenge ada di kolom kanan**, dan tepat di bawahnya (masih kolom kanan) ada panel **Real-time** lalu **Token merchant** dengan tombol **Copy** (token, session, copy semua, unduh JSON). Di bawah 900px semua panel menumpuk jadi satu kolom.

Di kolom kanan juga ada **panel Captcha Shopee**: kalau Shopee mengirim gambar captcha, gambarnya tampil di situ beserta kolom **Jawaban captcha**; kalau tidak, tampil instruksi langkah + kolom `captcha_signature`. Tombol **Kirim ulang OTP** memakai `POST /api/shopee/otp/retry` sehingga alur tidak diulang dari nol (login page, device-risk, dan password tidak dipanggil lagi — skor risiko tidak naik).

### Alur captcha & device-check (v4)

1. **Captcha tidak lagi di-hardcode.** `captcha_signature` diteruskan dari UI ke `send_otp` di semua jalur (request awal maupun retry). Kalau kosong, field-nya **tidak dikirim** — bukan dikirim sebagai string kosong yang justru ditolak Shopee.
2. **Retry tanpa ulang dari nol.** Saat Shopee membalas captcha/device-block, server mengembalikan `retry` (state terenkripsi: cookie, risk token, channel, trace). `POST /api/shopee/otp/retry` hanya memanggil `send_otp` sekali dengan state itu + captcha yang kamu isi.
3. **Captcha bergambar.** Kalau balasan Shopee memuat gambar (base64/URL), server menormalkannya jadi data URI dan mengirimkannya bersama `token` + `scene_id` + instruksi; UI menampilkan gambar dan mengirim jawaban sebagai `captcha`/`captcha_code`.
4. **Device-check.** `device_id` persisten (bukan acak per proses), telemetri selalu terisi, `szdet` bertanda tangan HMAC dan dikirim konsisten di semua request, UA satu untuk semua panggilan. Data asli dari browser bisa disuntik lewat `POST /api/shopee/identity` (panel **Identitas perangkat**) atau env `SHOPEE_DEVICE_ID` / `SHOPEE_DEVICE_REPORT` / `SHOPEE_SZDET`.
5. **Audit.** Setiap langkah tercatat di `GET /api/shopee/audit` — kalau OTP tidak sampai, kelihatan persis langkah mana yang ditolak Shopee.

Token manual tetap tersedia di kedua provider.

## API publik /api/v1 (stateless)

Menu **API** di dashboard adalah playground: isi parameter, klik Execute Request, hasilnya muncul di bawahnya (isian antar langkah terisi otomatis). Semua endpoint bisa **GET** (query) atau **POST** (JSON), tidak ada data yang disimpan di server. Nomor HP boleh `08...`, `628...`, atau `+628...`, selalu diproses sebagai `+628...`. Kalau `BOT_API_KEY` diisi, kirim `apikey` (query/body) atau header `x-api-key`.

| Provider | Endpoint | Parameter |
|---|---|---|
| ShopeePay | `/api/v1/shopee/otp` | phone, password?, channel?, captcha_signature?, captcha_answer?, captcha_token?, captcha_scene_id? |
| | `/api/v1/shopee/otp/retry` | retry (state dari respons error captcha), captcha_signature? / captcha_answer? / captcha_token? / captcha_scene_id? |
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
- `POST /api/shopee/otp`, `/api/shopee/otp/retry`, `/api/shopee/verify`, `/api/shopee/select`, `/api/shopee/logout`
- `GET|POST /api/shopee/identity`, `POST /api/shopee/identity/reset`: identitas perangkat (device-check)
- `GET /api/shopee/audit?limit=50`: audit trail OTP (nomor disamarkan, tanpa rahasia)
- `GET /api/token/status`, `POST /api/refresh {provider}`, `POST /api/auto/tick`, `POST /api/auto/config {provider, enabled, minutes}`: status dan jadwal auto refresh (token tidak pernah ikut dikirim). Versi bot: `/api/bot/token/status`, `/api/bot/refresh`, `/api/bot/auto/tick`
- `POST /api/bot/pay/create`, `/api/bot/pay/check`: sama seperti `/api/pay/*` tapi wajib `x-api-key` (hanya aktif kalau `BOT_API_KEY` diisi)
- `POST /api/admin/config`, `GET /api/health`

## Tes

```
npm test
```
Menjalankan 142 pengecekan offline (mode terkunci dan mode publik tanpa env): login OTP ShopeePay (server tiruan), bukti `send_otp` terverifikasi, retry captcha tanpa ulang dari nol, captcha bergambar (gambar + token + jawaban diteruskan), identitas perangkat stabil, anti-replay challenge, rate limit berlapis, audit trail tanpa rahasia, bikin QRIS, deteksi bayar, struk tidak bisa diklaim dua kali, token mati otomatis diperpanjang, penyimpanan persisten, batas percobaan login, dan layout panel kanan + tombol Copy.

```
npm run test:otp     # hanya alur OTP (80 cek)
npm run test:layout  # hanya struktur UI (23 cek)
```

## Yang perlu kamu tahu

- **Mode publik**: siapa pun yang tahu URL-nya bisa membuka dashboard, melihat riwayat, bahkan mengganti QRIS/token. Aman selama URL tidak tersebar. Kalau URL ikut tertulis di source bot yang dijual, isi `ADMIN_PASSWORD` di Vercel (satu env, tanpa kode tambahan) dan menu langsung terkunci.
- Pembayaran dicocokkan lewat **nominal + waktu**. Di bot sudah ada kode unik 10-200, di dashboard kasir belum. Kalau toko ramai, tambahkan kode unik sebelum bikin QRIS.
