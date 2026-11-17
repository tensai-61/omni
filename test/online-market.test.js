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
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const {
  installOnlineSchema,
  seedFreeTeams,
  applyBalanceChange,
  pickTeam,
  saveSquad
} = require('../lib/online-league');
const {
  priceBand,
  buyCatalog,
  addCatalogItem,
  updateCatalogItem,
  removeCatalogItem,
  listCard,
  buyListing,
  cancelListing,
  listPlayerMarketFor,
  PLACEHOLDERS
} = require('../lib/online-market');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'tour-maker.html'), 'utf8');
const password = 'OnlineTest1';
const now = new Date('2026-11-04T12:00:00.000Z');
const adminEmail = 'admin@x.com';

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-market-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      banned INTEGER NOT NULL DEFAULT 0,
      isBanned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  installOnlineSchema(database);
  seedFreeTeams(database);
  const insert = database.prepare('INSERT INTO users (email, username, role, banned, isBanned, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('buyer@x.com', 'Alici', 'user', 0, 0, now.toISOString());
  insert.run('seller@x.com', 'Satici', 'user', 0, 0, now.toISOString());
  insert.run(adminEmail, 'Yonetici', 'user', 0, 0, now.toISOString());
  return { dir, database };
}

function user(id, email) {
  return { id, email, role: 'user' };
}

function giveCard(database, userId, fields) {
  const created = database.prepare(`
    INSERT INTO online_cards (user_id, pool_id, name, position, gen, pack_slug, open_id, admin_card, origin, created_at)
    VALUES (?, 'test-pool', ?, ?, ?, 'bronz', NULL, ?, 'pack', ?)
  `).run(userId, fields.name, fields.position, fields.gen, fields.adminCard ? 1 : 0, now.toISOString());
  return Number(created.lastInsertRowid);
}

function balance(database, userId) {
  const row = database.prepare('SELECT coins, omni_dolar FROM user_balances WHERE user_id = ?').get(userId);
  return { coins: Number(row?.coins || 0), omniDolar: Number(row?.omni_dolar || 0) };
}

function withBand(fn) {
  const previousMin = process.env.MARKET_MIN_PER_GEN;
  const previousMax = process.env.MARKET_MAX_PER_GEN;
  const previousStart = process.env.STARTING_OMNI_DOLAR;
  process.env.MARKET_MIN_PER_GEN = '25';
  process.env.MARKET_MAX_PER_GEN = '80';
  process.env.STARTING_OMNI_DOLAR = '0';
  try {
    return fn();
  } finally {
    if (previousMin === undefined) delete process.env.MARKET_MIN_PER_GEN;
    else process.env.MARKET_MIN_PER_GEN = previousMin;
    if (previousMax === undefined) delete process.env.MARKET_MAX_PER_GEN;
    else process.env.MARKET_MAX_PER_GEN = previousMax;
    if (previousStart === undefined) delete process.env.STARTING_OMNI_DOLAR;
    else process.env.STARTING_OMNI_DOLAR = previousStart;
  }
}

test('market copy exists in all seven locales and the hub cards are live', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'locale.js'), 'utf8')}\nthis.I18N = I18N;`, context);
  const keys = [
    'onlinePlayerMarketDesc', 'onlineOmniMarketDesc', 'onlineMarketDesc', 'onlineMarketBuy',
    'onlineMarketFictional', 'onlineBazaarDesc', 'onlineBazaarBand', 'onlineBazaarAdmin',
    'onlineListedBadge', 'onlineListedLock', 'onlineMarketOfficial', 'onlineMarketLocked',
    'onlineBuyConfirm', 'onlineBuyConfirmAdmin', 'onlineBuyConfirmTitle', 'onlineAdminMarketPasswordHint', 'onlineMarketAdminDesc'
  ];
  for (const code of ['tr', 'en', 'es', 'ru', 'nl', 'de', 'az']) {
    for (const key of keys) {
      assert.equal(typeof context.I18N[code][key], 'string', `${code}.${key}`);
      assert.notEqual(context.I18N[code][key].trim(), '');
      assert.equal(context.I18N[code][key].includes('$'), false, `${code}.${key}`);
    }
    assert.match(context.I18N[code].onlineBazaarBand, /Ⓞ/);
  }
  assert.equal(context.I18N.tr.onlineMarketOfficial, 'Resmi');
  assert.equal(context.I18N.tr.onlineListedLock, 'Satışta 🔒');
  assert.match(context.I18N.tr.onlineBuyConfirmAdmin, /ücretsiz/);
  assert.match(context.I18N.tr.onlineBuyConfirmAdmin, /admin/);
  assert.equal(html.includes("t('onlineUnlimited')"), false);
  const player = html.slice(html.indexOf('id="onlinePlayerMarketCard"'), html.indexOf('id="onlineOmniMarketCard"'));
  const omni = html.slice(html.indexOf('id="onlineOmniMarketCard"'), html.indexOf('id="onlineLeagueScreen"'));
  assert.equal(player.includes('comingSoon'), false);
  assert.equal(omni.includes('comingSoon'), false);
  assert.match(player, /openPlayerMarket\(\)/);
  assert.match(omni, /openOmniMarket\(\)/);
  assert.match(html, /escapeHtml\(card\.name\)/);
  assert.match(html, /escapeHtml\(options\.seller\)/);
  assert.match(html, /class="resmi-badge"/);
  assert.match(html, /data-act="market-tab"/);
  assert.match(html, /listed-lock/);
  assert.match(html, /market-band/);
  assert.match(html, /confirmMarketBuy/);
  assert.match(html, /function omniPriceText/);
  assert.equal(html.includes('LIMIT 40'), false);
});

test('an admin Omni Market purchase is stored as a frozen admin card', () => {
  const { dir, database } = tempDatabase();
  try {
    withBand(() => {
      const item = addCatalogItem(database, user(3, adminEmail), {
        name: 'Örnek Yönetici Alımı', position: 'MID', gen: 75, price: 2000
      }, now, adminEmail);
      assert.throws(() => buyCatalog(database, user(3, adminEmail), {
        catalogId: item.id, requestKey: 'admin-market-yok', price: 1
      }, now, adminEmail), /şifre/);
      const bought = buyCatalog(database, user(3, adminEmail), {
        catalogId: item.id, requestKey: 'admin-market-0001', price: 1, passwordAccepted: true
      }, now, adminEmail);
      assert.equal(bought.price, 0);
      assert.equal(bought.free, true);
      assert.equal(bought.tag, 'admin');
      assert.equal(bought.card.adminCard, true);
      const stored = database.prepare('SELECT user_id, admin_card FROM online_cards WHERE id = ?').get(bought.card.id);
      assert.equal(stored.user_id, 3);
      assert.equal(stored.admin_card, 1);
      assert.equal(balance(database, 3).omniDolar, 0);
      const ledger = database.prepare("SELECT amount, tag, currency, balance_after FROM coin_ledger WHERE ref_key = 'omni-market:3:admin-market-0001'").get();
      assert.equal(ledger.amount, 0);
      assert.equal(ledger.tag, 'admin');
      assert.equal(ledger.currency, 'omni');
      assert.equal(ledger.balance_after, 0);
      assert.throws(() => listCard(database, user(3, adminEmail), { cardId: bought.card.id, price: 2000 }, now, adminEmail), /pazarında/);
      assert.throws(() => database.prepare('UPDATE online_cards SET user_id = 1 WHERE id = ?').run(bought.card.id), /admin card/);
      const replay = buyCatalog(database, user(3, adminEmail), {
        catalogId: item.id, requestKey: 'admin-market-0001', price: 9, passwordAccepted: true
      }, now, adminEmail);
      assert.equal(replay.replayed, true);
      assert.equal(replay.card.adminCard, true);
      assert.equal(replay.price, 0);
      assert.equal(balance(database, 3).omniDolar, 0);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog names with angle brackets are rejected and a stale listing price cannot be bought', () => {
  const { dir, database } = tempDatabase();
  try {
    withBand(() => {
      assert.throws(() => addCatalogItem(database, user(3, adminEmail), {
        name: '<script>alert', position: 'FWD', gen: 70, price: 1000
      }, now, adminEmail), /<|>/);
      assert.equal(database.prepare("SELECT COUNT(*) AS total FROM omni_market_catalog WHERE name LIKE '%script%'").get().total, 0);
      const seller = user(2, 'seller@x.com');
      const cardId = giveCard(database, 2, { name: 'Örnek Bant', position: 'MID', gen: 80 });
      const listed = listCard(database, seller, { cardId, price: 2000 }, now, adminEmail);
      process.env.MARKET_MIN_PER_GEN = '40';
      applyBalanceChange(database, 1, 5000, 'omni', 'alıcı', 'seed-band', now.toISOString(), 'user');
      assert.throws(() => buyListing(database, user(1, 'buyer@x.com'), listed.listing.id, now, adminEmail), /aralık/);
      assert.equal(database.prepare('SELECT user_id FROM online_cards WHERE id = ?').get(cardId).user_id, 2);
      assert.equal(database.prepare('SELECT status FROM player_market_listings WHERE id = ?').get(listed.listing.id).status, 'active');
      assert.equal(balance(database, 1).omniDolar, 5000);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('placeholder catalog players are fictional and priced only in omni', () => {
  assert.ok(PLACEHOLDERS.length >= 4);
  for (const [name, position, gen, price] of PLACEHOLDERS) {
    assert.match(name, /^Örnek /);
    assert.equal(/\$|fc|fifa/i.test(name), false);
    assert.ok(['GK', 'DEF', 'MID', 'FWD'].includes(position));
    assert.ok(gen >= 40 && gen <= 99);
    assert.ok(price > 0);
  }
});

test('parallel wrong admin passwords cannot push the free-open counter past 5', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-lock-race-'));
  const file = path.join(dir, 'test.db');
  const setup = new DatabaseSync(file);
  setup.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users (id) VALUES (1);
    CREATE TABLE admin_pack_password_attempts (
      user_id INTEGER PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= 5),
      locked_until INTEGER
    );
  `);
  setup.close();
  const workerCode = `
    const { workerData, parentPort } = require('worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { createPackPasswordGuard } = require(workerData.modulePath);
    const database = new DatabaseSync(workerData.file, { timeout: 8000 });
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
  const modulePath = path.join(root, 'lib', 'pack-password.js');
  const results = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, { eval: true, workerData: { file, modulePath } });
    const messages = [];
    worker.on('message', message => messages.push(message));
    worker.on('error', reject);
    worker.on('exit', code => (code ? reject(new Error(`worker ${code}`)) : resolve(messages[0])));
  })));
  const database = new DatabaseSync(file, { readOnly: true });
  const row = database.prepare('SELECT failures, locked_until FROM admin_pack_password_attempts').get();
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(row.failures, 5);
  assert.ok(row.locked_until > Date.now());
  assert.equal(results.reduce((sum, item) => sum + item.open, 0), 4);
  assert.ok(results.every(item => item.success.ok === false && item.success.locked === true));
});

test('catalog price ignores the client, and a repeated key is one sale', () => {
  const { dir, database } = tempDatabase();
  try {
    withBand(() => {
      const item = addCatalogItem(database, user(3, adminEmail), {
        name: 'Örnek Deneme', position: 'FWD', gen: 72, price: 2500
      }, now, adminEmail);
      const cheap = updateCatalogItem(database, user(3, adminEmail), item.id, { price: 1800 }, now, adminEmail);
      assert.equal(cheap.price, 1800);
      assert.equal(cheap.currency, 'omni');
      applyBalanceChange(database, 1, 5000, 'omni', 'yükleme', 'seed-buyer', now.toISOString(), 'user');
      const first = buyCatalog(database, user(1, 'buyer@x.com'), {
        catalogId: item.id, requestKey: 'market-istek-1', price: 1, currency: 'coin'
      }, now, adminEmail);
      assert.equal(first.replayed, false);
      assert.equal(first.price, 1800);
      assert.equal(first.card.adminCard, false);
      assert.equal(balance(database, 1).omniDolar, 3200);
      const replay = buyCatalog(database, user(1, 'buyer@x.com'), {
        catalogId: item.id, requestKey: 'market-istek-1', price: 1
      }, now, adminEmail);
      assert.equal(replay.replayed, true);
      assert.equal(replay.price, 1800);
      assert.equal(balance(database, 1).omniDolar, 3200);
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM online_cards WHERE origin = \'omni\'').get().total, 1);
      const sale = database.prepare('SELECT price FROM omni_market_sales').get();
      const ledger = database.prepare("SELECT amount, balance_after FROM coin_ledger WHERE ref_key = 'omni-market:1:market-istek-1'").get();
      assert.equal(sale.price, 1800);
      assert.equal(ledger.amount, -1800);
      assert.equal(ledger.balance_after, 3200);
      removeCatalogItem(database, user(3, adminEmail), item.id, adminEmail);
      assert.equal(database.prepare('SELECT user_id FROM online_cards WHERE id = ?').get(first.card.id).user_id, 1);
      assert.throws(() => addCatalogItem(database, user(1, 'buyer@x.com'), {
        name: 'Örnek Yasak', position: 'GK', gen: 70, price: 100
      }, now, adminEmail), /yönetici/i);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('player market enforces bounds, self-buy, XI lock, admin cards, and the ledger', () => {
  const { dir, database } = tempDatabase();
  try {
    withBand(() => {
      assert.deepEqual(priceBand(80), { min: 2000, max: 6400 });
      const seller = user(2, 'seller@x.com');
      const buyer = user(1, 'buyer@x.com');
      const admin = user(3, adminEmail);
      const squad = pickTeam(database, seller, 1, now, adminEmail);
      const cardId = giveCard(database, 2, { name: 'Örnek Satılık', position: 'MID', gen: 80 });
      const keeper = squad.startingXi.find(id => id.includes('gk')) || squad.startingXi[0];
      const withCard = squad.startingXi.map((id, index) => (index === 10 || id === keeper ? id : id));
      withCard[10] = `card:${cardId}`;
      if (!withCard.includes(keeper)) withCard[0] = keeper;
      saveSquad(database, seller, withCard, now, adminEmail);
      assert.throws(() => listCard(database, seller, { cardId, price: 2000 }, now, adminEmail), /İlk 11/);
      saveSquad(database, seller, squad.startingXi, now, adminEmail);
      assert.throws(() => listCard(database, seller, { cardId, price: 1999 }, now, adminEmail), /2000/);
      assert.throws(() => listCard(database, seller, { cardId, price: 6401 }, now, adminEmail), /6400/);
      const listed = listCard(database, seller, { cardId, price: 2000 }, now, adminEmail);
      assert.throws(() => saveSquad(database, seller, withCard, now, adminEmail), /Satıştaki kart/);
      assert.throws(() => listCard(database, seller, { cardId, price: 2000 }, now, adminEmail), /zaten satışta/);
      assert.throws(() => buyListing(database, seller, listed.listing.id, now, adminEmail), /Kendi ilan/);
      assert.equal(database.prepare('SELECT status FROM player_market_listings WHERE id = ?').get(listed.listing.id).status, 'active');
      applyBalanceChange(database, 1, 1500, 'omni', 'az bakiye', 'seed-short', now.toISOString(), 'user');
      assert.throws(() => buyListing(database, buyer, listed.listing.id, now, adminEmail), /eksiye/);
      assert.equal(balance(database, 1).omniDolar, 1500);
      assert.equal(balance(database, 2).omniDolar, 0);
      applyBalanceChange(database, 1, 1000, 'omni', 'tamamlama', 'seed-rest', now.toISOString(), 'user');
      const sale = buyListing(database, buyer, listed.listing.id, now, adminEmail);
      assert.equal(sale.price, 2000);
      assert.equal(sale.replayed, false);
      assert.equal(database.prepare('SELECT user_id, admin_card FROM online_cards WHERE id = ?').get(cardId).user_id, 1);
      const replay = buyListing(database, buyer, listed.listing.id, now, adminEmail);
      assert.equal(replay.replayed, true);
      assert.equal(balance(database, 1).omniDolar, 500);
      assert.equal(balance(database, 2).omniDolar, 2000);
      const legs = database.prepare("SELECT user_id, amount, balance_after FROM coin_ledger WHERE ref_key IN ('player-buy:1', 'player-sell:1') ORDER BY amount").all();
      assert.equal(legs.length, 2);
      assert.equal(legs.reduce((sum, row) => sum + row.amount, 0), 0);
      assert.equal(legs.find(row => row.user_id === 1).balance_after, 500);
      assert.equal(legs.find(row => row.user_id === 2).balance_after, 2000);
      assert.equal(database.prepare('SELECT price, currency FROM player_market_sales').get().price, 2000);
      assert.equal(database.prepare("SELECT currency FROM player_market_sales").get().currency, 'omni');
      const other = giveCard(database, 2, { name: 'Örnek İkinci', position: 'DEF', gen: 60 });
      const second = listCard(database, seller, { cardId: other, price: 1500 }, now, adminEmail);
      cancelListing(database, seller, second.listing.id, now, adminEmail);
      assert.equal(database.prepare('SELECT status FROM player_market_listings WHERE id = ?').get(second.listing.id).status, 'cancelled');
      const adminCard = giveCard(database, 2, { name: 'Örnek Yönetici', position: 'GK', gen: 90, adminCard: true });
      assert.throws(() => listCard(database, seller, { cardId: adminCard, price: 3000 }, now, adminEmail), /Yönetici kart/);
      assert.throws(() => database.prepare('UPDATE online_cards SET user_id = 1 WHERE id = ?').run(adminCard), /admin card/);
      const normal = giveCard(database, 1, { name: 'Örnek Admin Satamaz', position: 'FWD', gen: 70 });
      assert.throws(() => listCard(database, admin, { cardId: normal, price: 2000 }, now, adminEmail), /Yönetici oyuncu pazarında/);
      assert.throws(() => buyListing(database, admin, second.listing.id, now, adminEmail), /Yönetici oyuncu pazarında/);
      database.prepare('UPDATE users SET banned = 1, isBanned = 1 WHERE id = 2').run();
      const hidden = giveCard(database, 2, { name: 'Örnek Banlı', position: 'FWD', gen: 64 });
      database.prepare(`
        INSERT INTO player_market_listings (seller_id, card_id, price, currency, status, created_at)
        VALUES (2, ?, 1600, 'omni', 'active', ?)
      `).run(hidden, now.toISOString());
      const board = listPlayerMarketFor(database, buyer, { q: '', position: '', genMin: 40, genMax: 99 }, now, adminEmail);
      assert.equal(board.listings.some(item => item.name === 'Örnek Banlı'), false);
      assert.equal(database.prepare("SELECT status FROM player_market_listings WHERE card_id = ?").get(hidden).status, 'cancelled');
      assert.throws(() => listCard(database, seller, { cardId: other, price: 1500 }, now, adminEmail), /Banlı/);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  const header = Array.isArray(value) ? value.join('\n') : value;
  return `turnuva_session=${/turnuva_session=([^;]+)/.exec(header)[1]}`;
}

function insertUser(file, email, username, banned = false) {
  const db = new DatabaseSync(file, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, banned, isBanned, banReason, created_at)
    VALUES (?, ?, ?, ?, 1, 'user', ?, ?, ?, ?)
  `).run(email, username, hash.toString('hex'), salt.toString('hex'), banned ? 1 : 0, banned ? 1 : 0, banned ? 'test ban' : null, new Date().toISOString());
  db.close();
}

test('market endpoints ignore client prices, sell a listing once, and block bans', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-market-api-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin-market@example.com',
    STARTING_OMNI_DOLAR: '5000',
    MARKET_MIN_PER_GEN: '25',
    MARKET_MAX_PER_GEN: '80',
    SMTP_HOST: ''
  };
  delete env.NODE_ENV;
  delete env.ONLINE_LOCK_TRIGGER;
  const running = spawnServer(env);
  try {
    await running.ready;
    const anon = await httpCall({ port, method: 'GET', pathname: '/api/online/market' });
    assert.equal(anon.status, 401);
    insertUser(databaseFile, 'buyer-a@example.com', 'AliciA');
    insertUser(databaseFile, 'buyer-b@example.com', 'AliciB');
    insertUser(databaseFile, 'seller-m@example.com', 'SaticiM');
    insertUser(databaseFile, 'banned-m@example.com', 'BanliM', true);
    insertUser(databaseFile, 'admin-market@example.com', 'MarketAdmin');
    async function login(email) {
      const response = await httpCall({ port, method: 'POST', pathname: '/api/auth/login', body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200, response.text);
      return cookieFrom(response);
    }
    const bannedCookie = await login('banned-m@example.com');
    const bannedBuy = await httpCall({
      port, method: 'POST', pathname: '/api/online/market/1/buy', headers: { Cookie: bannedCookie },
      body: JSON.stringify({ requestId: 'banli-istek-1', price: 1 })
    });
    assert.equal(bannedBuy.status, 403);
    assert.equal(bannedBuy.json.banned, true);
    const bannedList = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: bannedCookie },
      body: JSON.stringify({ cardId: 1, price: 1000 })
    });
    assert.equal(bannedList.status, 403);
    assert.equal(bannedList.json.banned, true);
    const admin = await login('admin-market@example.com');
    await enrollTwoFactor(httpCall, port, admin, password);
    const seller = await login('seller-m@example.com');
    const buyerA = await login('buyer-a@example.com');
    const buyerB = await login('buyer-b@example.com');
    await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyerA } });
    await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyerB } });
    const catalog = await httpCall({ port, method: 'GET', pathname: '/api/online/market?position=GK', headers: { Cookie: buyerA } });
    assert.equal(catalog.status, 200, catalog.text);
    assert.ok(catalog.json.items.length >= 1);
    assert.ok(catalog.json.items.every(item => item.position === 'GK' && item.currency === 'omni' && !JSON.stringify(item).includes('$')));
    const created = await httpCall({
      port, method: 'POST', pathname: '/api/online/admin/market', headers: { Cookie: admin },
      body: JSON.stringify({ name: 'Örnek Sprint', position: 'FWD', gen: 75, price: 2200 })
    });
    assert.equal(created.status, 201, created.text);
    const deniedCreate = await httpCall({
      port, method: 'POST', pathname: '/api/online/admin/market', headers: { Cookie: seller },
      body: JSON.stringify({ name: 'Örnek Hack', position: 'FWD', gen: 75, price: 1 })
    });
    assert.equal(deniedCreate.status, 403, deniedCreate.text);
    const raced = await Promise.all([0, 1].map(() => httpCall({
      port, method: 'POST', pathname: `/api/online/market/${created.json.item.id}/buy`, headers: { Cookie: buyerA },
      body: JSON.stringify({ requestId: 'omni-yaris-0001', price: 1 })
    })));
    assert.ok(raced.every(item => item.status === 200), raced.map(item => item.text).join('\n'));
    assert.equal(raced.filter(item => item.json.replayed).length, 1);
    assert.ok(raced.every(item => item.json.price === 2200));
    const afterCatalog = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyerA } });
    assert.equal(afterCatalog.json.balances.omniDolar, 2800);
    const opened = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: seller },
      body: JSON.stringify({ slug: 'bronz', requestId: 'pazar-paket-1', price: 1 })
    });
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.price, 1000);
    const card = opened.json.cards[0];
    const min = card.gen * 25;
    const tooLow = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: seller },
      body: JSON.stringify({ cardId: card.id, price: min - 1 })
    });
    assert.equal(tooLow.status, 400, tooLow.text);
    const listing = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: seller },
      body: JSON.stringify({ cardId: card.id, price: min })
    });
    assert.equal(listing.status, 201, listing.text);
    const self = await httpCall({
      port, method: 'POST', pathname: `/api/online/player-market/${listing.json.listing.id}/buy`, headers: { Cookie: seller },
      body: JSON.stringify({ price: 1 })
    });
    assert.equal(self.status, 403, self.text);
    const adminBuy = await httpCall({
      port, method: 'POST', pathname: `/api/online/player-market/${listing.json.listing.id}/buy`, headers: { Cookie: admin },
      body: JSON.stringify({ price: min })
    });
    assert.equal(adminBuy.status, 403, adminBuy.text);
    const concurrent = await Promise.all([buyerA, buyerB].map(cookie => httpCall({
      port, method: 'POST', pathname: `/api/online/player-market/${listing.json.listing.id}/buy`, headers: { Cookie: cookie },
      body: JSON.stringify({ price: 1 })
    })));
    const won = concurrent.filter(item => item.status === 200);
    const lost = concurrent.filter(item => item.status === 409);
    assert.equal(won.length, 1, concurrent.map(item => `${item.status} ${item.text}`).join('\n'));
    assert.equal(lost.length, 1);
    assert.equal(won[0].json.price, min);
    const check = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    const owner = check.prepare('SELECT user_id, admin_card FROM online_cards WHERE id = ?').get(card.id);
    const sales = check.prepare('SELECT price, currency FROM player_market_sales').all();
    const legs = check.prepare("SELECT amount FROM coin_ledger WHERE ref_key LIKE 'player-%'").all();
    const negative = check.prepare('SELECT COUNT(*) AS total FROM user_balances WHERE omni_dolar < 0 OR coins < 0').get();
    const names = check.prepare('SELECT name FROM omni_market_catalog').all();
    check.close();
    assert.equal(sales.length, 1);
    assert.equal(sales[0].price, min);
    assert.equal(sales[0].currency, 'omni');
    assert.equal(legs.reduce((sum, row) => sum + row.amount, 0), 0);
    assert.equal(negative.total, 0);
    assert.notEqual(owner.user_id, null);
    assert.equal(owner.admin_card, 0);
    assert.ok(names.every(row => String(row.name).startsWith('Örnek') || row.name === 'Örnek Sprint'));
    const free = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: admin },
      body: JSON.stringify({ slug: 'bronz', requestId: 'admin-pazar-kart', password })
    });
    assert.equal(free.status, 200, free.text);
    const sealed = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: admin },
      body: JSON.stringify({ cardId: free.json.cards[0].id, price: 5000 })
    });
    assert.equal(sealed.status, 403, sealed.text);
    const users = await httpCall({ port, method: 'GET', pathname: '/api/admin/users', headers: { Cookie: admin } });
    const sellerRow = users.json.users.find(account => account.email === 'seller-m@example.com');
    const ban = await httpCall({
      port, method: 'POST', pathname: `/api/admin/users/${sellerRow.id}/ban`, headers: { Cookie: admin },
      body: JSON.stringify({ duration: 'PERMANENT', banReason: 'Pazar testi' })
    });
    assert.equal(ban.status, 200, ban.text);
    const spare = opened.json.cards[1];
    const relist = await httpCall({
      port, method: 'POST', pathname: '/api/online/player-market', headers: { Cookie: seller },
      body: JSON.stringify({ cardId: spare.id, price: spare.gen * 25 })
    });
    assert.equal(relist.status, 401);
    const board = await httpCall({ port, method: 'GET', pathname: '/api/online/player-market', headers: { Cookie: buyerB } });
    assert.equal(board.status, 200, board.text);
    assert.equal(board.json.listings.some(item => item.seller === 'SaticiM'), false);
    assert.equal(JSON.stringify(board.json).includes('$'), false);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin Omni Market buy is free with the shared pack password lock and a real zero balance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-admin-buy-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin-free-buy@example.com',
    STARTING_OMNI_DOLAR: '5000',
    SMTP_HOST: ''
  };
  delete env.NODE_ENV;
  const running = spawnServer(env);
  try {
    await running.ready;
    insertUser(databaseFile, 'admin-free-buy@example.com', 'Serbest');
    const login = await httpCall({
      port, method: 'POST', pathname: '/api/auth/login',
      body: JSON.stringify({ email: 'admin-free-buy@example.com', password })
    });
    assert.equal(login.status, 200, login.text);
    const headers = { Cookie: cookieFrom(login) };
    await enrollTwoFactor(httpCall, port, headers.Cookie, password);
    const home = await httpCall({ port, method: 'GET', pathname: '/api/online/home', headers });
    assert.equal(home.json.balances.unlimited, false);
    assert.equal(home.json.balances.omniDolar, 0);
    const catalog = await httpCall({ port, method: 'GET', pathname: '/api/online/market', headers });
    const item = catalog.json.items[0];
    const missing = await httpCall({
      port, method: 'POST', pathname: `/api/online/market/${item.id}/buy`, headers,
      body: JSON.stringify({ requestId: 'admin-sifresiz-1', price: 1 })
    });
    assert.equal(missing.status, 403, missing.text);
    const wrongMarket = await httpCall({
      port, method: 'POST', pathname: `/api/online/market/${item.id}/buy`, headers,
      body: JSON.stringify({ requestId: 'admin-yanlis-market', password: 'yanlis-sifre-1', price: 1 })
    });
    assert.equal(wrongMarket.status, 403, wrongMarket.text);
    const wrongPack = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers,
      body: JSON.stringify({ slug: 'bronz', requestId: 'admin-yanlis-paket', password: 'yanlis-sifre-1' })
    });
    assert.equal(wrongPack.status, 403, wrongPack.text);
    const mid = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    assert.equal(mid.prepare('SELECT failures FROM admin_pack_password_attempts').get().failures, 3);
    mid.close();
    const bought = await httpCall({
      port, method: 'POST', pathname: `/api/online/market/${item.id}/buy`, headers,
      body: JSON.stringify({ requestId: 'admin-ucretsiz-1', password, price: 1 })
    });
    assert.equal(bought.status, 200, bought.text);
    assert.equal(bought.json.price, 0);
    assert.equal(bought.json.free, true);
    assert.equal(bought.json.tag, 'admin');
    assert.equal(bought.json.card.adminCard, true);
    assert.equal(bought.json.balances.omniDolar, 0);
    assert.equal(bought.json.balances.unlimited, false);
    const check = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    const ledger = check.prepare("SELECT amount, tag, currency, balance_after FROM coin_ledger WHERE ref_key LIKE 'omni-market:%admin-ucretsiz-1'").get();
    const card = check.prepare('SELECT admin_card FROM online_cards WHERE id = ?').get(bought.json.card.id);
    const attempts = check.prepare('SELECT COUNT(*) AS total FROM admin_pack_password_attempts').get().total;
    check.close();
    assert.equal(ledger.amount, 0);
    assert.equal(ledger.tag, 'admin');
    assert.equal(ledger.currency, 'omni');
    assert.equal(ledger.balance_after, 0);
    assert.equal(card.admin_card, 1);
    assert.equal(attempts, 0);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
