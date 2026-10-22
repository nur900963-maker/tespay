/* Dashboard shell (sidebar + topbar) — dipakai semua halaman dashboard */
function renderShell(active = 'dashboard') {
  const user = Store.user || {};
  const initial = (user.username || 'U').charAt(0).toUpperCase();

  const nav = [
    { section: 'Utama' },
    { key: 'dashboard', href: '/dashboard', icon: 'fa-gauge-high', label: 'Dashboard' },
    { key: 'deposit', href: '/deposit', icon: 'fa-arrow-down', label: 'Deposit' },
    { key: 'withdraw', href: '/withdraw', icon: 'fa-arrow-up', label: 'Penarikan' },
    { key: 'transactions', href: '/transactions', icon: 'fa-receipt', label: 'Transaksi' },
    { section: 'Integrasi' },
    { key: 'docs', href: '/docs', icon: 'fa-book-open', label: 'Dokumentasi API' },
    { key: 'webhook-logs', href: '/webhook-logs', icon: 'fa-webhook', label: 'Riwayat Webhook' },
    { section: 'Akun' },
    { key: 'profile', href: '/profile', icon: 'fa-user', label: 'Profil & API Key' }
  ];
  if (user.role === 'admin') {
    nav.splice(1, 0, { section: 'Owner' }, { key: 'admin', href: '/admin', icon: 'fa-shield-halved', label: 'Owner Panel' });
  }

  const sidebar = `
    <aside class="dash-sidebar">
      <div style="padding:1rem 1rem .75rem;">
        <a href="/" class="nav-logo">
          <img src="/icon.svg" alt="Vincent Pay"><span>Vincent Pay</span>
        </a>
      </div>
      <div style="padding:0 .6rem 1rem; flex:1; overflow-y:auto;">
        ${nav.map(n => n.section
          ? `<div class="side-section">${n.section}</div>`
          : `<a href="${n.href}" class="side-link ${active === n.key ? 'active' : ''}">
               <i class="fas ${n.icon}"></i><span>${n.label}</span>
             </a>`).join('')}
      </div>
      <div style="padding:.8rem; border-top:1px solid var(--slate-100);">
        <div style="display:flex; align-items:center; gap:.6rem;">
          <div style="width:30px; height:30px; border-radius:8px; background:var(--brand-50); color:var(--brand-600); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; line-height:1; padding-top:1px;">${initial}</div>
          <div style="min-width:0; flex:1;">
            <p style="font-size:12px; font-weight:500; color:var(--slate-800); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${user.username || 'User'}</p>
            <p style="font-size:10.5px; color:var(--slate-400); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${user.email || ''}</p>
          </div>
        </div>
        <button onclick="logout()" class="btn-secondary" style="width:100%; margin-top:.6rem; font-size:11.5px; padding:.45rem;">
          <i class="fas fa-right-from-bracket" style="font-size:10px;"></i> Keluar
        </button>
      </div>
    </aside>`;

  document.getElementById('shell').innerHTML = `
    ${sidebar}
    <div class="dash-main">
      <div class="dash-topbar">
        <button class="nav-toggle" onclick="document.getElementById('sideDrawer').classList.toggle('hidden')" style="display:inline-flex;">
          <i class="fas fa-bars"></i>
        </button>
        <div style="flex:1;">
          <p style="font-size:12.5px; font-weight:500; color:var(--slate-800);" id="topbarTitle">Dashboard</p>
        </div>
        <a href="/deposit" class="btn-primary" style="padding:.42rem .7rem; font-size:11.5px;">
          <i class="fas fa-plus" style="font-size:10px;"></i> Deposit
        </a>
      </div>

      <!-- drawer mobile -->
      <div id="sideDrawer" class="hidden" style="background:#fff; border-bottom:1px solid var(--slate-200); padding:.6rem;">
        ${nav.map(n => n.section
          ? `<div class="side-section">${n.section}</div>`
          : `<a href="${n.href}" class="side-link ${active === n.key ? 'active' : ''}"><i class="fas ${n.icon}"></i><span>${n.label}</span></a>`).join('')}
        <button onclick="logout()" class="btn-secondary" style="width:100%; margin-top:.5rem; font-size:11.5px;">Keluar</button>
      </div>

      <div class="dash-content" id="content"></div>
    </div>`;
}

function logout() {
  Store.clear();
  location.href = '/login';
}

function setTopbar(title) {
  const el = document.getElementById('topbarTitle');
  if (el) el.textContent = title;
}

function statusBadge(status) {
  const map = {
    paid: ['badge-paid', 'Lunas'],
    success: ['badge-success', 'Berhasil'],
    pending: ['badge-pending', 'Menunggu'],
    expired: ['badge-expired', 'Kedaluwarsa'],
    failed: ['badge-failed', 'Gagal'],
    processing: ['badge-pending', 'Diproses']
  };
  const [cls, label] = map[status] || ['badge-expired', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function typeBadge(type) {
  return type === 'deposit'
    ? '<span class="badge badge-deposit">Deposit</span>'
    : '<span class="badge badge-withdrawal">Penarikan</span>';
}

/** Muat user terbaru lalu render halaman. */
async function bootDashboard(active, title, render) {
  if (!Store.token) { location.href = '/login'; return; }
  try {
    const me = await api('/api/auth/me');
    Store.user = me.user;
  } catch (e) {
    return; // api() sudah redirect ke login
  }
  renderShell(active);
  setTopbar(title);
  render();
}
