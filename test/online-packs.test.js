const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const {
  installOnlineSchema,
  seedFreeTeams,
  applyBalanceChange,
  isAdmin,
  pickTeam,
  saveSquad,
  searchLeagues
} = require('../lib/online-league');
const {
  PLAYER_POOL,
  PACK_DEFAULTS,
  openPack,
  updatePackPrice,
  listPacks,
  refuseCardTransfer,
  listOwnedCards
} = require('../lib/online-packs');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'tour-maker.html'), 'utf8');
const password = 'OnlineTest1';
const dayOne = new Date('2026-11-04T12:00:00.000Z');
const dayTwo = new Date('2026-11-04T22:00:00.000Z');

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-packs-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT,
      password_salt TEXT,
      created_at TEXT NOT NULL
    );
  `);
  installOnlineSchema(database);
  seedFreeTeams(database);
  database.prepare('INSERT INTO users (email, username, role, created_at) VALUES (?, ?, ?, ?)').run(
    'oyuncu@x.com', 'Oyuncu', 'user', '2026-11-04T00:00:00.000Z'
  );
  database.prepare('INSERT INTO users (email, username, role, created_at) VALUES (?, ?, ?, ?)').run(
    'admin@x.com', 'Yonetici', 'user', '2026-11-04T00:00:00.000Z'
  );
  return { dir, database };
}

function withStarting(value, fn) {
  const previous = process.env.STARTING_OMNI_DOLAR;
  if (value === undefined) delete process.env.STARTING_OMNI_DOLAR;
  else process.env.STARTING_OMNI_DOLAR = String(value);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.STARTING_OMNI_DOLAR;
    else process.env.STARTING_OMNI_DOLAR = previous;
  }
}

function balance(database, userId) {
  const row = database.prepare('SELECT coins, omni_dolar FROM user_balances WHERE user_id = ?').get(userId);
  return { coins: Number(row?.coins || 0), omniDolar: Number(row?.omni_dolar || 0) };
}

test('admin is only the ADMIN_EMAIL account', () => {
  assert.equal(isAdmin({ email: 'admin@x.com', role: 'user' }, 'admin@x.com'), true);
  assert.equal(isAdmin({ email: 'other@x.com', role: 'admin' }, 'admin@x.com'), false);
  assert.equal(isAdmin({ email: 'admin@x.com', role: 'admin' }, ''), false);
});

test('the sample pool is fictional and covers every pack range', () => {
  const names = PLAYER_POOL.map(player => player.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(PLAYER_POOL.some(player => /fc|fifa|ea sports|\$/i.test(player.name)), false);
  for (const pack of PACK_DEFAULTS) {
    const eligible = PLAYER_POOL.filter(player => player.gen >= pack.genMin && player.gen <= pack.genMax);
    assert.ok(eligible.length >= pack.count, pack.slug);
    assert.ok(eligible.every(player => player.gen >= pack.genMin && player.gen <= pack.genMax));
  }
  assert.equal(Math.min(...PLAYER_POOL.map(player => player.gen)), 60);
  assert.equal(Math.max(...PLAYER_POOL.map(player => player.gen)), 99);
});

test('balances cannot go negative', () => {
  const { dir, database } = tempDatabase();
  try {
    withStarting(0, () => {
      assert.throws(() => applyBalanceChange(database, 1, -1, 'omni', 'deneme', 'neg-omni', dayOne.toISOString(), 'user'), /eksiye/);
      assert.throws(() => applyBalanceChange(database, 1, -1, 'coin', 'deneme', 'neg-coin', dayOne.toISOString(), 'user'), /eksiye/);
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM user_balances').get().total, 0);
      applyBalanceChange(database, 1, 100, 'omni', 'yükleme', 'seed-omni', dayOne.toISOString(), 'user');
      assert.throws(() => openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'negatif-0001',
        price: 1
      }, dayOne, 'admin@x.com'), /eksiye/);
      assert.equal(balance(database, 1).omniDolar, 100);
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM online_cards').get().total, 0);
      assert.throws(() => database.prepare('UPDATE user_balances SET omni_dolar = -1 WHERE user_id = 1').run(), /CHECK/);
      assert.throws(() => database.prepare('UPDATE user_balances SET coins = -1 WHERE user_id = 1').run(), /CHECK/);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same opening is charged once and the daily limit uses the Istanbul day', () => {
  const { dir, database } = tempDatabase();
  try {
    withStarting(5000, () => {
      const first = openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'ayni-istek-1',
        price: 1,
        odds: [{ id: 'fake', chance: 1 }]
      }, dayOne, 'admin@x.com');
      const replay = openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'ayni-istek-1',
        price: 1
      }, dayOne, 'admin@x.com');
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.cards.map(card => card.id), first.cards.map(card => card.id));
      assert.equal(balance(database, 1).omniDolar, 4000);
      assert.equal(database.prepare("SELECT COUNT(*) AS total FROM coin_ledger WHERE reason LIKE 'Paket:%'").get().total, 1);
      for (let index = 2; index <= 5; index += 1) {
        openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
          slug: 'bronz',
          requestKey: `gun-ici-${index}`
        }, dayOne, 'admin@x.com');
      }
      assert.throws(() => openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'gun-ici-6'
      }, dayOne, 'admin@x.com'), /sınırı/);
      assert.equal(balance(database, 1).omniDolar, 0);
      applyBalanceChange(database, 1, 1000, 'omni', 'ertesi gün', 'ertesi-yukleme', dayTwo.toISOString(), 'user');
      const next = openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'yeni-gun-1'
      }, dayTwo, 'admin@x.com');
      assert.equal(next.replayed, false);
      assert.equal(next.cards.length, 8);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pack price and odds come from the server catalog', () => {
  const { dir, database } = tempDatabase();
  try {
    withStarting(20000, () => {
      const listed = listPacks(database).find(pack => pack.slug === 'bronz');
      assert.equal(listed.price, 1000);
      assert.equal(listed.currency, 'omni');
      assert.equal(listed.odds.pool, listed.players.length);
      assert.equal(listed.odds.chancePercent, Math.round((listed.odds.draw / listed.odds.pool) * 1000) / 10);
      const hiper = listPacks(database).find(pack => pack.slug === 'hiper');
      assert.equal(hiper.sale, 'closed');
      assert.equal(hiper.price, null);
      assert.equal(hiper.currency, 'real');
      assert.throws(() => openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'hiper',
        requestKey: 'hiper-kapali'
      }, dayOne, 'admin@x.com'), /kapalı/);
      updatePackPrice(database, 'bronz', 800);
      const opened = openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'fiyat-server',
        price: 1,
        currency: 'coin'
      }, dayOne, 'admin@x.com');
      assert.equal(opened.price, 800);
      assert.equal(opened.currency, 'omni');
      assert.equal(balance(database, 1).omniDolar, 19200);
      const ledger = database.prepare("SELECT amount, currency, tag FROM coin_ledger WHERE ref_key = 'pack:1:fiyat-server'").get();
      assert.equal(ledger.amount, -800);
      assert.equal(ledger.currency, 'omni');
      assert.equal(ledger.tag, 'user');
      assert.ok(opened.cards.every(card => card.gen >= 60 && card.gen <= 70));
      assert.throws(() => updatePackPrice(database, 'hiper', 10), /kapalı/);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin free opens need a password flag, are tagged, and the cards cannot move', () => {
  const { dir, database } = tempDatabase();
  try {
    withStarting(0, () => {
      assert.throws(() => openPack(database, { id: 2, email: 'admin@x.com' }, {
        slug: 'bronz',
        requestKey: 'admin-sifresiz'
      }, dayOne, 'admin@x.com'), /şifre/);
      assert.equal(database.prepare('SELECT COUNT(*) AS total FROM online_cards').get().total, 0);
      const opened = openPack(database, { id: 2, email: 'admin@x.com' }, {
        slug: 'bronz',
        requestKey: 'admin-sifreli',
        passwordAccepted: true
      }, dayOne, 'admin@x.com');
      assert.equal(opened.tag, 'admin');
      assert.equal(opened.price, 0);
      assert.ok(opened.cards.every(card => card.adminCard));
      const ledger = database.prepare("SELECT amount, tag, reason FROM coin_ledger WHERE ref_key = 'pack:2:admin-sifreli'").get();
      assert.equal(ledger.amount, 0);
      assert.equal(ledger.tag, 'admin');
      assert.match(ledger.reason, /Yönetici/);
      assert.equal(balance(database, 2).omniDolar, 0);
      const cardId = opened.cards[0].id;
      assert.throws(() => refuseCardTransfer(database, 2, cardId), /devredilemez/);
      assert.throws(() => database.prepare('UPDATE online_cards SET user_id = 1 WHERE id = ?').run(cardId), /admin card/);
      assert.equal(database.prepare('SELECT user_id, admin_card FROM online_cards WHERE id = ?').get(cardId).user_id, 2);
      const owned = listOwnedCards(database, 1, true);
      assert.equal(owned.length, 0);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opened cards can enter the starting XI and league search scans every open league', () => {
  const { dir, database } = tempDatabase();
  try {
    withStarting(5000, () => {
      const opened = openPack(database, { id: 1, email: 'oyuncu@x.com' }, {
        slug: 'bronz',
        requestKey: 'kadro-kart'
      }, dayOne, 'admin@x.com');
      const squad = pickTeam(database, { id: 1, email: 'oyuncu@x.com', role: 'user' }, 1, dayOne, 'admin@x.com');
      const card = opened.cards.find(item => item.position !== 'GK') || opened.cards[0];
      const xi = squad.startingXi.slice();
      const index = xi.findIndex(id => {
        const player = squad.players.find(item => item.id === id);
        return card.position === 'GK' ? player.position === 'GK' : player.position !== 'GK';
      });
      xi[index] = card.xiId;
      const saved = saveSquad(database, { id: 1, email: 'oyuncu@x.com', role: 'user' }, xi, dayOne, 'admin@x.com');
      assert.equal(saved.startingXi.includes(card.xiId), true);
      for (let index = 0; index < 45; index += 1) {
        database.prepare(`
          INSERT INTO online_leagues (name, size, owner_id, status, coin_reward, created_at)
          VALUES (?, 8, 1, 'open', 200, ?)
        `).run(index === 0 ? 'Eski Ozel Lig' : `Yeni Lig ${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
      }
      const found = searchLeagues(database, 'ozel', 1);
      assert.equal(found.some(league => league.name === 'Eski Ozel Lig'), true);
    });
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shop screen, ban focus trap, and favicon are wired', () => {
  assert.match(html, /id="onlineShopCard"/);
  assert.match(html, /id="onlineClubCard"/);
  assert.match(html, /id="onlinePackScreen"/);
  assert.match(html, /id="onlineClubScreen"/);
  assert.match(html, /rel="icon"/);
  assert.match(html, /setBanBackgroundInert/);
  assert.match(html, /id="banLockExit"/);
  assert.match(html, /function openOnlinePacks/);
  assert.equal(html.includes('LIMIT 40'), false);
  const locales = {};
  vm.createContext(locales);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'locale.js'), 'utf8')}\nthis.I18N = I18N;`, locales);
  const keys = Object.keys(locales.I18N.tr).filter(key => key.startsWith('onlinePack') || key.startsWith('onlineClub') || key === 'onlineUnlimited');
  assert.ok(keys.includes('onlinePack_hiper'));
  assert.ok(keys.includes('onlineClub'));
  for (const code of ['tr', 'en', 'es', 'ru', 'nl', 'de', 'az']) {
    for (const key of keys) {
      assert.equal(typeof locales.I18N[code][key], 'string', `${code}.${key}`);
      assert.equal(locales.I18N[code][key].includes('$'), false, `${code}.${key}`);
    }
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
  assert.ok(value, response.text);
  const header = Array.isArray(value) ? value.join('\n') : value;
  return `turnuva_session=${/turnuva_session=([^;]+)/.exec(header)[1]}`;
}

function insertUser(file, email, username, role, banned = false) {
  const db = new DatabaseSync(file, { timeout: 5000 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  db.prepare(`
    INSERT INTO users (email, username, password_hash, password_salt, verified, role, banned, isBanned, banReason, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(email, username, hash.toString('hex'), salt.toString('hex'), role, banned ? 1 : 0, banned ? 1 : 0, banned ? 'test ban' : null, new Date().toISOString());
  db.close();
}

test('pack endpoints ignore client prices, charge once, and keep admin cards sealed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-pack-api-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin-pack@example.com',
    STARTING_OMNI_DOLAR: '5000',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: ''
  };
  delete env.NODE_ENV;
  delete env.ONLINE_LOCK_TRIGGER;
  const running = spawnServer(env);
  try {
    await running.ready;
    const icon = await httpCall({ port, method: 'GET', pathname: '/favicon.ico' });
    assert.equal(icon.status, 200, icon.text.slice(0, 80));
    assert.match(String(icon.headers['content-type']), /image\/png/);
    const anon = await httpCall({ port, method: 'GET', pathname: '/api/online/packs' });
    assert.equal(anon.status, 401);
    insertUser(databaseFile, 'buyer-pack@example.com', 'Alici', 'user');
    insertUser(databaseFile, 'daily-pack@example.com', 'Gunluk', 'user');
    insertUser(databaseFile, 'admin-pack@example.com', 'Yonetici', 'modder');
    insertUser(databaseFile, 'banned-pack@example.com', 'Banli', 'user', true);
    async function login(email) {
      const response = await httpCall({ port, method: 'POST', pathname: '/api/auth/login', body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200, response.text);
      return cookieFrom(response);
    }
    const banned = await httpCall({ port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: await login('banned-pack@example.com') }, body: '{}' });
    assert.equal(banned.status, 403);
    assert.equal(banned.json.banned, true);
    const buyer = await login('buyer-pack@example.com');
    const dailyUser = await login('daily-pack@example.com');
    const admin = await login('admin-pack@example.com');
    await enrollTwoFactor(httpCall, port, admin, password);
    const catalog = await httpCall({ port, method: 'GET', pathname: '/api/online/packs', headers: { Cookie: buyer } });
    assert.equal(catalog.status, 200, catalog.text);
    const bronz = catalog.json.packs.find(pack => pack.slug === 'bronz');
    const hiper = catalog.json.packs.find(pack => pack.slug === 'hiper');
    assert.equal(bronz.price, 1000);
    assert.equal(bronz.odds.chancePercent, Math.round((bronz.odds.draw / bronz.odds.pool) * 1000) / 10);
    assert.equal(hiper.sale, 'closed');
    assert.equal(JSON.stringify(hiper).includes('$'), false);
    const closedPack = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyer },
      body: JSON.stringify({ slug: 'hiper', requestId: 'hiper-istek-1', price: 1 })
    });
    assert.equal(closedPack.status, 409, closedPack.text);
    const first = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyer },
      body: JSON.stringify({ slug: 'bronz', requestId: 'istemci-fiyat-1', price: 1, currency: 'coin', odds: [] })
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.price, 1000);
    assert.equal(first.json.currency, 'omni');
    assert.equal(first.json.balances.omniDolar, 4000);
    assert.equal(first.json.cards.length, 8);
    const again = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyer },
      body: JSON.stringify({ slug: 'bronz', requestId: 'istemci-fiyat-1', price: 1 })
    });
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.balances.omniDolar, 4000);
    const raced = await Promise.all([0, 1].map(() => httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyer },
      body: JSON.stringify({ slug: 'bronz', requestId: 'yaris-aynisi', price: 1 })
    })));
    assert.ok(raced.every(item => item.status === 200), raced.map(item => item.text).join('\n'));
    assert.equal(raced.filter(item => item.json.replayed).length, 1);
    const afterRace = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyer } });
    assert.equal(afterRace.json.balances.omniDolar, 3000);
    const priced = await httpCall({
      port, method: 'PUT', pathname: '/api/online/admin/packs/bronz', headers: { Cookie: admin },
      body: JSON.stringify({ price: 3000, currency: 'coin', sale: 'closed' })
    });
    assert.equal(priced.status, 200, priced.text);
    assert.equal(priced.json.pack.price, 3000);
    assert.equal(priced.json.pack.currency, 'omni');
    assert.equal(priced.json.pack.sale, 'open');
    const spend = await Promise.all(['yaris-a-0001', 'yaris-b-0001'].map(requestId => httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: buyer },
      body: JSON.stringify({ slug: 'bronz', requestId, price: 1 })
    })));
    const won = spend.filter(item => item.status === 200);
    const lost = spend.filter(item => item.status !== 200);
    assert.equal(won.length, 1, spend.map(item => `${item.status} ${item.text}`).join('\n'));
    assert.equal(lost.length, 1);
    const flat = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: buyer } });
    assert.equal(flat.json.balances.omniDolar, 0);
    const buyerDb = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    const debits = buyerDb.prepare("SELECT amount FROM coin_ledger WHERE currency = 'omni' AND amount < 0 AND user_id = (SELECT id FROM users WHERE email = 'buyer-pack@example.com')").all();
    buyerDb.close();
    assert.equal(debits.reduce((sum, row) => sum + row.amount, 0), -5000);
    const denied = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: admin },
      body: JSON.stringify({ slug: 'bronz', requestId: 'admin-yok' })
    });
    assert.equal(denied.status, 403, denied.text);
    const wrong = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: admin },
      body: JSON.stringify({ slug: 'bronz', requestId: 'admin-yanlis', password: 'yanlis-sifre' })
    });
    assert.equal(wrong.status, 403, wrong.text);
    const free = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: admin },
      body: JSON.stringify({ slug: 'bronz', requestId: 'admin-dogru', password, price: 0 })
    });
    assert.equal(free.status, 200, free.text);
    assert.equal(free.json.tag, 'admin');
    assert.ok(free.json.cards.every(card => card.adminCard));
    assert.equal(free.json.balances.unlimited, false);
    assert.equal(free.json.balances.omniDolar, 0);
    const moved = await httpCall({
      port, method: 'POST', pathname: `/api/online/cards/${free.json.cards[0].id}/transfer`, headers: { Cookie: admin },
      body: JSON.stringify({ targetUserId: 1 })
    });
    assert.equal(moved.status, 403, moved.text);
    const check = new DatabaseSync(databaseFile, { timeout: 5000 });
    const row = check.prepare("SELECT amount, tag FROM coin_ledger WHERE ref_key LIKE 'pack:%admin-dogru'").get();
    assert.equal(row.amount, 0);
    assert.equal(row.tag, 'admin');
    assert.throws(() => check.prepare('UPDATE online_cards SET user_id = 1 WHERE admin_card = 1').run(), /admin card/);
    check.close();
    const cheap = await httpCall({
      port, method: 'PUT', pathname: '/api/online/admin/packs/bronz', headers: { Cookie: admin },
      body: JSON.stringify({ price: 1 })
    });
    assert.equal(cheap.status, 200, cheap.text);
    for (let index = 1; index <= 5; index += 1) {
      const opened = await httpCall({
        port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: dailyUser },
        body: JSON.stringify({ slug: 'bronz', requestId: `gunluk-${index}-xxxx`, price: 999 })
      });
      assert.equal(opened.status, 200, opened.text);
      assert.equal(opened.json.price, 1);
    }
    const sixth = await httpCall({
      port, method: 'POST', pathname: '/api/online/packs/open', headers: { Cookie: dailyUser },
      body: JSON.stringify({ slug: 'bronz', requestId: 'gunluk-6-xxxx', price: 1 })
    });
    assert.equal(sixth.status, 429, sixth.text);
    const dailyBalance = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: dailyUser } });
    assert.equal(dailyBalance.json.balances.omniDolar, 4995);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('five wrong admin passwords lock free pack opens for 15 minutes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-pack-lock-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: path.join(dir, 'no.json'),
    ADMIN_EMAIL: 'admin-lock@example.com',
    STARTING_OMNI_DOLAR: '0',
    SMTP_HOST: ''
  };
  delete env.NODE_ENV;
  delete env.ONLINE_LOCK_TRIGGER;
  let running = spawnServer(env);
  try {
    await running.ready;
    insertUser(databaseFile, 'admin-lock@example.com', 'Kilit', 'user');
    const login = await httpCall({ port, method: 'POST', pathname: '/api/auth/login', body: JSON.stringify({ email: 'admin-lock@example.com', password }) });
    assert.equal(login.status, 200, login.text);
    const headers = { Cookie: cookieFrom(login) };
    await enrollTwoFactor(httpCall, port, headers.Cookie, password);
    async function attempt(requestId, secret) {
      return httpCall({
        port, method: 'POST', pathname: '/api/online/packs/open', headers,
        body: JSON.stringify({ slug: 'bronz', requestId, password: secret })
      });
    }
    for (let index = 1; index <= 4; index += 1) {
      const wrong = await attempt(`kilit-yanlis-${index}`, 'yanlis-sifre-1');
      assert.equal(wrong.status, 403, wrong.text);
      assert.match(wrong.json.error, /yeniden gir/);
    }
    const fifth = await attempt('kilit-yanlis-5', 'yanlis-sifre-1');
    assert.equal(fifth.status, 429, fifth.text);
    assert.equal(fifth.json.error, 'Çok fazla hatalı şifre denemesi. Ücretsiz açılış 15 dakika boyunca kilitli.');
    const blocked = await attempt('kilit-dogru-erken', password);
    assert.equal(blocked.status, 429, blocked.text);
    assert.equal(blocked.json.error, fifth.json.error);
    await stopServer(running.child);
    running = spawnServer(env);
    await running.ready;
    const afterRestart = await attempt('kilit-restart', password);
    assert.equal(afterRestart.status, 429, afterRestart.text);
    assert.equal(afterRestart.json.error, fifth.json.error);
    const db = new DatabaseSync(databaseFile, { timeout: 5000 });
    const stored = db.prepare('SELECT failures, locked_until FROM admin_pack_password_attempts').get();
    assert.equal(stored.failures, 5);
    assert.ok(stored.locked_until > Date.now());
    db.prepare('UPDATE admin_pack_password_attempts SET locked_until = ?').run(Date.now() - 1000);
    db.close();
    const opened = await attempt('kilit-acildi', password);
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.tag, 'admin');
    const cleared = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    assert.equal(cleared.prepare('SELECT COUNT(*) AS total FROM admin_pack_password_attempts').get().total, 0);
    cleared.close();
    const again = await attempt('kilit-sifir', 'yanlis-sifre-1');
    assert.equal(again.status, 403, again.text);
    const recount = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
    const row = recount.prepare('SELECT failures, locked_until FROM admin_pack_password_attempts').get();
    recount.close();
    assert.equal(row.failures, 1);
    assert.equal(row.locked_until, null);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
