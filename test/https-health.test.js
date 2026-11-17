const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

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

function request({ port, method, path: pathname, headers }) {
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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function baseEnv(port, databaseFile, extra = {}) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(path.dirname(databaseFile), 'no.json'),
    ADMIN_EMAIL: 'admin-health@example.com',
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
  return { ...env, ...extra };
}

test('GET /healthz is public and does not set a session cookie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-health-'));
  const port = await freePort();
  const running = spawnServer(baseEnv(port, path.join(dir, 'test.db')));
  try {
    await running.ready;
    const health = await request({ port, method: 'GET', path: '/healthz' });
    assert.equal(health.status, 200);
    assert.equal(health.text, 'ok');
    assert.equal(health.headers['set-cookie'], undefined);
    const post = await request({ port, method: 'POST', path: '/healthz' });
    assert.equal(post.status, 404);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production behind the proxy redirects HTTP and sends HSTS on HTTPS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-https-'));
  const port = await freePort();
  const running = spawnServer(baseEnv(port, path.join(dir, 'test.db'), {
    NODE_ENV: 'production',
    TRUST_PROXY: '1'
  }));
  try {
    await running.ready;
    const health = await request({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { Host: 'app.example.com', 'X-Forwarded-Proto': 'http' }
    });
    assert.equal(health.status, 200, health.text);
    const redirected = await request({
      port,
      method: 'GET',
      path: '/tour-maker.html?lang=tr',
      headers: { Host: 'app.example.com', 'X-Forwarded-Proto': 'http' }
    });
    assert.equal(redirected.status, 308);
    assert.equal(redirected.headers.location, 'https://app.example.com/tour-maker.html?lang=tr');
    const secure = await request({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { Host: 'app.example.com', 'X-Forwarded-Proto': 'https' }
    });
    assert.equal(secure.status, 200);
    assert.match(secure.headers['strict-transport-security'], /max-age=31536000/);
    const local = await request({ port, method: 'GET', path: '/healthz', headers: { Host: '127.0.0.1' } });
    assert.equal(local.status, 200);
    assert.equal(local.headers['strict-transport-security'], undefined);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted production exits before listening when required names are missing', async () => {
  const secret = 'smtp-password-must-stay-out-of-the-log';
  const token = 'turso-token-must-stay-out-of-the-log';
  const env = baseEnv(9, path.join(os.tmpdir(), 'unused.db'), {
    NODE_ENV: 'production',
    OMNI_HOSTED: '1',
    HOST: '0.0.0.0',
    TRUST_PROXY: '1',
    SMTP_PASS: secret,
    TURSO_AUTH_TOKEN: token,
    SESSION_SECRET: '0123456789abcdef0123456789abcdef'
  });
  delete env.TURSO_DATABASE_URL;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = await new Promise(resolve => {
    let err = '';
    let out = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('exit', code => resolve({ code, err, out }));
  });
  assert.notEqual(logs.code, 0);
  assert.match(logs.err, /TURSO_DATABASE_URL/);
  assert.equal(logs.err.includes(secret), false);
  assert.equal(logs.err.includes(token), false);
  assert.equal(logs.out.includes('Omni.verse hazır'), false);
});
