const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { renderMarkdown, resolveHref, KVKK_VERSION } = require('../lib/legal');

const root = path.join(__dirname, '..');

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
    const finish = error => {
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

function request({ port, method, pathname, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers,
      agent: false
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
    if (body) req.end(body);
    else req.end();
  });
}

function baseEnv(port, databaseFile) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(path.dirname(databaseFile), 'no.json'),
    ADMIN_EMAIL: 'admin-legal@example.com',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: ''
  };
  delete env.NODE_ENV;
  delete env.TRUST_PROXY;
  delete env.OMNI_HOSTED;
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;
  delete env.ONLINE_LOCK_TRIGGER;
  delete env.SESSION_SECRET;
  delete env.BREVO_API_KEY;
  delete env.MAIL_FROM_EMAIL;
  return env;
}

function startSmtpCapture() {
  return new Promise((resolve, reject) => {
    const messages = [];
    const server = net.createServer(socket => {
      let buffer = '';
      let dataMode = false;
      let current = '';
      socket.write('220 omni-test ESMTP\r\n');
      socket.on('data', chunk => {
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
              try { socket.write('250 OK\r\n'); } catch {}
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
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, messages, close: () => new Promise(done => server.close(done)) });
    });
    server.on('error', reject);
  });
}

async function postRegister(port, body) {
  const raw = JSON.stringify(body);
  return request({
    port,
    method: 'POST',
    pathname: '/api/auth/register',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    body: raw
  });
}

test('legal markdown remaps public links and drops the internal inventory href', () => {
  assert.equal(resolveHref('./cerez-politikasi.md'), '/cerez');
  assert.equal(resolveHref('/aydinlatma-metni'), '/kvkk');
  assert.equal(resolveHref('./veri-envanteri.md'), null);
  const html = renderMarkdown('Ayrıntı için [işleme envanterindeki boşluklar](./veri-envanteri.md) ve [Çerez Politikası](./cerez-politikasi.md).');
  assert.equal(html.includes('href="'), true);
  assert.match(html, /href="\/cerez"/);
  assert.equal(/href="[^"]*veri-envanteri/.test(html), false);
  assert.match(html, /işleme envanterindeki boşluklar/);
});

test('legal markdown escapes raw HTML and drops javascript hrefs', () => {
  const html = renderMarkdown('Merhaba <script>alert(1)</script> ve [kötü](javascript:alert(1)) ile [Çerez Politikası](./cerez-politikasi.md).');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(/href="javascript:/i.test(html), false);
  assert.match(html, /kötü/);
  assert.match(html, /href="\/cerez"/);
});

test('GET /kvkk, /gizlilik and /cerez return 200 legal pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-legal-'));
  const port = await freePort();
  const running = spawnServer(baseEnv(port, path.join(dir, 'test.db')));
  try {
    await running.ready;
    const pages = [
      ['/kvkk', 'KVKK Aydınlatma Metni'],
      ['/gizlilik', 'Gizlilik Politikası'],
      ['/cerez', 'Çerez Politikası']
    ];
    for (const [pathname, title] of pages) {
      const res = await request({ port, method: 'GET', pathname });
      assert.equal(res.status, 200, pathname);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.text, new RegExp(title));
      assert.match(res.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(res.text.includes('veri-envanteri'), false);
      assert.equal(/TASLAK|avukat onayı/i.test(res.text), false);
      assert.match(res.text, /href="\/kvkk"/);
      assert.match(res.text, /href="\/gizlilik"/);
      assert.match(res.text, /href="\/cerez"/);
      assert.equal(res.text.includes('<script>alert'), false);
    }
    const home = await request({ port, method: 'GET', pathname: '/' });
    assert.equal(home.status, 200);
    assert.match(home.text, /id="registerKvkk"/);
    assert.match(home.text, /Aydınlatma Metni'ni okudum/);
    assert.match(home.text, /id="registerAge"/);
    assert.match(home.text, /13 yaşından büyüğüm/);
    assert.match(home.text, /href="\/kvkk"/);
    assert.match(home.text, /class="site-footer"/);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/auth/register requires KVKK and age confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-legal-reg-'));
  const port = await freePort();
  const running = spawnServer(baseEnv(port, path.join(dir, 'test.db')));
  try {
    await running.ready;
    const payload = {
      username: 'legaluser',
      email: 'legal-user@example.com',
      password: 'password12',
      confirmation: 'password12'
    };
    const missingKvkk = await postRegister(port, { ...payload, ageConfirmed: true });
    assert.equal(missingKvkk.status, 400);
    assert.match(missingKvkk.json.error, /Aydınlatma Metni/);
    const deniedKvkk = await postRegister(port, { ...payload, kvkkAccepted: false, ageConfirmed: true });
    assert.equal(deniedKvkk.status, 400);
    assert.match(deniedKvkk.json.error, /Aydınlatma Metni/);
    const missingAge = await postRegister(port, { ...payload, kvkkAccepted: true });
    assert.equal(missingAge.status, 400);
    assert.match(missingAge.json.error, /13 yaşından büyük/);
    const deniedAge = await postRegister(port, { ...payload, kvkkAccepted: true, ageConfirmed: false });
    assert.equal(deniedAge.status, 400);
    assert.match(deniedAge.json.error, /13 yaşından büyük/);
    const accepted = await postRegister(port, { ...payload, kvkkAccepted: true, ageConfirmed: true });
    assert.equal(accepted.status, 503);
    assert.match(accepted.json.error, /E-posta gönderimi/);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('successful register stores kvkk_accepted_at and kvkk_version; existing users stay null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-legal-store-'));
  const databaseFile = path.join(dir, 'test.db');
  const seed = new DatabaseSync(databaseFile);
  seed.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL DEFAULT '',
      avatar_data TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      isBanned INTEGER NOT NULL DEFAULT 0,
      banReason TEXT,
      banNote TEXT,
      banType TEXT NOT NULL DEFAULT 'PERMANENT' CHECK (banType IN ('PERMANENT', 'TEMPORARY')),
      bannedAt TEXT,
      bannedUntil TEXT,
      deviceId TEXT,
      isDeviceBanned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO users (email, username, password_hash, password_salt, verified, created_at)
    VALUES ('eski@example.com', 'eski', 'hash', 'salt', 1, '2026-01-01T00:00:00.000Z');
  `);
  seed.close();

  const smtp = await startSmtpCapture();
  const port = await freePort();
  const env = baseEnv(port, databaseFile);
  env.SMTP_HOST = '127.0.0.1';
  env.SMTP_PORT = String(smtp.port);
  env.SMTP_USER = 'omni-test';
  env.SMTP_PASS = 'omni-test-pass';
  env.EMAIL_FROM = 'noreply@example.com';
  const running = spawnServer(env);
  try {
    await running.ready;
    const before = new DatabaseSync(databaseFile, { readOnly: true });
    const columns = new Set(before.prepare('PRAGMA table_info(users)').all().map(column => column.name));
    assert.equal(columns.has('kvkk_accepted_at'), true);
    assert.equal(columns.has('kvkk_version'), true);
    const existing = before.prepare('SELECT kvkk_accepted_at, kvkk_version FROM users WHERE email = ?').get('eski@example.com');
    assert.equal(existing.kvkk_accepted_at, null);
    assert.equal(existing.kvkk_version, null);
    before.close();

    const started = Date.now();
    const accepted = await postRegister(port, {
      username: 'yenikullanici',
      email: 'yeni@example.com',
      password: 'password12',
      confirmation: 'password12',
      kvkkAccepted: true,
      ageConfirmed: true
    });
    assert.equal(accepted.status, 201, accepted.text);
    const after = new DatabaseSync(databaseFile, { readOnly: true });
    const created = after.prepare('SELECT kvkk_accepted_at, kvkk_version FROM users WHERE email = ?').get('yeni@example.com');
    assert.equal(created.kvkk_version, KVKK_VERSION);
    assert.equal(created.kvkk_version, '2026-11-19');
    assert.match(created.kvkk_accepted_at, /^\d{4}-\d{2}-\d{2}T/);
    const acceptedAt = Date.parse(created.kvkk_accepted_at);
    assert.equal(Number.isNaN(acceptedAt), false);
    assert.equal(acceptedAt >= started - 1000, true);
    assert.equal(acceptedAt <= Date.now() + 1000, true);
    const stillNull = after.prepare('SELECT kvkk_accepted_at, kvkk_version FROM users WHERE email = ?').get('eski@example.com');
    assert.equal(stillNull.kvkk_accepted_at, null);
    assert.equal(stillNull.kvkk_version, null);
    after.close();
  } finally {
    await stopServer(running.child);
    await smtp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
