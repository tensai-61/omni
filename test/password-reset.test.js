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

const root = path.join(__dirname, '..');
const email = 'reset-user@example.com';
const password = 'EskiSifre12';
const nextPassword = 'YeniSifre34';
const receipt = 'E-posta adresin sistemde varsa şifre sıfırlama bağlantısı gönderildi.';

function decodeMail(raw) {
  return String(raw)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function resetTokenFromMail(raw) {
  const decoded = decodeMail(raw);
  const match = decoded.match(/http:\/\/127\.0\.0\.1:3999\/\?reset=([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
    probe.on('error', reject);
  });
}

function waitForMessages(smtp, count, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (smtp.messages.length >= count) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`expected ${count} mails, got ${smtp.messages.length}`));
      }
      setTimeout(poll, 20);
    })();
  });
}

function startSmtpCapture(options = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const delayMs = Number(options.delayMs) || 0;
    const server = net.createServer((socket) => {
      let buffer = '';
      let dataMode = false;
      let current = '';
      socket.write('220 omni-test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const idx = buffer.indexOf('\r\n');
          if (idx < 0) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (dataMode) {
            if (line === '.') {
              messages.push(current);
              current = '';
              dataMode = false;
              const ack = () => { try { socket.write('250 OK\r\n'); } catch {} };
              if (delayMs) setTimeout(ack, delayMs);
              else ack();
            } else {
              current += `${line.startsWith('.') ? line.slice(1) : line}\n`;
            }
            continue;
          }
          const command = line.toUpperCase();
          if (command.startsWith('EHLO') || command.startsWith('HELO')) {
            socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
          } else if (command === 'DATA') {
            dataMode = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          } else if (command.startsWith('AUTH LOGIN')) {
            socket.write('235 2.7.0 OK\r\n');
          } else if (command.startsWith('AUTH')) {
            socket.write('235 2.7.0 OK\r\n');
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, messages, close: () => new Promise((done) => server.close(done)) });
    });
    server.on('error', reject);
  });
}

function serverEnv(databaseFile, port, options = {}) {
  const env = { ...process.env };
  for (const name of [
    'NODE_ENV', 'COOKIE_SECURE', 'TRUST_PROXY', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
    'BREVO_API_KEY', 'MAIL_FROM_EMAIL', 'MAIL_FROM_NAME', 'OMNI_HOSTED', 'APP_BASE_URL',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'
  ]) delete env[name];
  env.HOST = '127.0.0.1';
  env.PORT = String(port);
  env.DATABASE_FILE = databaseFile;
  env.DATA_FILE = path.join(path.dirname(databaseFile), 'no-legacy.json');
  env.ADMIN_EMAIL = 'admin-unused@example.com';
  if (options.smtp) {
    env.SMTP_HOST = '127.0.0.1';
    env.SMTP_PORT = String(options.smtp.port);
    env.SMTP_USER = 'omni-test';
    env.SMTP_PASS = 'omni-test-pass';
    env.EMAIL_FROM = 'noreply@example.com';
  }
  if (options.baseUrl) env.APP_BASE_URL = options.baseUrl;
  return env;
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = { out: '', err: '' };
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`server did not start\nstdout:\n${logs.out}\nstderr:\n${logs.err}`));
    }, 8000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    child.on('exit', (code, signal) => {
      finish(new Error(`server exited before ready (${code ?? signal})\nstdout:\n${logs.out}\nstderr:\n${logs.err}`));
    });
    (function poll() {
      if (settled) return;
      if (logs.out.includes('Omni.verse hazır:')) finish();
      else setTimeout(poll, 20);
    })();
  });
  return { child, logs, ready };
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function insertUser(databaseFile, { userEmail = email, userPassword = password, verified = 1, username = 'resetuser' } = {}) {
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(userPassword, salt, 64);
  const result = db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, created_at)
    VALUES (?, ?, ?, ?, ?, 'user', ?)
  `).run(userEmail, username, hash.toString('hex'), salt.toString('hex'), verified, new Date().toISOString());
  const userId = Number(result.lastInsertRowid);
  db.close();
  return userId;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function insertResetToken(databaseFile, userId, token, expiresAt) {
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    expiresAt
  );
  db.close();
}

function tokenRows(databaseFile, userId) {
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  const rows = db.prepare('SELECT token_hash, user_id, expires_at FROM password_reset_tokens WHERE user_id = ?').all(userId);
  db.close();
  return rows;
}

function sessionCount(databaseFile, userId) {
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  const row = db.prepare('SELECT COUNT(*) AS total FROM user_sessions WHERE user_id = ?').get(userId);
  db.close();
  return Number(row.total);
}

function httpCall({ port, method, pathname, body, headers = {} }) {
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
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(res) {
  const value = res.headers['set-cookie'];
  if (!value) return '';
  return (Array.isArray(value) ? value : [value]).join('\n');
}

async function login(port, userEmail, userPassword) {
  return httpCall({
    port,
    method: 'POST',
    pathname: '/api/auth/login',
    body: JSON.stringify({ email: userEmail, password: userPassword })
  });
}

async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reset-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const running = spawnServer(serverEnv(databaseFile, port, options));
  try {
    await running.ready;
    await fn({ port, databaseFile, logs: running.logs });
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('forgot-password returns the same generic receipt and does not enumerate users', async () => {
  await withServer({}, async ({ port, databaseFile }) => {
    const userId = insertUser(databaseFile);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const known = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/forgot-password',
      body: JSON.stringify({ email })
    });
    const unknown = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/forgot-password',
      body: JSON.stringify({ email: 'yok@example.com' })
    });
    assert.equal(known.status, 200, known.body);
    assert.equal(unknown.status, 200, unknown.body);
    assert.deepEqual(known.json, unknown.json);
    assert.equal(known.json.ok, true);
    assert.equal(known.json.message, receipt);
    assert.equal(tokenRows(databaseFile, userId).length, 0);
  });
});

test('forgot-password with mail configured sends a hashed single-use token and invalidates earlier ones', async () => {
  const smtp = await startSmtpCapture();
  try {
    await withServer({ smtp, baseUrl: 'http://127.0.0.1:3999' }, async ({ port, databaseFile }) => {
      const userId = insertUser(databaseFile);
      const unverifiedId = insertUser(databaseFile, {
        userEmail: 'unverified@example.com',
        username: 'unverified',
        verified: 0
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const first = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email })
      });
      assert.equal(first.status, 200, first.body);
      assert.equal(first.json.message, receipt);
      await waitForMessages(smtp, 1);
      assert.equal(smtp.messages.length, 1, smtp.messages.join('\n---\n'));
      const firstToken = resetTokenFromMail(smtp.messages[0]);
      assert.ok(firstToken, decodeMail(smtp.messages[0]));
      const firstRows = tokenRows(databaseFile, userId);
      assert.equal(firstRows.length, 1);
      assert.equal(firstRows[0].token_hash, hashToken(firstToken));
      assert.equal(smtp.messages[0].includes(firstRows[0].token_hash), false);
      const remaining = firstRows[0].expires_at - Date.now();
      assert.ok(remaining > 20 * 60 * 1000, remaining);
      assert.ok(remaining <= 30 * 60 * 1000, remaining);

      const second = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email })
      });
      assert.equal(second.status, 200, second.body);
      await waitForMessages(smtp, 2);
      assert.equal(smtp.messages.length, 2);
      const secondToken = resetTokenFromMail(smtp.messages[1]);
      assert.ok(secondToken, decodeMail(smtp.messages[1]));
      assert.notEqual(secondToken, firstToken);
      const rows = tokenRows(databaseFile, userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, hashToken(secondToken));

      const unusable = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/reset-password',
        body: JSON.stringify({ token: firstToken, password: nextPassword, confirmation: nextPassword })
      });
      assert.equal(unusable.status, 400, unusable.body);

      const skipped = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email: 'unverified@example.com' })
      });
      assert.equal(skipped.status, 200, skipped.body);
      assert.equal(skipped.json.message, receipt);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(smtp.messages.length, 2);
      assert.equal(tokenRows(databaseFile, unverifiedId).length, 0);
    });
  } finally {
    await smtp.close();
  }
});

test('reset-password updates the hash, drops sessions, and rejects reused or expired tokens', async () => {
  await withServer({}, async ({ port, databaseFile }) => {
    const userId = insertUser(databaseFile);
    const goodToken = crypto.randomBytes(32).toString('base64url');
    const expiredToken = crypto.randomBytes(32).toString('base64url');
    insertResetToken(databaseFile, userId, goodToken, Date.now() + 30 * 60 * 1000);
    insertResetToken(databaseFile, userId, expiredToken, Date.now() - 1000);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const opened = await login(port, email, password);
    assert.equal(opened.status, 200, opened.body);
    assert.equal(sessionCount(databaseFile, userId), 1);
    const sessionCookie = cookieFrom(opened);

    const expired = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/reset-password',
      body: JSON.stringify({ token: expiredToken, password: nextPassword, confirmation: nextPassword })
    });
    assert.equal(expired.status, 400, expired.body);
    assert.match(expired.json.error, /geçersiz veya süresi dolmuş/);

    const short = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/reset-password',
      body: JSON.stringify({ token: goodToken, password: 'short', confirmation: 'short' })
    });
    assert.equal(short.status, 400, short.body);

    const mismatch = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/reset-password',
      body: JSON.stringify({ token: goodToken, password: nextPassword, confirmation: 'DigerSifre99' })
    });
    assert.equal(mismatch.status, 400, mismatch.body);

    const reset = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/reset-password',
      headers: { Cookie: sessionCookie.split('\n')[0] },
      body: JSON.stringify({ token: goodToken, password: nextPassword, confirmation: nextPassword })
    });
    assert.equal(reset.status, 200, reset.body);
    assert.equal(reset.json.ok, true);
    assert.match(reset.json.message, /güncellendi/);
    assert.equal(tokenRows(databaseFile, userId).length, 0);
    assert.equal(sessionCount(databaseFile, userId), 0);
    assert.match(cookieFrom(reset), /Max-Age=0(?:;|$)/);

    const oldLogin = await login(port, email, password);
    assert.equal(oldLogin.status, 401, oldLogin.body);
    const newLogin = await login(port, email, nextPassword);
    assert.equal(newLogin.status, 200, newLogin.body);

    const replay = await httpCall({
      port,
      method: 'POST',
      pathname: '/api/auth/reset-password',
      body: JSON.stringify({ token: goodToken, password: 'BaskaSifre56', confirmation: 'BaskaSifre56' })
    });
    assert.equal(replay.status, 400, replay.body);
  });
});

test('forgot-password is rate-limited and the login page includes the reset link', async () => {
  await withServer({}, async ({ port }) => {
    const page = await httpCall({ port, method: 'GET', pathname: '/' });
    assert.equal(page.status, 200, page.body.slice(0, 200));
    assert.match(page.body, /Şifremi unuttum/);
    assert.match(page.body, /id="forgotForm"/);
    assert.match(page.body, /id="resetForm"/);
    assert.match(page.body, /function showResetView\(token\)[\s\S]*?searchParams\.delete\('reset'\)/);

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email: `rate${i}@example.com` })
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
  });
});

test('forgot-password returns equally quickly for registered and unknown emails while mail is slow', async () => {
  const smtp = await startSmtpCapture({ delayMs: 1000 });
  try {
    await withServer({ smtp, baseUrl: 'http://127.0.0.1:3999' }, async ({ port, databaseFile }) => {
      insertUser(databaseFile);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const warmup = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email: 'isinma@example.com' })
      });
      assert.equal(warmup.status, 200, warmup.body);

      const unknownStarted = Date.now();
      const unknown = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email: 'yok@example.com' })
      });
      const unknownMs = Date.now() - unknownStarted;
      const knownStarted = Date.now();
      const known = await httpCall({
        port,
        method: 'POST',
        pathname: '/api/auth/forgot-password',
        body: JSON.stringify({ email })
      });
      const knownMs = Date.now() - knownStarted;

      assert.equal(unknown.status, 200, unknown.body);
      assert.equal(known.status, 200, known.body);
      assert.deepEqual(known.json, unknown.json);
      assert.equal(known.json.message, receipt);
      assert.ok(unknownMs < 400, `unknown email took ${unknownMs}ms`);
      assert.ok(knownMs < 400, `registered email took ${knownMs}ms and waited for mail`);
      assert.ok(Math.abs(knownMs - unknownMs) < 300, `timing gap ${knownMs - unknownMs}ms`);
      await waitForMessages(smtp, 1);
    });
  } finally {
    await smtp.close();
  }
});

test('forgot-password silently caps reset mail at three per email per hour', async () => {
  const smtp = await startSmtpCapture();
  try {
    await withServer({ smtp, baseUrl: 'http://127.0.0.1:3999' }, async ({ port, databaseFile }) => {
      const userId = insertUser(databaseFile);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await httpCall({
          port,
          method: 'POST',
          pathname: '/api/auth/forgot-password',
          body: JSON.stringify({ email })
        });
        statuses.push(response.status);
        assert.equal(response.json.message, receipt);
        if (i < 3) await waitForMessages(smtp, i + 1);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(smtp.messages.length, 3);
      const lastToken = resetTokenFromMail(smtp.messages[2]);
      assert.ok(lastToken);
      const rows = tokenRows(databaseFile, userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, hashToken(lastToken));
    });
  } finally {
    await smtp.close();
  }
});
