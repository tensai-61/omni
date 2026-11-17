const fs = require('fs');
const { spawnSync } = require('child_process');

const HEADER = '-- OMNI_BACKUP 1';
const SALTED_HEADER = 'Salted__';
const EXCLUDED_TABLES = new Set([
  'user_sessions',
  'verification_codes',
  'pending_registrations',
  'verification_sends',
  'app_secrets',
  'totp_key'
]);
const EMPTY_SENSITIVE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_secrets (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS totp_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL,
    avatar_data TEXT,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    device_id TEXT,
    registration_key TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_registrations_email ON pending_registrations(email);
  CREATE TABLE IF NOT EXISTS verification_sends (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS verification_sends_email_sent ON verification_sends(email, sent_at);
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Yedek sayısal değeri geçersiz');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function excludedObject(row) {
  return EXCLUDED_TABLES.has(row.name) || EXCLUDED_TABLES.has(row.tbl_name);
}

function listTables(database) {
  return database.prepare(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'libsql_%'
    ORDER BY name
  `).all()
    .filter(row => row.name !== 'sqlite_sequence' && !excludedObject(row))
    .map(row => row.name);
}

function schemaStatements(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'libsql_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name
  `).all().filter(row => !excludedObject(row));
}

function exportSql(database) {
  const tables = listTables(database);
  const counts = {};
  const lines = [
    HEADER,
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;'
  ];
  for (const row of schemaStatements(database)) {
    lines.push(`${row.sql};`);
  }
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    const names = columns.map(column => column.name);
    const rows = database.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
    counts[table] = rows.length;
    const columnSql = names.map(quoteIdent).join(', ');
    for (const row of rows) {
      const values = names.map(name => sqlLiteral(row[name])).join(', ');
      lines.push(`INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES (${values});`);
    }
  }
  lines.push('COMMIT;');
  lines.push('PRAGMA foreign_keys = ON;');
  lines.push(`-- OMNI_BACKUP_MANIFEST ${JSON.stringify({ version: 1, tables: counts })}`);
  lines.push('');
  return lines.join('\n');
}

function writeBackup(database, outPath) {
  const sql = exportSql(database);
  fs.writeFileSync(outPath, sql);
  return sql;
}

function manifestFrom(sql) {
  const match = String(sql).match(/^-- OMNI_BACKUP_MANIFEST (\{.*\})\s*$/m);
  if (!match) throw new Error('Yedek bildirimi yok');
  const parsed = JSON.parse(match[1]);
  if (!parsed || parsed.version !== 1 || !parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('Yedek bildirimi geçersiz');
  }
  return parsed;
}

function opensslEnc(args, passphrase) {
  const result = spawnSync('openssl', args, {
    env: { ...process.env, BACKUP_PASSPHRASE: passphrase },
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error('Yedek şifresi uygulanamadı');
  return result.stdout;
}

function encryptBackupFile(plainPath, encryptedPath, passphrase) {
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE yok');
  opensslEnc([
    'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
    '-pass', 'env:BACKUP_PASSPHRASE',
    '-in', plainPath,
    '-out', encryptedPath
  ], passphrase);
}

function decryptBackupFile(encryptedPath, passphrase) {
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE yok. Şifreli yedek açılamadı.');
  return opensslEnc([
    'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
    '-pass', 'env:BACKUP_PASSPHRASE',
    '-in', encryptedPath
  ], passphrase).toString('utf8');
}

function readBackupText(inputPath, passphrase = process.env.BACKUP_PASSPHRASE || '') {
  const bytes = fs.readFileSync(inputPath);
  if (bytes.subarray(0, SALTED_HEADER.length).toString('utf8') === SALTED_HEADER) {
    return decryptBackupFile(inputPath, String(passphrase || '').trim());
  }
  return bytes.toString('utf8');
}

function verifyRestored(database, manifest) {
  database.exec(EMPTY_SENSITIVE_SCHEMA);
  const problems = [];
  for (const table of EXCLUDED_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdent(table)}`).get();
    if (Number(row.total) !== 0) problems.push(`${table} boş olmalı`);
  }
  for (const [table, expected] of Object.entries(manifest.tables)) {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdent(table)}`).get();
    if (Number(row.total) !== Number(expected)) {
      problems.push(`${table}: ${row.total} satır, bildirim ${expected}`);
    }
  }
  const checks = database.prepare('PRAGMA foreign_key_check').all();
  if (checks.length) problems.push('foreign_key_check başarısız');
  const cards = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'online_cards'`).get();
  if (cards) {
    const trigger = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'online_cards_admin_frozen'
    `).get();
    if (!trigger || !String(trigger.sql).includes('admin card cannot move')) {
      problems.push('yönetici kartı tetikleyicisi yok');
    }
  }
  const balances = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_balances'`).get();
  if (balances) {
    const negative = database.prepare('SELECT COUNT(*) AS total FROM user_balances WHERE coins < 0 OR omni_dolar < 0').get();
    if (Number(negative.total) !== 0) problems.push('eksi bakiye var');
  }
  if (problems.length) throw new Error(`Geri yükleme doğrulanamadı: ${problems.join('; ')}`);
}

function restoreBackup(sqlText, destPath) {
  if (!String(sqlText).startsWith(HEADER)) throw new Error('Bu dosya Omni yedeği değil');
  if (fs.existsSync(destPath)) throw new Error('Hedef veritabanı zaten var. Yeni bir dosya yolu verin.');
  const manifest = manifestFrom(sqlText);
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(destPath);
  try {
    database.exec(sqlText);
    verifyRestored(database, manifest);
  } catch (error) {
    try { database.close(); } catch {}
    try { fs.rmSync(destPath, { force: true }); } catch {}
    throw error;
  }
  database.close();
  return manifest;
}

module.exports = {
  HEADER,
  SALTED_HEADER,
  EXCLUDED_TABLES,
  exportSql,
  writeBackup,
  restoreBackup,
  verifyRestored,
  manifestFrom,
  encryptBackupFile,
  decryptBackupFile,
  readBackupText
};
