const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { installRanks } = require('../lib/ranks');

const root = path.join(__dirname, '..');
const workerPath = path.join(root, 'scripts', 'totp-fail-worker.js');
const ranksPath = path.join(root, 'lib', 'ranks.js');

function prepare(database) {
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO users (id, email, username, role, created_at)
    VALUES (1, 'a@b.co', 'A', 'user', '2026-11-13T00:00:00.000Z')
  `).run();
  installRanks(database, '');
  database.prepare(`
    INSERT INTO user_security (user_id, totp_enabled, totp_failures, mute_permanent)
    VALUES (1, 1, 0, 0)
  `).run();
}

function once(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    const messages = [];
    worker.on('message', message => messages.push(message));
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code) reject(new Error(`worker ${code}`));
      else resolve(messages[0]);
    });
  });
}

async function assertLock(database) {
  const results = await Promise.all(Array.from({ length: 20 }, () => once(database.workerData)));
  const row = database.handle.prepare('SELECT totp_failures, totp_locked_until FROM user_security WHERE user_id = 1').get();
  assert.equal(Number(row.totp_failures), 5, JSON.stringify(results));
  assert.ok(Number(row.totp_locked_until) > Date.now());
  assert.equal(results.filter(item => item.status === 403).length, 4, JSON.stringify(results));
  assert.equal(results.filter(item => item.status === 429).length, 16, JSON.stringify(results));
}

test('parallel wrong codes cannot push the TOTP failure counter past 5 on sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-race-sqlite-'));
  const file = path.join(dir, 'test.db');
  const database = new DatabaseSync(file);
  database.exec('PRAGMA busy_timeout = 5000');
  try {
    prepare(database);
    await assertLock({
      handle: database,
      workerData: { file, ranksPath }
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel wrong codes cannot push the TOTP failure counter past 5 on libsql', { timeout: 120000 }, async () => {
  const { startSqld, stopSqld } = require('../scripts/sqld-fixture');
  const { openLibsqlSync } = require('../lib/libsql-sync');
  const sqld = await startSqld();
  const database = openLibsqlSync({ url: sqld.url, authToken: sqld.token });
  try {
    prepare(database);
    await assertLock({
      handle: database,
      workerData: {
        url: sqld.url,
        authToken: sqld.token,
        adapterPath: path.join(root, 'lib', 'libsql-sync.js'),
        ranksPath
      }
    });
  } finally {
    database.close();
    await stopSqld(sqld);
  }
});
