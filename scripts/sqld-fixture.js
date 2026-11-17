const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');

const TOKEN = 'omni-local-test-token';
const ARCHIVE = 'https://github.com/tursodatabase/libsql/releases/download/libsql-server-v0.24.32/libsql-server-x86_64-unknown-linux-gnu.tar.xz';

function walk(dir) {
  if (!fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walk(full);
      if (found) return found;
    } else if (entry.name === 'sqld' && entry.isFile()) return full;
  }
  return '';
}

function ensureSqld() {
  if (process.env.SQLD_BIN && fs.existsSync(process.env.SQLD_BIN)) return Promise.resolve(process.env.SQLD_BIN);
  const cached = walk('/tmp/omni-sqld');
  if (cached) return Promise.resolve(cached);
  fs.mkdirSync('/tmp/omni-sqld', { recursive: true });
  const archive = '/tmp/omni-sqld/sqld.tar.xz';
  return new Promise((resolve, reject) => {
    execFile('curl', ['-fsSL', '-o', archive, ARCHIVE], error => {
      if (error) {
        reject(error);
        return;
      }
      execFile('tar', ['-xJf', archive, '-C', '/tmp/omni-sqld'], extractError => {
        if (extractError) reject(extractError);
        else {
          const binary = walk('/tmp/omni-sqld');
          if (!binary) reject(new Error('sqld ikili dosyası açılmadı'));
          else resolve(binary);
        }
      });
    });
  });
}

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

function waitForHealth(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 500 }, res => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() > deadline) reject(new Error('sqld sağlık kontrolü başarısız'));
        else setTimeout(attempt, 50);
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('sqld açılmadı'));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function startSqld() {
  const binary = await ensureSqld();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-sqld-'));
  const port = await freePort();
  const child = spawn(binary, [
    '--db-path', path.join(dir, 'db.sqld'),
    '--http-listen-addr', `127.0.0.1:${port}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  try {
    await waitForHealth(port);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${log}`);
  }
  return {
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    dir,
    child,
    log: () => log
  };
}

function stopSqld(running) {
  if (!running) return Promise.resolve();
  const { child, dir } = running;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    });
    child.kill('SIGTERM');
  });
}

module.exports = { startSqld, stopSqld, TOKEN };
