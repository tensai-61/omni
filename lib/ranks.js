const crypto = require('crypto');
const { canonicalEmail } = require('./account');
const { qrSvg } = require('./qr');

const TOTP_FAIL_LIMIT = 5;
const PENDING_2FA_MS = 5 * 60 * 1000;
const RANKS = ['player', 'support', 'moderator', 'admin'];
const RANK_LEVEL = { player: 1, support: 2, moderator: 3, admin: 4 };
const ACTIONS = new Set([
  'role_change', 'ban', 'unban', 'mute', 'unmute', 'listing_remove',
  'balance_adjust', 'price_change', 'economy_change', 'totp_setup', 'totp_reset', 'totp_disable', 'view_pii'
]);
const DURATIONS = {
  PERMANENT: null,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS roles (
    name TEXT PRIMARY KEY,
    rank INTEGER NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL REFERENCES roles(name),
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS role_seed (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS schema_flags (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_security (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
    totp_failures INTEGER NOT NULL DEFAULT 0,
    totp_locked_until INTEGER,
    totp_last_step INTEGER,
    muted_until TEXT,
    mute_permanent INTEGER NOT NULL DEFAULT 0 CHECK (mute_permanent IN (0, 1)),
    mute_reason TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS user_reports (
    id INTEGER PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    target_id INTEGER,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at, id);
  CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, id);
  CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log cannot be updated');
  END;
  CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS user_roles_protect_last_admin
  BEFORE UPDATE OF role ON user_roles
  WHEN OLD.role = 'admin' AND NEW.role <> 'admin'
    AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1
  BEGIN
    SELECT RAISE(ABORT, 'last admin cannot be demoted');
  END;
  CREATE TRIGGER IF NOT EXISTS users_protect_last_admin
  BEFORE DELETE ON users
  WHEN (SELECT role FROM user_roles WHERE user_id = OLD.id) = 'admin'
    AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1
  BEGIN
    SELECT RAISE(ABORT, 'last admin cannot be deleted');
  END;
`;

function fail(status, error, extra = {}) {
  return Object.assign(new Error(error), { status, ...extra });
}

function asId(value) {
  if (typeof value === 'bigint') value = Number(value);
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function withImmediate(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function installRanks(database, adminEmail = '') {
  database.exec(SCHEMA);
  const securityColumns = new Set(database.prepare('PRAGMA table_info(user_security)').all().map(column => column.name));
  if (!securityColumns.has('totp_last_step')) {
    database.exec('ALTER TABLE user_security ADD COLUMN totp_last_step INTEGER');
  }
  const insertRole = database.prepare('INSERT OR IGNORE INTO roles (name, rank) VALUES (?, ?)');
  RANKS.forEach((name, index) => insertRole.run(name, index + 1));
  const email = canonicalEmail(adminEmail);
  withImmediate(database, () => {
    const flag = database.prepare("SELECT value FROM schema_flags WHERE name = 'ranks_v1'").get();
    if (!flag) {
      if (email) database.prepare('INSERT OR IGNORE INTO role_seed (id, email, consumed) VALUES (1, ?, 0)').run(email);
      const users = database.prepare('SELECT id, email, role FROM users').all();
      for (const user of users) assignInitial(database, user);
      database.prepare("INSERT INTO schema_flags (name, value) VALUES ('ranks_v1', '1')").run();
      return;
    }
    let seed = database.prepare('SELECT email, consumed FROM role_seed WHERE id = 1').get();
    if (!seed && email) {
      database.prepare('INSERT INTO role_seed (id, email, consumed) VALUES (1, ?, 0)').run(email);
      seed = database.prepare('SELECT email, consumed FROM role_seed WHERE id = 1').get();
    }
    if (!seed || Number(seed.consumed)) return;
    const user = database.prepare('SELECT id, email, role FROM users WHERE email = ? COLLATE NOCASE').get(seed.email);
    if (user) assignInitial(database, user);
  });
}

function assignInitial(database, user) {
  const id = asId(user?.id);
  if (!id) return 'player';
  const existing = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(id);
  if (existing?.role) return existing.role;
  let role = 'player';
  const seed = database.prepare('SELECT email, consumed FROM role_seed WHERE id = 1').get();
  if (seed && !Number(seed.consumed) && canonicalEmail(user.email) === canonicalEmail(seed.email)) {
    const consumed = database.prepare('UPDATE role_seed SET consumed = 1 WHERE id = 1 AND consumed = 0').run();
    if (consumed.changes === 1) role = 'admin';
  }
  const now = new Date().toISOString();
  database.prepare('INSERT INTO user_roles (user_id, role, updated_at, updated_by) VALUES (?, ?, ?, NULL)').run(id, role, now);
  if (role === 'admin') database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
  else if (user.role === 'admin') database.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role = 'admin'").run(id);
  return role;
}

function ensureRank(database, user) {
  const id = asId(user?.id);
  if (!id) return 'player';
  const existing = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(id);
  if (existing?.role) return existing.role;
  return withImmediate(database, () => assignInitial(database, user));
}

function rankOf(database, userId) {
  const id = asId(userId);
  if (!id) return 'player';
  const row = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(id);
  return row?.role && RANK_LEVEL[row.role] ? row.role : 'player';
}

function level(role) {
  return RANK_LEVEL[role] || 0;
}

function outranks(actorRank, targetRank) {
  return level(actorRank) > level(targetRank);
}

function twoFactorRequired(rank) {
  return rank === 'admin' || rank === 'moderator';
}

function assertTwoFactor(user) {
  if (!twoFactorRequired(user?.rank) || user.totpEnabled) return;
  throw fail(403, 'Bu işlem için iki adımlı doğrulama kurulmalı', {
    code: '2fa_required',
    setupPath: '/api/account/2fa/setup'
  });
}

function assertOutranks(actor, target, message) {
  assertTwoFactor(actor);
  const targetRank = target?.rank || 'player';
  if (!outranks(actor.rank, targetRank)) {
    throw fail(403, message || 'Yalnızca alt rütbelere işlem yapılabilir');
  }
}

function maskEmail(email) {
  const canonical = canonicalEmail(email);
  const at = canonical.lastIndexOf('@');
  if (at <= 0 || at === canonical.length - 1) return '***';
  const local = canonical.slice(0, at);
  const domain = canonical.slice(at + 1);
  const dot = domain.indexOf('.');
  const host = dot === -1 ? domain : domain.slice(0, dot);
  const tld = dot === -1 ? '' : domain.slice(dot);
  const hide = (value) => `${value.slice(0, 1) || '*'}***`;
  return `${hide(local)}@${hide(host)}${tld}`;
}

function clip(value, max = 2000) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) : text;
}

function writeAudit(database, entry) {
  const action = String(entry?.action || '');
  if (!ACTIONS.has(action)) throw fail(500, 'Denetim eylemi geçersiz');
  database.prepare(`
    INSERT INTO audit_log (actor_id, target_id, action, old_value, new_value, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    asId(entry.actorId) || null,
    asId(entry.targetId) || null,
    action,
    clip(entry.oldValue),
    clip(entry.newValue),
    clip(entry.ip, 80),
    entry.createdAt || new Date().toISOString()
  );
}

function listAudit(database, filters = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 50));
  const page = Math.max(1, Number(filters.page) || 1);
  const action = typeof filters.action === 'string' && ACTIONS.has(filters.action) ? filters.action : '';
  const actorId = asId(filters.actorId);
  const targetId = asId(filters.targetId);
  const where = 'WHERE (? = \'\' OR action = ?) AND (? = 0 OR actor_id = ?) AND (? = 0 OR target_id = ?)';
  const args = [action, action, actorId, actorId, targetId, targetId];
  const total = Number(database.prepare(`SELECT COUNT(*) AS total FROM audit_log ${where}`).get(...args).total);
  const rows = database.prepare(`
    SELECT id, actor_id, target_id, action, old_value, new_value, ip, created_at
    FROM audit_log ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);
  return {
    page,
    pageSize,
    total,
    entries: rows.map(row => ({
      id: asId(row.id),
      actorId: asId(row.actor_id) || null,
      targetId: asId(row.target_id) || null,
      action: row.action,
      oldValue: row.old_value,
      newValue: row.new_value,
      ip: row.ip,
      createdAt: row.created_at
    }))
  };
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(text || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

function totpCode(secret, at = Date.now(), step = 30) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (!key || !key.length) return '';
  const counter = Math.floor(Number(at) / 1000 / step);
  return hotp(key, counter);
}

function matchTotpStep(secret, code, at = Date.now()) {
  const token = String(code || '').trim();
  if (!/^\d{6}$/.test(token)) return null;
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (!key || !key.length) return null;
  const counter = Math.floor(Number(at) / 1000 / 30);
  const actual = Buffer.from(token);
  for (const drift of [-1, 0, 1]) {
    const step = counter + drift;
    const expected = Buffer.from(hotp(key, step));
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return step;
  }
  return null;
}

function verifyTotp(secret, code, at = Date.now()) {
  return matchTotpStep(secret, code, at) !== null;
}

function totpKey(sessionSecret) {
  return crypto.createHmac('sha256', String(sessionSecret)).update('omni-totp-secret-v1').digest();
}

function encryptSecret(plain, sessionSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', totpKey(sessionSecret), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decryptSecret(payload, sessionSecret) {
  const raw = Buffer.from(String(payload || ''), 'base64');
  if (raw.length < 29) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', totpKey(sessionSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function hashBackup(sessionSecret, code) {
  return crypto.createHmac('sha256', String(sessionSecret)).update(`backup:${code}`).digest('hex');
}

function normalizeBackup(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function securityRow(database, userId) {
  return database.prepare('SELECT * FROM user_security WHERE user_id = ?').get(asId(userId));
}

function ensureSecurity(database, userId) {
  const id = asId(userId);
  database.prepare('INSERT OR IGNORE INTO user_security (user_id, updated_at) VALUES (?, ?)').run(id, new Date().toISOString());
  return securityRow(database, id);
}

function setupTwoFactor(database, user, sessionSecret) {
  const id = asId(user?.id);
  if (!id) throw fail(400, 'Hesap bulunamadı');
  const current = ensureSecurity(database, id);
  if (Number(current.totp_enabled) === 1) throw fail(409, 'İki adımlı doğrulama zaten açık');
  const secret = base32Encode(crypto.randomBytes(20));
  const codes = Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const label = canonicalEmail(user.email) || `user-${id}`;
  const otpauthUrl = `otpauth://totp/Omni:${encodeURIComponent(label)}?secret=${secret}&issuer=Omni&algorithm=SHA1&digits=6&period=30`;
  withImmediate(database, () => {
    database.prepare(`
      UPDATE user_security
      SET totp_secret_enc = ?, totp_enabled = 0, totp_failures = 0, totp_locked_until = NULL, updated_at = ?
      WHERE user_id = ?
    `).run(encryptSecret(secret, sessionSecret), new Date().toISOString(), id);
    database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(id);
    const insert = database.prepare('INSERT INTO totp_backup_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(id, hashBackup(sessionSecret, normalizeBackup(code)));
  });
  return { secret, otpauthUrl, qrSvg: qrSvg(otpauthUrl), backupCodes: codes };
}

function totpLocked(row, now = Date.now()) {
  return Number(row?.totp_locked_until || 0) > now;
}

function recordTotpFailure(database, userId) {
  const id = asId(userId);
  const now = Date.now();
  let outcome = { failures: 0, locked: true };
  withImmediate(database, () => {
    const updated = database.prepare(`
      UPDATE user_security
      SET totp_failures = CASE
            WHEN totp_locked_until IS NOT NULL AND totp_locked_until > ? THEN totp_failures
            WHEN totp_failures >= ? THEN totp_failures
            ELSE totp_failures + 1
          END,
          totp_locked_until = CASE
            WHEN totp_locked_until IS NOT NULL AND totp_locked_until > ? THEN totp_locked_until
            WHEN totp_failures >= ? OR totp_failures + 1 >= ? THEN ?
            ELSE NULL
          END,
          updated_at = ?
      WHERE user_id = ?
      RETURNING totp_failures, totp_locked_until
    `).get(now, TOTP_FAIL_LIMIT, now, TOTP_FAIL_LIMIT, TOTP_FAIL_LIMIT, now + 15 * 60 * 1000, new Date(now).toISOString(), id);
    if (!updated) throw fail(400, 'İki adımlı doğrulama henüz kurulmadı');
    const failures = Number(updated.totp_failures);
    outcome = { failures, locked: Number(updated.totp_locked_until || 0) > now || failures >= TOTP_FAIL_LIMIT };
  });
  if (outcome.locked) throw fail(429, 'Çok fazla hatalı doğrulama kodu. 15 dakika bekleyin.');
  throw fail(403, 'Doğrulama kodu hatalı');
}

function acceptTotp(database, userId, secret, code, at = Date.now()) {
  const step = matchTotpStep(secret, code, at);
  if (step === null) return false;
  withImmediate(database, () => {
    const current = database.prepare('SELECT totp_last_step FROM user_security WHERE user_id = ?').get(asId(userId));
    const last = current?.totp_last_step;
    if (last !== null && last !== undefined && step <= Number(last)) {
      throw fail(403, 'Bu doğrulama kodu zaten kullanıldı');
    }
    const updated = database.prepare(`
      UPDATE user_security
      SET totp_failures = 0, totp_locked_until = NULL, totp_last_step = ?, updated_at = ?
      WHERE user_id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
    `).run(step, new Date().toISOString(), asId(userId), step);
    if (updated.changes !== 1) throw fail(403, 'Bu doğrulama kodu zaten kullanıldı');
  });
  return true;
}

function readTotpSecret(database, userId, sessionSecret) {
  const row = ensureSecurity(database, userId);
  if (totpLocked(row)) throw fail(429, 'Çok fazla hatalı doğrulama kodu. 15 dakika bekleyin.');
  if (!row.totp_secret_enc) throw fail(400, 'İki adımlı doğrulama henüz kurulmadı');
  let secret = '';
  try {
    secret = decryptSecret(row.totp_secret_enc, sessionSecret);
  } catch {
    throw fail(500, 'Doğrulama sırrı okunamadı');
  }
  return { row, secret };
}

function confirmTwoFactor(database, user, code, sessionSecret, ip) {
  const id = asId(user?.id);
  const { row, secret } = readTotpSecret(database, id, sessionSecret);
  if (Number(row.totp_enabled) === 1) throw fail(409, 'İki adımlı doğrulama zaten açık');
  if (!acceptTotp(database, id, secret, code)) recordTotpFailure(database, id);
  withImmediate(database, () => {
    database.prepare('UPDATE user_security SET totp_enabled = 1, updated_at = ? WHERE user_id = ?').run(new Date().toISOString(), id);
    writeAudit(database, {
      actorId: id,
      targetId: id,
      action: 'totp_setup',
      oldValue: { enabled: false },
      newValue: { enabled: true },
      ip
    });
  });
  return { enabled: true };
}

function consumeBackup(database, userId, code, sessionSecret) {
  const normalized = normalizeBackup(code);
  if (normalized.length !== 10) return false;
  const expected = Buffer.from(hashBackup(sessionSecret, normalized), 'hex');
  const rows = database.prepare('SELECT id, code_hash, used_at FROM totp_backup_codes WHERE user_id = ?').all(asId(userId));
  for (const row of rows) {
    if (row.used_at) continue;
    const actual = Buffer.from(String(row.code_hash || ''), 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) continue;
    const used = database.prepare('UPDATE totp_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(new Date().toISOString(), row.id);
    return used.changes === 1;
  }
  return false;
}

function verifyFactor(database, user, code, sessionSecret) {
  const id = asId(user?.id);
  const { row, secret } = readTotpSecret(database, id, sessionSecret);
  if (Number(row.totp_enabled) !== 1) throw fail(403, 'İki adımlı doğrulama henüz onaylanmadı');
  if (acceptTotp(database, id, secret, code)) return { ok: true, method: 'totp' };
  const backup = withImmediate(database, () => consumeBackup(database, id, code, sessionSecret));
  if (backup) {
    database.prepare('UPDATE user_security SET totp_failures = 0, totp_locked_until = NULL, updated_at = ? WHERE user_id = ?').run(new Date().toISOString(), id);
    return { ok: true, method: 'backup' };
  }
  recordTotpFailure(database, id);
}

function disableTwoFactor(database, user, code, sessionSecret, ip) {
  if (user?.rank === 'admin' || user?.rank === 'moderator') {
    throw fail(403, 'Admin ve moderatör iki adımlı doğrulamayı kapatamaz');
  }
  const id = asId(user?.id);
  verifyFactor(database, { id, rank: user.rank }, code, sessionSecret);
  withImmediate(database, () => {
    database.prepare(`
      UPDATE user_security
      SET totp_secret_enc = NULL, totp_enabled = 0, totp_failures = 0, totp_locked_until = NULL, totp_last_step = NULL, updated_at = ?
      WHERE user_id = ?
    `).run(new Date().toISOString(), id);
    database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(id);
    writeAudit(database, {
      actorId: id,
      targetId: id,
      action: 'totp_disable',
      oldValue: { enabled: true },
      newValue: { enabled: false },
      ip
    });
  });
  return { enabled: false };
}

function resetTwoFactor(database, actor, target, ip, options = {}) {
  if (actor?.rank !== 'admin') throw fail(403, 'İki adımlı doğrulamayı yalnızca yönetici sıfırlayabilir');
  const id = asId(target.id);
  if (!id || asId(actor.id) === id) throw fail(403, 'Kendi iki adımlı doğrulamanı bu yoldan sıfırlayamazsın');
  if (target.rank === 'admin' && options.reauth !== true) {
    throw fail(403, 'Yönetici doğrulamasını sıfırlamak için şifre ve doğrulama kodu gerekli', { code: 'reauth_required' });
  }
  if (target.rank !== 'admin') assertOutranks(actor, target, 'Yalnızca alt rütbenin doğrulaması sıfırlanabilir');
  withImmediate(database, () => {
    const before = ensureSecurity(database, id);
    database.prepare(`
      UPDATE user_security
      SET totp_secret_enc = NULL, totp_enabled = 0, totp_failures = 0, totp_locked_until = NULL, totp_last_step = NULL, updated_at = ?
      WHERE user_id = ?
    `).run(new Date().toISOString(), id);
    database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(id);
    writeAudit(database, {
      actorId: actor.id,
      targetId: id,
      action: 'totp_reset',
      oldValue: { enabled: Number(before.totp_enabled) === 1 },
      newValue: { enabled: false, reauth: target.rank === 'admin' },
      ip
    });
  });
}

function columnRole(rank, previous) {
  if (rank === 'player') return previous === 'modder' ? 'modder' : 'user';
  return rank;
}

function assignRole(database, actor, target, nextRole, ip, options = {}) {
  if (actor?.rank !== 'admin') throw fail(403, 'Rütbe ataması yalnızca yöneticiye açık');
  assertTwoFactor(actor);
  if (!RANKS.includes(nextRole)) throw fail(400, 'Rütbe geçersiz');
  const targetId = asId(target?.id);
  if (!targetId) throw fail(400, 'Kullanıcı kimliği geçersiz');
  return withImmediate(database, () => {
    let current = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(targetId);
    if (!current) {
      assignInitial(database, target);
      current = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(targetId);
    }
    if (!current) throw fail(404, 'Kullanıcı rütbesi bulunamadı');
    const oldRole = current.role;
    if (oldRole === nextRole) return { role: oldRole, changed: false };
    const admins = Number(database.prepare("SELECT COUNT(*) AS total FROM user_roles WHERE role = 'admin'").get().total);
    if (oldRole === 'admin' && nextRole !== 'admin' && admins <= 1) {
      throw fail(409, 'Son yönetici düşürülemez');
    }
    if (asId(actor.id) === targetId && oldRole === 'admin' && nextRole !== 'admin') {
      throw fail(403, 'Yönetici kendi rütbesini bu yoldan düşüremez');
    }
    const needsReauth = oldRole === 'admin' || nextRole === 'admin';
    if (needsReauth && options.reauth !== true) {
      throw fail(403, 'Bu rütbe değişikliği için şifre ve doğrulama kodu gerekli', { code: 'reauth_required' });
    }
    if (!(oldRole === 'admin' && asId(actor.id) !== targetId) && !outranks(actor.rank, oldRole)) {
      throw fail(403, 'Yalnızca alt rütbelere işlem yapılabilir');
    }
    const previous = database.prepare('SELECT role FROM users WHERE id = ?').get(targetId);
    database.prepare('UPDATE user_roles SET role = ?, updated_at = ?, updated_by = ? WHERE user_id = ?').run(
      nextRole, new Date().toISOString(), asId(actor.id), targetId
    );
    database.prepare('UPDATE users SET role = ? WHERE id = ?').run(columnRole(nextRole, previous?.role), targetId);
    writeAudit(database, {
      actorId: actor.id,
      targetId,
      action: 'role_change',
      oldValue: { role: oldRole },
      newValue: { role: nextRole, reauth: needsReauth === true },
      ip
    });
    return { role: nextRole, changed: true };
  });
}

function muteActive(row, now = Date.now()) {
  if (!row) return false;
  if (Number(row.mute_permanent) === 1) return true;
  if (!row.muted_until) return false;
  const until = Date.parse(row.muted_until);
  return Number.isFinite(until) && until > now;
}

function setMute(database, actor, target, input, ip) {
  assertOutranks(actor, target, actor?.rank === 'moderator'
    ? 'Moderatör, moderatör veya yöneticiyi susturamaz'
    : 'Yalnızca alt rütbelere işlem yapılabilir');
  const duration = typeof input?.duration === 'string' ? input.duration : 'PERMANENT';
  if (!Object.hasOwn(DURATIONS, duration)) throw fail(400, 'Susturma süresi geçersiz');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 500) throw fail(400, 'Susturma sebebi 1-500 karakter olmalı');
  const permanent = duration === 'PERMANENT';
  const until = permanent ? null : new Date(Date.now() + DURATIONS[duration]).toISOString();
  const targetId = asId(target.id);
  withImmediate(database, () => {
    const before = ensureSecurity(database, targetId);
    database.prepare(`
      UPDATE user_security
      SET muted_until = ?, mute_permanent = ?, mute_reason = ?, updated_at = ?
      WHERE user_id = ?
    `).run(until, permanent ? 1 : 0, reason, new Date().toISOString(), targetId);
    writeAudit(database, {
      actorId: actor.id,
      targetId,
      action: 'mute',
      oldValue: { until: before.muted_until || null, permanent: Number(before.mute_permanent) === 1 },
      newValue: { until, permanent, reason },
      ip
    });
  });
  return { muted: true, permanent, until, reason };
}

function clearMute(database, actor, target, ip) {
  assertOutranks(actor, target);
  const targetId = asId(target.id);
  withImmediate(database, () => {
    const before = ensureSecurity(database, targetId);
    database.prepare(`
      UPDATE user_security
      SET muted_until = NULL, mute_permanent = 0, mute_reason = NULL, updated_at = ?
      WHERE user_id = ?
    `).run(new Date().toISOString(), targetId);
    writeAudit(database, {
      actorId: actor.id,
      targetId,
      action: 'unmute',
      oldValue: { until: before.muted_until || null, permanent: Number(before.mute_permanent) === 1 },
      newValue: { muted: false },
      ip
    });
  });
  return { muted: false };
}

function assertCanChat(database, userId) {
  const row = securityRow(database, userId);
  if (muteActive(row)) {
    throw fail(403, row.mute_reason ? `Sohbet susturması: ${row.mute_reason}` : 'Sohbetin susturulmuş');
  }
}

function postChat(database, user, text) {
  const body = typeof text === 'string' ? text.replace(/[<>]/g, '').trim() : '';
  if (body.length < 1 || body.length > 500) throw fail(400, 'Mesaj 1-500 karakter olmalı');
  assertCanChat(database, user.id);
  const created = database.prepare('INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)').run(
    asId(user.id), body, new Date().toISOString()
  );
  return { id: asId(created.lastInsertRowid), body };
}

function createReport(database, reporter, targetId, reason) {
  const target = asId(targetId);
  if (!target || target === asId(reporter.id)) throw fail(400, 'Rapor hedefi geçersiz');
  const found = database.prepare('SELECT id FROM users WHERE id = ?').get(target);
  if (!found) throw fail(404, 'Kullanıcı bulunamadı');
  const text = typeof reason === 'string' ? reason.replace(/[<>]/g, '').trim() : '';
  if (text.length < 3 || text.length > 500) throw fail(400, 'Rapor sebebi 3-500 karakter olmalı');
  const created = database.prepare(`
    INSERT INTO user_reports (reporter_id, target_id, reason, status, created_at)
    VALUES (?, ?, ?, 'open', ?)
  `).run(asId(reporter.id), target, text, new Date().toISOString());
  return { id: asId(created.lastInsertRowid) };
}

function listReports(database) {
  return database.prepare(`
    SELECT user_reports.id, user_reports.reason, user_reports.status, user_reports.created_at,
      user_reports.target_id, target.username AS target_name,
      user_reports.reporter_id, reporter.username AS reporter_name
    FROM user_reports
    JOIN users target ON target.id = user_reports.target_id
    JOIN users reporter ON reporter.id = user_reports.reporter_id
    ORDER BY user_reports.id DESC
    LIMIT 100
  `).all().map(row => ({
    id: asId(row.id),
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    targetId: asId(row.target_id),
    targetName: row.target_name,
    reporterId: asId(row.reporter_id),
    reporterName: row.reporter_name
  }));
}

function supportProfile(database, targetId) {
  const id = asId(targetId);
  const user = database.prepare(`
    SELECT id, email, username, verified, role, banned, isBanned, banReason, banType, bannedUntil, created_at
    FROM users WHERE id = ?
  `).get(id);
  if (!user) return null;
  const rank = rankOf(database, id);
  const matches = database.prepare(`
    SELECT online_fixtures.id, online_fixtures.home_score, online_fixtures.away_score, online_fixtures.played_at,
      hu.username AS home_name, au.username AS away_name
    FROM online_fixtures
    JOIN users hu ON hu.id = online_fixtures.home_user_id
    JOIN users au ON au.id = online_fixtures.away_user_id
    WHERE (online_fixtures.home_user_id = ? OR online_fixtures.away_user_id = ?)
      AND online_fixtures.status = 'played'
    ORDER BY online_fixtures.id DESC
    LIMIT 30
  `).all(id, id).map(row => ({
    id: asId(row.id),
    home: row.home_name,
    away: row.away_name,
    homeScore: row.home_score,
    awayScore: row.away_score,
    playedAt: row.played_at
  }));
  const ledger = database.prepare(`
    SELECT id, amount, balance_after, currency, reason, created_at, tag
    FROM coin_ledger WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(id).map(row => ({
    id: asId(row.id),
    amount: row.amount,
    balanceAfter: row.balance_after,
    currency: row.currency,
    reason: row.reason,
    createdAt: row.created_at,
    tag: row.tag
  }));
  return {
    user: {
      id,
      username: user.username,
      email: maskEmail(user.email),
      role: rank,
      verified: Boolean(user.verified),
      banned: Boolean(user.isBanned || user.banned),
      banReason: user.banReason || null,
      banType: user.banType || null,
      bannedUntil: user.bannedUntil || null,
      createdAt: user.created_at
    },
    matches,
    ledger
  };
}

function recordViewPii(database, actor, targets, ip) {
  const ids = [...new Set((targets || []).map(asId).filter(Boolean))];
  if (!ids.length) return;
  withImmediate(database, () => {
    for (const targetId of ids) {
      writeAudit(database, {
        actorId: actor.id,
        targetId,
        action: 'view_pii',
        oldValue: null,
        newValue: { fields: ['email', 'deviceId'] },
        ip
      });
    }
  });
}

function actingAdminEmail(user) {
  return user?.rank === 'admin' ? canonicalEmail(user.email) : '';
}

module.exports = {
  RANKS,
  RANK_LEVEL,
  ACTIONS,
  DURATIONS,
  installRanks,
  ensureRank,
  rankOf,
  level,
  outranks,
  twoFactorRequired,
  assertTwoFactor,
  assertOutranks,
  maskEmail,
  writeAudit,
  listAudit,
  base32Encode,
  base32Decode,
  TOTP_FAIL_LIMIT,
  PENDING_2FA_MS,
  totpCode,
  matchTotpStep,
  verifyTotp,
  encryptSecret,
  decryptSecret,
  setupTwoFactor,
  confirmTwoFactor,
  verifyFactor,
  disableTwoFactor,
  recordTotpFailure,
  acceptTotp,
  resetTwoFactor,
  assignRole,
  muteActive,
  setMute,
  clearMute,
  assertCanChat,
  postChat,
  createReport,
  listReports,
  supportProfile,
  recordViewPii,
  actingAdminEmail,
  withImmediate
};
