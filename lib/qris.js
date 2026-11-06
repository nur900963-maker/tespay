// QRIS (EMVCo) helper: parse TLV, hitung CRC16, ubah QRIS statis -> dinamis, baca info merchant.
// Dipakai untuk Create QRIS dan untuk memeriksa hasil scan QRIS di browser.

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
  return fields.map(([tag, val]) => tag + String(val.length).padStart(2, '0') + val).join('');
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

const stripCRC = s => {
  const str = String(s || '').trim();
  const i = str.lastIndexOf('6304');
  return i >= 0 ? str.slice(0, i) : str;
};

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
  // Hanya buang spasi di ujung dan karakter baris baru. Spasi di dalam nama merchant HARUS dipertahankan.
  const s = String(payload || '').replace(/[\r\n\t]+/g, '').trim();
  if (!s) throw Object.assign(new Error('QRIS masih kosong'), { status: 400 });
  if (!s.startsWith('000201')) throw Object.assign(new Error('Bukan payload QRIS (harus diawali 000201)'), { status: 400 });
  if (!s.includes('5802ID')) throw Object.assign(new Error('QRIS tidak memuat kode negara ID (5802ID)'), { status: 400 });
  const fields = parseTLV(s);
  if (!fields.length) throw Object.assign(new Error('Struktur QRIS tidak terbaca'), { status: 400 });
  return s;
}

// QRIS statis -> dinamis: tag 01 jadi 12, tag 54 diisi nominal, CRC dihitung ulang.
function toDynamic(staticPayload, amount) {
  const nominal = Math.round(Number(amount));
  if (!(nominal >= 1)) throw Object.assign(new Error('Nominal tidak valid'), { status: 400 });
  if (nominal > 999999999) throw Object.assign(new Error('Nominal terlalu besar'), { status: 400 });

  const src = normalizeStatic(staticPayload);
  const fields = parseTLV(src).filter(([tag]) => tag !== '63' && tag !== '54');

  const out = [];
  let amountPlaced = false;
  for (const [tag, val] of fields) {
    if (tag === '01') { out.push(['01', '12']); continue; }
    out.push([tag, val]);
    if (tag === '53') { out.push(['54', String(nominal)]); amountPlaced = true; }
  }
  if (!amountPlaced) out.push(['54', String(nominal)]);

  return withCRC(buildTLV(out));
}

function info(payload) {
  const s = String(payload || '').trim();
  const fields = parseTLV(s);
  const map = {};
  for (const [tag, val] of fields) if (!map[tag]) map[tag] = val;

  let merchant = null;
  if (map['26']) {
    const sub = parseTLV(map['26']);
    const sm = {};
    for (const [t, v] of sub) if (!sm[t]) sm[t] = v;
    merchant = { nmid: sm['02'] || null, id: sm['01'] || null, criteria: sm['00'] || null };
  }
  if (!merchant && map['51']) {
    const sub = parseTLV(map['51']);
    const sm = {};
    for (const [t, v] of sub) if (!sm[t]) sm[t] = v;
    merchant = { nmid: sm['02'] || null, id: sm['01'] || null, criteria: sm['00'] || null };
  }

  const amount = map['54'] ? Number(map['54']) : null;
  return {
    valid: s.startsWith('000201') && fields.length > 0,
    crc_ok: verifyCRC(s),
    type: map['01'] === '12' ? 'dynamic' : 'static',
    amount: Number.isFinite(amount) ? amount : null,
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

module.exports = { parseTLV, buildTLV, crc16, withCRC, verifyCRC, toDynamic, info, normalizeStatic };
