// Nomor HP Indonesia. Terima 08xx / 628xx / +628xx, hasilnya selalu format +628xx.
// national = tanpa 0 dan tanpa 62 (dipakai GoBiz bersama country_code 62).
module.exports = function normPhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('62')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (!/^8\d{8,11}$/.test(d)) {
    const e = new Error('Nomor HP harus format +628xxxxxxxxx (boleh ditulis 08xxxxxxxxx)');
    e.status = 400; throw e;
  }
  return { national: d, e164: '62' + d, plus: '+62' + d };
};
