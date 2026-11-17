const crypto = require('crypto');
const { ALGORITHM, simulateOnlineMatch } = require('./online-match');
const { canonicalEmail, isAdminAccount } = require('./account');

const SIZES = [8, 10, 12, 16, 20];
const REWARDS = { 8: 200, 10: 250, 12: 300, 16: 400, 20: 500 };
const TIME_ZONE = 'Europe/Istanbul';
const LOCK_HOUR = 20;

const TEAM_BLUEPRINTS = [
  { slug: 'kuzey', name: 'Kuzey Yıldızı (örnek)', base: 84 },
  { slug: 'ada', name: 'Ada Kıyısı (örnek)', base: 80 },
  { slug: 'bozkir', name: 'Bozkır SK (örnek)', base: 76 },
  { slug: 'liman', name: 'Liman 1907 (örnek)', base: 73 },
  { slug: 'yayla', name: 'Yayla Birliği (örnek)', base: 70 },
  { slug: 'demir', name: 'Demir Kapı (örnek)', base: 67 },
  { slug: 'vadi', name: 'Vadi Spor (örnek)', base: 64 },
  { slug: 'feneriz', name: 'Fener İz (örnek)', base: 60 }
];

const ROSTER_SHAPE = [['GK', 2], ['DEF', 5], ['MID', 6], ['FWD', 5]];
const POSITION_LABEL = { GK: 'Kaleci', DEF: 'Defans', MID: 'Orta saha', FWD: 'Forvet' };

function fail(status, error) {
  return Object.assign(new Error(error), { status });
}

function asId(value) {
  if (typeof value === 'bigint') value = Number(value);
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function isUnique(error) {
  if (Number(error?.errcode) === 2067) return true;
  return String(error?.message || '').includes('UNIQUE constraint');
}

function cleanText(value, min, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[<>]/g, '').trim();
  if (text.length < min || text.length > max) return '';
  return text;
}

function publicName(value) {
  return String(value || '').replace(/[<>]/g, '').slice(0, 40);
}

function istanbulParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    hour: bag.hour === '24' ? 0 : Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second)
  };
}

function addIstanbulDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return istanbulParts(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0))).date;
}

function lockInstant(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
}

function nextLockInstant(now) {
  const parts = istanbulParts(now);
  const today = lockInstant(parts.date);
  if (today.getTime() > now.getTime()) return today;
  return lockInstant(addIstanbulDays(parts.date, 1));
}

function firstMatchDay(now) {
  const parts = istanbulParts(now);
  if (parts.hour >= LOCK_HOUR) return addIstanbulDays(parts.date, 1);
  return parts.date;
}

function isDue(matchDay, now) {
  const parts = istanbulParts(now);
  if (matchDay < parts.date) return true;
  if (matchDay > parts.date) return false;
  return parts.hour >= LOCK_HOUR;
}

function withImmediate(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function installOnlineSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS free_teams (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      placeholder INTEGER NOT NULL DEFAULT 1,
      roster TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_squads (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      free_team_id INTEGER NOT NULL REFERENCES free_teams(id),
      starting_xi TEXT NOT NULL,
      picked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_leagues (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size IN (8, 10, 12, 16, 20)),
      owner_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'finished')),
      coin_reward INTEGER NOT NULL CHECK (coin_reward > 0),
      winner_user_id INTEGER,
      reward_paid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS online_league_members (
      league_id INTEGER NOT NULL REFERENCES online_leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (league_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS user_active_league (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      league_id INTEGER NOT NULL REFERENCES online_leagues(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS online_fixtures (
      id INTEGER PRIMARY KEY,
      league_id INTEGER NOT NULL REFERENCES online_leagues(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      match_day TEXT NOT NULL,
      home_user_id INTEGER NOT NULL REFERENCES users(id),
      away_user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'played')),
      seed TEXT,
      algorithm TEXT,
      home_score INTEGER,
      away_score INTEGER,
      home_snapshot TEXT,
      away_snapshot TEXT,
      events TEXT,
      played_at TEXT,
      UNIQUE (league_id, round, home_user_id, away_user_id)
    );
    CREATE INDEX IF NOT EXISTS online_fixtures_due ON online_fixtures(status, match_day);
    CREATE TABLE IF NOT EXISTS user_balances (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
      omni_dolar INTEGER NOT NULL DEFAULT 0 CHECK (omni_dolar >= 0)
    );
    CREATE TABLE IF NOT EXISTS coin_ledger (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      currency TEXT NOT NULL CHECK (currency IN ('coin', 'omni')),
      reason TEXT NOT NULL,
      ref_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      tag TEXT NOT NULL DEFAULT 'user' CHECK (tag IN ('user', 'admin'))
    );
    CREATE TABLE IF NOT EXISTS online_sim_runs (
      day_key TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS online_fixtures_immutable
    BEFORE UPDATE ON online_fixtures
    WHEN OLD.status = 'played'
    BEGIN
      SELECT RAISE(ABORT, 'fixture immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS online_fixtures_no_delete
    BEFORE DELETE ON online_fixtures
    WHEN OLD.status = 'played'
    BEGIN
      SELECT RAISE(ABORT, 'played fixture cannot be deleted');
    END;
  `);
  const ledgerColumns = new Set(database.prepare('PRAGMA table_info(coin_ledger)').all().map(column => column.name));
  if (!ledgerColumns.has('tag')) {
    database.exec("ALTER TABLE coin_ledger ADD COLUMN tag TEXT NOT NULL DEFAULT 'user'");
  }
  require('./online-packs').installPackSchema(database);
  require('./online-market').installMarketSchema(database);
}

function buildRoster(team) {
  const players = [];
  for (const [position, count] of ROSTER_SHAPE) {
    for (let index = 1; index <= count; index += 1) {
      const gen = clampGen(team.base - (index - 1) * 2 + (position === 'FWD' ? 1 : 0));
      players.push({
        id: `${team.slug}-${position.toLowerCase()}-${index}`,
        name: `Örnek ${POSITION_LABEL[position]} ${index}`,
        position,
        gen
      });
    }
  }
  return players;
}

function clampGen(value) {
  return Math.max(40, Math.min(92, value));
}

function defaultXi(players) {
  const groups = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const player of players) {
    if (groups[player.position]) groups[player.position].push(player);
  }
  for (const list of Object.values(groups)) {
    list.sort((left, right) => right.gen - left.gen || String(left.id).localeCompare(String(right.id)));
  }
  const chosen = [
    ...groups.GK.slice(0, 1),
    ...groups.DEF.slice(0, 4),
    ...groups.MID.slice(0, 4),
    ...groups.FWD.slice(0, 2)
  ];
  const used = new Set(chosen.map(player => player.id));
  const rest = players.filter(player => !used.has(player.id)).sort((left, right) => right.gen - left.gen);
  while (chosen.length < 11 && rest.length) chosen.push(rest.shift());
  return chosen.slice(0, 11).map(player => player.id);
}

function seedFreeTeams(database) {
  const insert = database.prepare('INSERT OR IGNORE INTO free_teams (slug, name, placeholder, roster) VALUES (?, ?, 1, ?)');
  for (const team of TEAM_BLUEPRINTS) insert.run(team.slug, team.name, JSON.stringify(buildRoster(team)));
}

function roundRobin(ids) {
  const list = ids.slice();
  const count = list.length;
  if (!SIZES.includes(count)) throw fail(400, 'Lig boyutu geçersiz');
  const rounds = [];
  for (let round = 0; round < count - 1; round += 1) {
    const pairs = [];
    for (let index = 0; index < count / 2; index += 1) {
      const left = list[index];
      const right = list[count - 1 - index];
      pairs.push(round % 2 === 0 ? [left, right] : [right, left]);
    }
    rounds.push(pairs);
    const tail = list.pop();
    list.splice(1, 0, tail);
  }
  return rounds;
}

function isAdmin(user, adminEmail) {
  return isAdminAccount(user, adminEmail);
}

function storedAdmin(database, userId) {
  const id = asId(userId);
  if (!id) return false;
  const table = database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'user_roles'").get();
  if (!table) return false;
  const row = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(id);
  return row?.role === 'admin';
}

function excludedAdmin(database, user, adminEmail) {
  if (isAdmin(user, adminEmail)) return true;
  return storedAdmin(database, user?.id || user?.userId);
}

function actingAdminEmail(user) {
  return user?.rank === 'admin' ? canonicalEmail(user.email) : '';
}

function configuredInteger(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0 || value > max) return fallback;
  return value;
}

function assertCompetitor(user, adminEmail) {
  if (isAdmin(user, adminEmail)) throw fail(403, 'Yönetici hesapları online lige katılamaz');
}

function readRoster(value) {
  const roster = JSON.parse(value);
  return Array.isArray(roster) ? roster : [];
}

function squadRow(database, userId) {
  return database.prepare(`
    SELECT user_squads.user_id, user_squads.free_team_id, user_squads.starting_xi, user_squads.picked_at,
      free_teams.name, free_teams.placeholder, free_teams.roster, free_teams.slug
    FROM user_squads JOIN free_teams ON free_teams.id = user_squads.free_team_id
    WHERE user_squads.user_id = ?
  `).get(userId);
}

function publicSquad(row) {
  if (!row) return null;
  const players = readRoster(row.roster);
  return {
    teamId: asId(row.free_team_id),
    teamName: row.name,
    placeholder: Boolean(row.placeholder),
    players,
    startingXi: JSON.parse(row.starting_xi)
  };
}

function listTeams(database) {
  return database.prepare('SELECT id, slug, name, placeholder, roster FROM free_teams ORDER BY id').all().map(row => {
    const players = readRoster(row.roster);
    const average = players.length ? Math.round(players.reduce((total, player) => total + Number(player.gen || 0), 0) / players.length) : 0;
    return {
      id: asId(row.id),
      name: row.name,
      placeholder: Boolean(row.placeholder),
      averageGen: average,
      players
    };
  });
}

function balancesOf(database, userId) {
  const row = database.prepare('SELECT coins, omni_dolar FROM user_balances WHERE user_id = ?').get(userId);
  return { coins: Number(row?.coins || 0), omniDolar: Number(row?.omni_dolar || 0) };
}

const BALANCE_COLUMN = { coin: 'coins', omni: 'omni_dolar' };

function applyBalanceChange(database, userId, amount, currency, reason, refKey, nowIso, tag = 'user') {
  const column = BALANCE_COLUMN[currency];
  if (!column) throw fail(400, 'Para birimi geçersiz');
  if (tag !== 'user' && tag !== 'admin') throw fail(400, 'Kayıt etiketi geçersiz');
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw fail(400, 'Tutar geçersiz');
  if (typeof refKey !== 'string' || refKey.length < 1 || refKey.length > 160) throw fail(400, 'Kayıt anahtarı geçersiz');
  const note = typeof reason === 'string' ? reason.replace(/[<>]/g, '').trim().slice(0, 160) : '';
  if (!note) throw fail(400, 'Kayıt açıklaması geçersiz');
  const existing = database.prepare('SELECT balance_after, currency FROM coin_ledger WHERE ref_key = ?').get(refKey);
  if (existing) {
    if (existing.currency !== currency) throw fail(409, 'Kayıt anahtarı çakıştı');
    return { applied: false, balance: Number(existing.balance_after) };
  }
  const current = database.prepare('SELECT coins, omni_dolar FROM user_balances WHERE user_id = ?').get(userId);
  const balance = Number(current?.[column] || 0);
  const next = balance + amount;
  if (!Number.isInteger(next) || next < 0) throw fail(409, 'Bakiye eksiye düşemez');
  if (!current) {
    const coins = currency === 'coin' ? next : 0;
    const omni = currency === 'omni' ? next : 0;
    database.prepare('INSERT INTO user_balances (user_id, coins, omni_dolar) VALUES (?, ?, ?)').run(userId, coins, omni);
  } else {
    const updated = database.prepare(`UPDATE user_balances SET ${column} = ? WHERE user_id = ? AND ${column} = ?`).run(next, userId, balance);
    if (updated.changes !== 1) throw fail(409, 'Bakiye çakışması');
  }
  database.prepare(`
    INSERT INTO coin_ledger (user_id, amount, balance_after, currency, reason, ref_key, created_at, tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, amount, next, currency, note, refKey, nowIso, tag);
  return { applied: true, balance: next };
}

function applyCoinChange(database, userId, amount, reason, refKey, nowIso) {
  return applyBalanceChange(database, userId, amount, 'coin', reason, refKey, nowIso, 'user');
}

function recordAdminZero(database, userId, currency, reason, refKey, nowIso) {
  const column = BALANCE_COLUMN[currency];
  if (!column) throw fail(400, 'Para birimi geçersiz');
  if (typeof refKey !== 'string' || refKey.length < 1 || refKey.length > 160) throw fail(400, 'Kayıt anahtarı geçersiz');
  const note = typeof reason === 'string' ? reason.replace(/[<>]/g, '').trim().slice(0, 160) : '';
  if (!note) throw fail(400, 'Kayıt açıklaması geçersiz');
  const existing = database.prepare('SELECT balance_after, currency, tag FROM coin_ledger WHERE ref_key = ?').get(refKey);
  if (existing) {
    if (existing.currency !== currency || existing.tag !== 'admin') throw fail(409, 'Kayıt anahtarı çakıştı');
    return { applied: false, balance: Number(existing.balance_after) };
  }
  const balanceAfter = currency === 'coin' ? balancesOf(database, userId).coins : balancesOf(database, userId).omniDolar;
  database.prepare(`
    INSERT INTO coin_ledger (user_id, amount, balance_after, currency, reason, ref_key, created_at, tag)
    VALUES (?, 0, ?, ?, ?, ?, ?, 'admin')
  `).run(userId, balanceAfter, currency, note, refKey, nowIso);
  return { applied: true, balance: balanceAfter };
}

function grantStartingOmni(database, user, nowIso, adminEmail) {
  if (!asId(user?.id) || isAdmin(user, adminEmail)) return { applied: false };
  const amount = configuredInteger('STARTING_OMNI_DOLAR', 5000, 1_000_000);
  if (!amount) return { applied: false };
  return applyBalanceChange(database, user.id, amount, 'omni', 'Başlangıç Omni Dolar', `omni-start:${user.id}`, nowIso, 'user');
}

function ensureStartingOmni(database, user, nowIso, adminEmail) {
  return withImmediate(database, () => grantStartingOmni(database, user, nowIso, adminEmail));
}

function squadLocked(database, userId, now) {
  const rows = database.prepare(`
    SELECT match_day FROM online_fixtures
    WHERE status = 'scheduled' AND (home_user_id = ? OR away_user_id = ?)
  `).all(userId, userId);
  return rows.some(row => isDue(row.match_day, now));
}

function pickTeam(database, user, teamId, now, adminEmail) {
  assertCompetitor(user, adminEmail);
  const id = asId(teamId);
  return withImmediate(database, () => {
    const team = database.prepare('SELECT id, roster FROM free_teams WHERE id = ?').get(id);
    if (!team) throw fail(404, 'Takım bulunamadı');
    const existing = database.prepare('SELECT user_id FROM user_squads WHERE user_id = ?').get(user.id);
    if (existing) throw fail(409, 'Ücretsiz takım bir kez seçilir');
    const xi = defaultXi(readRoster(team.roster));
    if (xi.length !== 11) throw fail(500, 'Takım kadrosu eksik');
    database.prepare('INSERT INTO user_squads (user_id, free_team_id, starting_xi, picked_at) VALUES (?, ?, ?, ?)').run(
      user.id, team.id, JSON.stringify(xi), now.toISOString()
    );
    return publicSquad(squadRow(database, user.id));
  });
}

function validXiId(id) {
  return /^[\w.-]{1,40}$/.test(id) || /^card:\d{1,12}$/.test(id);
}

function clubSquadPlayers(database, userId) {
  return require('./online-packs').listOwnedCards(database, userId, false).map(card => ({
    id: card.xiId,
    name: card.name,
    position: card.position,
    gen: card.gen,
    source: 'club'
  }));
}

function saveSquad(database, user, startingXi, now, adminEmail) {
  assertCompetitor(user, adminEmail);
  if (!Array.isArray(startingXi) || startingXi.length !== 11) throw fail(400, 'İlk 11 tam 11 oyuncu olmalı');
  const ids = startingXi.map(id => String(id || ''));
  if (new Set(ids).size !== 11 || ids.some(id => !validXiId(id))) throw fail(400, 'İlk 11 geçersiz');
  return withImmediate(database, () => {
    if (squadLocked(database, user.id, now)) throw fail(409, 'Kadron bu maç günü için kilitlendi');
    const row = squadRow(database, user.id);
    if (!row) throw fail(400, 'Önce ücretsiz takımını seç');
    const pool = new Map(readRoster(row.roster).map(player => [player.id, player]));
    for (const player of clubSquadPlayers(database, user.id)) pool.set(player.id, player);
    const chosen = ids.map(id => pool.get(id));
    if (chosen.some(player => !player)) throw fail(400, 'İlk 11 takım kadrosundan veya kulübünden seçilmeli');
    const listed = require('./online-market').listedXiIds(database, user.id);
    if (ids.some(id => listed.has(id))) throw fail(409, 'Satıştaki kart ilk 11’de duramaz');
    if (!chosen.some(player => player.position === 'GK')) throw fail(400, 'İlk 11 içinde bir kaleci olmalı');
    database.prepare('UPDATE user_squads SET starting_xi = ? WHERE user_id = ?').run(JSON.stringify(ids), user.id);
    return publicSquad(squadRow(database, user.id));
  });
}

function activeLeagueId(database, userId) {
  const row = database.prepare('SELECT league_id FROM user_active_league WHERE user_id = ?').get(userId);
  return row ? asId(row.league_id) : 0;
}

function visibleLeagueId(database, userId) {
  const active = activeLeagueId(database, userId);
  if (active) return active;
  const row = database.prepare(`
    SELECT league_id FROM online_league_members
    WHERE user_id = ?
    ORDER BY joined_at DESC
    LIMIT 1
  `).get(userId);
  return row ? asId(row.league_id) : 0;
}

function scheduleLeague(database, leagueId, now) {
  const members = database.prepare(`
    SELECT user_id FROM online_league_members WHERE league_id = ? ORDER BY joined_at, user_id
  `).all(leagueId).map(row => asId(row.user_id));
  const rounds = roundRobin(members);
  const start = firstMatchDay(now);
  const insert = database.prepare(`
    INSERT INTO online_fixtures (league_id, round, match_day, home_user_id, away_user_id, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
  `);
  rounds.forEach((pairs, index) => {
    const day = addIstanbulDays(start, index);
    for (const [home, away] of pairs) insert.run(leagueId, index + 1, day, home, away);
  });
  database.prepare(`UPDATE online_leagues SET status = 'active', started_at = ? WHERE id = ?`).run(now.toISOString(), leagueId);
}

function createLeague(database, user, name, size, now, adminEmail) {
  assertCompetitor(user, adminEmail);
  const title = cleanText(name, 2, 40);
  if (!title) throw fail(400, 'Lig adı 2-40 karakter olmalı');
  if (!SIZES.includes(size)) throw fail(400, 'Lig boyutu 8, 10, 12, 16 veya 20 olmalı');
  return withImmediate(database, () => {
    if (!squadRow(database, user.id)) throw fail(400, 'Önce ücretsiz takımını seç');
    if (activeLeagueId(database, user.id)) throw fail(409, 'Zaten aktif bir online ligdesin');
    let leagueId = 0;
    try {
      const created = database.prepare(`
        INSERT INTO online_leagues (name, size, owner_id, status, coin_reward, created_at)
        VALUES (?, ?, ?, 'open', ?, ?)
      `).run(title, size, user.id, REWARDS[size], now.toISOString());
      leagueId = asId(created.lastInsertRowid);
      database.prepare('INSERT INTO online_league_members (league_id, user_id, joined_at) VALUES (?, ?, ?)').run(leagueId, user.id, now.toISOString());
      database.prepare('INSERT INTO user_active_league (user_id, league_id) VALUES (?, ?)').run(user.id, leagueId);
    } catch (error) {
      if (isUnique(error)) throw fail(409, 'Zaten aktif bir online ligdesin');
      throw error;
    }
    return leagueView(database, leagueId, user.id);
  });
}

function joinLeague(database, user, leagueId, now, adminEmail) {
  assertCompetitor(user, adminEmail);
  const id = asId(leagueId);
  return withImmediate(database, () => {
    if (!squadRow(database, user.id)) throw fail(400, 'Önce ücretsiz takımını seç');
    const league = database.prepare('SELECT id, size, status FROM online_leagues WHERE id = ?').get(id);
    if (!league) throw fail(404, 'Lig bulunamadı');
    if (league.status !== 'open') throw fail(409, 'Bu lig katılmaya kapalı');
    const count = Number(database.prepare('SELECT COUNT(*) AS total FROM online_league_members WHERE league_id = ?').get(id).total);
    if (count >= league.size) throw fail(409, 'Lig doldu');
    if (activeLeagueId(database, user.id)) throw fail(409, 'Zaten aktif bir online ligdesin');
    try {
      database.prepare('INSERT INTO online_league_members (league_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, user.id, now.toISOString());
      database.prepare('INSERT INTO user_active_league (user_id, league_id) VALUES (?, ?)').run(user.id, id);
    } catch (error) {
      if (isUnique(error)) throw fail(409, 'Zaten aktif bir online ligdesin');
      throw error;
    }
    if (count + 1 === league.size) scheduleLeague(database, id, now);
    return leagueView(database, id, user.id);
  });
}

function leaveLeague(database, user, leagueId, now) {
  const id = asId(leagueId);
  return withImmediate(database, () => {
    const league = database.prepare('SELECT id, owner_id, status FROM online_leagues WHERE id = ?').get(id);
    if (!league || league.status !== 'open') throw fail(409, 'Başlamış ligden ayrılamazsın');
    const member = database.prepare('SELECT user_id FROM online_league_members WHERE league_id = ? AND user_id = ?').get(id, user.id);
    if (!member) throw fail(404, 'Bu ligde değilsin');
    database.prepare('DELETE FROM online_league_members WHERE league_id = ? AND user_id = ?').run(id, user.id);
    database.prepare('DELETE FROM user_active_league WHERE user_id = ? AND league_id = ?').run(user.id, id);
    const remaining = database.prepare(`
      SELECT user_id FROM online_league_members WHERE league_id = ? ORDER BY joined_at, user_id LIMIT 1
    `).get(id);
    if (!remaining) {
      database.prepare('DELETE FROM online_leagues WHERE id = ? AND status = ?').run(id, 'open');
      return { ok: true, deleted: true };
    }
    if (asId(league.owner_id) === user.id) {
      database.prepare('UPDATE online_leagues SET owner_id = ? WHERE id = ?').run(remaining.user_id, id);
    }
    return leagueView(database, id, user.id);
  });
}

function emptyRow() {
  return { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 };
}

function applyResult(row, goalsFor, goalsAgainst) {
  row.played += 1;
  row.gf += goalsFor;
  row.ga += goalsAgainst;
  if (goalsFor > goalsAgainst) { row.won += 1; row.points += 3; }
  else if (goalsFor === goalsAgainst) { row.drawn += 1; row.points += 1; }
  else row.lost += 1;
}

function sortTable(rows) {
  return rows.sort((left, right) =>
    right.points - left.points ||
    (right.gf - right.ga) - (left.gf - left.ga) ||
    right.gf - left.gf ||
    left.username.localeCompare(right.username, 'tr') ||
    left.userId - right.userId
  );
}

function leagueTable(database, leagueId) {
  const members = database.prepare(`
    SELECT online_league_members.user_id, users.username, users.role, users.email
    FROM online_league_members JOIN users ON users.id = online_league_members.user_id
    WHERE online_league_members.league_id = ?
  `).all(leagueId);
  const rows = new Map(members.map(member => [asId(member.user_id), {
    userId: asId(member.user_id),
    username: publicName(member.username),
    role: member.role,
    email: member.email,
    ...emptyRow()
  }]));
  const fixtures = database.prepare(`
    SELECT home_user_id, away_user_id, home_score, away_score
    FROM online_fixtures WHERE league_id = ? AND status = 'played'
  `).all(leagueId);
  for (const fixture of fixtures) {
    const home = rows.get(asId(fixture.home_user_id));
    const away = rows.get(asId(fixture.away_user_id));
    if (!home || !away) continue;
    applyResult(home, fixture.home_score, fixture.away_score);
    applyResult(away, fixture.away_score, fixture.home_score);
  }
  return sortTable([...rows.values()]).map(row => ({
    userId: row.userId,
    username: row.username,
    played: row.played,
    won: row.won,
    drawn: row.drawn,
    lost: row.lost,
    gf: row.gf,
    ga: row.ga,
    gd: row.gf - row.ga,
    points: row.points
  }));
}

function worldRanking(database, adminEmail) {
  const fixtures = database.prepare(`
    SELECT f.home_user_id, f.away_user_id, f.home_score, f.away_score,
      hu.username AS home_name, hu.role AS home_role, hu.email AS home_email,
      au.username AS away_name, au.role AS away_role, au.email AS away_email
    FROM online_fixtures f
    JOIN users hu ON hu.id = f.home_user_id
    JOIN users au ON au.id = f.away_user_id
    WHERE f.status = 'played'
  `).all();
  const rows = new Map();
  function ensure(id, username, role, email) {
    if (excludedAdmin(database, { id, role, email }, adminEmail)) return null;
    const key = asId(id);
    if (!rows.has(key)) rows.set(key, { userId: key, username: publicName(username), ...emptyRow() });
    return rows.get(key);
  }
  for (const fixture of fixtures) {
    const home = ensure(fixture.home_user_id, fixture.home_name, fixture.home_role, fixture.home_email);
    const away = ensure(fixture.away_user_id, fixture.away_name, fixture.away_role, fixture.away_email);
    if (home) applyResult(home, fixture.home_score, fixture.away_score);
    if (away) applyResult(away, fixture.away_score, fixture.home_score);
  }
  return sortTable([...rows.values()]).map((row, index) => ({
    place: index + 1,
    userId: row.userId,
    username: row.username,
    played: row.played,
    gf: row.gf,
    ga: row.ga,
    gd: row.gf - row.ga,
    points: row.points
  }));
}

function fixtureView(row, reveal) {
  const played = row.status === 'played';
  const show = played && reveal;
  return {
    id: asId(row.id),
    round: row.round,
    matchDay: row.match_day,
    homeUserId: asId(row.home_user_id),
    awayUserId: asId(row.away_user_id),
    homeName: publicName(row.home_name),
    awayName: publicName(row.away_name),
    status: row.status,
    homeScore: show ? row.home_score : null,
    awayScore: show ? row.away_score : null,
    events: show ? JSON.parse(row.events) : null,
    seed: show ? row.seed : null,
    algorithm: show ? row.algorithm : null,
    lineups: show ? { home: JSON.parse(row.home_snapshot), away: JSON.parse(row.away_snapshot) } : null
  };
}

function leagueView(database, leagueId, viewerId) {
  const league = database.prepare(`
    SELECT online_leagues.*, users.username AS winner_name
    FROM online_leagues LEFT JOIN users ON users.id = online_leagues.winner_user_id
    WHERE online_leagues.id = ?
  `).get(leagueId);
  if (!league) return null;
  const members = database.prepare(`
    SELECT online_league_members.user_id, online_league_members.joined_at, users.username
    FROM online_league_members JOIN users ON users.id = online_league_members.user_id
    WHERE online_league_members.league_id = ?
    ORDER BY online_league_members.joined_at, online_league_members.user_id
  `).all(leagueId).map(row => ({
    userId: asId(row.user_id),
    username: publicName(row.username),
    joinedAt: row.joined_at
  }));
  const fixtures = database.prepare(`
    SELECT online_fixtures.*, hu.username AS home_name, au.username AS away_name
    FROM online_fixtures
    JOIN users hu ON hu.id = online_fixtures.home_user_id
    JOIN users au ON au.id = online_fixtures.away_user_id
    WHERE online_fixtures.league_id = ?
    ORDER BY online_fixtures.round, online_fixtures.id
  `).all(leagueId).map(row => fixtureView(row, true));
  return {
    id: asId(league.id),
    name: league.name,
    size: league.size,
    status: league.status,
    coinReward: league.coin_reward,
    ownerId: asId(league.owner_id),
    winnerUserId: league.winner_user_id ? asId(league.winner_user_id) : null,
    winnerName: league.winner_name ? publicName(league.winner_name) : null,
    rewardPaid: Boolean(league.reward_paid),
    memberCount: members.length,
    joined: members.some(member => member.userId === viewerId),
    members,
    table: leagueTable(database, leagueId),
    fixtures
  };
}

function searchLeagues(database, query, viewerId) {
  const needle = String(query || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, '').trim().slice(0, 40).toLocaleLowerCase('tr-TR');
  const rows = database.prepare(`
    SELECT id, name FROM online_leagues WHERE status != 'finished' ORDER BY created_at DESC
  `).all();
  return rows
    .filter(row => !needle || row.name.toLocaleLowerCase('tr-TR').includes(needle))
    .slice(0, 30)
    .map(row => {
      const view = leagueView(database, row.id, viewerId);
      return {
        id: view.id,
        name: view.name,
        size: view.size,
        status: view.status,
        memberCount: view.memberCount,
        coinReward: view.coinReward,
        joined: view.joined
      };
    });
}

function snapshotFor(database, userId) {
  const row = squadRow(database, userId);
  const user = database.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const squad = publicSquad(row);
  const teamPlayers = (squad?.players || []).map(player => ({ ...player, source: 'team' }));
  return {
    username: publicName(user?.username),
    club: squad?.teamName || 'Takım',
    squad: [...teamPlayers, ...clubSquadPlayers(database, userId)],
    xi: squad?.startingXi || []
  };
}

function payMatchWin(database, fixture, result, nowIso, adminEmail) {
  if (result.homeScore === result.awayScore) return;
  const reward = configuredInteger('OMNI_MATCH_WIN_REWARD', 25, 100_000);
  if (!reward) return;
  const winnerId = result.homeScore > result.awayScore ? asId(fixture.home_user_id) : asId(fixture.away_user_id);
  const winner = database.prepare('SELECT id, email, role FROM users WHERE id = ?').get(winnerId);
  if (!winner || excludedAdmin(database, winner, adminEmail)) return;
  applyBalanceChange(database, winnerId, reward, 'omni', 'Online maç galibiyeti', `online-match-win:${asId(fixture.id)}`, nowIso, 'user');
}

function simulateFixture(database, fixtureId, nowIso, adminEmail = '') {
  return withImmediate(database, () => {
    const fixture = database.prepare('SELECT * FROM online_fixtures WHERE id = ?').get(fixtureId);
    if (!fixture || fixture.status !== 'scheduled') return { skipped: true };
    const home = snapshotFor(database, fixture.home_user_id);
    const away = snapshotFor(database, fixture.away_user_id);
    const seed = crypto.randomBytes(32).toString('hex');
    const result = simulateOnlineMatch({ home, away, seed });
    const updated = database.prepare(`
      UPDATE online_fixtures
      SET status = 'played', seed = ?, algorithm = ?, home_score = ?, away_score = ?,
        home_snapshot = ?, away_snapshot = ?, events = ?, played_at = ?
      WHERE id = ? AND status = 'scheduled'
    `).run(
      seed,
      result.algorithm,
      result.homeScore,
      result.awayScore,
      JSON.stringify(home),
      JSON.stringify(away),
      JSON.stringify(result.events),
      nowIso,
      fixture.id
    );
    if (updated.changes !== 1) throw fail(409, 'Maç zaten oynandı');
    payMatchWin(database, fixture, result, nowIso, adminEmail);
    return { played: true, leagueId: asId(fixture.league_id) };
  });
}

function settleLeague(database, leagueId, nowIso, adminEmail, attempt = 0) {
  try {
    return withImmediate(database, () => {
      const league = database.prepare('SELECT * FROM online_leagues WHERE id = ?').get(leagueId);
      if (!league || league.status === 'open') return { settled: false };
      const remaining = Number(database.prepare(`
        SELECT COUNT(*) AS total FROM online_fixtures WHERE league_id = ? AND status != 'played'
      `).get(leagueId).total);
      if (remaining > 0) return { settled: false };
      if (league.reward_paid) return { settled: true, already: true };
      const table = leagueTable(database, leagueId).filter(row => !excludedAdmin(
        database,
        { id: row.userId, ...database.prepare('SELECT role, email FROM users WHERE id = ?').get(row.userId) },
        adminEmail
      ));
      const winner = table[0];
      if (winner) {
        applyCoinChange(database, winner.userId, league.coin_reward, 'Online lig şampiyonluğu', `online-league-win:${leagueId}`, nowIso);
      }
      database.prepare(`
        UPDATE online_leagues
        SET status = 'finished', winner_user_id = ?, reward_paid = 1, finished_at = ?
        WHERE id = ? AND reward_paid = 0
      `).run(winner ? winner.userId : null, nowIso, leagueId);
      database.prepare('DELETE FROM user_active_league WHERE league_id = ?').run(leagueId);
      return { settled: true, winnerUserId: winner ? winner.userId : null };
    });
  } catch (error) {
    if (isUnique(error) && attempt < 1) return settleLeague(database, leagueId, nowIso, adminEmail, attempt + 1);
    throw error;
  }
}

let simRunning = false;

function catchUpDailySim(database, now = new Date(), adminEmail = '') {
  if (simRunning) return { skipped: true, reason: 'running', leagues: 0 };
  simRunning = true;
  try {
    const parts = istanbulParts(now);
    const dueDay = parts.hour >= LOCK_HOUR ? parts.date : addIstanbulDays(parts.date, -1);
    const result = runDailyLock(database, now, adminEmail);
    database.prepare(`
      INSERT INTO online_sim_runs (day_key, ran_at) VALUES (?, ?)
      ON CONFLICT(day_key) DO NOTHING
    `).run(dueDay, now.toISOString());
    return { skipped: false, dayKey: dueDay, ...result };
  } finally {
    simRunning = false;
  }
}

function runDailyLock(database, now, adminEmail = '') {
  const rows = database.prepare(`
    SELECT id, match_day FROM online_fixtures WHERE status = 'scheduled' ORDER BY match_day, league_id, round, id
  `).all();
  const leagues = new Set();
  for (const row of rows) {
    if (!isDue(row.match_day, now)) continue;
    try {
      const result = simulateFixture(database, row.id, now.toISOString(), adminEmail);
      if (result.leagueId) leagues.add(result.leagueId);
    } catch (error) {
      if (error.status === 409 || String(error.message || '').includes('immutable')) continue;
      throw error;
    }
  }
  for (const leagueId of leagues) settleLeague(database, leagueId, now.toISOString(), adminEmail);
  return { leagues: leagues.size };
}

function visibleBalances(database, user) {
  const balances = balancesOf(database, user.id);
  return { unlimited: false, coins: balances.coins, omniDolar: balances.omniDolar };
}

function homePayload(database, user, now, adminEmail) {
  const squad = publicSquad(squadRow(database, user.id));
  const leagueId = visibleLeagueId(database, user.id);
  const packs = require('./online-packs');
  return {
    userId: user.id,
    balances: visibleBalances(database, user, adminEmail),
    admin: isAdmin(user, adminEmail),
    collection: packs.listOwnedCards(database, user.id, true),
    lock: {
      timeZone: TIME_ZONE,
      hour: LOCK_HOUR,
      nextLockAt: nextLockInstant(now).toISOString(),
      squadLocked: squadLocked(database, user.id, now)
    },
    squad,
    teams: squad || isAdmin(user, adminEmail) ? [] : listTeams(database),
    league: leagueId ? leagueView(database, leagueId, user.id) : null,
    ranking: worldRanking(database, adminEmail).slice(0, 50)
  };
}

function requestNow(request, triggerEnabled, user) {
  if (!triggerEnabled || user?.rank !== 'admin' || !user.totpEnabled) return new Date();
  const raw = request.headers['x-online-now'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return new Date();
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) throw fail(400, 'Saat başlığı geçersiz');
  return parsed;
}

function createOnlineApi(deps) {
  const { database, requireSession, requireSameOrigin, readJsonBody, sendJson, userRole, triggerEnabled, confirmPassword, audit, clientAddress } = deps;

  function actor(request, response) {
    const sessionUser = requireSession(request, response);
    if (!sessionUser) return null;
    return {
      id: sessionUser.id,
      email: sessionUser.email,
      username: sessionUser.username,
      role: userRole(sessionUser),
      rank: sessionUser.rank || 'player',
      totpEnabled: sessionUser.totpEnabled === true
    };
  }

  function rejectTwoFactor(response) {
    sendJson(response, 403, {
      ok: false,
      error: 'Bu işlem için iki adımlı doğrulama kurulmalı',
      code: '2fa_required',
      setupPath: '/api/account/2fa/setup'
    });
  }

  function allowRankAdmin(user, response) {
    if (user?.rank !== 'admin') {
      sendJson(response, 403, { ok: false, error: 'Bu işlem için yönetici yetkisi gerekiyor' });
      return false;
    }
    if (!user.totpEnabled) {
      rejectTwoFactor(response);
      return false;
    }
    return true;
  }

  function noteAudit(request, entry) {
    if (typeof audit !== 'function') return;
    audit({ ...entry, ip: typeof clientAddress === 'function' ? clientAddress(request) : null });
  }

  return async function handleOnlineRequest(request, response, pathname, requestUrl) {
    if (!pathname.startsWith('/api/online')) return false;
    const path = pathname.replace(/\/+$/, '') || '/api/online';
    try {
      if (path === '/api/online/dev/run-lock') {
        if (!triggerEnabled) {
          sendJson(response, 404, { ok: false, error: 'API bulunamadı' });
          return true;
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { Allow: 'POST' });
          response.end('Method not allowed');
          return true;
        }
        if (!requireSameOrigin(request, response)) return true;
        const user = actor(request, response);
        if (!user) return true;
        if (!allowRankAdmin(user, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        let now = requestNow(request, true, user);
        if (body.at !== undefined) {
          now = new Date(body.at);
          if (Number.isNaN(now.getTime())) throw fail(400, 'Simülasyon saati geçersiz');
        }
        const result = runDailyLock(database, now, '');
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }

      const user = actor(request, response);
      if (!user) return true;
      const gate = actingAdminEmail(user);
      const now = requestNow(request, triggerEnabled, user);
      const packs = require('./online-packs');

      async function gateAdminFreeAction(body) {
        if (user.rank !== 'admin') return false;
        if (!user.totpEnabled) {
          rejectTwoFactor(response);
          return null;
        }
        const password = typeof body?.password === 'string' ? body.password : '';
        const check = typeof confirmPassword === 'function' ? await confirmPassword(user.id, password, request) : { ok: false };
        if (check?.ok === true) return true;
        sendJson(response, check?.locked ? 429 : 403, {
          ok: false,
          error: check?.error || 'Ücretsiz açılış için şifreni yeniden gir'
        });
        return null;
      }
      const leagueMatch = path.match(/^\/api\/online\/leagues\/(\d+)(?:\/(join|leave))?$/);

      if (path === '/api/online/balances' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, { balances: visibleBalances(database, user) });
        return true;
      }
      if (path === '/api/online/home' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, homePayload(database, user, now, gate));
        return true;
      }
      if (path === '/api/online/packs' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, {
          packs: packs.listPacks(database),
          daily: packs.dailyUsage(database, user.id, now),
          admin: user.rank === 'admin',
          balances: visibleBalances(database, user)
        });
        return true;
      }
      if (path === '/api/online/club' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, {
          cards: packs.listOwnedCards(database, user.id, true),
          squad: publicSquad(squadRow(database, user.id)),
          lock: { squadLocked: squadLocked(database, user.id, now) },
          admin: user.rank === 'admin',
          balances: visibleBalances(database, user)
        });
        return true;
      }
      if (path === '/api/online/teams' && request.method === 'GET') {
        sendJson(response, 200, { teams: listTeams(database) });
        return true;
      }
      if (path === '/api/online/ranking' && request.method === 'GET') {
        sendJson(response, 200, { ranking: worldRanking(database, '') });
        return true;
      }
      if (path === '/api/online/leagues' && request.method === 'GET') {
        sendJson(response, 200, { leagues: searchLeagues(database, requestUrl.searchParams.get('q') || '', user.id) });
        return true;
      }
      if (path === '/api/online/team' && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        sendJson(response, 200, { ok: true, squad: pickTeam(database, user, body.teamId, now, gate) });
        return true;
      }
      if (path === '/api/online/squad' && request.method === 'PUT') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        sendJson(response, 200, { ok: true, squad: saveSquad(database, user, body.startingXi, now, gate) });
        return true;
      }
      if (path === '/api/online/leagues' && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const league = createLeague(database, user, body.name, body.size, now, gate);
        sendJson(response, 201, { ok: true, league });
        return true;
      }
      if (leagueMatch && request.method === 'GET' && !leagueMatch[2]) {
        const league = leagueView(database, Number(leagueMatch[1]), user.id);
        if (!league) throw fail(404, 'Lig bulunamadı');
        sendJson(response, 200, { league });
        return true;
      }
      if (leagueMatch && request.method === 'POST' && leagueMatch[2] === 'join') {
        if (!requireSameOrigin(request, response)) return true;
        const league = joinLeague(database, user, Number(leagueMatch[1]), now, gate);
        sendJson(response, 200, { ok: true, league });
        return true;
      }
      if (leagueMatch && request.method === 'POST' && leagueMatch[2] === 'leave') {
        if (!requireSameOrigin(request, response)) return true;
        const league = leaveLeague(database, user, Number(leagueMatch[1]), now);
        sendJson(response, 200, { ok: true, league });
        return true;
      }
      const packPriceMatch = path.match(/^\/api\/online\/admin\/packs\/([a-z]{3,16})$/);
      if (packPriceMatch && request.method === 'PUT') {
        if (!requireSameOrigin(request, response)) return true;
        if (!allowRankAdmin(user, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const pack = packs.updatePackPrice(database, packPriceMatch[1], body.price, change => noteAudit(request, {
          actorId: user.id,
          action: 'price_change',
          oldValue: { slug: change.slug, price: change.oldPrice },
          newValue: { slug: change.slug, price: change.price }
        }));
        sendJson(response, 200, { ok: true, pack });
        return true;
      }
      if (path === '/api/online/packs/open' && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const adminFree = await gateAdminFreeAction(body);
        if (adminFree === null) return true;
        const opened = packs.openPack(database, user, {
          slug: body.slug,
          requestKey: typeof body.requestId === 'string' ? body.requestId : body.requestKey,
          passwordAccepted: adminFree === true
        }, now, gate);
        sendJson(response, 200, { ok: true, ...opened });
        return true;
      }
      const market = require('./online-market');
      const marketFilters = market.readFilters({
        q: requestUrl.searchParams.get('q'),
        position: requestUrl.searchParams.get('position'),
        genMin: requestUrl.searchParams.get('genMin'),
        genMax: requestUrl.searchParams.get('genMax')
      });
      const marketBuy = path.match(/^\/api\/online\/market\/(\d+)\/buy$/);
      const adminMarketItem = path.match(/^\/api\/online\/admin\/market\/(\d+)$/);
      const playerMarketItem = path.match(/^\/api\/online\/player-market\/(\d+)\/(buy|cancel)$/);

      if (path === '/api/online/market' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, {
          items: market.listCatalog(database, marketFilters),
          admin: user.rank === 'admin',
          balances: visibleBalances(database, user)
        });
        return true;
      }
      if (path === '/api/online/admin/market' && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        if (!allowRankAdmin(user, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        database.exec('BEGIN IMMEDIATE');
        try {
          const item = market.addCatalogItem(database, user, body, now, gate);
          noteAudit(request, {
            actorId: user.id,
            action: 'economy_change',
            newValue: { op: 'add', id: item.id, price: item.price, name: item.name }
          });
          database.exec('COMMIT');
          sendJson(response, 201, { ok: true, item });
        } catch (error) {
          try { database.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return true;
      }
      if (adminMarketItem && request.method === 'PUT') {
        if (!requireSameOrigin(request, response)) return true;
        if (!allowRankAdmin(user, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        database.exec('BEGIN IMMEDIATE');
        try {
          const before = database.prepare('SELECT id, price, name FROM omni_market_catalog WHERE id = ?').get(Number(adminMarketItem[1]));
          const item = market.updateCatalogItem(database, user, Number(adminMarketItem[1]), body, now, gate);
          noteAudit(request, {
            actorId: user.id,
            action: 'economy_change',
            oldValue: before ? { id: item.id, price: before.price, name: before.name } : null,
            newValue: { op: 'update', id: item.id, price: item.price, name: item.name }
          });
          database.exec('COMMIT');
          sendJson(response, 200, { ok: true, item });
        } catch (error) {
          try { database.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return true;
      }
      if (adminMarketItem && request.method === 'DELETE') {
        if (!requireSameOrigin(request, response)) return true;
        if (!allowRankAdmin(user, response)) return true;
        database.exec('BEGIN IMMEDIATE');
        try {
          const before = database.prepare('SELECT id, price, name FROM omni_market_catalog WHERE id = ?').get(Number(adminMarketItem[1]));
          const removed = market.removeCatalogItem(database, user, Number(adminMarketItem[1]), gate);
          noteAudit(request, {
            actorId: user.id,
            action: 'economy_change',
            oldValue: before || null,
            newValue: { op: 'remove', id: removed.id }
          });
          database.exec('COMMIT');
          sendJson(response, 200, { ok: true, ...removed });
        } catch (error) {
          try { database.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return true;
      }
      if (marketBuy && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const adminFree = await gateAdminFreeAction(body);
        if (adminFree === null) return true;
        const bought = market.buyCatalog(database, user, {
          catalogId: Number(marketBuy[1]),
          requestKey: typeof body.requestId === 'string' ? body.requestId : body.requestKey,
          passwordAccepted: adminFree === true
        }, now, gate);
        sendJson(response, 200, { ok: true, ...bought });
        return true;
      }
      if (path === '/api/online/player-market' && request.method === 'GET') {
        ensureStartingOmni(database, user, now.toISOString(), gate);
        sendJson(response, 200, {
          ...market.listPlayerMarketFor(database, user, marketFilters, now, gate),
          balances: visibleBalances(database, user)
        });
        return true;
      }
      if (path === '/api/online/player-market' && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const listed = market.listCard(database, user, { cardId: body.cardId, price: body.price }, now, gate);
        sendJson(response, 201, { ok: true, ...listed });
        return true;
      }
      if (playerMarketItem && request.method === 'POST' && playerMarketItem[2] === 'buy') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        const bought = market.buyListing(database, user, Number(playerMarketItem[1]), now, gate);
        sendJson(response, 200, { ok: true, ...bought });
        return true;
      }
      if (playerMarketItem && request.method === 'POST' && playerMarketItem[2] === 'cancel') {
        if (!requireSameOrigin(request, response)) return true;
        const cancelled = market.cancelListing(database, user, Number(playerMarketItem[1]), now, gate);
        sendJson(response, 200, { ok: true, ...cancelled });
        return true;
      }
      const transferMatch = path.match(/^\/api\/online\/cards\/(\d+)\/transfer$/);
      if (transferMatch && request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return true;
        const body = await readJsonBody(request, response, 16 * 1024);
        if (body === null) return true;
        packs.refuseCardTransfer(database, user.id, Number(transferMatch[1]));
        return true;
      }
      sendJson(response, 404, { ok: false, error: 'API bulunamadı' });
      return true;
    } catch (error) {
      if (response.headersSent) return true;
      const status = Number(error.status) || 500;
      if (status === 500) console.error('Online istek başarısız:', error.code || error.name);
      sendJson(response, status, { ok: false, error: status === 500 ? 'Sunucu isteği tamamlayamadı' : error.message });
      return true;
    }
  };
}

function scheduleOnlineLock(database, adminEmail = '') {
  const wait = Math.max(1000, nextLockInstant(new Date()).getTime() - Date.now());
  const timer = setTimeout(() => {
    try { catchUpDailySim(database, new Date(), adminEmail); }
    catch (error) { console.error('Online kilit başarısız:', error.code || error.name); }
    scheduleOnlineLock(database, adminEmail);
  }, Math.min(wait, 2_147_483_647));
  timer.unref();
}

module.exports = {
  SIZES,
  REWARDS,
  TIME_ZONE,
  ALGORITHM,
  installOnlineSchema,
  seedFreeTeams,
  roundRobin,
  defaultXi,
  fail,
  withImmediate,
  asId,
  isAdmin,
  applyCoinChange,
  applyBalanceChange,
  recordAdminZero,
  balancesOf,
  grantStartingOmni,
  ensureStartingOmni,
  configuredInteger,
  cleanText,
  publicName,
  searchLeagues,
  worldRanking,
  pickTeam,
  saveSquad,
  createLeague,
  joinLeague,
  runDailyLock,
  catchUpDailySim,
  istanbulParts,
  nextLockInstant,
  firstMatchDay,
  isDue,
  createOnlineApi,
  scheduleOnlineLock,
  simulateOnlineMatch
};
