const LIMIT = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOCK_MESSAGE = 'Çok fazla hatalı şifre denemesi. Ücretsiz açılış 15 dakika boyunca kilitli.';
const RETRY_MESSAGE = 'Ücretsiz açılış için şifreni yeniden gir';

function isBusy(error) {
  const text = String(error?.message || '');
  return /database is locked|database is busy|SQLITE_BUSY|TRANSACTION_TIMEOUT/i.test(text);
}

function isUnique(error) {
  if (Number(error?.errcode) === 2067) return true;
  return /UNIQUE constraint/i.test(String(error?.message || ''));
}

function createPackPasswordGuard(database) {
  const readAttempt = database.prepare('SELECT failures, locked_until FROM admin_pack_password_attempts WHERE user_id = ?');
  const insertAttempt = database.prepare('INSERT INTO admin_pack_password_attempts (user_id, failures, locked_until) VALUES (?, 1, NULL)');
  const bumpAttempt = database.prepare(`
    UPDATE admin_pack_password_attempts
    SET failures = CASE
          WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1
          ELSE MIN(failures + 1, ?)
        END,
        locked_until = CASE
          WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL
          WHEN failures + 1 >= ? THEN ?
          ELSE NULL
        END
    WHERE user_id = ?
      AND (locked_until IS NULL OR locked_until <= ?)
  `);
  const clearAttempt = database.prepare('DELETE FROM admin_pack_password_attempts WHERE user_id = ?');

  function withImmediate(fn) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        database.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusy(error) && attempt < 7) continue;
        throw error;
      }
      try {
        const result = fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        if (isBusy(error) && attempt < 7) continue;
        throw error;
      }
    }
    const busy = new Error('Şifre kilidi meşgul');
    busy.status = 503;
    throw busy;
  }

  function lockedResult() {
    return { locked: true, error: LOCK_MESSAGE };
  }

  function readLock(userId, now) {
    const row = readAttempt.get(userId);
    const until = Number(row?.locked_until || 0);
    if (!until || until <= now) return null;
    return lockedResult();
  }

  function recordFailure(userId, now) {
    const lockAt = now + LOCK_MS;
    return withImmediate(() => {
      const updated = bumpAttempt.run(now, LIMIT, now, LIMIT, lockAt, userId, now);
      if (updated.changes !== 1) {
        try {
          insertAttempt.run(userId);
        } catch (error) {
          if (isUnique(error)) return lockedResult();
          throw error;
        }
      }
      const row = readAttempt.get(userId);
      const until = Number(row?.locked_until || 0);
      const failures = Number(row?.failures || 0);
      if (failures > LIMIT) {
        const overflow = new Error('Şifre denemesi sınırı aşıldı');
        overflow.status = 500;
        throw overflow;
      }
      if (until > now) return lockedResult();
      return { locked: false, error: RETRY_MESSAGE };
    });
  }

  function recordSuccess(userId, now) {
    return withImmediate(() => {
      const active = readLock(userId, now);
      if (active) return { ok: false, ...active };
      clearAttempt.run(userId);
      return { ok: true };
    });
  }

  return { readLock, recordFailure, recordSuccess };
}

function installPasswordAttemptCap(database) {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_pack_password_attempts'").get();
  if (!row || String(row.sql).includes('failures <= 5')) return;
  database.exec(`
    CREATE TABLE admin_pack_password_attempts_next (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= 5),
      locked_until INTEGER
    );
    INSERT INTO admin_pack_password_attempts_next (user_id, failures, locked_until)
    SELECT user_id, MIN(failures, 5), locked_until FROM admin_pack_password_attempts;
    DROP TABLE admin_pack_password_attempts;
    ALTER TABLE admin_pack_password_attempts_next RENAME TO admin_pack_password_attempts;
  `);
}

module.exports = {
  LIMIT,
  LOCK_MS,
  LOCK_MESSAGE,
  RETRY_MESSAGE,
  createPackPasswordGuard,
  installPasswordAttemptCap
};
