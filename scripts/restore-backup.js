const { readBackupText, restoreBackup } = require('../lib/backup');
const { redact } = require('../lib/redact');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return '';
  return process.argv[index + 1];
}

const input = argument('--in');
const dest = argument('--out');
if (!input || !dest) {
  console.error('Kullanım: node scripts/restore-backup.js --in yedek.sql --out yeni.db');
  process.exit(2);
}

try {
  const sql = readBackupText(input);
  const manifest = restoreBackup(sql, dest);
  const tables = Object.keys(manifest.tables).length;
  console.log(`Geri yükleme doğrulandı. ${tables} tablo kontrol edildi.`);
} catch (error) {
  console.error(redact(error && error.message));
  process.exit(1);
}
