/* ============================================================
   Vincent Pay — Gopay x Shoppepay
   Front-end controller
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- storage ---------------- */
  const STORE_KEY = 'vincentpay.session.v1';
  const DAY = 86400000;

  const defaults = {
    apikey: '',
    phone: '',
    password: '',
    channel: '',
    provider: 'shopee',
    staticQr: '',
    amount: '',
    qrisProvider: 'shopee',
    token: '',
    tokenProvider: '',
    tokenAt: 0,
    savedAt: 0,
  };

  function readStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { ...defaults };
      return { ...defaults, ...parsed };
    } catch (e) {
      return { ...defaults };
    }
  }

  function writeStore(patch) {
    try {
      const next = { ...state, ...patch, savedAt: Date.now() };
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      Object.assign(state, next);
      renderSession();
    } catch (e) { /* storage penuh / diblokir: abaikan */ }
  }

  const state = readStore();

  /* ---------------- helpers ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    apikey: $('#inApikey'),
    phone: $('#inPhone'),
    password: $('#inPassword'),
    channel: $('#inChannel'),
    channelField: $('#channelField'),
    staticQr: $('#inStatic'),
    amount: $('#inAmount'),
    qrisProvider: $('#inQrisProvider'),
    otp: $('#inOtp'),

    btnRequest: $('#btnRequest'),
    btnResetOtp: $('#btnResetOtp'),
    btnVerify: $('#btnVerify'),
    btnResend: $('#btnResend'),
    btnCreateQris: $('#btnCreateQris'),
    btnClearQris: $('#btnClearQris'),
    btnInspect: $('#btnInspect'),
    btnScanQris: $('#btnScanQris'),
    fileQris: $('#fileQris'),
    btnCheckPay: $('#btnCheckPay'),
    btnDownloadQr: $('#btnDownloadQr'),
    btnCopyResult: $('#btnCopyResult'),
    btnCopyPayload: $('#btnCopyPayload'),
    btnForget: $('#btnForget'),

    verifyCard: $('#verify'),
    verifyLock: $('#verifyLock'),
    verifyBody: $('#verifyBody'),
    chPhone: $('#chPhone'),
    chChannel: $('#chChannel'),
    chTimer: $('#chTimer'),

    resultCode: $('#resultCode'),
    resultTime: $('#resultTime'),
    resultStatus: $('#resultStatus'),
    resultStatusText: $('#resultStatusText'),

    qrPanel: $('#qrPanel'),
    qrImage: $('#qrImage'),
    qrAmount: $('#qrAmount'),
    qrMeta: $('#qrMeta'),

    keyPill: $('#keyPill'),
    keyPillText: $('#keyPillText'),
    keyModal: $('#keyModal'),
    modalKey: $('#modalKey'),
    btnSaveKey: $('#btnSaveKey'),
    btnSettings: $('#btnSettings'),

    sessPhone: $('#sessPhone'),
    sessKey: $('#sessKey'),
    sessPass: $('#sessPass'),
    sessToken: $('#sessToken'),
    statSession: $('#statSession'),

    toastStack: $('#toastStack'),
  };

  let challenge = null;      // { token, provider, phone, channel, expiresAt }
  let timerId = null;
  let lastResult = null;     // objek hasil terakhir untuk Copy
  let lastQr = null;         // { payload, amount, createdAt, provider }

  /* ---------------- toast ---------------- */
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>';

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast toast--' + (kind === 'err' ? 'err' : 'ok');
    node.innerHTML = (kind === 'err' ? ICON_ERR : ICON_OK) + '<span></span>';
    node.querySelector('span').textContent = message;
    el.toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 240);
    }, kind === 'err' ? 4200 : 2600);
  }

  /* ---------------- clipboard ---------------- */
  // Kalau browser memblokir clipboard, tampilkan panel salin manual supaya tidak pernah gagal diam-diam.
  function manualCopy(text) {
    const old = document.getElementById('manualCopy');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = 'manualCopy';
    wrap.className = 'modal';
    wrap.innerHTML =
      '<div class="modal-backdrop" data-mc-close></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mcTitle">' +
        '<header class="modal-head"><div><h2 id="mcTitle">Salin manual</h2>' +
        '<p>Browser memblokir clipboard. Teks di bawah sudah dipilih, tekan Ctrl+C atau ⌘+C.</p></div>' +
        '<button class="icon-btn icon-btn--sm" type="button" data-mc-close aria-label="Tutup">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></header>' +
        '<div class="modal-body"><textarea id="mcText" class="manual-text" readonly rows="8"></textarea></div>' +
        '<footer class="modal-foot"><button class="btn btn--blue" type="button" data-mc-close>Tutup</button></footer>' +
      '</div>';
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    const ta = wrap.querySelector('#mcText');
    ta.value = text;
    setTimeout(() => { ta.focus(); ta.select(); }, 60);

    const close = () => { wrap.remove(); document.body.style.overflow = ''; };
    wrap.querySelectorAll('[data-mc-close]').forEach(n => n.addEventListener('click', close));
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallback di bawah */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch (e) { /* fallback manual */ }
    manualCopy(text);
    return false;
  }

  function flashCopy(btn) {
    const label = btn.querySelector('span');
    const original = label ? label.textContent : '';
    btn.classList.add('is-done');
    if (label) label.textContent = 'Tersalin';
    setTimeout(() => {
      btn.classList.remove('is-done');
      if (label) label.textContent = original;
    }, 1600);
  }

  /* ---------------- JSON renderer ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlight(value, indent) {
    const pad = '  '.repeat(indent || 0);
    if (value === null) return '<span class="c-null">null</span>';
    if (typeof value === 'boolean') return '<span class="c-bool">' + value + '</span>';
    if (typeof value === 'number') return '<span class="c-num">' + value + '</span>';
    if (typeof value === 'string') return '<span class="c-str">"' + escapeHtml(value) + '"</span>';
    if (Array.isArray(value)) {
      if (!value.length) return '<span class="c-punc">[]</span>';
      const items = value.map(v => pad + '  ' + highlight(v, (indent || 0) + 1));
      return '<span class="c-punc">[</span>\n' + items.join('<span class="c-punc">,</span>\n') + '\n' + pad + '<span class="c-punc">]</span>';
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (!keys.length) return '<span class="c-punc">{}</span>';
      const rows = keys.map(k => pad + '  <span class="c-key">"' + escapeHtml(k) + '"</span><span class="c-punc">: </span>' + highlight(value[k], (indent || 0) + 1));
      return '<span class="c-punc">{</span>\n' + rows.join('<span class="c-punc">,</span>\n') + '\n' + pad + '<span class="c-punc">}</span>';
    }
    return escapeHtml(String(value));
  }

  function showResult(obj, meta) {
    lastResult = obj;
    el.resultCode.innerHTML = highlight(obj, 0);
    el.resultTime.textContent = meta && meta.ms != null ? meta.ms + 'ms' : new Date().toLocaleTimeString('id-ID');
    setStatus(meta && meta.error ? 'err' : 'ok', meta && meta.error ? 'Request gagal' : 'Berhasil');
  }

  function showRaw(text) {
    lastResult = null;
    el.resultCode.innerHTML = '<span class="c-muted">' + escapeHtml(text) + '</span>';
    el.resultTime.textContent = '—';
  }

  function setStatus(kind, text) {
    el.resultStatus.dataset.state = kind;
    el.resultStatusText.textContent = text;
  }

  /* ---------------- API ---------------- */
  // Mode statis: halaman dibuka tanpa server (mis. preview). QRIS tetap jalan di browser,
  // sedangkan OTP butuh server karena harus memanggil Shopee/GoBiz.
  let staticMode = false;

  async function detectMode() {
    try {
      const r = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.indexOf('application/json') < 0) staticMode = true;
    } catch (e) {
      staticMode = true;
    }
    if (staticMode) {
      document.documentElement.setAttribute('data-mode', 'static');
      const note = document.getElementById('staticNote');
      if (note) note.hidden = false;
    }
  }

  function localQris(path, body) {
    const core = window.QRISCore;
    if (!core) throw new Error('Mesin QRIS tidak tersedia');
    if (path === '/api/qris/inspect') {
      const info = core.info(body.payload);
      if (!info.valid) throw new Error('Payload bukan QRIS yang valid');
      return Object.assign({ success: true }, info);
    }
    if (path === '/api/qris/create') {
      const amount = parseInt(body.amount, 10);
      if (!(amount >= 1)) throw new Error('Nominal tidak valid');
      const payload = core.toDynamic(body.static_qr, amount);
      const info = core.info(payload);
      return window.QRCodeLib.toDataURL(payload, {
        errorCorrectionLevel: 'M', margin: 2, width: 640,
        color: { dark: '#0f172a', light: '#ffffff' },
      }).then(function (image) {
        return {
          success: true, amount: amount, payload: payload, image: image, info: info,
          created_at: new Date().toISOString(), expires_in: 900, elapsed_ms: 0,
        };
      });
    }
    throw new Error('Aksi ini butuh server. Jalankan "npm start" lalu buka localhost:3015.');
  }

  async function api(path, body) {
    if (staticMode) {
      if (path.indexOf('/api/qris/') === 0) return localQris(path, body || {});
      throw new Error('Request OTP butuh server. Jalankan "npm start" lalu buka localhost:3015.');
    }

    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.success === false) {
      const err = new Error((data && data.error) || 'Permintaan gagal (' + res.status + ')');
      err.code = data && data.code;
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  /* ---------------- loading ---------------- */
  function busy(btn, on) {
    btn.classList.toggle('is-loading', !!on);
    btn.disabled = !!on;
  }

  /* ---------------- API key gate ---------------- */
  function hasKey() { return !!String(state.apikey || '').trim(); }

  function openKeyModal(focus) {
    el.modalKey.value = state.apikey || '';
    el.keyModal.hidden = false;
    document.body.style.overflow = 'hidden';
    if (focus !== false) setTimeout(() => el.modalKey.focus(), 60);
  }

  function closeKeyModal() {
    el.keyModal.hidden = true;
    document.body.style.overflow = '';
  }

  function renderKey() {
    const set = hasKey();
    el.keyPill.dataset.state = set ? 'set' : 'empty';
    el.keyPillText.textContent = set ? 'API key aktif' : 'API key belum diisi';
    el.apikey.value = state.apikey || '';
  }

  // Pastikan API key ada sebelum aksi. Mengembalikan true kalau boleh lanjut.
  function ensureKey() {
    if (hasKey()) return true;
    openKeyModal();
    toast('Isi API key dulu untuk menjalankan aksi ini.', 'err');
    return false;
  }

  /* ---------------- session panel ---------------- */
  function maskKey(k) {
    if (!k) return '—';
    const s = String(k);
    if (s.length <= 8) return '•'.repeat(s.length);
    return s.slice(0, 4) + '•'.repeat(Math.min(10, s.length - 8)) + s.slice(-4);
  }

  function maskToken(t) {
    if (!t) return '—';
    const s = String(t);
    if (s.length <= 12) return '•'.repeat(s.length);
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  function renderSession() {
    el.sessPhone.textContent = state.phone ? '+62 ' + String(state.phone).replace(/^0+/, '') : '—';
    el.sessKey.textContent = maskKey(state.apikey);
    el.sessPass.textContent = state.password ? '•'.repeat(Math.min(10, state.password.length)) : '—';
    el.sessToken.textContent = maskToken(state.token);
    el.statSession.textContent = state.token ? 'Token aktif' : (state.phone ? 'Nomor tersimpan' : 'Belum ada');
  }

  /* ---------------- provider switch ---------------- */
  function setProvider(p) {
    state.provider = p;
    $$('.provider').forEach(b => {
      const on = b.dataset.provider === p;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // GoPay tidak memakai password / channel
    const isGopay = p === 'gopay';
    el.password.closest('.field').style.display = isGopay ? 'none' : '';
    el.channelField.style.display = isGopay ? 'none' : '';
    writeStore({ provider: p });
  }

  /* ---------------- OTP flow ---------------- */
  function normalizePhoneInput(v) {
    let d = String(v || '').replace(/\D+/g, '');
    if (d.startsWith('62')) d = d.slice(2);
    d = d.replace(/^0+/, '');
    return d;
  }

  function startTimer(seconds) {
    stopTimer();
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        el.chTimer.textContent = 'Kedaluwarsa';
        el.chTimer.style.color = '#ef4444';
        stopTimer();
        return;
      }
      const m = String(Math.floor(left / 60)).padStart(2, '0');
      const s = String(left % 60).padStart(2, '0');
      el.chTimer.textContent = m + ':' + s;
      el.chTimer.style.color = '';
      left -= 1;
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function unlockVerify(data) {
    challenge = {
      token: data.challenge,
      provider: data.provider,
      phone: data.phone,
      channel: data.channel_label,
      expiresAt: Date.now() + (data.expires_in || 600) * 1000,
    };
    el.verifyCard.classList.remove('is-locked');
    el.verifyLock.hidden = true;
    el.verifyBody.hidden = false;
    el.chPhone.textContent = data.phone;
    el.chChannel.textContent = data.channel_label || '—';
    startTimer(data.expires_in || 600);
    el.otp.value = '';
    setTimeout(() => el.otp.focus(), 120);
  }

  function lockVerify() {
    challenge = null;
    stopTimer();
    el.verifyCard.classList.add('is-locked');
    el.verifyLock.hidden = false;
    el.verifyBody.hidden = true;
    el.otp.value = '';
  }

  async function doRequest() {
    if (!ensureKey()) return;

    const phone = normalizePhoneInput(el.phone.value);
    if (!phone || phone.length < 9) {
      toast('Nomor HP belum benar. Contoh: 812 3456 7890', 'err');
      el.phone.focus();
      return;
    }

    const provider = state.provider;
    const payload = {
      provider,
      phone,
      apikey: state.apikey,
    };
    if (provider === 'shopee') {
      if (el.password.value) payload.password = el.password.value;
      if (el.channel.value) payload.channel = Number(el.channel.value);
    }

    busy(el.btnRequest, true);
    setStatus('busy', 'Mengirim OTP…');
    showRaw('// Mengirim permintaan OTP…');

    try {
      const data = await api('/api/otp/request', payload);
      writeStore({
        phone,
        password: provider === 'shopee' ? el.password.value : state.password,
        channel: el.channel.value || '',
        provider,
      });
      unlockVerify(data);
      showResult({
        success: true,
        provider: data.provider,
        phone: data.phone,
        channel: data.channel,
        channel_label: data.channel_label,
        channels: data.channels,
        has_password: data.has_password,
        expires_in: data.expires_in,
        challenge: data.challenge,
        elapsed_ms: data.elapsed_ms,
        at: data.at,
      }, { ms: data.elapsed_ms });
      toast('Kode OTP terkirim ke ' + data.phone);
      el.verifyCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      setStatus('err', 'Gagal mengirim OTP');
      showResult({ success: false, code: e.code || null, error: e.message }, { error: true });
      toast(e.message, 'err');
      if (e.code === 'API_KEY_INVALID' || e.code === 'API_KEY_REQUIRED') openKeyModal();
    } finally {
      busy(el.btnRequest, false);
    }
  }

  async function doVerify() {
    if (!ensureKey()) return;
    if (!challenge) { toast('Kirim OTP dulu.', 'err'); return; }

    const code = String(el.otp.value || '').replace(/\D+/g, '');
    if (code.length < 4) {
      toast('Kode OTP minimal 4 digit.', 'err');
      el.otp.focus();
      return;
    }

    busy(el.btnVerify, true);
    setStatus('busy', 'Memverifikasi OTP…');
    showRaw('// Memverifikasi kode OTP…');

    try {
      const data = await api('/api/otp/verify', {
        provider: challenge.provider,
        challenge: challenge.token,
        otp: code,
        apikey: state.apikey,
      });

      writeStore({
        token: data.token,
        tokenProvider: data.provider,
        tokenAt: Date.now(),
      });

      showResult({
        success: true,
        provider: data.provider,
        merchant: data.merchant,
        merchants: data.merchants,
        token: data.token,
        refresh_token: data.refresh_token,
        account_id: data.account_id,
        expires_at: data.expires_at,
        elapsed_ms: data.elapsed_ms,
        at: data.at,
      }, { ms: data.elapsed_ms });

      setStatus('ok', 'Token merchant siap');
      toast('Berhasil. Token merchant sudah didapat.');
      stopTimer();
      el.chTimer.textContent = 'Selesai';
      el.chTimer.style.color = '#059669';
    } catch (e) {
      setStatus('err', 'Verifikasi gagal');
      showResult({ success: false, code: e.code || null, error: e.message }, { error: true });
      toast(e.message, 'err');
      if (e.code === 'API_KEY_INVALID' || e.code === 'API_KEY_REQUIRED') openKeyModal();
    } finally {
      busy(el.btnVerify, false);
    }
  }

  /* ---------------- QRIS ---------------- */
  function formatRupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  }

  function parseAmount(v) {
    const digits = String(v || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  async function doCreateQris() {
    if (!ensureKey()) return;

    const staticQr = String(el.staticQr.value || '').trim();
    if (!staticQr) {
      toast('Tempel QRIS statis dulu.', 'err');
      el.staticQr.focus();
      return;
    }
    const amount = parseAmount(el.amount.value);
    if (!(amount >= 1)) {
      toast('Nominal belum diisi.', 'err');
      el.amount.focus();
      return;
    }

    busy(el.btnCreateQris, true);
    setStatus('busy', 'Membuat QRIS…');

    try {
      const data = await api('/api/qris/create', {
        static_qr: staticQr,
        amount,
        apikey: state.apikey,
      });

      lastQr = {
        payload: data.payload,
        amount: data.amount,
        createdAt: data.created_at,
        provider: el.qrisProvider.value,
      };

      el.qrImage.src = data.image;
      el.qrAmount.textContent = formatRupiah(data.amount);
      el.btnDownloadQr.href = data.image;
      el.btnDownloadQr.download = 'qris-' + data.amount + '.png';
      el.qrMeta.innerHTML = '';
      const rows = [
        ['Merchant', data.info.merchant_name || '—'],
        ['NMID', data.info.nmid || '—'],
        ['Tipe', data.info.type === 'dynamic' ? 'Dinamis' : 'Statis'],
        ['CRC', data.info.crc_ok ? 'Valid' : 'Tidak valid'],
      ];
      rows.forEach(([k, v]) => {
        const d = document.createElement('div');
        const s = document.createElement('span');
        s.textContent = k;
        const st = document.createElement('strong');
        st.textContent = v;
        d.appendChild(s); d.appendChild(st);
        el.qrMeta.appendChild(d);
      });
      el.qrPanel.hidden = false;

      writeStore({ staticQr, amount: String(amount), qrisProvider: el.qrisProvider.value });

      showResult({
        success: true,
        amount: data.amount,
        payload: data.payload,
        info: data.info,
        created_at: data.created_at,
        expires_in: data.expires_in,
        elapsed_ms: data.elapsed_ms,
      }, { ms: data.elapsed_ms });

      setStatus('ok', 'QRIS siap dipakai');
      toast('QRIS dinamis berhasil dibuat.');
      el.qrPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      setStatus('err', 'Gagal membuat QRIS');
      showResult({ success: false, code: e.code || null, error: e.message }, { error: true });
      toast(e.message, 'err');
      if (e.code === 'API_KEY_INVALID' || e.code === 'API_KEY_REQUIRED') openKeyModal();
    } finally {
      busy(el.btnCreateQris, false);
    }
  }

  async function doInspect() {
    const payload = String(el.staticQr.value || '').trim();
    if (!payload) { toast('Tempel atau scan QRIS dulu.', 'err'); return; }
    try {
      const data = await api('/api/qris/inspect', { payload });
      showResult(data, {});
      setStatus('ok', 'QRIS terbaca');
      toast('QRIS valid: ' + (data.merchant_name || 'tanpa nama merchant'));
    } catch (e) {
      setStatus('err', 'QRIS tidak terbaca');
      showResult({ success: false, error: e.message }, { error: true });
      toast(e.message, 'err');
    }
  }

  async function doCheckPay() {
    if (!ensureKey()) return;
    if (!lastQr) { toast('Buat QRIS dulu.', 'err'); return; }
    if (!state.token) { toast('Selesaikan OTP dulu supaya token tersedia.', 'err'); return; }

    busy(el.btnCheckPay, true);
    setStatus('busy', 'Mengecek pembayaran…');
    try {
      const data = await api('/api/qris/check', {
        provider: lastQr.provider,
        amount: lastQr.amount,
        token: state.token,
        created_at: lastQr.createdAt,
        apikey: state.apikey,
      });
      showResult(data, { ms: data.elapsed_ms });
      if (data.status === 'PAID') {
        setStatus('ok', 'Pembayaran diterima');
        toast('Pembayaran masuk: ' + formatRupiah(lastQr.amount));
      } else {
        setStatus('ok', 'Belum ada pembayaran');
        toast('Belum ada pembayaran untuk nominal ini.');
      }
    } catch (e) {
      setStatus('err', 'Gagal cek pembayaran');
      showResult({ success: false, error: e.message }, { error: true });
      toast(e.message, 'err');
    } finally {
      busy(el.btnCheckPay, false);
    }
  }

  /* ---------------- scan QRIS image ---------------- */
  async function scanQrisFile(file) {
    if (!file) return;
    if (typeof window.jsQR !== 'function') {
      toast('Pembaca QR tidak tersedia di browser ini.', 'err');
      return;
    }
    toast('Membaca gambar QRIS…');
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (!result || !result.data) {
        toast('QR tidak terbaca. Coba foto yang lebih jelas.', 'err');
        return;
      }
      el.staticQr.value = result.data;
      writeStore({ staticQr: result.data });
      toast('QRIS berhasil dibaca dari gambar.');
      doInspect();
    } catch (e) {
      toast('Gagal membaca gambar: ' + e.message, 'err');
    }
  }

  /* ---------------- wiring ---------------- */
  function bindToggle(btn) {
    const target = document.getElementById(btn.dataset.toggle);
    if (!target) return;
    btn.addEventListener('click', () => {
      const show = target.type === 'password';
      target.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Sembunyikan' : 'Tampilkan');
    });
  }

  function init() {
    detectMode();

    // restore form values
    el.apikey.value = state.apikey || '';
    el.phone.value = state.phone || '';
    el.password.value = state.password || '';
    el.channel.value = state.channel || '';
    el.staticQr.value = state.staticQr || '';
    el.amount.value = state.amount ? Number(state.amount).toLocaleString('id-ID') : '';
    el.qrisProvider.value = state.qrisProvider || 'shopee';

    renderKey();
    renderSession();
    setProvider(state.provider || 'shopee');
    showRaw('// Hasil request akan muncul di sini.');

    // provider buttons
    $$('.provider').forEach(b => b.addEventListener('click', () => setProvider(b.dataset.provider)));

    // password toggles
    $$('[data-toggle]').forEach(bindToggle);

    // persist on input
    el.apikey.addEventListener('input', () => writeStore({ apikey: el.apikey.value.trim() }));
    el.phone.addEventListener('input', () => writeStore({ phone: normalizePhoneInput(el.phone.value) }));
    el.password.addEventListener('input', () => writeStore({ password: el.password.value }));
    el.channel.addEventListener('change', () => writeStore({ channel: el.channel.value }));
    el.staticQr.addEventListener('input', () => writeStore({ staticQr: el.staticQr.value }));
    el.qrisProvider.addEventListener('change', () => writeStore({ qrisProvider: el.qrisProvider.value }));

    el.amount.addEventListener('input', () => {
      const n = parseAmount(el.amount.value);
      el.amount.value = n ? n.toLocaleString('id-ID') : '';
      writeStore({ amount: n ? String(n) : '' });
    });

    // actions
    el.btnRequest.addEventListener('click', doRequest);
    el.btnVerify.addEventListener('click', doVerify);
    el.btnResend.addEventListener('click', doRequest);
    el.btnCreateQris.addEventListener('click', doCreateQris);
    el.btnInspect.addEventListener('click', doInspect);
    el.btnCheckPay.addEventListener('click', doCheckPay);

    el.btnResetOtp.addEventListener('click', () => {
      el.phone.value = '';
      el.password.value = '';
      el.channel.value = '';
      el.otp.value = '';
      lockVerify();
      writeStore({ phone: '', password: '', channel: '' });
      showRaw('// Form dikosongkan.');
      setStatus('idle', 'Menunggu request');
      toast('Form OTP dikosongkan.');
    });

    el.btnClearQris.addEventListener('click', () => {
      el.staticQr.value = '';
      el.amount.value = '';
      el.qrPanel.hidden = true;
      lastQr = null;
      writeStore({ staticQr: '', amount: '' });
      toast('Data QRIS dibersihkan.');
    });

    el.btnScanQris.addEventListener('click', () => el.fileQris.click());
    el.fileQris.addEventListener('change', () => {
      const f = el.fileQris.files && el.fileQris.files[0];
      scanQrisFile(f);
      el.fileQris.value = '';
    });

    // copy
    el.btnCopyResult.addEventListener('click', async () => {
      const text = lastResult ? JSON.stringify(lastResult, null, 2) : el.resultCode.textContent;
      const ok = await copyText(text);
      if (ok) { flashCopy(el.btnCopyResult); toast('Hasil disalin.'); }
      else toast('Gagal menyalin. Salin manual dari panel.', 'err');
    });

    el.btnCopyPayload.addEventListener('click', async () => {
      if (!lastQr) return;
      const ok = await copyText(lastQr.payload);
      if (ok) { flashCopy(el.btnCopyPayload); toast('Payload QRIS disalin.'); }
      else toast('Gagal menyalin payload.', 'err');
    });

    // forget session
    el.btnForget.addEventListener('click', () => {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
      Object.assign(state, defaults);
      el.apikey.value = '';
      el.phone.value = '';
      el.password.value = '';
      el.channel.value = '';
      el.staticQr.value = '';
      el.amount.value = '';
      el.qrPanel.hidden = true;
      lastQr = null;
      lockVerify();
      renderKey();
      renderSession();
      showRaw('// Sesi dihapus dari perangkat ini.');
      setStatus('idle', 'Menunggu request');
      toast('Data tersimpan sudah dihapus.');
    });

    // key modal
    el.btnSettings.addEventListener('click', () => openKeyModal());
    el.btnSaveKey.addEventListener('click', () => {
      const v = el.modalKey.value.trim();
      writeStore({ apikey: v });
      el.apikey.value = v;
      renderKey();
      closeKeyModal();
      toast(v ? 'API key disimpan.' : 'API key dikosongkan.');
    });
    el.modalKey.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.btnSaveKey.click(); }
    });
    $$('[data-close]', el.keyModal).forEach(n => n.addEventListener('click', closeKeyModal));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !el.keyModal.hidden) closeKeyModal();
    });

    // OTP input: digits only
    el.otp.addEventListener('input', () => {
      el.otp.value = el.otp.value.replace(/\D+/g, '').slice(0, 10);
    });
    el.otp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doVerify(); }
    });
    el.phone.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doRequest(); }
    });

    // nav active state
    const sections = ['otp', 'qris', 'panduan'].map(id => document.getElementById(id)).filter(Boolean);
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          $$('.topnav-link').forEach(a => {
            a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id);
          });
        });
      }, { rootMargin: '-30% 0px -60% 0px' });
      sections.forEach(s => obs.observe(s));
    }

    // kalau token tersimpan masih ada, tampilkan di panel
    if (state.token) {
      showResult({
        success: true,
        note: 'Token merchant tersimpan di perangkat ini',
        provider: state.tokenProvider || null,
        token: state.token,
        saved_at: state.tokenAt ? new Date(state.tokenAt).toISOString() : null,
      }, {});
      setStatus('ok', 'Token tersimpan');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
