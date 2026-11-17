const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { totpCode, verifyTotp, maskEmail, installRanks, encryptSecret, decryptSecret, setupTwoFactor, acceptTotp } = require('../lib/ranks');
const { encodeQr, formatBits } = require('../lib/qr');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');

const root = path.join(__dirname, '..');
const password = 'RankTest1a';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
    probe.on('error', reject);
  });
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = { out: '', err: '' };
  child.stdout.on('data', chunk => { logs.out += chunk; });
  child.stderr.on('data', chunk => { logs.err += chunk; });
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${logs.out}\n${logs.err}`)), 8000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.on('exit', code => finish(new Error(`server exited ${code}\n${logs.out}\n${logs.err}`)));
    (function poll() {
      if (settled) return;
      if (logs.out.includes('Omni.verse hazır:')) finish();
      else setTimeout(poll, 20);
    })();
  });
  return { child, logs, ready };
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function httpCall({ port, method, pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      agent: false,
      headers: {
        Host: '127.0.0.1',
        Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(response) {
  const value = response.headers['set-cookie'];
  assert.ok(value, response.text);
  const header = Array.isArray(value) ? value.join('\n') : value;
  return `turnuva_session=${/turnuva_session=([^;]+)/.exec(header)[1]}`;
}

function insertUser(file, email, username, role = 'user') {
  const db = new DatabaseSync(file, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, deviceId, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(email, username, hash, salt.toString('hex'), role, `device-${username}`, new Date().toISOString());
  const id = Number(db.prepare('SELECT id FROM users WHERE email = ?').get(email).id);
  db.close();
  return { id, hash };
}

test('TOTP matches the RFC 6238 SHA1 vectors and backup material is not the secret', () => {
  const key = Buffer.from('12345678901234567890');
  const vectors = [
    [59_000, '287082'],
    [1111111109_000, '081804'],
    [1111111111_000, '050471'],
    [1234567890_000, '005924'],
    [2000000000_000, '279037']
  ];
  for (const [at, code] of vectors) {
    assert.equal(totpCode(key, at), code);
    assert.equal(verifyTotp(key, code, at), true);
  }
  assert.equal(verifyTotp(key, '000000', 59_000), false);
  assert.equal(maskEmail('ali@example.com'), 'a***@e***.com');
  assert.equal(maskEmail('alice@example.com').includes('alice'), false);
  const wrapped = encryptSecret('BASE32SECRET', 'session-secret-session-secret-session');
  assert.equal(wrapped.includes('BASE32SECRET'), false);
  assert.equal(decryptSecret(wrapped, 'session-secret-session-secret-session'), 'BASE32SECRET');
  const totpKey = 'totp-enc-key-0123456789abcdef0123456789';
  const sealed = encryptSecret('BASE32SECRET', totpKey);
  assert.throws(() => decryptSecret(sealed, 'another-session-secret-32-characters'));
  assert.equal(decryptSecret(sealed, totpKey), 'BASE32SECRET');
  const modules = encodeQr('otpauth://totp/Omni:a@b.co?secret=JBSWY3DPEHPK3PXP&issuer=Omni');
  assert.equal(modules.length, modules[0].length);
  assert.equal(modules[0][0], 1);
  assert.deepEqual(formatBits().join(''), '111011111000100');
});

test('an older TOTP step is rejected after a newer step was accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranks-replay-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  try {
    prepareUsers(database);
    installRanks(database, '');
    database.prepare("INSERT INTO users (email, username, role, created_at) VALUES ('a@b.co', 'A', 'user', '2026-11-13T00:00:00.000Z')").run();
    const key = 'totp-enc-key-0123456789abcdef0123456789';
    const setup = setupTwoFactor(database, { id: 1, email: 'a@b.co' }, key);
    const newerAt = 1_700_000_060_000;
    acceptTotp(database, 1, setup.secret, totpCode(setup.secret, newerAt), newerAt);
    assert.throws(() => acceptTotp(database, 1, setup.secret, totpCode(setup.secret, newerAt - 60_000), newerAt - 60_000), /zaten kullanıldı/);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function prepareUsers(database) {
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
}

function assertImmutableAudit(database) {
  database.prepare(`
    INSERT INTO audit_log (actor_id, target_id, action, old_value, new_value, ip, created_at)
    VALUES (1, 2, 'ban', 'old', 'new', '127.0.0.1', '2026-11-13T00:00:00.000Z')
  `).run();
  assert.throws(() => database.prepare("UPDATE audit_log SET action = 'tampered'").run(), /audit_log/);
  assert.throws(() => database.prepare('DELETE FROM audit_log').run(), /audit_log/);
  assert.equal(database.prepare('SELECT action FROM audit_log').get().action, 'ban');
}

function assertLastAdmin(database) {
  database.prepare("INSERT INTO users (email, username, role, created_at) VALUES ('solo@x.com', 'Solo', 'user', '2026-11-13T00:00:00.000Z')").run();
  const solo = Number(database.prepare('SELECT id FROM users WHERE email = ?').get('solo@x.com').id);
  database.prepare("INSERT INTO user_roles (user_id, role, updated_at) VALUES (?, 'admin', '2026-11-13T00:00:00.000Z')").run(solo);
  assert.throws(() => database.prepare("UPDATE user_roles SET role = 'player' WHERE user_id = ?").run(solo), /last admin/);
  assert.throws(() => database.prepare('DELETE FROM users WHERE id = ?').run(solo), /last admin/);
  database.prepare("INSERT INTO users (email, username, role, created_at) VALUES ('pair@x.com', 'Pair', 'user', '2026-11-13T00:00:00.000Z')").run();
  const pair = Number(database.prepare('SELECT id FROM users WHERE email = ?').get('pair@x.com').id);
  database.prepare("INSERT INTO user_roles (user_id, role, updated_at) VALUES (?, 'admin', '2026-11-13T00:00:00.000Z')").run(pair);
  database.prepare("UPDATE user_roles SET role = 'player' WHERE user_id = ?").run(pair);
  assert.throws(() => database.prepare('DELETE FROM users WHERE id = ?').run(solo), /last admin/);
  assert.equal(database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(solo).role, 'admin');
}

test('audit triggers and the last admin guard hold on sqlite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranks-sqlite-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    prepareUsers(database);
    installRanks(database, '');
    assertImmutableAudit(database);
    assertLastAdmin(database);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit triggers and the last admin guard hold on libsql', { timeout: 120000 }, async () => {
  const { startSqld, stopSqld } = require('../scripts/sqld-fixture');
  const { openLibsqlSync } = require('../lib/libsql-sync');
  const sqld = await startSqld();
  const database = openLibsqlSync({ url: sqld.url, authToken: sqld.token });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    prepareUsers(database);
    installRanks(database, '');
    assertImmutableAudit(database);
    assertLastAdmin(database);
  } finally {
    database.close();
    await stopSqld(sqld);
  }
});

test('rank permissions, 2FA, masked support, and view_pii are enforced on the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranks-http-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin@ranks.test',
    SESSION_SECRET: 'rank-test-session-secret-32chars-min',
    STARTING_OMNI_DOLAR: '5000',
    SMTP_HOST: ''
  };
  delete env.NODE_ENV;
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;
  delete env.ONLINE_LOCK_TRIGGER;
  const running = spawnServer(env);
  try {
    await running.ready;
    const adminId = insertUser(databaseFile, 'admin@ranks.test', 'Admin').id;
    const modId = insertUser(databaseFile, 'mod@ranks.test', 'Mod').id;
    const otherModId = insertUser(databaseFile, 'mod2@ranks.test', 'ModIki').id;
    const supportId = insertUser(databaseFile, 'destek@ranks.test', 'Destek').id;
    const playerRow = insertUser(databaseFile, 'alice@example.com', 'Alice');
    const playerId = playerRow.id;
    const rankedId = insertUser(databaseFile, 'baska@ranks.test', 'Baska', 'admin').id;
    async function login(email) {
      const response = await httpCall({
        port, method: 'POST', pathname: '/api/auth/login',
        body: JSON.stringify({ email, password })
      });
      assert.equal(response.status, 200, response.text);
      return cookieFrom(response);
    }
    async function call(cookie, method, pathname, body) {
      return httpCall({
        port, method, pathname,
        headers: { Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }
    const admin = await login('admin@ranks.test');
    const early = await call(admin, 'POST', `/api/admin/users/${playerId}/ban`, { duration: 'PERMANENT', banReason: 'erken' });
    assert.equal(early.status, 403, early.text);
    assert.equal(early.json.code, '2fa_required');
    assert.equal(early.json.setupPath, '/api/account/2fa/setup');
    const enrolledAdmin = await enrollTwoFactor(httpCall, port, admin, password);
    async function grant(id, role, extra = {}) {
      const response = await call(admin, 'POST', `/api/admin/users/${id}/role`, { role, ...extra });
      assert.equal(response.status, 200, response.text);
      return response;
    }
    await grant(modId, 'moderator');
    await grant(otherModId, 'moderator');
    await grant(supportId, 'support');
    const mod = await login('mod@ranks.test');
    const modEarly = await call(mod, 'POST', `/api/admin/users/${playerId}/ban`, { duration: '1d', banReason: 'modsuz' });
    assert.equal(modEarly.status, 403, modEarly.text);
    assert.equal(modEarly.json.code, '2fa_required');
    await enrollTwoFactor(httpCall, port, mod, password);
    const support = await login('destek@ranks.test');
    const player = await login('alice@example.com');
    const stranger = await login('baska@ranks.test');
    const deniedPrice = await call(stranger, 'PUT', '/api/online/admin/packs/bronz', { price: 50 });
    assert.equal(deniedPrice.status, 403, deniedPrice.text);
    const matrix = [
      [admin, 'POST', `/api/admin/users/${playerId}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 200],
      [mod, 'POST', `/api/admin/users/${playerId}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [support, 'POST', `/api/admin/users/${playerId}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [player, 'POST', `/api/admin/users/${playerId}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [mod, 'PUT', '/api/online/admin/packs/bronz', { price: 40 }, 403],
      [admin, 'PUT', '/api/online/admin/packs/bronz', { price: 40 }, 200],
      [mod, 'POST', `/api/admin/users/${playerId}/role`, { role: 'support' }, 403],
      [support, 'GET', '/api/admin/audit', null, 403],
      [player, 'GET', '/api/mod/reports', null, 403],
      [mod, 'GET', '/api/admin/audit', null, 403]
    ];
    for (const [cookie, method, pathname, body, status] of matrix) {
      const response = await call(cookie, method, pathname, body === null ? undefined : body);
      assert.equal(response.status, status, `${method} ${pathname} ${response.text}`);
    }
    const banPlayer = await call(mod, 'POST', `/api/admin/users/${playerId}/ban`, { duration: '1d', banReason: 'alt rütbe' });
    assert.equal(banPlayer.status, 200, banPlayer.text);
    const unban = await call(mod, 'POST', `/api/admin/users/${playerId}/unban`, {});
    assert.equal(unban.status, 200, unban.text);
    const playerAgain = await login('alice@example.com');
    const banMod = await call(mod, 'POST', `/api/admin/users/${otherModId}/ban`, { duration: 'PERMANENT', banReason: 'eş rütbe' });
    assert.equal(banMod.status, 403, banMod.text);
    assert.match(banMod.json.error, /Moderatör/);
    const banAdmin = await call(mod, 'POST', `/api/admin/users/${adminId}/ban`, { duration: 'PERMANENT', banReason: 'yönetici' });
    assert.equal(banAdmin.status, 403, banAdmin.text);
    const adminBansAdmin = await call(admin, 'POST', `/api/admin/users/${adminId}/ban`, { duration: 'PERMANENT', banReason: 'kendisi' });
    assert.equal(adminBansAdmin.status, 403, adminBansAdmin.text);
    const last = await call(admin, 'POST', `/api/admin/users/${adminId}/role`, { role: 'player' });
    assert.equal(last.status, 409, last.text);
    assert.match(last.json.error, /Son yönetici/);
    const mute = await call(mod, 'POST', `/api/admin/users/${playerId}/mute`, { duration: '1h', reason: 'sohbet' });
    assert.equal(mute.status, 200, mute.text);
    const muted = await call(playerAgain, 'POST', '/api/chat', { text: 'merhaba' });
    assert.equal(muted.status, 403, muted.text);
    const muteMod = await call(mod, 'POST', `/api/admin/users/${adminId}/mute`, { duration: '1h', reason: 'olmaz' });
    assert.equal(muteMod.status, 403, muteMod.text);
    await call(mod, 'POST', `/api/admin/users/${playerId}/unmute`, {});
    const said = await call(playerAgain, 'POST', '/api/chat', { text: 'merhaba' });
    assert.equal(said.status, 201, said.text);
    const opened = await call(playerAgain, 'POST', '/api/online/packs/open', { slug: 'bronz', requestId: 'ilan-kaldir-01' });
    assert.equal(opened.status, 200, opened.text);
    const card = opened.json.cards[0];
    const listed = await call(playerAgain, 'POST', '/api/online/player-market', { cardId: card.id, price: card.gen * 25 });
    assert.equal(listed.status, 201, listed.text);
    const removedListing = await call(mod, 'POST', `/api/mod/listings/${listed.json.listing.id}/remove`, {});
    assert.equal(removedListing.status, 200, removedListing.text);
    const staffListing = await call(mod, 'POST', `/api/mod/listings/${listed.json.listing.id}/remove`, {});
    assert.equal(staffListing.status, 409, staffListing.text);
    const report = await call(playerAgain, 'POST', '/api/reports', { targetId: modId, reason: 'deneme raporu' });
    assert.equal(report.status, 201, report.text);
    const reports = await call(mod, 'GET', '/api/mod/reports');
    assert.equal(reports.status, 200, reports.text);
    assert.equal(reports.json.reports.some(row => row.reason === 'deneme raporu'), true);
    const supportDenied = await call(support, 'GET', '/api/mod/reports');
    assert.equal(supportDenied.status, 403, supportDenied.text);
    const profile = await call(support, 'GET', `/api/support/users/${playerId}`);
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.json.user.email, 'a***@e***.com');
    assert.equal(profile.text.includes('alice@example.com'), false);
    assert.equal(profile.text.includes(playerRow.hash), false);
    assert.equal(profile.text.includes('password_hash'), false);
    assert.equal(Object.hasOwn(profile.json.user, 'deviceId'), false);
    const users = await call(admin, 'GET', '/api/admin/users');
    assert.equal(users.status, 200, users.text);
    assert.equal(users.json.users.some(row => row.email === 'alice@example.com'), true);
    const db = new DatabaseSync(databaseFile, { timeout: 5000 });
    const viewed = db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'view_pii' AND target_id = ?").get(playerId);
    assert.ok(Number(viewed.total) >= 1);
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'yok'").run(), /audit_log/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE action = \'view_pii\'').run(), /audit_log/);
    db.close();
    const audit = await call(admin, 'GET', '/api/admin/audit?action=view_pii&page=1&pageSize=10');
    assert.equal(audit.status, 200, audit.text);
    assert.ok(audit.json.entries.length >= 1);
    assert.equal(audit.json.entries.every(entry => entry.action === 'view_pii'), true);
    const removed = await call(admin, 'DELETE', '/api/admin/audit');
    assert.equal(removed.status, 405, removed.text);
    await grant(rankedId, 'admin', { password, code: enrolledAdmin.backupCodes[0] });
    const promoted = await login('baska@ranks.test');
    const promotedEarly = await call(promoted, 'PUT', '/api/online/admin/packs/bronz', { price: 30 });
    assert.equal(promotedEarly.status, 403, promotedEarly.text);
    await enrollTwoFactor(httpCall, port, promoted, password);
    const promotedPrice = await call(promoted, 'PUT', '/api/online/admin/packs/bronz', { price: 30 });
    assert.equal(promotedPrice.status, 200, promotedPrice.text);
    const free = await call(promoted, 'POST', '/api/online/packs/open', { slug: 'bronz', requestId: 'admin-rutbe-01', password });
    assert.equal(free.status, 200, free.text);
    assert.equal(free.json.tag, 'admin');
    const modFree = await call(mod, 'POST', '/api/online/packs/open', { slug: 'bronz', requestId: 'mod-ucretli-1' });
    assert.equal(modFree.status, 200, modFree.text);
    assert.equal(modFree.json.tag, 'user');
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
