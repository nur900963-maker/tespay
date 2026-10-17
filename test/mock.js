// Server tiruan Shopee untuk tes offline. Semua panggilan keluar (axios) dialihkan ke sini.
const assert = require('assert');
const axios = require('axios');

const state = { txs: [], listCalls: 0, killToken: null, tokenSeq: 1, otpOk: '1234' };
state.goSeq = 1;
const jwt = (tok, uid) => 'h.' + Buffer.from(JSON.stringify({ token: tok, userid: uid, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.s';
const J = (o, extra = {}) => ({ status: 200, headers: { ...extra }, data: JSON.stringify(o) });

function mock(cfg) {
  const u = new URL(cfg.url), p = u.pathname, h = cfg.headers || {};
  const body = typeof cfg.data === 'string' && cfg.data.startsWith('{') ? JSON.parse(cfg.data) : {};
  if (u.host === 'partner.business.accounts.shopee.co.id') {
    if (p === '/login') return { status: 200, headers: { 'set-cookie': ['csrftoken=csrf1; Path=/'] }, data: '<html>' };
    if (p.endsWith('check_password_migrate')) return J({ error: 0, data: {} });
    if (p.endsWith('check_account_exist_by_password')) return J({ error: 1, data: null });
    if (p.endsWith('authenticate_toc_by_password')) return J({ error: 0, data: {} });
    if (p.endsWith('get_otp_settings')) return J({ error: 0, data: { available_channel_list: [1, 3], default_channel: 3 } });
    if (p.endsWith('send_otp')) return J({ error: 0, data: {} });
    if (p.endsWith('verify_otp')) {
      assert.strictEqual(body.phone, '(+62) 812 3456 789');
      return body.otp === state.otpOk ? J({ error: 0, data: { otp_token: 'OT' } }) : J({ error: 1, error_msg: 'wrong otp', data: null });
    }
    if (p.endsWith('authenticate_toc_by_otp')) return J({ error: 0, data: { toc_nonce: 'NONCE', toc_account: { userid: 111 } } }, { 'set-cookie': ['SPC_CLIENTID=cid1; Path=/'] });
    if (p.startsWith('/authenticate/login/token')) return { status: 200, headers: {}, data: 'ok' };
    if (p.endsWith('login_toc')) return J({ error: 0, data: { nonce: 'CODE' } });
    if (p.endsWith('login_status')) return J({ error: state.accountDead ? 48500102 : 0, data: {} });
  }
  if (u.host === 'df.infra.sz.shopee.co.id') return J({ code: 0, data: { riskToken: 'RISK' } });
  if (u.host === 'partner.shopee.co.id') {
    if (p === '/account/login/auth' && !u.searchParams.get('hop')) return { status: 302, headers: { location: '/account/login/auth?hop=1' }, data: '' };
    if (p === '/account/login/auth') return { status: 200, headers: {}, data: 'ok' };
    if (p === '/account/login/tob/auth') {
      assert.strictEqual(u.searchParams.get('code'), 'CODE');
      return { status: 200, headers: { 'set-cookie': [`__shopee_partner_website_x_token_live=${jwt('B:LIVE' + state.tokenSeq++, 222)}; Path=/`] }, data: 'ok' };
    }
  }
  if (u.host === 'api.partner.shopee.co.id') {
    assert.ok(!h.Cookie, 'API partner tidak boleh kirim cookie');
    if (p.endsWith('MerchantDetect')) { assert.strictEqual(h['X-Merchant-ToC-Nonce'], 'NONCE'); return J({ errorCode: 0, data: { selectMerchant: { merchantList: [{ merchantId: 777, merchantName: 'Toko Uji', staffTobUid: 222, isActive: true, isBanned: false, isCurrentLoginUser: true }] } } }); }
    if (p.endsWith('GetUserInfo')) return J({ errorCode: 0, data: { merchantId: 777, merchantName: 'Toko Uji' } });
  }
  if (u.host === 'shopeepay.shopee.co.id') {
    state.listCalls++;
    const tok = body.data.metadata.token;
    if (tok === state.killToken) return J({ code: 200020, msg: 'invalid token', data: null });
    return J({ code: 0, data: { list: state.txs } });
  }
  if (u.host === 'api.gobiz.co.id') {
    const fail401 = msg => { const e = new Error('Request failed with status code 401'); e.response = { status: 401, data: { message: msg } }; throw e; };
    if (p === '/goid/token') {
      if (state.goRefreshFail) fail401('invalid refresh token');
      const n = state.goSeq++;
      return J({ data: { access_token: 'GA' + n, refresh_token: 'GR' + n, expires_in: 3600 } });
    }
    if (p === '/v1/users/me') { if (state.goDead && String(h.Authorization || '').includes(state.goDead)) fail401('expired'); return J({ user: { merchant_id: 'm1' } }); }
  }
  throw new Error('request tidak terduga: ' + cfg.url);
}
axios.defaults.adapter = async cfg => { const r = mock(cfg); return { ...r, statusText: 'OK', config: cfg, request: {} }; };


module.exports = { state };
