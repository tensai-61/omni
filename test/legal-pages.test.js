const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, resolveHref } = require('../lib/legal');

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
      assert.equal(/href="[^"]*veri-envanteri/.test(res.text), false);
      assert.match(res.text, /href="\/kvkk"/);
      assert.match(res.text, /href="\/gizlilik"/);
      assert.match(res.text, /href="\/cerez"/);
    }
    const home = await request({ port, method: 'GET', pathname: '/' });
    assert.equal(home.status, 200);
    assert.match(home.text, /id="registerKvkk"/);
    assert.match(home.text, /Aydınlatma Metni'ni okudum/);
    assert.match(home.text, /href="\/kvkk"/);
    assert.match(home.text, /class="site-footer"/);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/auth/register requires the KVKK checkbox', async () => {
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
    async function post(body) {
      const raw = JSON.stringify(body);
      return request({
        port,
        method: 'POST',
        pathname: '/api/auth/register',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
        body: raw
      });
    }
    const missing = await post(payload);
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /Aydınlatma Metni/);
    const denied = await post({ ...payload, kvkkAccepted: false });
    assert.equal(denied.status, 400);
    assert.match(denied.json.error, /Aydınlatma Metni/);
    const accepted = await post({ ...payload, kvkkAccepted: true });
    assert.equal(accepted.status, 503);
    assert.match(accepted.json.error, /E-posta gönderimi/);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
