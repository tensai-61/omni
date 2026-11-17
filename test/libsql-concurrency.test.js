const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const test = require('node:test');
const assert = require('node:assert/strict');
const { openLibsqlSync } = require('../lib/libsql-sync');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const { installOnlineSchema } = require('../lib/online-league');
const { startSqld, stopSqld } = require('../scripts/sqld-fixture');

const root = path.join(__dirname, '..');
const password = 'OnlineTest1';

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
    const timer = setTimeout(() => reject(new Error(`server did not start\n${logs.out}\n${logs.err}`)), 20000);
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
      else setTimeout(poll, 30);
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

function sessionCookie(response) {
  const header = response.headers?.['set-cookie'] || '';
  const joined = Array.isArray(header) ? header.join('\n') : String(header);
  const match = /turnuva_session=([^;]+)/.exec(joined);
  assert.ok(match, response.text);
  return `turnuva_session=${match[1]}`;
}

function runWorkers(count, workerCode, workerData) {
  return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, { eval: true, workerData });
    const messages = [];
    worker.on('message', message => messages.push(message));
    worker.on('error', reject);
    worker.on('exit', code => (code ? reject(new Error(`worker ${code}`)) : resolve(messages[0])));
  })));
}

test('empty libSQL database gets the schema, and a balance key cannot be applied twice', async () => {
  const sqld = await startSqld();
  const database = openLibsqlSync({ url: sqld.url, authToken: sqld.token });
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    installOnlineSchema(database);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    for (const name of ['coin_ledger', 'online_cards', 'online_fixtures', 'online_sim_runs', 'omni_market_catalog']) {
      assert.ok(tables.includes(name), name);
    }
    const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'online_cards_admin_frozen'").get();
    assert.match(trigger.sql, /admin card cannot move/);
    database.prepare('INSERT INTO users (id, email, created_at) VALUES (1, ?, ?)').run('u@example.com', '2026-11-13T00:00:00.000Z');
    database.prepare(`
      INSERT INTO online_cards (user_id, pool_id, name, position, gen, admin_card, created_at)
      VALUES (1, 'pool', 'Örnek', 'GK', 70, 1, '2026-11-13T00:00:00.000Z')
    `).run();
    assert.throws(() => database.prepare('UPDATE online_cards SET user_id = 2 WHERE admin_card = 1').run(), /admin card/);
    assert.throws(() => database.prepare(`
      INSERT INTO coin_ledger (user_id, amount, balance_after, currency, reason, ref_key, created_at)
      VALUES (99, 1, 1, 'omni', 'yabancı', 'bad-fk', '2026-11-13T00:00:00.000Z')
    `).run(), /FOREIGN KEY/);
    const workerCode = `
      const { workerData, parentPort } = require('worker_threads');
      const { openLibsqlSync } = require(workerData.adapterPath);
      const { withImmediate, applyBalanceChange } = require(workerData.leaguePath);
      const database = openLibsqlSync({ url: workerData.url, authToken: workerData.authToken });
      let outcome = 'applied';
      try {
        const result = withImmediate(database, () => applyBalanceChange(
          database, 1, 100, 'omni', 'yarış', 'ref-yaris', '2026-11-13T00:00:00.000Z', 'user'
        ));
        outcome = result.applied ? 'applied' : 'replay';
      } catch (error) {
        outcome = /UNIQUE constraint|çakıştı/.test(String(error && error.message)) ? 'conflict' : String(error && error.message);
      }
      database.close();
      parentPort.postMessage({ outcome });
    `;
    const results = await runWorkers(2, workerCode, {
      url: sqld.url,
      authToken: sqld.token,
      adapterPath: path.join(root, 'lib', 'libsql-sync.js'),
      leaguePath: path.join(root, 'lib', 'online-league.js')
    });
    const balance = database.prepare('SELECT omni_dolar FROM user_balances WHERE user_id = 1').get();
    const ledger = database.prepare("SELECT COUNT(*) AS total FROM coin_ledger WHERE ref_key = 'ref-yaris'").get();
    assert.equal(balance.omni_dolar, 100);
    assert.equal(ledger.total, 1);
    assert.equal(results.filter(item => item.outcome === 'applied').length, 1);
    assert.ok(results.every(item => item.outcome === 'applied' || item.outcome === 'replay' || item.outcome === 'conflict'));
  } finally {
    database.close();
    await stopSqld(sqld);
  }
});

test('parallel wrong passwords on libSQL cannot push the counter past 5', async () => {
  const sqld = await startSqld();
  const database = openLibsqlSync({ url: sqld.url, authToken: sqld.token });
  try {
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO users (id) VALUES (1);
      CREATE TABLE admin_pack_password_attempts (
        user_id INTEGER PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= 5),
        locked_until INTEGER
      );
    `);
    const workerCode = `
      const { workerData, parentPort } = require('worker_threads');
      const { openLibsqlSync } = require(workerData.adapterPath);
      const { createPackPasswordGuard } = require(workerData.modulePath);
      const database = openLibsqlSync({ url: workerData.url, authToken: workerData.authToken });
      const guard = createPackPasswordGuard(database);
      let locked = 0;
      let open = 0;
      for (let index = 0; index < 10; index += 1) {
        const result = guard.recordFailure(1, Date.now());
        if (result.locked) locked += 1;
        else open += 1;
      }
      const success = guard.recordSuccess(1, Date.now());
      database.close();
      parentPort.postMessage({ locked, open, success });
    `;
    const results = await runWorkers(4, workerCode, {
      url: sqld.url,
      authToken: sqld.token,
      adapterPath: path.join(root, 'lib', 'libsql-sync.js'),
      modulePath: path.join(root, 'lib', 'pack-password.js')
    });
    const row = database.prepare('SELECT failures, locked_until FROM admin_pack_password_attempts').get();
    assert.equal(row.failures, 5);
    assert.ok(row.locked_until > Date.now());
    assert.equal(results.reduce((sum, item) => sum + item.open, 0), 4);
    assert.ok(results.every(item => item.success.ok === false && item.success.locked === true));
  } finally {
    database.close();
    await stopSqld(sqld);
  }
});

test('server bootstraps an empty libSQL database and keeps raced sales atomic', { timeout: 120000 }, async () => {
  const sqld = await startSqld();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-libsql-http-'));
  const databaseFile = path.join(dir, 'should-not-be-used.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin-libsql@example.com',
    STARTING_OMNI_DOLAR: '5000',
    MARKET_MIN_PER_GEN: '25',
    MARKET_MAX_PER_GEN: '80',
    TURSO_DATABASE_URL: sqld.url,
    TURSO_AUTH_TOKEN: sqld.token,
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: ''
  };
  delete env.NODE_ENV;
  delete env.ONLINE_LOCK_TRIGGER;
  delete env.OMNI_HOSTED;
  delete env.SESSION_SECRET;
  const running = spawnServer(env);
  const probe = openLibsqlSync({ url: sqld.url, authToken: sqld.token });
  try {
    await running.ready;
    assert.equal(fs.existsSync(databaseFile), false);
    const names = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    for (const name of ['users', 'user_sessions', 'coin_ledger', 'online_cards', 'online_pack_opens', 'player_market_listings']) {
      assert.ok(names.includes(name), name);
    }
    const health = await httpCall({ port, method: 'GET', pathname: '/healthz' });
    assert.equal(health.status, 200);
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    const insert = probe.prepare(`
      INSERT INTO users (email, username, password_hash, password_salt, verified, role, created_at)
      VALUES (?, ?, ?, ?, 1, 'user', ?)
    `);
    for (const [email, username] of [
      ['buyer-a@example.com', 'AliciA'],
      ['buyer-b@example.com', 'AliciB'],
      ['seller-m@example.com', 'Satici'],
      ['admin-libsql@example.com', 'Yonetici']
    ]) {
      insert.run(email, username, hash.toString('hex'), salt.toString('hex'), new Date().toISOString());
    }
    async function login(email) {
      const response = await httpCall({
        port, method: 'POST', pathname: '/api/auth/login',
        body: JSON.stringify({ email, password })
      });
      assert.equal(response.status, 200, response.text);
      return sessionCookie(response);
    }
    const buyerA = await login('buyer-a@example.com');
    const buyerB = await login('buyer-b@example.com');
    const seller = await login('seller-m@example.com');
    const admin = await login('admin-libsql@example.com');
    await enrollTwoFactor(httpCall, port, admin, password);
    await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyerA } });
    const catalog = await httpCall({ port, method: 'GET', pathname: '/api/online/market', headers: { Cookie: buyerA } });
    assert.equal(catalog.status, 200, catalog.text);
    const item = catalog.json.items.find(entry => entry.price <= 2000);
    assert.ok(item);
    const raced = await Promise.all([0, 1].map(() => httpCall({
      port, method: 'POST', pathname: `/api/online/market/${item.id}/buy`, headers: { Cookie: buyerA },
      body: JSON.stringify({ requestId: 'omni-yaris-0001', price: 1 })
    })));
    assert.ok(raced.every(entry => entry.status === 200), raced.map(entry => entry.text).join('\n'));
    assert.equal(raced.filter(entry => entry.json.replayed).length, 1);
    const opened = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: seller },
      body: JSON.stringify({ slug: 'bronz', requestId: 'pazar-paket-1' })
    });
    assert.equal(opened.status, 200, opened.text);
    const card = opened.json.cards[0];
    const listing = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: seller },
      body: JSON.stringify({ cardId: card.id, price: card.gen * 25 })
    });
    assert.equal(listing.status, 201, listing.text);
    await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyerB } });
    const concurrent = await Promise.all([buyerA, buyerB].map(cookie => httpCall({
      port, method: 'POST', pathname: `/api/online/player-market/${listing.json.listing.id}/buy`,
      headers: { Cookie: cookie },
      body: JSON.stringify({ price: 1 })
    })));
    assert.equal(concurrent.filter(entry => entry.status === 200).length, 1, concurrent.map(entry => entry.text).join('\n'));
    assert.equal(concurrent.filter(entry => entry.status === 409).length, 1);
    const priced = await httpCall({
      port, method: 'PUT', pathname: '/api/online/admin/packs/bronz', headers: { Cookie: admin },
      body: JSON.stringify({ price: 1 })
    });
    assert.equal(priced.status, 200, priced.text);
    for (let index = 1; index <= 4; index += 1) {
      const daily = await httpCall({
        port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyerB },
        body: JSON.stringify({ slug: 'bronz', requestId: `gunluk-${index}-xxxx` })
      });
      assert.equal(daily.status, 200, daily.text);
    }
    const sixth = await Promise.all([5, 6].map(index => httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyerB },
      body: JSON.stringify({ slug: 'bronz', requestId: `gunluk-${index}-xxxx` })
    })));
    assert.equal(sixth.filter(entry => entry.status === 200).length, 1, sixth.map(entry => entry.text).join('\n'));
    assert.equal(sixth.filter(entry => entry.status === 429).length, 1);
    const sales = probe.prepare('SELECT COUNT(*) AS total FROM omni_market_sales').get();
    const playerSales = probe.prepare('SELECT COUNT(*) AS total FROM player_market_sales').get();
    const opens = probe.prepare("SELECT COUNT(*) AS total FROM online_pack_opens WHERE tag = 'user' AND user_id = (SELECT id FROM users WHERE email = 'buyer-b@example.com')").get();
    const negative = probe.prepare('SELECT COUNT(*) AS total FROM user_balances WHERE omni_dolar < 0 OR coins < 0').get();
    assert.equal(sales.total, 1);
    assert.equal(playerSales.total, 1);
    assert.equal(opens.total, 5);
    assert.equal(negative.total, 0);
  } finally {
    probe.close();
    await stopServer(running.child);
    await stopSqld(sqld);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
