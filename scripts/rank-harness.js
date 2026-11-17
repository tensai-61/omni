const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const password = 'RankTest1a';

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
    const finish = (error) => {
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

function httpCall({ port, method, pathname, headers = {}, body }) {
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
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(response) {
  const value = response.headers['set-cookie'];
  assert.ok(value, response.text);
  const header = Array.isArray(value) ? value.join('\n') : value;
  return `turnuva_session=${/turnuva_session=([^;]+)/.exec(header)[1]}`;
}

function insertUser(file, email, username, role = 'user') {
  const db = new DatabaseSync(file, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, deviceId, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(email, username, hash, salt.toString('hex'), role, `device-${username}`, new Date().toISOString());
  const id = Number(db.prepare('SELECT id FROM users WHERE email = ?').get(email).id);
  db.close();
  return { id, hash };
}

async function boot(adminEmail = 'admin@ranks.test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranks-http-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: adminEmail,
    SESSION_SECRET: 'rank-test-session-secret-32chars-min',
    STARTING_OMNI_DOLAR: '5000',
    SMTP_HOST: ''
  };
  delete env.NODE_ENV;
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;
  delete env.ONLINE_LOCK_TRIGGER;
  const running = spawnServer(env);
  await running.ready;
  return { dir, databaseFile, port, running, adminEmail };
}

async function shutdown(ctx) {
  await stopServer(ctx.running.child);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

async function login(port, email) {
  const response = await httpCall({
    port, method: 'POST', pathname: '/api/auth/login',
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, response.text);
  return { response, cookie: cookieFrom(response) };
}

function call(port, cookie, method, pathname, body) {
  return httpCall({
    port, method, pathname,
    headers: cookie ? { Cookie: cookie } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

module.exports = {
  password, insertUser, boot, shutdown, login, call, httpCall, cookieFrom, spawnServer, stopServer
};
