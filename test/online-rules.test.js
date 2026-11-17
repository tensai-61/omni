const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { simulateOnlineMatch, EVENT_TYPES } = require('../lib/online-match');
const {
  installOnlineSchema,
  seedFreeTeams,
  roundRobin,
  applyCoinChange,
  worldRanking,
  pickTeam,
  saveSquad,
  createLeague,
  joinLeague,
  runDailyLock,
  catchUpDailySim
} = require('../lib/online-league');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'tour-maker.html'), 'utf8');
const matchSource = fs.readFileSync(path.join(root, 'lib/online-match.js'), 'utf8');

function loadLocales() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'locale.js'), 'utf8')}\nthis.I18N = I18N;`, context);
  return context.I18N;
}

function side(base, name) {
  const squad = [];
  for (const [position, count] of [['GK', 2], ['DEF', 5], ['MID', 6], ['FWD', 5]]) {
    for (let index = 1; index <= count; index += 1) {
      squad.push({
        id: `${name}-${position}-${index}`,
        name: `${name} ${position} ${index}`,
        position,
        gen: Math.max(40, base - index)
      });
    }
  }
  const xi = [];
  for (const position of ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD']) {
    xi.push(squad.find(player => player.position === position && !xi.includes(player.id)).id);
  }
  return { name, squad, xi };
}

test('online simulation is seeded, replayable, and never asks the user', () => {
  assert.equal(matchSource.includes('showSimulationChoice'), false);
  assert.equal(matchSource.includes('Math.random'), false);
  assert.match(html, /async function simulateFreeKickEvent/);
  assert.match(html, /showSimulationChoice\('Serbest vuruş sonucu'/);
  const home = side(86, 'Ev');
  const away = side(58, 'Dep');
  const seed = crypto.createHash('sha256').update('replay').digest('hex');
  const first = simulateOnlineMatch({ home, away, seed });
  const second = simulateOnlineMatch({ home, away, seed });
  assert.deepEqual(second, first);
  assert.ok(first.events.length > 8);
  assert.ok(first.events.every(event => EVENT_TYPES.includes(event.type)));
  assert.ok(first.events.every(event => event.minute >= 1 && event.minute <= 90));
  const types = new Set();
  let favorite = 0;
  let underdog = 0;
  let upset = 0;
  for (let index = 0; index < 40; index += 1) {
    const result = simulateOnlineMatch({
      home,
      away,
      seed: crypto.createHash('sha256').update(`mix-${index}`).digest('hex')
    });
    if (result.homeScore > result.awayScore) favorite += 1;
    if (result.awayScore > result.homeScore) underdog += 1;
    if (result.events.some(event => event.upset)) upset += 1;
    for (const event of result.events) types.add(event.type);
  }
  for (const type of ['goal', 'save', 'freeKickGoal', 'penaltyGoal', 'corner', 'yellow']) {
    assert.equal(types.has(type), true, type);
  }
  assert.ok(favorite > 24);
  assert.ok(upset >= 1);
});

test('banned reload shows the lock instead of the login screen', () => {
  const onload = html.slice(html.indexOf('window.onload'), html.indexOf('function showBanLock'));
  assert.match(onload, /if\(error\.banned\)showBanLock\(error\)/);
  assert.equal(/catch\(error\)\{\s*showAuthView/.test(onload), false);
  assert.match(html, /function showBanLock\(error\)/);
  assert.match(html, /authView'\)\.classList\.add\('hidden'\)/);
});

test('every language has the online league copy', () => {
  const locales = loadLocales();
  const keys = Object.keys(locales.tr).filter(key => key.startsWith('online'));
  assert.ok(keys.includes('onlineGoal'));
  assert.ok(keys.includes('onlineCoinNote'));
  for (const code of ['tr', 'en', 'es', 'ru', 'nl', 'de', 'az']) {
    for (const key of keys) {
      assert.equal(typeof locales[code][key], 'string', `${code}.${key}`);
      assert.notEqual(locales[code][key].trim(), '', `${code}.${key}`);
      assert.equal(locales[code][key].includes('$'), false, `${code}.${key}`);
    }
  }
  const goals = ['tr', 'en', 'es', 'ru', 'nl', 'de', 'az'].map(code => locales[code].onlineGoal);
  assert.equal(new Set(goals).size, goals.length);
  assert.match(html, /id="onlineLeagueScreen"/);
  assert.match(html, /id="onlineLeagueCard"/);
  assert.equal(html.includes('showSimulationChoice'), true);
});

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-rules-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );
  `);
  installOnlineSchema(database);
  seedFreeTeams(database);
  return { dir, database };
}

test('coins cannot go negative and a ledger key pays only once', () => {
  const { dir, database } = tempDatabase();
  try {
    database.prepare('INSERT INTO users (email, username, role, created_at) VALUES (?, ?, ?, ?)').run('u@x.com', 'U', 'user', '2026-11-03T00:00:00.000Z');
    const userId = 1;
    assert.throws(() => applyCoinChange(database, userId, -5, 'deneme', 'neg', '2026-11-03T00:00:00.000Z'), /eksiye/);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM user_balances').get().total, 0);
    const first = applyCoinChange(database, userId, 40, 'ödül', 'ref-1', '2026-11-03T00:00:00.000Z');
    const second = applyCoinChange(database, userId, 40, 'ödül', 'ref-1', '2026-11-03T00:00:01.000Z');
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(database.prepare('SELECT coins FROM user_balances WHERE user_id = 1').get().coins, 40);
    assert.throws(() => applyCoinChange(database, userId, -50, 'harcama', 'ref-2', '2026-11-03T00:00:02.000Z'), /eksiye/);
    assert.equal(database.prepare('SELECT coins FROM user_balances WHERE user_id = 1').get().coins, 40);
    assert.throws(() => database.prepare('UPDATE user_balances SET coins = -1 WHERE user_id = 1').run(), /CHECK/);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one active league, admin exclusion, single simulation, and one reward', () => {
  const { dir, database } = tempDatabase();
  try {
    const rounds = roundRobin([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(rounds.length, 7);
    const pairs = new Set();
    for (const round of rounds) {
      const seen = new Set();
      assert.equal(round.length, 4);
      for (const [home, away] of round) {
        assert.equal(seen.has(home) || seen.has(away) || home === away, false);
        seen.add(home);
        seen.add(away);
        const key = [home, away].sort((left, right) => left - right).join('-');
        assert.equal(pairs.has(key), false);
        pairs.add(key);
      }
    }
    assert.equal(pairs.size, 28);

    const insert = database.prepare('INSERT INTO users (email, username, role, created_at) VALUES (?, ?, ?, ?)');
    for (let index = 1; index <= 8; index += 1) insert.run(`u${index}@x.com`, `Oyuncu${index}`, 'user', '2026-11-03T00:00:00.000Z');
    insert.run('admin@x.com', 'Yonetici', 'admin', '2026-11-03T00:00:00.000Z');
    const before = new Date('2026-11-03T09:00:00.000Z');
    const lock = new Date('2026-11-03T17:30:00.000Z');
    for (let index = 1; index <= 8; index += 1) {
      pickTeam(database, { id: index, email: `u${index}@x.com`, role: 'user' }, index, before, 'admin@x.com');
    }
    assert.throws(() => pickTeam(database, { id: 1, email: 'u1@x.com', role: 'user' }, 2, before, 'admin@x.com'), /bir kez/);
    assert.throws(() => createLeague(database, { id: 9, email: 'admin@x.com', role: 'admin' }, 'Admin Ligi', 8, before, 'admin@x.com'), /katılamaz/);
    const league = createLeague(database, { id: 1, email: 'u1@x.com', role: 'user' }, 'Aksam Ligi', 8, before, 'admin@x.com');
    assert.throws(() => createLeague(database, { id: 1, email: 'u1@x.com', role: 'user' }, 'Ikinci', 8, before, 'admin@x.com'), /aktif/);
    for (let index = 2; index <= 8; index += 1) {
      joinLeague(database, { id: index, email: `u${index}@x.com`, role: 'user' }, league.id, before, 'admin@x.com');
    }
    assert.throws(() => joinLeague(database, { id: 9, email: 'admin@x.com', role: 'admin' }, league.id, before, 'admin@x.com'), /katılamaz/);
    assert.throws(() => database.prepare('INSERT INTO user_active_league (user_id, league_id) VALUES (1, ?)').run(league.id), /UNIQUE/);
    const squad = database.prepare('SELECT starting_xi FROM user_squads WHERE user_id = 1').get();
    const xi = JSON.parse(squad.starting_xi);
    const swapped = xi.slice();
    const hold = swapped[5];
    swapped[5] = swapped[6];
    swapped[6] = hold;
    saveSquad(database, { id: 1, email: 'u1@x.com', role: 'user' }, swapped, before, 'admin@x.com');
    assert.throws(() => saveSquad(database, { id: 1, email: 'u1@x.com', role: 'user' }, swapped, lock, 'admin@x.com'), /kilitlendi/);

    runDailyLock(database, lock, 'admin@x.com');
    const played = database.prepare(`SELECT * FROM online_fixtures WHERE status = 'played' ORDER BY id`).all();
    const waiting = database.prepare(`SELECT * FROM online_fixtures WHERE status = 'scheduled'`).all();
    assert.equal(played.length, 4);
    assert.equal(waiting.length, 24);
    assert.ok(played.every(row => /^[0-9a-f]{64}$/.test(row.seed) && row.events && row.home_snapshot));
    assert.ok(waiting.every(row => row.seed === null && row.events === null));
    const snapshot = played.map(row => ({ id: row.id, score: `${row.home_score}-${row.away_score}`, seed: row.seed, events: row.events }));
    runDailyLock(database, lock, 'admin@x.com');
    const again = database.prepare(`SELECT id, home_score, away_score, seed, events FROM online_fixtures WHERE status = 'played' ORDER BY id`).all();
    assert.deepEqual(again.map(row => ({ id: row.id, score: `${row.home_score}-${row.away_score}`, seed: row.seed, events: row.events })), snapshot);
    for (const row of played) {
      const replay = simulateOnlineMatch({
        home: JSON.parse(row.home_snapshot),
        away: JSON.parse(row.away_snapshot),
        seed: row.seed
      });
      assert.equal(replay.homeScore, row.home_score);
      assert.equal(replay.awayScore, row.away_score);
      assert.deepEqual(replay.events, JSON.parse(row.events));
    }
    assert.throws(() => database.prepare('UPDATE online_fixtures SET home_score = 9 WHERE id = ?').run(played[0].id), /immutable/);

    const lastDay = database.prepare(`SELECT MAX(match_day) AS day FROM online_fixtures`).get().day;
    runDailyLock(database, new Date(`${lastDay}T17:30:00.000Z`), 'admin@x.com');
    assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM online_fixtures WHERE status != 'played'`).get().total, 0);
    const ledger = database.prepare("SELECT user_id, amount, balance_after, ref_key FROM coin_ledger WHERE currency = 'coin'").all();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].ref_key, `online-league-win:${league.id}`);
    assert.ok(ledger[0].amount > 0);
    assert.equal(ledger[0].balance_after, ledger[0].amount);
    const finished = database.prepare('SELECT status, reward_paid, winner_user_id FROM online_leagues WHERE id = ?').get(league.id);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.reward_paid, 1);
    assert.equal(finished.winner_user_id, ledger[0].user_id);
    const omniRows = database.prepare("SELECT COUNT(*) AS total FROM coin_ledger WHERE currency = 'omni'").get().total;
    runDailyLock(database, new Date(`${lastDay}T18:00:00.000Z`), 'admin@x.com');
    catchUpDailySim(database, new Date(`${lastDay}T18:00:00.000Z`), 'admin@x.com');
    catchUpDailySim(database, new Date(`${lastDay}T18:30:00.000Z`), 'admin@x.com');
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM online_sim_runs').get().total, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM coin_ledger WHERE currency = 'coin'").get().total, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM coin_ledger WHERE currency = 'omni'").get().total, omniRows);
    assert.equal(database.prepare('SELECT coins FROM user_balances WHERE user_id = ?').get(ledger[0].user_id).coins, ledger[0].amount);
    const ranking = worldRanking(database, 'admin@x.com');
    assert.equal(ranking.some(row => row.username === 'Yonetici'), false);
    assert.ok(ranking.length >= 1);

    database.prepare(`
      INSERT INTO online_fixtures (league_id, round, match_day, home_user_id, away_user_id, status, home_score, away_score, played_at)
      VALUES (?, 99, '2026-11-01', 9, 1, 'played', 0, 3, '2026-11-01T17:00:00.000Z')
    `).run(league.id);
    const hidden = worldRanking(database, 'admin@x.com');
    assert.equal(hidden.some(row => row.userId === 9 || row.username === 'Yonetici'), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM user_active_league').get().total, 0);
    assert.doesNotThrow(() => createLeague(database, { id: 2, email: 'u2@x.com', role: 'user' }, 'Yeni Sezon', 8, new Date('2026-12-01T09:00:00.000Z'), 'admin@x.com'));
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
