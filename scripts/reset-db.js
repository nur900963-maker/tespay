// Hanya untuk reset SQLite lokal. Tidak berjalan jika DATABASE_URL terpasang.
'use strict';
const fs = require('fs');
const path = require('path');
if (process.env.DATABASE_URL) {
  console.error('Reset database diblokir saat DATABASE_URL aktif. Kelola database production secara manual.');
  process.exit(1);
}
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
for (const file of ['vincent-pay.db','vincent-pay.db-wal','vincent-pay.db-shm']) {
  const target = path.join(dir,file);
  if (fs.existsSync(target)) { fs.unlinkSync(target); console.log('Dihapus:', target); }
}
require('../db').initDb().then(()=>{console.log('Database Vincent Pay dibuat ulang. Admin hanya dibuat jika ADMIN_EMAIL dan ADMIN_PASSWORD telah diatur.');process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
