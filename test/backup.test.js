const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { encryptBackupFile, EXCLUDED_TABLES, SALTED_HEADER } = require('../lib/backup');

const root = path.join(__dirname, '..');

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => resolve({ code, out, err }));
  });
}

test('restore script loads a backup into a fresh database and checks it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-backup-'));
  const source = path.join(dir, 'source.db');
  const dump = path.join(dir, 'backup.sql');
  const restored = path.join(dir, 'restored.db');
  const database = new DatabaseSync(source);
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    );
    CREATE TABLE user_balances (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      coins INTEGER NOT NULL CHECK (coins >= 0),
      omni_dolar INTEGER NOT NULL CHECK (omni_dolar >= 0)
    );
    CREATE TABLE online_cards (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      admin_card INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER online_cards_admin_frozen
    BEFORE UPDATE ON online_cards
    WHEN OLD.admin_card = 1 AND (NEW.user_id != OLD.user_id OR NEW.admin_card != 1)
    BEGIN
      SELECT RAISE(ABORT, 'admin card cannot move');
    END;
    INSERT INTO users (id, email) VALUES (1, 'oyuncu@example.com');
    INSERT INTO user_balances (user_id, coins, omni_dolar) VALUES (1, 40, 15);
    INSERT INTO online_cards (id, user_id, admin_card) VALUES (7, 1, 1);
  `);
  database.close();
  const exported = await run(['scripts/export-backup.js', '--file', source, '--out', dump]);
  assert.equal(exported.code, 0, exported.err);
  assert.equal(fs.readFileSync(dump, 'utf8').includes('oyuncu@example.com'), true);
  const loaded = await run(['scripts/restore-backup.js', '--in', dump, '--out', restored]);
  assert.equal(loaded.code, 0, loaded.err);
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT email FROM users WHERE id = 1').get().email, 'oyuncu@example.com');
  assert.equal(check.prepare('SELECT omni_dolar FROM user_balances').get().omni_dolar, 15);
  assert.throws(() => check.prepare('UPDATE online_cards SET user_id = 2 WHERE id = 7').run(), /admin card/);
  check.close();
  const again = await run(['scripts/restore-backup.js', '--in', dump, '--out', restored]);
  assert.notEqual(again.code, 0);
  const tamperedPath = path.join(dir, 'tampered.sql');
  const tampered = fs.readFileSync(dump, 'utf8').replace('"users":1', '"users":99');
  fs.writeFileSync(tamperedPath, tampered);
  const badDest = path.join(dir, 'bad.db');
  const failed = await run(['scripts/restore-backup.js', '--in', tamperedPath, '--out', badDest]);
  assert.notEqual(failed.code, 0);
  assert.equal(fs.existsSync(badDest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploaded backup is encrypted and omits sessions, verification, and app secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-backup-enc-'));
  const source = path.join(dir, 'source.db');
  const dump = path.join(dir, 'backup.sql');
  const encrypted = path.join(dir, 'backup.sql.enc');
  const restored = path.join(dir, 'restored.db');
  const passphrase = 'test-backup-passphrase-not-stored';
  const database = new DatabaseSync(source);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE user_balances (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      coins INTEGER NOT NULL CHECK (coins >= 0),
      omni_dolar INTEGER NOT NULL CHECK (omni_dolar >= 0)
    );
    CREATE TABLE app_secrets (id INTEGER PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE totp_key (id INTEGER PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE verification_codes (
      user_id INTEGER PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL
    );
    CREATE TABLE pending_registrations (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      registration_key TEXT NOT NULL,
      code_hash TEXT NOT NULL
    );
    CREATE TABLE verification_sends (id INTEGER PRIMARY KEY, email TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE TABLE user_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE password_reset_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE password_reset_sends (id INTEGER PRIMARY KEY, email TEXT NOT NULL, sent_at INTEGER NOT NULL);
    INSERT INTO users (id, email) VALUES (1, 'oyuncu@example.com');
    INSERT INTO user_balances (user_id, coins, omni_dolar) VALUES (1, 3, 4);
    INSERT INTO app_secrets (id, secret) VALUES (1, 'app-secret-row-value');
    INSERT INTO totp_key (id, secret) VALUES (1, 'totp-key-secret-row');
    INSERT INTO verification_codes (user_id, code_hash, expires_at, attempts, last_sent_at)
      VALUES (1, 'verify-code-secret-row', 1, 0, 1);
    INSERT INTO pending_registrations (id, email, registration_key, code_hash)
      VALUES (1, 'pending@example.com', 'pending-secret-row', 'pending-code-secret-row');
    INSERT INTO verification_sends (id, email, sent_at) VALUES (1, 'verify-send-secret@example.com', 1);
    INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ('session-secret-row-token', 1, 1);
    INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ('reset-secret-row-token', 1, 1);
    INSERT INTO password_reset_sends (id, email, sent_at) VALUES (1, 'reset-send-secret@example.com', 1);
  `);
  database.close();
  const exported = await run(['scripts/export-backup.js', '--file', source, '--out', dump]);
  assert.equal(exported.code, 0, exported.err);
  const sql = fs.readFileSync(dump, 'utf8');
  for (const table of EXCLUDED_TABLES) assert.equal(sql.includes(table), false, table);
  for (const secret of [
    'app-secret-row-value',
    'totp-key-secret-row',
    'verify-code-secret-row',
    'pending-secret-row',
    'pending-code-secret-row',
    'verify-send-secret@example.com',
    'session-secret-row-token',
    'reset-secret-row-token',
    'reset-send-secret@example.com'
  ]) {
    assert.equal(sql.includes(secret), false, secret);
  }
  assert.equal(sql.includes('oyuncu@example.com'), true);
  encryptBackupFile(dump, encrypted, passphrase);
  const bytes = fs.readFileSync(encrypted);
  assert.equal(bytes.subarray(0, 8).toString('utf8'), SALTED_HEADER);
  const cipherText = bytes.toString('latin1');
  assert.equal(cipherText.includes('CREATE TABLE'), false);
  assert.equal(cipherText.includes('INSERT'), false);
  for (const table of EXCLUDED_TABLES) assert.equal(cipherText.includes(table), false, table);
  const loaded = await run(
    ['scripts/restore-backup.js', '--in', encrypted, '--out', restored],
    { BACKUP_PASSPHRASE: passphrase }
  );
  assert.equal(loaded.code, 0, loaded.err);
  assert.equal(loaded.err.includes(passphrase), false);
  assert.equal(loaded.out.includes(passphrase), false);
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT email FROM users WHERE id = 1').get().email, 'oyuncu@example.com');
  for (const table of EXCLUDED_TABLES) {
    const row = check.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get();
    assert.equal(row.total, 0, table);
  }
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
