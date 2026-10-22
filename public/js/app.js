/* =====================================================================
   Vincent Pay — shared client helpers
   ===================================================================== */
const API = '';

const Store = {
  get token() { return localStorage.getItem('vp_token'); },
  set token(v) { v ? localStorage.setItem('vp_token', v) : localStorage.removeItem('vp_token'); },
  get user() {
    try { return JSON.parse(localStorage.getItem('vp_user') || 'null'); } catch { return null; }
  },
  set user(v) { v ? localStorage.setItem('vp_user', JSON.stringify(v)) : localStorage.removeItem('vp_user'); },
  clear() { localStorage.removeItem('vp_token'); localStorage.removeItem('vp_user'); }
};

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && Store.token) headers.Authorization = `Bearer ${Store.token}`;

  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (res.status === 401 && auth) {
    Store.clear();
    if (!location.pathname.endsWith('login.html') && location.pathname !== '/login') {
      location.href = '/login';
    }
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request gagal (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- formatting ---------------- */
function rupiah(n) {
  const num = Number(n || 0);
  return 'Rp ' + num.toLocaleString('id-ID');
}
function rupiahShort(n) {
  const num = Number(n || 0);
  if (num >= 1e9) return 'Rp ' + (num / 1e9).toFixed(1).replace('.0', '') + ' M';
  if (num >= 1e6) return 'Rp ' + (num / 1e6).toFixed(1).replace('.0', '') + ' jt';
  if (num >= 1e3) return 'Rp ' + (num / 1e3).toFixed(0) + ' rb';
  return rupiah(num);
}
function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDateShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  return `${d} hari lalu`;
}

/* ---------------- toast ---------------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = document.createElement('i');
  icon.className = `fas ${type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}`;
  const text = document.createElement('span');
  text.textContent = String(msg ?? '');
  el.append(icon, text);
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

/* ---------------- navbar ---------------- */
function renderNav(active = '') {
  const mount = document.getElementById('nav');
  if (!mount) return;
  const user = Store.user;
  const links = [
    ['/', 'Beranda', 'home'],
    ['/pricing', 'Biaya', 'pricing'],
    ['/docs', 'Dokumentasi', 'docs']
  ];

  mount.innerHTML = `
  <nav class="site-nav">
    <div class="nav-inner">
      <a href="/" class="nav-logo">
        <img src="/icon.svg" alt="Vincent Pay">
        <span>Vincent Pay</span>
      </a>
      <div class="nav-links">
        ${links.map(([href, label, key]) =>
          `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`).join('')}
      </div>
      <div class="nav-actions">
        ${user
          ? `<a href="/dashboard" class="btn-primary"><i class="fas fa-gauge-high text-[11px]"></i> Dashboard</a>`
          : `<a href="/login" class="btn-secondary">Masuk</a>
             <a href="/register" class="btn-primary">Daftar</a>`}
        <button class="nav-toggle" id="navToggle" aria-label="Menu"><i class="fas fa-bars"></i></button>
      </div>
    </div>
    <div class="mobile-menu" id="mobileMenu">
      ${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
      ${user ? '<a href="/dashboard">Dashboard</a><a href="#" id="mLogout">Keluar</a>'
             : '<a href="/login">Masuk</a><a href="/register">Daftar</a>'}
    </div>
  </nav>`;

  document.getElementById('navToggle')?.addEventListener('click', () => {
    document.getElementById('mobileMenu').classList.toggle('open');
  });
  const logout = () => { Store.clear(); location.href = '/'; };
  document.getElementById('mLogout')?.addEventListener('click', (e) => { e.preventDefault(); logout(); });
}

/* ---------------- scroll reveal ---------------- */
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); } });
  }, { threshold: .12 });
  els.forEach((el) => io.observe(el));
}

/* ---------------- misc ---------------- */
function togglePassword(btn) {
  const input = btn.parentElement.querySelector('input');
  const icon = btn.querySelector('i');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  icon.className = `fas ${show ? 'fa-eye-slash' : 'fa-eye'} text-[12.5px]`;
  btn.setAttribute('aria-pressed', String(show));
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const old = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-check"></i> Tersalin';
      setTimeout(() => { btn.innerHTML = old; }, 1600);
    }
    toast('Berhasil disalin ke clipboard.', 'success');
  }).catch(() => toast('Gagal menyalin.', 'error'));
}

function initFaq() {
  document.querySelectorAll('.faq-q').forEach((q) => {
    q.addEventListener('click', () => q.closest('.faq-item').classList.toggle('open'));
  });
}

function requireLogin() {
  if (!Store.token) { location.href = '/login'; return false; }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  initReveal();
  initFaq();
  document.querySelectorAll('.js-toggle-pass').forEach((b) =>
    b.addEventListener('click', () => togglePassword(b)));
});
