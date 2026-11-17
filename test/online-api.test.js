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
const { enrollTwoFactor } = require('../scripts/enroll-2fa');
const { simulateOnlineMatch } = require('../lib/online-match');

const root = path.join(__dirname, '..');
const password = 'OnlineTest1';
const before = '2026-11-03T09:00:00.000Z';

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
  `).run(
    email,
    username,
    hash.toString('hex'),
    salt.toString('hex'),
    role,
    banned ? 1 : 0,
    banned ? 1 : 0,
    banned ? 'test ban' : null,
    new Date().toISOString()
  );
  db.close();
}

test('online API checks auth and ban, and the dev lock runs the day once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-api-'));
  const databaseFile = path.join(dir, 'test.db');
  const port = await freePort();
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_FILE: databaseFile, DATA_FILE: path.join(dir, 'no.json'), ADMIN_EMAIL: 'admin-online@example.com', ONLINE_LOCK_TRIGGER: '1', STARTING_OMNI_DOLAR: '5000', SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: '' };
  delete env.NODE_ENV;
  const running = spawnServer(env);
  try {
    await running.ready;
    const closed = await httpCall({ port, method: 'POST', pathname: '/api/online/dev/run-lock', body: '{}' });
    assert.equal(closed.status, 401, closed.text);
    const anon = await httpCall({ port, method: 'GET', pathname: '/api/online/home' });
    assert.equal(anon.status, 401, anon.text);
    for (let index = 1; index <= 8; index += 1) insertUser(databaseFile, `u${index}@omni.test`, `Oyuncu${index}`, 'user');
    insertUser(databaseFile, 'admin-online@example.com', 'Yonetici', 'user');
    insertUser(databaseFile, 'banned-online@example.com', 'Banli', 'user', true);
    async function login(email) {
      const response = await httpCall({ port, method: 'POST', pathname: '/api/auth/login', body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200, response.text);
      return cookieFrom(response);
    }
    const bannedCookie = await login('banned-online@example.com');
    const bannedSession = await httpCall({ port, method: 'GET', pathname: '/api/auth/session', headers: { Cookie: bannedCookie } });
    assert.equal(bannedSession.status, 403);
    assert.equal(bannedSession.json.banned, true);
    const bannedHome = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: bannedCookie } });
    assert.equal(bannedHome.status, 403);
    assert.equal(bannedHome.json.banned, true);
    const adminCookie = await login('admin-online@example.com');
    await enrollTwoFactor(httpCall, port, adminCookie, password);
    const adminJoin = await httpCall({
      port, method: 'POST', pathname: '/api/online/leagues', headers: { Cookie: adminCookie, 'x-online-now': before },
      body: JSON.stringify({ name: 'Admin Ligi', size: 8 })
    });
    assert.equal(adminJoin.status, 403, adminJoin.text);
    const cookies = [];
    for (let index = 1; index <= 8; index += 1) cookies.push(await login(`u${index}@omni.test`));
    const headers = (index) => ({ Cookie: cookies[index] });
    const adminHeaders = { Cookie: adminCookie };
    const userDenied = await httpCall({
      port, method: 'POST', pathname: '/api/online/dev/run-lock',
      headers: headers(0),
      body: JSON.stringify({ at: '2099-06-01T12:00:00.000Z' })
    });
    assert.equal(userDenied.status, 403, userDenied.text);
    const teams = await httpCall({ port, method: 'GET', pathname: '/api/online/teams', headers: headers(0) });
    assert.equal(teams.json.teams.length, 8);
    assert.equal(teams.json.teams.every(team => team.placeholder && team.players.some(player => player.name.startsWith('Örnek'))), true);
    for (let index = 0; index < 8; index += 1) {
      const picked = await httpCall({
        port, method: 'POST', pathname: '/api/online/team', headers: headers(index),
        body: JSON.stringify({ teamId: teams.json.teams[index].id })
      });
      assert.equal(picked.status, 200, picked.text);
      assert.equal(picked.json.squad.startingXi.length, 11);
    }
    const created = await httpCall({
      port, method: 'POST', pathname: '/api/online/leagues', headers: headers(0),
      body: JSON.stringify({ name: 'Aksam Ligi', size: 8 })
    });
    assert.equal(created.status, 201, created.text);
    const again = await httpCall({
      port, method: 'POST', pathname: '/api/online/leagues', headers: headers(0),
      body: JSON.stringify({ name: 'Ikinci Lig', size: 8 })
    });
    assert.equal(again.status, 409, again.text);
    const found = await httpCall({ port, method: 'GET', pathname: '/api/online/leagues?q=aksam', headers: headers(1) });
    assert.equal(found.json.leagues.some(league => league.id === created.json.league.id), true);
    for (let index = 1; index < 8; index += 1) {
      const joined = await httpCall({
        port, method: 'POST', pathname: `/api/online/leagues/${created.json.league.id}/join`, headers: headers(index), body: '{}'
      });
      assert.equal(joined.status, 200, joined.text);
    }
    const home = await httpCall({ port, method: 'GET', pathname: '/api/online/home', headers: headers(0) });
    assert.equal(home.json.balances.coins, 0);
    assert.equal(home.json.balances.omniDolar, 5000);
    assert.equal(home.json.balances.unlimited, false);
    assert.equal(home.json.league.fixtures.every(fixture => fixture.seed === null && fixture.events === null), true);
    const xi = home.json.squad.startingXi.slice();
    const swapped = xi.slice();
    const hold = swapped[5];
    swapped[5] = swapped[6];
    swapped[6] = hold;
    const saved = await httpCall({
      port, method: 'PUT', pathname: '/api/online/squad', headers: headers(0),
      body: JSON.stringify({ startingXi: swapped })
    });
    assert.equal(saved.status, 200, saved.text);
    const clockPlain = await httpCall({ port, method: 'GET', pathname: '/api/online/home', headers: headers(0) });
    const clockSpoof = await httpCall({
      port, method: 'GET', pathname: '/api/online/home',
      headers: { ...headers(0), 'x-online-now': '2099-06-01T12:00:00.000Z' }
    });
    assert.equal(clockSpoof.json.lock.nextLockAt, clockPlain.json.lock.nextLockAt);
    assert.equal(clockSpoof.json.lock.squadLocked, clockPlain.json.lock.squadLocked);
    const adminClock = await httpCall({
      port, method: 'GET', pathname: '/api/online/home',
      headers: { ...adminHeaders, 'x-online-now': '2099-06-01T12:00:00.000Z' }
    });
    assert.match(adminClock.json.lock.nextLockAt, /^2099-/);
    const firstDay = home.json.league.fixtures.find(fixture => fixture.round === 1).matchDay;
    const ran = await httpCall({
      port, method: 'POST', pathname: '/api/online/dev/run-lock', headers: adminHeaders,
      body: JSON.stringify({ at: `${firstDay}T17:30:00.000Z` })
    });
    assert.equal(ran.status, 200, ran.text);
    const day = await httpCall({ port, method: 'GET', pathname: `/api/online/leagues/${created.json.league.id}`, headers: headers(0) });
    const played = day.json.league.fixtures.filter(fixture => fixture.status === 'played');
    const waiting = day.json.league.fixtures.filter(fixture => fixture.status === 'scheduled');
    assert.equal(played.length, 4);
    assert.equal(waiting.length, 24);
    assert.ok(waiting.every(fixture => fixture.seed === null));
    for (const fixture of played) {
      const replay = simulateOnlineMatch({ home: fixture.lineups.home, away: fixture.lineups.away, seed: fixture.seed });
      assert.deepEqual(replay.events, fixture.events);
      assert.equal(replay.homeScore, fixture.homeScore);
    }
    const firstSeed = played[0].seed;
    const reran = await httpCall({
      port, method: 'POST', pathname: '/api/online/dev/run-lock', headers: adminHeaders,
      body: JSON.stringify({ at: `${firstDay}T17:30:00.000Z` })
    });
    assert.equal(reran.status, 200, reran.text);
    const same = await httpCall({ port, method: 'GET', pathname: `/api/online/leagues/${created.json.league.id}`, headers: headers(0) });
    const samePlayed = same.json.league.fixtures.find(fixture => fixture.id === played[0].id);
    assert.equal(samePlayed.seed, firstSeed);
    assert.deepEqual(samePlayed.events, played[0].events);
    const lastDay = same.json.league.fixtures.reduce((max, fixture) => fixture.matchDay > max ? fixture.matchDay : max, '');
    const season = await httpCall({
      port, method: 'POST', pathname: '/api/online/dev/run-lock', headers: adminHeaders,
      body: JSON.stringify({ at: `${lastDay}T17:30:00.000Z` })
    });
    assert.equal(season.status, 200, season.text);
    const finished = await httpCall({ port, method: 'GET', pathname: `/api/online/leagues/${created.json.league.id}`, headers: headers(0) });
    assert.equal(finished.json.league.status, 'finished');
    assert.equal(finished.json.league.rewardPaid, true);
    const homes = [];
    for (let index = 0; index < 8; index += 1) {
      const mine = await httpCall({ port, method: 'GET', pathname: '/api/online/home', headers: headers(index) });
      homes.push(mine.json);
    }
    const paid = homes.filter(item => item.balances.coins > 0);
    assert.equal(paid.length, 1);
    assert.equal(paid[0].userId, finished.json.league.winnerUserId);
    assert.equal(paid[0].balances.coins, finished.json.league.coinReward);
    const repeat = await httpCall({
      port, method: 'POST', pathname: '/api/online/dev/run-lock', headers: adminHeaders,
      body: JSON.stringify({ at: `${lastDay}T18:00:00.000Z` })
    });
    assert.equal(repeat.status, 200, repeat.text);
    const winner = await httpCall({ port, method: 'GET', pathname: '/api/online/balances', headers: { Cookie: cookies[homes.findIndex(item => item.userId === paid[0].userId)] } });
    assert.equal(winner.json.balances.coins, paid[0].balances.coins);
    const ranking = await httpCall({ port, method: 'GET', pathname: '/api/online/ranking', headers: headers(0) });
    assert.equal(ranking.json.ranking.some(row => row.username === 'Yonetici'), false);
    assert.equal(ranking.json.ranking.some(row => row.username === 'Banli'), false);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock trigger stays hidden unless the test switch is on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-api-off-'));
  const port = await freePort();
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_FILE: path.join(dir, 'test.db'), DATA_FILE: path.join(dir, 'no.json'), ADMIN_EMAIL: 'admin-online@example.com', SMTP_HOST: '' };
  delete env.NODE_ENV;
  delete env.ONLINE_LOCK_TRIGGER;
  const running = spawnServer(env);
  try {
    await running.ready;
    const hidden = await httpCall({ port, method: 'POST', pathname: '/api/online/dev/run-lock', body: '{}' });
    assert.equal(hidden.status, 404, hidden.text);
  } finally {
    await stopServer(running.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
