// Lapisan layanan OTP: membungkus klien ShopeePay (lib/shopeepay.js) dan GoMerch (GoMerchant.js)
// supaya app.js cukup memanggil satu fungsi. Semua state sementara dibungkus seal() (stateless).
const ShopeePayClient = require('./shopeepay');
const GoMerchant = require('../GoMerchant');
const normPhone = require('./phone');

const go = new GoMerchant();

const CHANNEL_LABEL = {
  1: 'WhatsApp',
  2: 'SMS',
  3: 'Email',
  4: 'Telepon',
  5: 'Shopee App',
};

function friendly(err) {
  const code = err && err.code;
  if (code === 'PASSWORD_REQUIRED') return 'Akun ini memakai password. Isi password ShopeePay dulu, lalu kirim OTP lagi.';
  if (code === 'INVALID_PASSWORD') return 'Password ShopeePay salah.';
  if (code === 'CHANNEL_UNAVAILABLE') return 'Channel OTP yang dipilih tidak tersedia untuk akun ini.';
  if (code === 'DEVICE_RISK') return 'Layanan verifikasi perangkat Shopee sedang tidak merespons. Coba lagi sebentar.';
  if (err && err.name === 'CaptchaRequired') return 'Shopee meminta captcha. Selesaikan dulu di aplikasi/browser Shopee, lalu coba lagi.';
  const msg = (err && err.message) || 'Terjadi kesalahan';
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(msg)) return 'Koneksi ke server provider terputus. Coba lagi.';
  return msg;
}

// ---------- ShopeePay ----------
async function shopeeRequest({ phone, password, channel }) {
  const ph = normPhone(phone);
  const client = new ShopeePayClient();
  const ch = channel === undefined || channel === null || channel === '' ? undefined : Number(channel);
  const challenge = await client.requestOtp(ph.plus, { password: password || undefined, channel: ch });
  return {
    provider: 'shopee',
    phone: ph.plus,
    channel: challenge.channel,
    channel_label: CHANNEL_LABEL[challenge.channel] || `Channel ${challenge.channel}`,
    channels: (challenge.availableChannels || []).map(c => ({ id: c, label: CHANNEL_LABEL[c] || `Channel ${c}` })),
    has_password: !!challenge.hasPassword,
    expires_in: 300,
    challenge,
  };
}

async function shopeeVerify(challenge, otp) {
  const client = new ShopeePayClient();
  const verification = await client.verifyOtp(challenge, otp);
  const usable = (verification.merchants || []).filter(m => m.isActive !== false && !m.isBanned);
  if (!usable.length) throw Object.assign(new Error('Akun ini tidak punya merchant aktif'), { status: 400 });
  const session = await client.completeLogin(verification, { merchantId: usable[0].id });
  return {
    provider: 'shopee',
    token: session.token,
    account_id: session.accountId,
    merchant: { id: session.merchantId, name: session.merchantName },
    merchants: usable.map(m => ({ id: String(m.id), name: m.name })),
    expires_at: null,
    session,
  };
}

// ---------- GoPay / GoMerch ----------
async function gopayRequest({ phone }) {
  const ph = normPhone(phone);
  const res = await go.requestOtp(ph.national);
  const data = res && res.data ? res.data : res;
  if (!data || !data.otp_token) throw Object.assign(new Error('GoBiz tidak mengembalikan token OTP'), { status: 502 });
  return {
    provider: 'gopay',
    phone: ph.plus,
    channel: 2,
    channel_label: 'SMS / WhatsApp',
    channels: [{ id: 2, label: 'SMS / WhatsApp' }],
    has_password: false,
    expires_in: 300,
    challenge: { otp_token: data.otp_token, phone: ph.plus },
  };
}

async function gopayVerify(challenge, otp) {
  const res = await go.verifyOtp(String(otp).trim(), challenge.otp_token);
  const t = res && res.data ? res.data : res;
  if (!t || !t.access_token) throw Object.assign(new Error('OTP ditolak GoBiz'), { status: 400 });
  let merchant = null;
  try {
    const me = await go.getMe(t.access_token);
    merchant = { id: me.user && me.user.merchant_id, name: (me.user && (me.user.merchant_name || me.user.name)) || 'GoPay Merchant' };
  } catch (e) { /* profil opsional */ }
  return {
    provider: 'gopay',
    token: t.access_token,
    refresh_token: t.refresh_token || null,
    merchant: merchant || { id: null, name: 'GoPay Merchant' },
    merchants: merchant ? [merchant] : [],
    expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
  };
}

module.exports = {
  CHANNEL_LABEL,
  friendly,
  request: (provider, body) => (provider === 'gopay' ? gopayRequest(body) : shopeeRequest(body)),
  verify: (provider, challenge, otp) => (provider === 'gopay' ? gopayVerify(challenge, otp) : shopeeVerify(challenge, otp)),
  go,
};
