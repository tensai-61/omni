const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const { httpCall, password, insertUser, boot, shutdown, login, call } = require('../scripts/rank-harness');

async function staffReady(ctx) {
  const player = insertUser(ctx.databaseFile, 'alice@example.com', 'Alice');
  const mod = insertUser(ctx.databaseFile, 'mod@ranks.test', 'Mod');
  const otherMod = insertUser(ctx.databaseFile, 'mod2@ranks.test', 'ModIki');
  const support = insertUser(ctx.databaseFile, 'destek@ranks.test', 'Destek');
  insertUser(ctx.databaseFile, 'admin@ranks.test', 'Admin');
  const adminLogin = await login(ctx.port, 'admin@ranks.test');
  await enrollTwoFactor(httpCall, ctx.port, adminLogin.cookie, password);
  assert.equal((await call(ctx.port, adminLogin.cookie, 'POST', `/api/admin/users/${mod.id}/role`, { role: 'moderator' })).status, 200);
  assert.equal((await call(ctx.port, adminLogin.cookie, 'POST', `/api/admin/users/${otherMod.id}/role`, { role: 'moderator' })).status, 200);
  assert.equal((await call(ctx.port, adminLogin.cookie, 'POST', `/api/admin/users/${support.id}/role`, { role: 'support' })).status, 200);
  const modLogin = await login(ctx.port, 'mod@ranks.test');
  await enrollTwoFactor(httpCall, ctx.port, modLogin.cookie, password);
  const supportLogin = await login(ctx.port, 'destek@ranks.test');
  const playerLogin = await login(ctx.port, 'alice@example.com');
  return {
    player,
    mod,
    otherMod,
    support,
    admin: adminLogin.cookie,
    moderator: modLogin.cookie,
    supportCookie: supportLogin.cookie,
    playerCookie: playerLogin.cookie
  };
}

test('permission matrix allows or refuses each rank', async () => {
  const ctx = await boot();
  try {
    const who = await staffReady(ctx);
    const cases = [
      [who.admin, 'POST', `/api/admin/users/${who.player.id}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 200],
      [who.moderator, 'POST', `/api/admin/users/${who.player.id}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [who.supportCookie, 'POST', `/api/admin/users/${who.player.id}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [who.playerCookie, 'POST', `/api/admin/users/${who.player.id}/balance`, { currency: 'omni', amount: 25, reason: 'düzeltme' }, 403],
      [who.admin, 'PUT', '/api/online/admin/packs/bronz', { price: 40 }, 200],
      [who.moderator, 'PUT', '/api/online/admin/packs/bronz', { price: 41 }, 403],
      [who.supportCookie, 'PUT', '/api/online/admin/packs/bronz', { price: 42 }, 403],
      [who.playerCookie, 'PUT', '/api/online/admin/packs/bronz', { price: 43 }, 403],
      [who.admin, 'POST', `/api/admin/users/${who.player.id}/role`, { role: 'player' }, 200],
      [who.moderator, 'POST', `/api/admin/users/${who.player.id}/role`, { role: 'support' }, 403],
      [who.supportCookie, 'GET', '/api/admin/audit', undefined, 403],
      [who.playerCookie, 'GET', '/api/mod/reports', undefined, 403],
      [who.moderator, 'GET', '/api/admin/audit', undefined, 403],
      [who.supportCookie, 'GET', '/api/mod/reports', undefined, 403],
      [who.moderator, 'GET', '/api/mod/reports', undefined, 200],
      [who.admin, 'GET', '/api/mod/reports', undefined, 200],
      [who.supportCookie, 'GET', `/api/support/users/${who.player.id}`, undefined, 200],
      [who.playerCookie, 'GET', `/api/support/users/${who.player.id}`, undefined, 403]
    ];
    for (const [cookie, method, pathname, body, status] of cases) {
      const response = await call(ctx.port, cookie, method, pathname, body);
      assert.equal(response.status, status, `${method} ${pathname} ${response.text}`);
    }
  } finally {
    await shutdown(ctx);
  }
});

test('a rank can act only on a lower rank', async () => {
  const ctx = await boot();
  try {
    const who = await staffReady(ctx);
    const muted = await call(ctx.port, who.moderator, 'POST', `/api/admin/users/${who.player.id}/mute`, { duration: '1h', reason: 'alt rütbe' });
    assert.equal(muted.status, 200, muted.text);
    const upward = await call(ctx.port, who.moderator, 'POST', `/api/admin/users/${who.otherMod.id}/mute`, { duration: '1h', reason: 'eşit' });
    assert.equal(upward.status, 403, upward.text);
    const above = await call(ctx.port, who.supportCookie, 'POST', `/api/admin/users/${who.player.id}/mute`, { duration: '1h', reason: 'yok' });
    assert.equal(above.status, 403, above.text);
  } finally {
    await shutdown(ctx);
  }
});

test('a moderator cannot ban a moderator or an admin', async () => {
  const ctx = await boot();
  try {
    const who = await staffReady(ctx);
    const banMod = await call(ctx.port, who.moderator, 'POST', `/api/admin/users/${who.otherMod.id}/ban`, { duration: 'PERMANENT', banReason: 'eş rütbe' });
    assert.equal(banMod.status, 403, banMod.text);
    assert.match(banMod.json.error, /Moderatör/);
    const lookup = new DatabaseSync(ctx.databaseFile, { readOnly: true });
    const adminId = lookup.prepare("SELECT id FROM users WHERE email = 'admin@ranks.test'").get().id;
    lookup.close();
    const banAdmin = await call(ctx.port, who.moderator, 'POST', `/api/admin/users/${adminId}/ban`, { duration: 'PERMANENT', banReason: 'yönetici' });
    assert.equal(banAdmin.status, 403, banAdmin.text);
    const playerBan = await call(ctx.port, who.moderator, 'POST', `/api/admin/users/${who.player.id}/ban`, { duration: '1d', banReason: 'oyuncu' });
    assert.equal(playerBan.status, 200, playerBan.text);
  } finally {
    await shutdown(ctx);
  }
});

test('the last admin cannot be demoted through the API', async () => {
  const ctx = await boot();
  try {
    insertUser(ctx.databaseFile, 'admin@ranks.test', 'Admin');
    const admin = (await login(ctx.port, 'admin@ranks.test')).cookie;
    await enrollTwoFactor(httpCall, ctx.port, admin, password);
    const lookup = new DatabaseSync(ctx.databaseFile, { readOnly: true });
    const adminId = lookup.prepare("SELECT id FROM users WHERE email = 'admin@ranks.test'").get().id;
    lookup.close();
    const last = await call(ctx.port, admin, 'POST', `/api/admin/users/${adminId}/role`, { role: 'player' });
    assert.equal(last.status, 409, last.text);
    assert.match(last.json.error, /Son yönetici/);
  } finally {
    await shutdown(ctx);
  }
});

test('support cannot see a full email, password hash, or device id', async () => {
  const ctx = await boot();
  try {
    const who = await staffReady(ctx);
    const profile = await call(ctx.port, who.supportCookie, 'GET', `/api/support/users/${who.player.id}`);
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.json.user.email, 'a***@e***.com');
    assert.equal(profile.text.includes('alice@example.com'), false);
    assert.equal(profile.text.includes(who.player.hash), false);
    assert.equal(profile.text.includes('password_hash'), false);
    assert.equal(Object.hasOwn(profile.json.user, 'deviceId'), false);
  } finally {
    await shutdown(ctx);
  }
});

test('viewing email or device id writes view_pii', async () => {
  const ctx = await boot();
  try {
    const who = await staffReady(ctx);
    const users = await call(ctx.port, who.admin, 'GET', '/api/admin/users');
    assert.equal(users.status, 200, users.text);
    assert.equal(users.json.users.some(row => row.email === 'alice@example.com' && row.deviceId), true);
    const db = new DatabaseSync(ctx.databaseFile, { timeout: 5000 });
    const viewed = db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'view_pii' AND target_id = ?").get(who.player.id);
    db.close();
    assert.ok(Number(viewed.total) >= 1);
  } finally {
    await shutdown(ctx);
  }
});
