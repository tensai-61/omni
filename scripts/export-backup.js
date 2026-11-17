const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');
const { writeBackup } = require('../lib/backup');
const { redact } = require('../lib/redact');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return '';
  return process.argv[index + 1];
}

const outPath = argument('--out');
const file = argument('--file');
if (!outPath) {
  console.error('Kullanım: node scripts/export-backup.js --out yedek.sql [--file yerel.db]');
  process.exit(2);
}

let database;
try {
  database = file ? new DatabaseSync(file, { readOnly: true, timeout: 5000 }) : openDatabase();
  writeBackup(database, outPath);
  console.log('Yedek yazıldı.');
} catch (error) {
  console.error(redact(error && error.message));
  process.exit(1);
} finally {
  try { database?.close(); } catch {}
}
