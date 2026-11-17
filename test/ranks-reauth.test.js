const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const { httpCall, password, insertUser, boot, shutdown, login, call, spawnServer, stopServer } = require('../scripts/rank-harness');

async function twoAdmins(ctx) {
  insertUser(ctx.databaseFile, ctx.adminEmail, 'Birinci');
  const second = insertUser(ctx.databaseFile, 'ikinci@ranks.test', 'Ikinci');
  const first = await login(ctx.port, ctx.adminEmail);
  const enrolled = await enrollTwoFactor(httpCall, ctx.port, first.cookie, password);
  const granted = await call(ctx.port, first.cookie, 'POST', `/api/admin/users/${second.id}/role`, {
    role: 'admin', password, code: enrolled.backupCodes[0]
  });
  assert.equal(granted.status, 200, granted.text);
  const other = await login(ctx.port, 'ikinci@ranks.test');
  const otherCodes = await enrollTwoFactor(httpCall, ctx.port, other.cookie, password);
  return { first: first.cookie, enrolled, second, other: other.cookie, otherCodes };
}

test('demoting another admin requires a fresh password and code, then is audited', async () => {
  const ctx = await boot('birinci@ranks.test');
  try {
    const who = await twoAdmins(ctx);
    const lookup = new DatabaseSync(ctx.databaseFile, { readOnly: true });
    const firstId = Number(lookup.prepare("SELECT id FROM users WHERE email = 'birinci@ranks.test'").get().id);
    lookup.close();
    const missing = await call(ctx.port, who.other, 'POST', `/api/admin/users/${firstId}/role`, { role: 'player' });
    assert.equal(missing.status, 403, missing.text);
    const self = await call(ctx.port, who.other, 'POST', `/api/admin/users/${who.second.id}/role`, {
      role: 'player', password, code: who.otherCodes.backupCodes[0]
    });
    assert.equal(self.status, 403, self.text);
    const wrong = await call(ctx.port, who.other, 'POST', `/api/admin/users/${firstId}/role`, {
      role: 'player', password, code: '000000'
    });
    assert.equal(wrong.status, 403, wrong.text);
    const dropped = await call(ctx.port, who.other, 'POST', `/api/admin/users/${firstId}/role`, {
      role: 'player', password, code: who.otherCodes.backupCodes[1]
    });
    assert.equal(dropped.status, 200, dropped.text);
    const db = new DatabaseSync(ctx.databaseFile, { readOnly: true, timeout: 5000 });
    const audit = db.prepare("SELECT actor_id, target_id, old_value, new_value FROM audit_log WHERE action = 'role_change' AND target_id = ? ORDER BY id DESC").get(firstId);
    db.close();
    assert.equal(Number(audit.target_id), firstId);
    assert.match(audit.old_value, /admin/);
    assert.match(audit.new_value, /player/);
    assert.match(audit.new_value, /"reauth":true/);
  } finally {
    await shutdown(ctx);
  }
});

test('granting admin requires a fresh password and code', async () => {
  const ctx = await boot('veren@ranks.test');
  try {
    insertUser(ctx.databaseFile, 'veren@ranks.test', 'Veren');
    const player = insertUser(ctx.databaseFile, 'aday@ranks.test', 'Aday');
    const admin = (await login(ctx.port, 'veren@ranks.test')).cookie;
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, admin, password);
    const missing = await call(ctx.port, admin, 'POST', `/api/admin/users/${player.id}/role`, { role: 'admin' });
    assert.equal(missing.status, 403, missing.text);
    const granted = await call(ctx.port, admin, 'POST', `/api/admin/users/${player.id}/role`, {
      role: 'admin', password, code: enrolled.backupCodes[0]
    });
    assert.equal(granted.status, 200, granted.text);
    const db = new DatabaseSync(ctx.databaseFile, { readOnly: true, timeout: 5000 });
    const audit = db.prepare("SELECT new_value FROM audit_log WHERE action = 'role_change' AND target_id = ?").get(player.id);
    db.close();
    assert.match(audit.new_value, /"reauth":true/);
    assert.match(audit.new_value, /admin/);
  } finally {
    await shutdown(ctx);
  }
});

test('the last admin still cannot be demoted, and lower ranks cannot use the role endpoint', async () => {
  const ctx = await boot('son@ranks.test');
  try {
    const adminRow = insertUser(ctx.databaseFile, 'son@ranks.test', 'Son');
    const mod = insertUser(ctx.databaseFile, 'mod-re@ranks.test', 'Mod');
    const support = insertUser(ctx.databaseFile, 'destek-re@ranks.test', 'Destek');
    const admin = (await login(ctx.port, 'son@ranks.test')).cookie;
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, admin, password);
    await call(ctx.port, admin, 'POST', `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
    await call(ctx.port, admin, 'POST', `/api/admin/users/${support.id}/role`, { role: 'support' });
    const modLogin = await login(ctx.port, 'mod-re@ranks.test');
    await enrollTwoFactor(httpCall, ctx.port, modLogin.cookie, password);
    const supportLogin = await login(ctx.port, 'destek-re@ranks.test');
    const last = await call(ctx.port, admin, 'POST', `/api/admin/users/${adminRow.id}/role`, {
      role: 'player', password, code: enrolled.backupCodes[0]
    });
    assert.equal(last.status, 409, last.text);
    assert.match(last.json.error, /Son yönetici/);
    const modDenied = await call(ctx.port, modLogin.cookie, 'POST', `/api/admin/users/${support.id}/role`, { role: 'player' });
    assert.equal(modDenied.status, 403, modDenied.text);
    const supportDenied = await call(ctx.port, supportLogin.cookie, 'POST', `/api/admin/users/${mod.id}/role`, { role: 'player' });
    assert.equal(supportDenied.status, 403, supportDenied.text);
  } finally {
    await shutdown(ctx);
  }
});

test('another admin can reset a lost authenticator only with a fresh code', async () => {
  const ctx = await boot('kurtaran@ranks.test');
  try {
    const who = await twoAdmins(ctx);
    const missing = await call(ctx.port, who.other, 'POST', `/api/admin/users/${who.second.id}/2fa/reset`, {});
    assert.equal(missing.status, 403, missing.text);
    const lookup = new DatabaseSync(ctx.databaseFile, { readOnly: true });
    const firstId = Number(lookup.prepare("SELECT id FROM users WHERE email = 'kurtaran@ranks.test'").get().id);
    lookup.close();
    const reset = await call(ctx.port, who.other, 'POST', `/api/admin/users/${firstId}/2fa/reset`, {
      password, code: who.otherCodes.backupCodes[1]
    });
    assert.equal(reset.status, 200, reset.text);
    const db = new DatabaseSync(ctx.databaseFile, { timeout: 5000 });
    const audit = db.prepare("SELECT new_value FROM audit_log WHERE action = 'totp_reset' AND target_id = ?").get(firstId);
    assert.match(audit.new_value, /"reauth":true/);
    db.close();
    const again = await login(ctx.port, 'kurtaran@ranks.test');
    assert.equal(again.response.json.pending2fa, undefined);
    const blocked = await call(ctx.port, again.cookie, 'GET', '/api/admin/users');
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.json.code, '2fa_required');
  } finally {
    await shutdown(ctx);
  }
});

test('a changed SESSION_SECRET does not break 2FA sealed with TOTP_ENC_KEY', async () => {
  const ctx = await boot('ayri@ranks.test');
  try {
    insertUser(ctx.databaseFile, 'ayri@ranks.test', 'Ayri');
    const first = await login(ctx.port, 'ayri@ranks.test');
    const enrolled = await enrollTwoFactor(httpCall, ctx.port, first.cookie, password);
    await stopServer(ctx.running.child);
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(ctx.port),
      DATABASE_FILE: ctx.databaseFile,
      DATA_FILE: `${ctx.dir}/no.json`,
      ADMIN_EMAIL: 'ayri@ranks.test',
      SESSION_SECRET: 'brand-new-session-secret-32chars-min',
      STARTING_OMNI_DOLAR: '5000',
      SMTP_HOST: ''
    };
    delete env.NODE_ENV;
    delete env.TURSO_DATABASE_URL;
    delete env.TURSO_AUTH_TOKEN;
    delete env.TOTP_ENC_KEY;
    ctx.running = spawnServer(env);
    await ctx.running.ready;
    const pending = await login(ctx.port, 'ayri@ranks.test');
    assert.equal(pending.response.json.pending2fa, true);
    const done = await call(ctx.port, pending.cookie, 'POST', '/api/auth/2fa', { code: enrolled.backupCodes[0] });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.method, 'backup');
  } finally {
    await shutdown(ctx);
  }
});
