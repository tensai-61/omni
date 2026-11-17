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
const email = 'cookie-secure@example.com';
const password = 'CookieTest1';
const warningText = 'Secure oturum çerezleri HTTPS gerektirir.';

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

function serverEnv(databaseFile, port, options) {
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.COOKIE_SECURE;
  delete env.TRUST_PROXY;
  if (options.nodeEnv !== undefined) env.NODE_ENV = options.nodeEnv;
  if (options.cookieSecure !== undefined) env.COOKIE_SECURE = options.cookieSecure;
  if (options.trustProxy !== undefined) env.TRUST_PROXY = options.trustProxy;
  env.HOST = options.hostBind || '127.0.0.1';
  env.PORT = String(port);
  env.DATABASE_FILE = databaseFile;
  env.DATA_FILE = path.join(path.dirname(databaseFile), 'no-legacy.json');
  env.SMTP_HOST = '';
  env.SMTP_PORT = '';
  env.SMTP_USER = '';
  env.SMTP_PASS = '';
  env.EMAIL_FROM = '';
  env.ADMIN_EMAIL = 'admin-unused@example.com';
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

function insertVerifiedUser(databaseFile) {
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, created_at)
    VALUES (?, 'cookieuser', ?, ?, 1, 'user', ?)
  `).run(email, hash.toString('hex'), salt.toString('hex'), new Date().toISOString());
  db.close();
}

function httpCall({ port, method, pathname, host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      agent: false,
      headers: {
        Host: host,
        Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setCookieHeader(res) {
  const value = res.headers['set-cookie'];
  assert.ok(value, `missing Set-Cookie (${res.status}): ${res.body}`);
  return (Array.isArray(value) ? value : [value]).join('\n');
}

function hasSecure(header) {
  return /(?:^|;\s*)Secure(?:\s*;|\s*$)/.test(header);
}

async function loginAndLogout(port, { host, headers = {} }) {
  const login = await httpCall({
    port,
    method: 'POST',
    pathname: '/api/auth/login',
    host,
    headers,
    body: JSON.stringify({ email, password })
  });
  assert.equal(login.status, 200, login.body);
  const loginCookie = setCookieHeader(login);
  assert.match(loginCookie, /turnuva_session=/);
  assert.match(loginCookie, /HttpOnly/);
  assert.match(loginCookie, /SameSite=Strict/);
  assert.match(loginCookie, /Max-Age=2592000(?:;|$)/);
  const token = /turnuva_session=([^;]+)/.exec(loginCookie)[1];
  const logout = await httpCall({
    port,
    method: 'POST',
    pathname: '/api/auth/logout',
    host,
    headers: { ...headers, Cookie: `turnuva_session=${token}` }
  });
  assert.equal(logout.status, 200, logout.body);
  const logoutCookie = setCookieHeader(logout);
  assert.match(logoutCookie, /turnuva_session=/);
  assert.match(logoutCookie, /HttpOnly/);
  assert.match(logoutCookie, /SameSite=Strict/);
  assert.match(logoutCookie, /Max-Age=0(?:;|$)/);
  return { loginCookie, logoutCookie };
}

async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-secure-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const running = spawnServer(serverEnv(databaseFile, port, options));
  try {
    await running.ready;
    if (options.withUser) insertVerifiedUser(databaseFile);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fn({ port, logs: running.logs });
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function expectCookieSecure(cookies, secure) {
  assert.equal(hasSecure(cookies.loginCookie), secure, cookies.loginCookie);
  assert.equal(hasSecure(cookies.logoutCookie), secure, cookies.logoutCookie);
}

test('local request omits Secure', async () => {
  await withServer({ withUser: true }, async ({ port }) => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const cookies = await loginAndLogout(port, { host });
      expectCookieSecure(cookies, false);
    }
  });
});

test('foreign Host sets Secure', async () => {
  await withServer({ withUser: true }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: 'example.com' });
    expectCookieSecure(cookies, true);
  });
});

test('TRUST_PROXY=1 and X-Forwarded-Proto https on a foreign Host sets Secure', async () => {
  await withServer({ withUser: true, trustProxy: '1' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, {
      host: 'example.com',
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    expectCookieSecure(cookies, true);
  });
});

test('X-Forwarded-Proto without TRUST_PROXY does not make a local request HTTPS', async () => {
  await withServer({ withUser: true }, async ({ port }) => {
    const cookies = await loginAndLogout(port, {
      host: 'localhost',
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    expectCookieSecure(cookies, false);
  });
});

test('TRUST_PROXY=1 does not treat a loopback socket as local', async () => {
  await withServer({ withUser: true, trustProxy: '1' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: '127.0.0.1' });
    expectCookieSecure(cookies, true);
  });
});

test('COOKIE_SECURE=always sets Secure on a local request', async () => {
  await withServer({ withUser: true, cookieSecure: 'always' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: 'localhost' });
    expectCookieSecure(cookies, true);
  });
});

test('COOKIE_SECURE=never omits Secure on a foreign Host', async () => {
  await withServer({ withUser: true, cookieSecure: 'never' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: 'example.com' });
    expectCookieSecure(cookies, false);
  });
});

test('NODE_ENV=production sets Secure even on a local request', async () => {
  await withServer({ withUser: true, nodeEnv: 'production' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: '127.0.0.1' });
    expectCookieSecure(cookies, true);
  });
});

test('NODE_ENV=production overrides COOKIE_SECURE=never', async () => {
  await withServer({ withUser: true, nodeEnv: 'production', cookieSecure: 'never' }, async ({ port }) => {
    const cookies = await loginAndLogout(port, { host: 'localhost' });
    expectCookieSecure(cookies, true);
  });
});

test('startup warns when HOST is not loopback and TRUST_PROXY is off', async () => {
  await withServer({ hostBind: '0.0.0.0' }, async ({ logs }) => {
    assert.match(logs.err, new RegExp(warningText));
  });
});

test('startup stays quiet for a loopback HOST', async () => {
  await withServer({ hostBind: '127.0.0.1' }, async ({ logs }) => {
    assert.equal(logs.err.includes(warningText), false, logs.err);
  });
});

test('startup stays quiet when TRUST_PROXY=1', async () => {
  await withServer({ hostBind: '0.0.0.0', trustProxy: '1' }, async ({ logs }) => {
    assert.equal(logs.err.includes(warningText), false, logs.err);
  });
});
