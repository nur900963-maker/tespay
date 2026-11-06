/* Mesin QRIS versi browser — dipakai saat halaman dibuka tanpa server (preview statis).
   Logikanya identik dengan lib/qris.js di sisi server. */
(function (global) {
  'use strict';

  function parseTLV(data) {
    const out = [];
    let i = 0;
    const s = String(data || '');
    while (i + 4 <= s.length) {
      const tag = s.slice(i, i + 2);
      const len = parseInt(s.slice(i + 2, i + 4), 10);
      if (!/^\d{2}$/.test(tag) || isNaN(len)) break;
      i += 4;
      if (i + len > s.length) break;
      out.push([tag, s.slice(i, i + len)]);
      i += len;
    }
    return out;
  }

  function buildTLV(fields) {
    return fields.map(function (f) {
      return f[0] + String(f[1].length).padStart(2, '0') + f[1];
    }).join('');
  }

  function crc16(data) {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  function stripCRC(s) {
    const str = String(s || '').trim();
    const i = str.lastIndexOf('6304');
    return i >= 0 ? str.slice(0, i) : str;
  }

  function withCRC(body) {
    const base = stripCRC(body) + '6304';
    return base + crc16(base);
  }

  function verifyCRC(payload) {
    const s = String(payload || '').trim();
    const i = s.lastIndexOf('6304');
    if (i < 0 || s.length < i + 8) return false;
    return crc16(s.slice(0, i + 4)) === s.slice(i + 4, i + 8).toUpperCase();
  }

  function normalizeStatic(payload) {
    const s = String(payload || '').replace(/[\r\n\t]+/g, '').trim();
    if (!s) throw new Error('QRIS masih kosong');
    if (s.indexOf('000201') !== 0) throw new Error('Bukan payload QRIS (harus diawali 000201)');
    if (s.indexOf('5802ID') < 0) throw new Error('QRIS tidak memuat kode negara ID (5802ID)');
    if (!parseTLV(s).length) throw new Error('Struktur QRIS tidak terbaca');
    return s;
  }

  function toDynamic(staticPayload, amount) {
    const nominal = Math.round(Number(amount));
    if (!(nominal >= 1)) throw new Error('Nominal tidak valid');
    if (nominal > 999999999) throw new Error('Nominal terlalu besar');

    const src = normalizeStatic(staticPayload);
    const fields = parseTLV(src).filter(function (f) { return f[0] !== '63' && f[0] !== '54'; });

    const out = [];
    let placed = false;
    for (let i = 0; i < fields.length; i++) {
      const tag = fields[i][0], val = fields[i][1];
      if (tag === '01') { out.push(['01', '12']); continue; }
      out.push([tag, val]);
      if (tag === '53') { out.push(['54', String(nominal)]); placed = true; }
    }
    if (!placed) out.push(['54', String(nominal)]);
    return withCRC(buildTLV(out));
  }

  function info(payload) {
    const s = String(payload || '').trim();
    const fields = parseTLV(s);
    const map = {};
    fields.forEach(function (f) { if (!map[f[0]]) map[f[0]] = f[1]; });

    let merchant = null;
    ['26', '51'].forEach(function (tag) {
      if (merchant || !map[tag]) return;
      const sub = {};
      parseTLV(map[tag]).forEach(function (f) { if (!sub[f[0]]) sub[f[0]] = f[1]; });
      merchant = { nmid: sub['02'] || null, id: sub['01'] || null };
    });

    const amount = map['54'] ? Number(map['54']) : null;
    return {
      valid: s.indexOf('000201') === 0 && fields.length > 0,
      crc_ok: verifyCRC(s),
      type: map['01'] === '12' ? 'dynamic' : 'static',
      amount: isFinite(amount) ? amount : null,
      currency: map['53'] === '360' ? 'IDR' : (map['53'] || null),
      country: map['58'] || null,
      merchant_name: map['59'] || null,
      merchant_city: map['60'] || null,
      postal_code: map['61'] || null,
      nmid: merchant ? merchant.nmid : null,
      acquirer: merchant ? merchant.id : null,
      mcc: map['52'] || null,
      fields: fields.length,
    };
  }

  global.QRISCore = {
    parseTLV: parseTLV, buildTLV: buildTLV, crc16: crc16, withCRC: withCRC,
    verifyCRC: verifyCRC, toDynamic: toDynamic, info: info, normalizeStatic: normalizeStatic,
  };
})(window);
