// Captcha Shopee: ekstraksi challenge dari balasan + penyusunan field untuk send_otp.
//
// Kenapa modul terpisah:
//   Versi lama meng-hardcode `captcha_signature: ''` dan tidak pernah membaca
//   challenge yang dikirim Shopee. Akibatnya, saat Shopee minta captcha, user
//   tidak tahu apa-apa dan tidak punya jalan untuk menyelesaikannya.
//
// Yang dilakukan modul ini:
//   1. `extract(payload)` membaca balasan Shopee dan mengambil apa pun yang bisa
//      ditampilkan: gambar captcha (base64 atau URL), token/signature, tipe
//      challenge, dan scene id. Bentuk balasan Shopee bisa berbeda-beda, jadi
//      pencariannya toleran (banyak nama field alternatif).
//   2. `fields({ signature, answer, token, sceneId })` menyusun body captcha untuk
//      send_otp. Hanya field yang benar-benar ada yang dikirim, jadi tidak ada
//      lagi `captcha_signature: ''` yang menimpa nilai asli.
//   3. `instruction(info)` membuat instruksi bahasa manusia yang dipakai UI saat
//      Shopee TIDAK mengirim gambar (kasus paling umum: captcha hanya muncul di
//      browser, jadi user menyelesaikannya di sana lalu menempel signature).
//
// Catatan jujur: menyelesaikan captcha gambar secara otomatis TIDAK dilakukan di
// sini. Itu bukan jalur sah dan melanggar ketentuan layanan. Yang disediakan
// adalah jalur sah: user menyelesaikan captcha di browser Shopee sendiri, lalu
// hasilnya (signature/token) diteruskan ke server.

// Nama field yang mungkin dipakai Shopee untuk gambar captcha.
const IMAGE_KEYS = [
  'captcha_image', 'captchaImage', 'captcha_img', 'captchaImg', 'image', 'img',
  'image_base64', 'imageBase64', 'captcha_base64', 'captchaBase64', 'captcha_url', 'captchaUrl',
  'bg_image', 'bgImage', 'background_image', 'backgroundImage', 'puzzle_image', 'puzzleImage',
];
// Nama field untuk token / signature / scene.
const TOKEN_KEYS = ['captcha_token', 'captchaToken', 'captcha_signature', 'captchaSignature', 'token', 'sig', 'signature'];
const SCENE_KEYS = ['captcha_scene_id', 'captchaSceneId', 'scene_id', 'sceneId', 'captcha_type', 'captchaType', 'type'];
const HINT_KEYS = ['captcha_hint', 'captchaHint', 'captcha_msg', 'captchaMsg', 'hint', 'instruction', 'desc', 'description'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Cari nilai pertama yang tidak kosong dari daftar nama field, rekursif 3 level.
function pick(obj, keys, depth = 0) {
  if (!isObj(obj) || depth > 3) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  for (const v of Object.values(obj)) {
    if (isObj(v)) {
      const found = pick(v, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

// Apakah payload ini benar-benar minta captcha?
function isCaptcha(payload) {
  if (!isObj(payload)) return false;
  const d = isObj(payload.data) ? payload.data : payload;
  if (d.captcha_required === true || d.need_captcha === true || d.captchaRequired === true) return true;
  const msg = String(payload.error_msg || payload.msg || payload.message || '');
  if (/captcha/i.test(msg)) return true;
  // ada gambar captcha tapi tanpa flag eksplisit
  return !!(pick(d, IMAGE_KEYS) || pick(d, ['captcha_token', 'captchaToken']));
}

// Normalisasi gambar: data URI siap pakai untuk <img src>.
function normalizeImage(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^data:image\//i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/\s/g, '').length >= 24) {
    // base64 mentah: tebak tipe dari magic bytes (bukan dari panjangnya —
    // captcha kecil bisa < 200 karakter, dan menolaknya membuat gambar hilang)
    const b = s.replace(/\s/g, '');
    const head = Buffer.from(b.slice(0, 16), 'base64');
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    const isGif = head.slice(0, 4).toString() === 'GIF8';
    const isWebp = head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP';
    if (!isPng && !isJpg && !isGif && !isWebp) return null;
    const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : 'image/webp';
    return `data:${mime};base64,${b}`;
  }
  return null;
}

// Ambil semua info captcha yang bisa ditampilkan.
function extract(payload) {
  const d = isObj(payload) && isObj(payload.data) ? payload.data : (isObj(payload) ? payload : {});
  const image = normalizeImage(pick(d, IMAGE_KEYS));
  const token = pick(d, TOKEN_KEYS);
  const scene = pick(d, SCENE_KEYS);
  const hint = pick(d, HINT_KEYS);
  const info = {
    has_image: !!image,
    image: image || null,
    token: token ? String(token) : null,
    scene_id: scene != null ? String(scene) : null,
    hint: hint ? String(hint).slice(0, 300) : null,
    // field mentah yang dikenali, berguna untuk audit (tanpa nilai rahasia)
    keys: Object.keys(d).slice(0, 40),
  };
  info.instruction = instruction(info);
  return info;
}

// Instruksi untuk user. Dua jalur: gambar tersedia, atau tidak.
function instruction(info = {}) {
  if (info.has_image) {
    return 'Shopee mengirim gambar captcha. Ketik jawabannya di kolom "Jawaban captcha", lalu klik Kirim ulang OTP. '
      + 'Kalau jawaban ditolak, selesaikan captcha di browser Shopee lalu tempel captcha_signature-nya.';
  }
  return 'Shopee minta captcha tapi tidak mengirim gambar ke server (captcha hanya tampil di browser). '
    + 'Buka partner.shopee.co.id di browser, login dengan nomor yang sama, selesaikan captcha di sana, '
    + 'lalu buka DevTools > Network > cari request send_otp > Payload > salin nilai captcha_signature ke kolom di bawah.';
}

// Susun field captcha untuk body send_otp. Hanya yang terisi yang dikirim.
// `signature` = captcha_signature dari browser (paling umum & paling ampuh).
// `answer`    = jawaban captcha gambar (kalau Shopee mengirim gambar).
function fields({ signature, answer, token, sceneId } = {}) {
  const out = {};
  const sig = signature != null ? String(signature).trim() : '';
  const ans = answer != null ? String(answer).trim() : '';
  const tok = token != null ? String(token).trim() : '';
  const sc = sceneId != null ? String(sceneId).trim() : '';

  if (sig) out.captcha_signature = sig;
  if (ans) {
    // Shopee memakai beberapa nama; kirim yang paling umum sekaligus aman
    // (server mengabaikan field yang tidak dikenal).
    out.captcha = ans;
    out.captcha_code = ans;
  }
  if (tok) out.captcha_token = tok;
  if (sc) out.captcha_scene_id = sc;
  return out;
}

// Apakah ada sesuatu yang bisa dikirim?
const hasAny = f => !!(f && Object.keys(f).length);

module.exports = { extract, instruction, fields, hasAny, isCaptcha, normalizeImage, IMAGE_KEYS, TOKEN_KEYS };
