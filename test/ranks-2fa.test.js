const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { totpCode } = require('../lib/ranks');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const { spawnServer, stopServer, httpCall, password, insertUser, boot, shutdown, login, call } = require('../scripts/rank-harness');

async function enrolledPlayer(ctx, email, username) {
  const row = insertUser(ctx.databaseFile, email, username);
  const first = await login(ctx.port, email);
  assert.equal(first.response.json.pending2fa, undefined);
  const enrolled = await enrollTwoFactor(httpCall, ctx.port, first.cookie, password);
  const out = await call(ctx.port, first.cookie, 'POST', '/api/auth/logout', {});
  assert.equal(out.status, 200, out.text);
  const pending = await login(ctx.port, email);
  assert.equal(pending.response.json.pending2fa, true);
  assert.equal(pending.response.json.user, undefined);
  return { row, enrolled, cookie: pending.cookie };
}

test('a session without the second factor gets 403 on privileged and personal data', async () => {
  const ctx = await boot('admin-factor@ranks.test');
  try {
    const admin = await enrolledPlayer(ctx, 'admin-factor@ranks.test', 'Admin');
    const users = await call(ctx.port, admin.cookie, 'GET', '/api/admin/users');
    assert.equal(users.status, 403, users.text);
    assert.equal(users.json.code, 'pending_2fa');
    const session = await call(ctx.port, admin.cookie, 'GET', '/api/auth/session');
    assert.equal(session.json.pending2fa, true);
    assert.equal(session.json.user, null);
    assert.equal(session.text.includes('admin-factor@ranks.test'), false);
    const home = await call(ctx.port, admin.cookie, 'GET', '/api/online/home');
    assert.equal(home.status, 403, home.text);
    assert.equal(home.json.code, 'pending_2fa');
    const done = await call(ctx.port, admin.cookie, 'POST', '/api/auth/2fa', { code: admin.enrolled.backupCodes[0] });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.method, 'backup');
    const open = await call(ctx.port, admin.cookie, 'GET', '/api/admin/users');
    assert.equal(open.status, 200, open.text);
  } finally {
    await shutdown(ctx);
  }
});

test('five wrong second-factor codes lock the next attempt', async () => {
  const ctx = await boot('lock@ranks.test');
  try {
    const player = await enrolledPlayer(ctx, 'lock@ranks.test', 'Kilit');
    for (let index = 1; index <= 4; index += 1) {
      const wrong = await call(ctx.port, player.cookie, 'POST', '/api/auth/2fa', { code: '000000' });
      assert.equal(wrong.status, 403, wrong.text);
    }
    const fifth = await call(ctx.port, player.cookie, 'POST', '/api/auth/2fa', { code: '000000' });
    assert.equal(fifth.status, 429, fifth.text);
    const blocked = await call(ctx.port, player.cookie, 'POST', '/api/auth/2fa', { code: player.enrolled.backupCodes[0] });
    assert.equal(blocked.status, 429, blocked.text);
  } finally {
    await shutdown(ctx);
  }
});

test('the same TOTP code is rejected twice inside one time step', async () => {
  const ctx = await boot('replay@ranks.test');
  try {
    insertUser(ctx.databaseFile, 'replay@ranks.test', 'Tekrar');
    const first = await login(ctx.port, 'replay@ranks.test');
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, first.cookie, password);
    await call(ctx.port, first.cookie, 'POST', '/api/auth/logout', {});
    const pending = await login(ctx.port, 'replay@ranks.test');
    const replay = await call(ctx.port, pending.cookie, 'POST', '/api/auth/2fa', { code: totpCode(enrolled.secret) });
    assert.equal(replay.status, 403, replay.text);
    assert.match(replay.json.error, /zaten kullanıldı/);
    const backup = await call(ctx.port, pending.cookie, 'POST', '/api/auth/2fa', { code: enrolled.backupCodes[0] });
    assert.equal(backup.status, 200, backup.text);
  } finally {
    await shutdown(ctx);
  }
});

test('a backup code can be used only once', async () => {
  const ctx = await boot('backup@ranks.test');
  try {
    const player = await enrolledPlayer(ctx, 'backup@ranks.test', 'Yedek');
    const code = player.enrolled.backupCodes[1];
    const once = await call(ctx.port, player.cookie, 'POST', '/api/auth/2fa', { code });
    assert.equal(once.status, 200, once.text);
    assert.equal(once.json.method, 'backup');
    await call(ctx.port, player.cookie, 'POST', '/api/auth/logout', {});
    const again = await login(ctx.port, 'backup@ranks.test');
    const twice = await call(ctx.port, again.cookie, 'POST', '/api/auth/2fa', { code });
    assert.equal(twice.status, 403, twice.text);
  } finally {
    await shutdown(ctx);
  }
});

test('admin and moderator cannot turn 2FA off, and a player disable is audited', async () => {
  const ctx = await boot('kapat@ranks.test');
  try {
    const admin = await enrolledPlayer(ctx, 'kapat@ranks.test', 'Admin');
    const signed = await call(ctx.port, admin.cookie, 'POST', '/api/auth/2fa', { code: admin.enrolled.backupCodes[0] });
    assert.equal(signed.status, 200, signed.text);
    const refused = await call(ctx.port, admin.cookie, 'POST', '/api/account/2fa/disable', {
      password, code: admin.enrolled.backupCodes[2]
    });
    assert.equal(refused.status, 403, refused.text);
    assert.match(refused.json.error, /kapatamaz/);
    const modRow = insertUser(ctx.databaseFile, 'mod-kapat@ranks.test', 'Mod');
    assert.equal((await call(ctx.port, admin.cookie, 'POST', `/api/admin/users/${modRow.id}/role`, { role: 'moderator' })).status, 200);
    const modLogin = await login(ctx.port, 'mod-kapat@ranks.test');
    const modEnrolled = await enrollTwoFactor(httpCall, ctx.port, modLogin.cookie, password);
    const modRefused = await call(ctx.port, modLogin.cookie, 'POST', '/api/account/2fa/disable', {
      password, code: modEnrolled.backupCodes[0]
    });
    assert.equal(modRefused.status, 403, modRefused.text);
    insertUser(ctx.databaseFile, 'oyuncu-kapat@ranks.test', 'Oyuncu');
    const playerLogin = await login(ctx.port, 'oyuncu-kapat@ranks.test');
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, playerLogin.cookie, password);
    const disabled = await call(ctx.port, playerLogin.cookie, 'POST', '/api/account/2fa/disable', {
      password, code: enrolled.backupCodes[0]
    });
    assert.equal(disabled.status, 200, disabled.text);
    const db = new DatabaseSync(ctx.databaseFile, { readOnly: true, timeout: 5000 });
    const row = db.prepare("SELECT action FROM audit_log WHERE action = 'totp_disable'").get();
    const still = db.prepare("SELECT totp_enabled FROM user_security WHERE user_id = (SELECT id FROM users WHERE email = 'kapat@ranks.test')").get();
    db.close();
    assert.equal(row.action, 'totp_disable');
    assert.equal(Number(still.totp_enabled), 1);
  } finally {
    await shutdown(ctx);
  }
});

test('ADMIN_EMAIL seeds the first admin only once', async () => {
  const ctx = await boot('seed@ranks.test');
  try {
    insertUser(ctx.databaseFile, 'seed@ranks.test', 'Ilk');
    const other = insertUser(ctx.databaseFile, 'diger@ranks.test', 'Diger');
    const first = await login(ctx.port, 'seed@ranks.test');
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, first.cookie, password);
    assert.equal((await call(ctx.port, first.cookie, 'POST', `/api/admin/users/${other.id}/role`, {
      role: 'admin', password, code: enrolled.backupCodes[1]
    })).status, 200);
    const otherLogin = await login(ctx.port, 'diger@ranks.test');
    await enrollTwoFactor(httpCall, ctx.port, otherLogin.cookie, password);
    const db = new DatabaseSync(ctx.databaseFile, { timeout: 5000 });
    const seeded = db.prepare("SELECT id FROM users WHERE email = 'seed@ranks.test'").get();
    db.prepare("UPDATE user_roles SET role = 'player' WHERE user_id = ?").run(seeded.id);
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(seeded.id);
    assert.equal(Number(db.prepare('SELECT consumed FROM role_seed WHERE id = 1').get().consumed), 1);
    db.close();
    await stopServer(ctx.running.child);
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(ctx.port),
      DATABASE_FILE: ctx.databaseFile,
      DATA_FILE: `${ctx.dir}/no.json`,
      ADMIN_EMAIL: 'seed@ranks.test',
      SESSION_SECRET: 'rank-test-session-secret-32chars-min',
      STARTING_OMNI_DOLAR: '5000',
      SMTP_HOST: ''
    };
    delete env.NODE_ENV;
    delete env.TURSO_DATABASE_URL;
    delete env.TURSO_AUTH_TOKEN;
    ctx.running = spawnServer(env);
    await ctx.running.ready;
    const pending = await login(ctx.port, 'seed@ranks.test');
    assert.equal(pending.response.json.pending2fa, true);
    const done = await call(ctx.port, pending.cookie, 'POST', '/api/auth/2fa', { code: enrolled.backupCodes[0] });
    assert.equal(done.status, 200, done.text);
    const priced = await call(ctx.port, pending.cookie, 'PUT', '/api/online/admin/packs/bronz', { price: 30 });
    assert.equal(priced.status, 403, priced.text);
    insertUser(ctx.databaseFile, 'sahte-admin@ranks.test', 'Sahte', 'admin');
    const fake = await login(ctx.port, 'sahte-admin@ranks.test');
    assert.equal(fake.response.json.pending2fa, undefined);
    const fakePrice = await call(ctx.port, fake.cookie, 'PUT', '/api/online/admin/packs/bronz', { price: 31 });
    assert.equal(fakePrice.status, 403, fakePrice.text);
    const check = new DatabaseSync(ctx.databaseFile, { readOnly: true, timeout: 5000 });
    assert.equal(Number(check.prepare('SELECT consumed FROM role_seed WHERE id = 1').get().consumed), 1);
    assert.equal(check.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(seeded.id).role, 'player');
    check.close();
  } finally {
    await shutdown(ctx);
  }
});
