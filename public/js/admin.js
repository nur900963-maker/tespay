'use strict';

const VP_PROVIDERS = {
  dana: {
    title: 'DANA Merchant QRIS',
    description: 'API QRIS Acquirer MPM resmi DANA. Credential/API base URL didapat dari onboarding merchant DANA.',
    fields: [
      ['mode','Mode','select',['sandbox','production']],['api_base_url','API base URL','text'],['partner_id','X-Partner-ID / Client ID','text'],
      ['merchant_id','Merchant ID','text'],['store_id','Store ID','text'],['terminal_id','Terminal ID (opsional)','text'],['channel_id','Channel ID','text'],
      ['origin','Origin domain (opsional)','text'],['private_key_pem','Private key PEM','secretarea'],['dana_public_key_pem','DANA public key PEM (opsional)','secretarea']
    ]
  },
  shopeepay: {
    title: 'ShopeePay Merchant QRIS',
    description: 'Dynamic QR MPM resmi ShopeePay. Pastikan API products dan callback URL sudah diaktifkan di onboarding merchant.',
    fields: [
      ['mode','Mode','select',['sandbox','production']],['api_base_url','API base URL','text'],['client_id','Client ID / Partner ID','text'],
      ['client_secret','Client secret','secret'],['merchant_id','Merchant ID','text'],['store_id','External Store ID','text'],['terminal_id','Terminal ID (opsional)','text'],
      ['channel_id','Channel ID','text'],['origin','Origin domain (opsional)','text'],['private_key_pem','Private key PEM untuk token','secretarea'],['shopeepay_public_key_pem','ShopeePay public key PEM (opsional)','secretarea']
    ]
  },
  gopay: {
    title: 'GoPay / GoBiz Merchant QRIS',
    description: 'Direct GoBiz Open API: OAuth client credentials, buat transaksi QRIS, lalu query status transaksi.',
    fields: [
      ['mode','Mode','select',['sandbox','production']],['api_base_url','GoBiz API base URL','text'],['oauth_base_url','OAuth base URL','text'],
      ['client_id','Client ID','text'],['client_secret','Client secret','secret'],['scope','OAuth scope','text'],['outlet_id','Outlet ID','text'],['origin','Origin domain (opsional)','text']
    ]
  }
};
let vpAdminSettings = {};
let vpProviderSummaries = [];
let vpActiveTab = 'overview';

function vpEsc(v) { return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function vpDate(v) { return v ? fmtDate(v) : '-'; }
function vpStatus(v) { return `<span class="owner-pill">${vpEsc(({paid:'Lunas',success:'Berhasil',pending:'Pending',processing:'Diproses',failed:'Gagal',expired:'Kedaluwarsa',cancelled:'Dibatalkan',creating:'Membuat'}[v] || v || '-'))}</span>`; }
function vpButton(label, action, id, variant='btn-secondary') { return `<button class="${variant}" data-action="${vpEsc(action)}" data-id="${vpEsc(id)}">${label}</button>`; }

bootDashboard('admin', 'Owner Panel', async () => {
  if (Store.user?.role !== 'admin') {
    document.getElementById('content').innerHTML = '<div class="dash-card"><div class="dash-card-body"><h2 style="font-weight:700">Akses ditolak</h2><p style="font-size:12px;color:var(--slate-500);margin-top:.5rem">Halaman ini khusus owner/admin Vincent Pay.</p></div></div>';
    return;
  }
  const content = document.getElementById('content');
  content.innerHTML = `
    <div style="margin-bottom:1rem"><h1 style="font-size:1.2rem;font-weight:700;color:var(--slate-900)">Owner Control Center</h1><p style="font-size:12px;color:var(--slate-500);margin-top:.3rem">Kontrol credential merchant, biaya, transaksi, user, dan antrean penarikan.</p></div>
    <div class="owner-tabs" role="tablist">
      ${[['overview','Ringkasan'],['providers','Integrasi Merchant'],['fees','Fee & Limit'],['transactions','Transaksi'],['withdrawals','Withdrawal'],['users','Pengguna'],['audit','Audit Log']].map(([id,label])=>`<button class="owner-tab ${id===vpActiveTab?'active':''}" data-tab="${id}">${label}</button>`).join('')}
    </div>
    <div id="ownerPanel"><div class="dash-card"><div class="dash-card-body">Memuat data owner…</div></div></div>`;
  content.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
    vpActiveTab = btn.dataset.tab; content.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===vpActiveTab)); vpLoadTab();
  }));
  content.addEventListener('click', vpHandleAction);
  await vpLoadTab();
  if (window.__vpOwnerRefresh) clearInterval(window.__vpOwnerRefresh);
  window.__vpOwnerRefresh = setInterval(() => { if (!document.hidden && vpActiveTab === 'overview') vpLoadTab(); }, 15000);
});

async function vpLoadBase() {
  const d = await api('/api/admin/settings');
  vpAdminSettings = d.settings || {};
  vpProviderSummaries = d.providers || [];
}
async function vpLoadTab() {
  const mount = document.getElementById('ownerPanel');
  if (!mount) return;
  mount.innerHTML = '<div class="dash-card"><div class="dash-card-body" style="font-size:12px;color:var(--slate-500)"><i class="fas fa-spinner fa-spin"></i> Memuat…</div></div>';
  try {
    await vpLoadBase();
    if (vpActiveTab === 'overview') return await vpOverview(mount);
    if (vpActiveTab === 'providers') return vpProviders(mount);
    if (vpActiveTab === 'fees') return vpFees(mount);
    if (vpActiveTab === 'transactions') return await vpTransactions(mount);
    if (vpActiveTab === 'withdrawals') return await vpWithdrawals(mount);
    if (vpActiveTab === 'users') return await vpUsers(mount);
    if (vpActiveTab === 'audit') return await vpAudit(mount);
  } catch (e) { mount.innerHTML = `<div class="dash-card"><div class="dash-card-body" style="color:#b91c1c;font-size:12px">${vpEsc(e.message)}</div></div>`; }
}
async function vpOverview(mount) {
  const d = await api('/api/admin/overview'); const t = d.totals || {};
  mount.innerHTML = `<div class="owner-grid">
    ${[['Pengguna',Number(t.users||0).toLocaleString('id-ID')],['Total transaksi',Number(t.transactions||0).toLocaleString('id-ID')],['Menunggu pembayaran',Number(t.pending_transactions||0).toLocaleString('id-ID')],['Antrean withdrawal',Number(t.pending_withdrawals||0).toLocaleString('id-ID')],['Volume pembayaran',rupiah(t.paid_volume)],['Fee QRIS tercatat',rupiah(t.qris_fee_volume)],['Pembayaran hari ini',Number(t.paid_today||0).toLocaleString('id-ID')]].map(([k,v])=>`<div class="owner-kpi"><div class="k">${k}</div><div class="v">${vpEsc(v)}</div></div>`).join('')}
    </div><div class="owner-card"><div class="owner-card-head"><span>Transaksi terbaru</span><button class="btn-secondary" data-tab="transactions">Lihat semua</button></div><div class="owner-table-wrap"><table class="owner-table"><thead><tr><th>Reference</th><th>User</th><th>Provider</th><th>Nominal</th><th>Status</th><th>Waktu</th></tr></thead><tbody>${(d.recent||[]).map(x=>`<tr><td>${vpEsc(x.reference)}</td><td>${vpEsc(x.username)}</td><td>${vpEsc(x.channel||'-')}</td><td>${rupiah(x.total)}</td><td>${vpStatus(x.status)}</td><td>${vpDate(x.created_at)}</td></tr>`).join('')||'<tr><td colspan="6">Belum ada transaksi.</td></tr>'}</tbody></table></div></div>
    <div class="owner-card"><div class="owner-card-head">Status integrasi merchant</div><div class="owner-card-body"><div class="owner-grid" style="margin:0">${vpProviderSummaries.map(p=>`<div class="owner-kpi"><div class="k">${vpEsc(p.label)}</div><div class="v" style="font-size:1rem">${p.enabled&&p.configured?'Aktif':'Belum siap'}</div><div class="owner-note" style="margin-top:.35rem">Mode: ${vpEsc(p.mode||'sandbox')} · Tes terakhir: ${vpEsc(p.last_test_status||'belum dites')}</div></div>`).join('')}</div></div></div>`;
  mount.querySelector('[data-tab="transactions"]')?.addEventListener('click',()=>{vpActiveTab='transactions';document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===vpActiveTab));vpLoadTab();});
}
function vpProviders(mount) {
  const cards = Object.keys(VP_PROVIDERS).map(id => {
    const spec = VP_PROVIDERS[id]; const p = vpProviderSummaries.find(x=>x.provider===id)||{fields:{},enabled:false,configured:false,mode:'sandbox'};
    const fields = spec.fields.map(([key,label,type,opts]) => {
      const val = p.fields?.[key]; const secret = ['secret','secretarea'].includes(type);
      const inputValue = (typeof val === 'string' || typeof val === 'number') && !secret ? val : '';
      const placeholder = secret ? (val ? 'Sudah tersimpan terenkripsi — kosongkan untuk mempertahankan' : 'Isi credential merchant') : (key.endsWith('_url')?'https://alamat-resmi-provider': '');
      const ctrl = type === 'select' ? `<select name="${key}" data-provider-field>${opts.map(o=>`<option value="${o}" ${(inputValue||'sandbox')===o?'selected':''}>${o}</option>`).join('')}</select>` : type === 'secretarea' ? `<textarea name="${key}" data-provider-field autocomplete="new-password" placeholder="${vpEsc(placeholder)}"></textarea>` : `<input name="${key}" data-provider-field type="${secret?'password':'text'}" value="${vpEsc(inputValue)}" autocomplete="${secret?'new-password':'off'}" placeholder="${vpEsc(placeholder)}">`;
      return `<div class="owner-field"><label>${vpEsc(label)}</label>${ctrl}</div>`;
    }).join('');
    return `<form class="owner-card provider-form" data-provider="${id}"><div class="owner-card-head"><div><div>${vpEsc(spec.title)}</div><div class="owner-note" style="font-weight:400;margin-top:.3rem">${vpEsc(spec.description)}</div></div><label style="display:flex;align-items:center;gap:.4rem;font-weight:500"><input type="checkbox" name="enabled" ${p.enabled?'checked':''}> Aktifkan</label></div><div class="owner-card-body"><div class="owner-fields">${fields}</div><p class="owner-note" style="margin-top:.85rem">Mode sandbox/production di sini hanya penanda. Masukkan Base URL yang diberikan provider untuk mode yang dipilih. Credential dienkripsi server-side dan tidak ditampilkan kembali.</p><div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem"><button class="btn-primary" type="submit"><i class="fas fa-floppy-disk"></i> Simpan konfigurasi</button><button class="btn-secondary" type="button" data-action="test-provider" data-id="${id}"><i class="fas fa-plug"></i> Tes credential</button><span class="owner-note" style="align-self:center">${p.configured?'Field wajib terisi':'Belum lengkap'} · ${p.last_test_status||'belum dites'}${p.last_test_at?' · '+vpDate(p.last_test_at):''}</span></div></div></form>`;
  }).join('');
  mount.innerHTML = `<div class="owner-card"><div class="owner-card-head">Integrasi API langsung merchant</div><div class="owner-card-body"><p class="owner-note">Vincent Pay tidak mengirim transaksi lewat gateway aggregator lain. Setiap adapter memanggil API provider yang dipilih. Gunakan hanya URL dan credential dari dashboard/kontrak merchant resmi. Jangan memasukkan password akun merchant atau token sesi browser.</p><p class="owner-note" style="margin-top:.4rem"><strong>Penting:</strong> DANA membutuhkan signing key/certificate sesuai onboarding. ShopeePay membutuhkan client key/secret dan key pair resmi. GoBiz membutuhkan client credentials, scope payment, dan outlet ID.</p></div></div>${cards}`;
  mount.querySelectorAll('.provider-form').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault(); const id=form.dataset.provider; const payload={enabled:form.elements.enabled.checked};
    form.querySelectorAll('[data-provider-field]').forEach(el=>{ if(el.value!=='' || !['password'].includes(el.type)) payload[el.name]=el.value; });
    const submit=form.querySelector('button[type="submit"]');submit.disabled=true;
    try { const d=await api(`/api/admin/providers/${id}`,{method:'PUT',body:payload});toast(d.message||'Konfigurasi disimpan.','success');await vpLoadTab(); }
    catch(err){toast(err.message,'error');} finally{submit.disabled=false;}
  }));
}
function vpFees(mount) {
  const s=vpAdminSettings;
  const fields=[['qris_fee','Fee tetap buat QRIS (Rp)','number'],['qris_fee_percent','Fee persentase (%)','number'],['deposit_min','Nominal deposit minimum (Rp)','number'],['deposit_max','Nominal deposit maksimum (Rp)','number'],['withdrawal_fee_dana','Fee withdrawal DANA (Rp)','number'],['withdrawal_fee_gopay','Fee withdrawal GoPay (Rp)','number'],['withdrawal_fee_shopeepay','Fee withdrawal ShopeePay (Rp)','number'],['withdrawal_fee_manual','Fee withdrawal manual (Rp)','number'],['withdrawal_min','Withdrawal minimum (Rp)','number'],['withdrawal_max','Withdrawal maksimum (Rp)','number'],['invoice_expiry_minutes','Invoice berlaku (menit)','number']];
  mount.innerHTML=`<form id="feesForm" class="owner-card"><div class="owner-card-head">Fee & batas transaksi</div><div class="owner-card-body"><div class="owner-fields">${fields.map(([k,l,t])=>`<div class="owner-field"><label>${l}</label><input name="${k}" type="${t}" min="0" step="${k==='qris_fee_percent'?'0.01':'1'}" required value="${vpEsc(s[k]??0)}"></div>`).join('')}<div class="owner-field"><label>Default provider QRIS</label><select name="default_provider">${[['dana','DANA Merchant'],['shopeepay','ShopeePay Merchant'],['gopay','GoPay / GoBiz']].map(([v,l])=>`<option value="${v}" ${s.default_provider===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="owner-field"><label>Nama brand</label><input name="brand_name" value="${vpEsc(s.brand_name||'Vincent Pay')}"></div></div><div style="display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0"><label style="font-size:12px"><input name="withdrawals_enabled" type="checkbox" ${Number(s.withdrawals_enabled)?'checked':''}> Terima permintaan withdrawal</label><label style="font-size:12px"><input name="public_api_enabled" type="checkbox" ${Number(s.public_api_enabled)?'checked':''}> Aktifkan public API</label></div><p class="owner-note">Fee hanya mengatur biaya platform di invoice Vincent Pay; fee provider dan kewajiban merchant tetap mengikuti kontrak provider. Perubahan diterapkan pada transaksi yang dibuat setelah penyimpanan.</p><button class="btn-primary" type="submit" style="margin-top:1rem"><i class="fas fa-floppy-disk"></i> Simpan fee & limit</button></div></form>`;
  mount.querySelector('#feesForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const settings={};for(const [k,v] of new FormData(f).entries()) settings[k]=v;f.querySelectorAll('input[type=checkbox]').forEach(x=>settings[x.name]=x.checked);for(const k of Object.keys(settings))if(!['default_provider','brand_name','withdrawals_enabled','public_api_enabled'].includes(k))settings[k]=Number(settings[k]);try{const d=await api('/api/admin/settings',{method:'PUT',body:{settings}});toast(d.message||'Pengaturan disimpan.','success');await vpLoadTab()}catch(err){toast(err.message,'error')}});
}
async function vpTransactions(mount) {
  const d=await api('/api/admin/transactions?limit=100');
  mount.innerHTML=`<div class="owner-card"><div class="owner-card-head">Semua transaksi <button class="btn-secondary" data-action="refresh">Refresh</button></div><div class="owner-table-wrap"><table class="owner-table"><thead><tr><th>Reference</th><th>User</th><th>Tipe</th><th>Provider / tujuan</th><th>Nominal</th><th>Fee</th><th>Total</th><th>Status</th><th>Dibuat</th></tr></thead><tbody>${(d.data||[]).map(x=>`<tr><td>${vpEsc(x.reference)}<div class="owner-note">${vpEsc(x.id)}</div></td><td>${vpEsc(x.username)}<div class="owner-note">${vpEsc(x.email)}</div></td><td>${vpEsc(x.type)}</td><td>${vpEsc(x.channel||'-')}${x.account_number?`<div class="owner-note">${vpEsc(x.account_number)} · ${vpEsc(x.account_name||'')}</div>`:''}</td><td>${rupiah(x.amount)}</td><td>${rupiah(x.fee)}</td><td>${rupiah(x.total)}</td><td>${vpStatus(x.status)}</td><td>${vpDate(x.created_at)}</td></tr>`).join('')||'<tr><td colspan="9">Belum ada transaksi.</td></tr>'}</tbody></table></div></div>`;
}
async function vpWithdrawals(mount) {
  const d=await api('/api/admin/withdrawals?status=open');
  mount.innerHTML=`<div class="owner-card"><div class="owner-card-head">Antrean withdrawal <button class="btn-secondary" data-action="refresh">Refresh</button></div><div class="owner-card-body"><p class="owner-note">Withdrawal sekarang diproses manual. Tombol Setujui hanya mengubah status menjadi Diproses. Transfer uang secara nyata melalui kanal merchant, lalu pilih Tandai paid. Jangan tandai paid sebelum transfer benar-benar selesai.</p></div><div class="owner-table-wrap"><table class="owner-table"><thead><tr><th>Reference</th><th>User</th><th>Tujuan</th><th>Jumlah</th><th>Fee</th><th>Total dipotong</th><th>Status</th><th>Waktu</th><th>Aksi</th></tr></thead><tbody>${(d.data||[]).map(x=>`<tr><td>${vpEsc(x.reference)}</td><td>${vpEsc(x.username)}<div class="owner-note">${vpEsc(x.email)}</div></td><td>${vpEsc(x.channel)} · ${vpEsc(x.account_number)}<div class="owner-note">${vpEsc(x.account_name)}</div></td><td>${rupiah(x.amount)}</td><td>${rupiah(x.fee)}</td><td>${rupiah(x.total)}</td><td>${vpStatus(x.status)}</td><td>${vpDate(x.created_at)}</td><td><div class="owner-actions">${x.status==='pending'?vpButton('Setujui','withdraw-approve',x.id,'btn-primary'):''}${x.status==='processing'?vpButton('Tandai paid','withdraw-paid',x.id,'btn-primary'):''}${['pending','processing'].includes(x.status)?vpButton('Tolak/refund','withdraw-reject',x.id):''}</div></td></tr>`).join('')||'<tr><td colspan="9">Tidak ada withdrawal pending atau processing.</td></tr>'}</tbody></table></div></div>`;
}
async function vpUsers(mount) {
  const d=await api('/api/admin/users?limit=150');
  mount.innerHTML=`<div class="owner-card"><div class="owner-card-head">Pengguna terdaftar <button class="btn-secondary" data-action="refresh">Refresh</button></div><div class="owner-table-wrap"><table class="owner-table"><thead><tr><th>User</th><th>Role</th><th>Saldo</th><th>Pending</th><th>Status</th><th>Bergabung</th><th>Aksi</th></tr></thead><tbody>${(d.data||[]).map(x=>`<tr><td>${vpEsc(x.username)}<div class="owner-note">${vpEsc(x.email)}</div></td><td>${vpEsc(x.role)}</td><td>${rupiah(x.balance)}</td><td>${rupiah(x.pending_balance)}</td><td>${vpStatus(x.status)}</td><td>${vpDate(x.created_at)}</td><td>${x.role!=='admin'?vpButton(x.status==='active'?'Suspend':'Aktifkan',x.status==='active'?'user-suspend':'user-activate',x.id):'<span class="owner-pill">Owner</span>'}</td></tr>`).join('')||'<tr><td colspan="7">Belum ada pengguna.</td></tr>'}</tbody></table></div></div>`;
}
async function vpAudit(mount) {
  const d=await api('/api/admin/audit-logs');
  mount.innerHTML=`<div class="owner-card"><div class="owner-card-head">Audit log owner</div><div class="owner-table-wrap"><table class="owner-table"><thead><tr><th>Aksi</th><th>Target</th><th>Detail</th><th>Waktu</th></tr></thead><tbody>${(d.data||[]).map(x=>`<tr><td>${vpEsc(x.action)}</td><td>${vpEsc(x.target_type||'')} ${vpEsc(x.target_id||'')}</td><td><code>${vpEsc(JSON.stringify(x.details||{}))}</code></td><td>${vpDate(x.created_at)}</td></tr>`).join('')||'<tr><td colspan="4">Belum ada log.</td></tr>'}</tbody></table></div></div>`;
}

async function vpHandleAction(event) {
  const button=event.target.closest('[data-action]'); if(!button)return;
  const action=button.dataset.action,id=button.dataset.id; button.disabled=true;
  try {
    if(action==='test-provider') { const d=await api(`/api/admin/providers/${id}/test`,{method:'POST',body:{}});toast(d.message||'Tes selesai.',d.success?'success':'error');await vpLoadTab();return; }
    if(action==='refresh') { await vpLoadTab();return; }
    if(action.startsWith('withdraw-')) { const map={'withdraw-approve':'approve','withdraw-paid':'paid','withdraw-reject':'reject'};const actionName=map[action];let reason='';if(actionName==='paid'&&!confirm('Pastikan transfer ke rekening/e-wallet tujuan SUDAH berhasil sebelum melanjutkan. Tandai paid?'))return;if(actionName==='approve'&&!confirm('Setujui withdrawal dan pindahkan ke status Diproses?'))return;if(actionName==='reject'){reason=prompt('Alasan penolakan (saldo akan dikembalikan):','Data tujuan perlu diperbaiki')??null;if(reason===null)return;}const d=await api(`/api/admin/withdrawals/${encodeURIComponent(id)}/review`,{method:'POST',body:{action:actionName,reason}});toast(d.message||'Status diperbarui.','success');await vpLoadTab();return; }
    if(action==='user-suspend'||action==='user-activate') {const status=action==='user-suspend'?'suspended':'active';if(!confirm(status==='suspended'?'Suspend pengguna ini?':'Aktifkan kembali pengguna ini?'))return;const d=await api(`/api/admin/users/${encodeURIComponent(id)}/status`,{method:'POST',body:{status}});toast(d.message||'Status pengguna diperbarui.','success');await vpLoadTab();return;}
  } catch(e) { toast(e.message,'error'); } finally {button.disabled=false;}
}
