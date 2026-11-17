const crypto = require('crypto');
const {
  fail,
  withImmediate,
  asId,
  istanbulParts,
  isAdmin,
  applyBalanceChange,
  recordAdminZero,
  balancesOf,
  grantStartingOmni
} = require('./online-league');

const DAILY_PACK_LIMIT = 5;
const TIME_ZONE = 'Europe/Istanbul';

const FIRST_NAMES = [
  'Kerem', 'Deniz', 'Aras', 'Efe', 'Mert', 'Can', 'Emir', 'Baran', 'Yaman', 'Koray',
  'Selim', 'Tan', 'Eren', 'Kaan', 'Poyraz', 'Doruk', 'Umut', 'Çınar', 'Alper', 'Tolga',
  'Ozan', 'Berk', 'Alp', 'Kuzey', 'Toprak', 'Nehir', 'Ada', 'Defne', 'Eylül', 'Melis',
  'Sena', 'Işık', 'Mercan', 'Lara', 'Derin', 'Pelin', 'Ekin', 'Çağan', 'Rüzgar', 'Ayaz'
];
const LAST_NAMES = [
  'Yalaz', 'Korubent', 'Mavitaş', 'Işıkyol', 'Dalgın', 'Tepeören', 'Kumsal', 'Buzkır', 'Yelkenci', 'Ovaçiçek',
  'Serince', 'Karayel', 'Puslu', 'Akıntı', 'Kıyısoy', 'Yamaçlı', 'Gölgehan', 'Rüzgarlı', 'Odakır', 'Tanyeli',
  'Sovuk', 'Mavisu', 'Kırçiçek', 'Denizyolu', 'Ateşin', 'Sırça', 'Pınarkent', 'Uzgöl', 'Çakıl', 'Eseniz',
  'Torlak', 'Günebakan', 'Harmanlı', 'İzci', 'Salkım', 'Yağmurca', 'Kıvılcım', 'Örsele', 'Camgöl', 'Nerkis'
];
const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

const PACK_DEFAULTS = [
  { slug: 'bronz', name: 'Bronz', genMin: 60, genMax: 70, count: 8, price: 1000, currency: 'omni', sale: 'open', sort: 1 },
  { slug: 'gumus', name: 'Gümüş', genMin: 70, genMax: 75, count: 7, price: 2500, currency: 'omni', sale: 'open', sort: 2 },
  { slug: 'altin', name: 'Altın', genMin: 75, genMax: 80, count: 6, price: 6000, currency: 'omni', sale: 'open', sort: 3 },
  { slug: 'platin', name: 'Platin', genMin: 80, genMax: 85, count: 5, price: 15000, currency: 'omni', sale: 'open', sort: 4 },
  { slug: 'super', name: 'Süper', genMin: 85, genMax: 90, count: 4, price: 150, currency: 'coin', sale: 'open', sort: 5 },
  { slug: 'ultra', name: 'Ultra', genMin: 90, genMax: 95, count: 3, price: 400, currency: 'coin', sale: 'open', sort: 6 },
  { slug: 'mega', name: 'Mega', genMin: 95, genMax: 98, count: 2, price: 1000, currency: 'coin', sale: 'open', sort: 7 },
  { slug: 'hiper', name: 'Hiper', genMin: 99, genMax: 99, count: 1, price: 0, currency: 'real', sale: 'closed', sort: 8 }
];

function buildPlayerPool() {
  const players = [];
  const seen = new Set();
  let cursor = 0;
  for (let gen = 60; gen <= 99; gen += 1) {
    for (let copy = 0; copy < 2; copy += 1) {
      const first = FIRST_NAMES[cursor % FIRST_NAMES.length];
      let last = LAST_NAMES[(cursor + copy * 13) % LAST_NAMES.length];
      let name = `${first} ${last}`;
      let spin = 0;
      while (seen.has(name)) {
        spin += 1;
        last = LAST_NAMES[(cursor + copy * 13 + spin) % LAST_NAMES.length];
        name = spin > LAST_NAMES.length ? `${first} ${last} ${gen}-${copy}` : `${first} ${last}`;
      }
      seen.add(name);
      players.push({
        id: `pool-${gen}-${copy}`,
        name,
        position: POSITIONS[cursor % POSITIONS.length],
        gen
      });
      cursor += 1;
    }
  }
  return players;
}

const PLAYER_POOL = buildPlayerPool();

function installPackSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS online_pack_catalog (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gen_min INTEGER NOT NULL,
      gen_max INTEGER NOT NULL,
      player_count INTEGER NOT NULL CHECK (player_count > 0),
      price INTEGER NOT NULL CHECK (price >= 0),
      currency TEXT NOT NULL CHECK (currency IN ('omni', 'coin', 'real')),
      sale TEXT NOT NULL CHECK (sale IN ('open', 'closed')),
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_pack_opens (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      request_key TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      currency TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('user', 'admin')),
      day_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS online_pack_opens_day ON online_pack_opens(user_id, day_key, tag);
    CREATE TABLE IF NOT EXISTS online_cards (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pool_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      gen INTEGER NOT NULL,
      pack_slug TEXT NOT NULL DEFAULT '',
      open_id INTEGER REFERENCES online_pack_opens(id),
      admin_card INTEGER NOT NULL DEFAULT 0 CHECK (admin_card IN (0, 1)),
      origin TEXT NOT NULL DEFAULT 'pack' CHECK (origin IN ('pack', 'omni')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS online_cards_owner ON online_cards(user_id, admin_card);
    CREATE TRIGGER IF NOT EXISTS online_cards_admin_frozen
    BEFORE UPDATE ON online_cards
    WHEN OLD.admin_card = 1 AND (NEW.user_id != OLD.user_id OR NEW.admin_card != 1)
    BEGIN
      SELECT RAISE(ABORT, 'admin card cannot move');
    END;
  `);
  migrateOnlineCards(database);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO online_pack_catalog
      (slug, name, gen_min, gen_max, player_count, price, currency, sale, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const pack of PACK_DEFAULTS) {
    insert.run(pack.slug, pack.name, pack.genMin, pack.genMax, pack.count, pack.price, pack.currency, pack.sale, pack.sort);
  }
}

function migrateOnlineCards(database) {
  const columns = database.prepare('PRAGMA table_info(online_cards)').all();
  if (!columns.length) return;
  const openId = columns.find(column => column.name === 'open_id');
  const hasOrigin = columns.some(column => column.name === 'origin');
  if (hasOrigin && Number(openId?.notnull) !== 1) return;
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN');
  try {
    database.exec(`
      CREATE TABLE online_cards_next (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pool_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        gen INTEGER NOT NULL,
        pack_slug TEXT NOT NULL DEFAULT '',
        open_id INTEGER REFERENCES online_pack_opens(id),
        admin_card INTEGER NOT NULL DEFAULT 0 CHECK (admin_card IN (0, 1)),
        origin TEXT NOT NULL DEFAULT 'pack' CHECK (origin IN ('pack', 'omni')),
        created_at TEXT NOT NULL
      );
      INSERT INTO online_cards_next (id, user_id, pool_id, name, position, gen, pack_slug, open_id, admin_card, origin, created_at)
      SELECT id, user_id, pool_id, name, position, gen, pack_slug, open_id, admin_card, 'pack', created_at FROM online_cards;
      DROP TRIGGER IF EXISTS online_cards_admin_frozen;
      DROP TABLE online_cards;
      ALTER TABLE online_cards_next RENAME TO online_cards;
      CREATE INDEX IF NOT EXISTS online_cards_owner ON online_cards(user_id, admin_card);
      CREATE TRIGGER IF NOT EXISTS online_cards_admin_frozen
      BEFORE UPDATE ON online_cards
      WHEN OLD.admin_card = 1 AND (NEW.user_id != OLD.user_id OR NEW.admin_card != 1)
      BEGIN
        SELECT RAISE(ABORT, 'admin card cannot move');
      END;
    `);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    database.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
  database.exec('PRAGMA foreign_keys = ON');
}

function packRow(row) {
  return {
    slug: row.slug,
    name: row.name,
    genMin: row.gen_min,
    genMax: row.gen_max,
    playerCount: row.player_count,
    price: row.price,
    currency: row.currency,
    sale: row.sale
  };
}

function eligiblePlayers(pack) {
  return PLAYER_POOL.filter(player => player.gen >= pack.genMin && player.gen <= pack.genMax);
}

function chancePercent(draw, pool) {
  if (!pool) return 0;
  return Math.round((draw / pool) * 1000) / 10;
}

function publicPack(row) {
  const pack = packRow(row);
  const players = eligiblePlayers(pack);
  const open = pack.sale === 'open' && pack.currency !== 'real';
  return {
    slug: pack.slug,
    name: pack.name,
    genMin: pack.genMin,
    genMax: pack.genMax,
    playerCount: pack.playerCount,
    price: open ? pack.price : null,
    currency: pack.currency,
    sale: open ? 'open' : 'closed',
    odds: {
      draw: pack.playerCount,
      pool: players.length,
      chancePercent: chancePercent(pack.playerCount, players.length)
    },
    players: players.map(player => ({
      id: player.id,
      name: player.name,
      position: player.position,
      gen: player.gen
    }))
  };
}

function listPacks(database) {
  return database.prepare('SELECT * FROM online_pack_catalog ORDER BY sort_order, slug').all().map(publicPack);
}

function dailyUsage(database, userId, now) {
  const day = istanbulParts(now).date;
  const used = Number(database.prepare(`
    SELECT COUNT(*) AS total FROM online_pack_opens
    WHERE user_id = ? AND day_key = ? AND tag = 'user'
  `).get(userId, day).total);
  return {
    used,
    limit: DAILY_PACK_LIMIT,
    remaining: Math.max(0, DAILY_PACK_LIMIT - used),
    day,
    timeZone: TIME_ZONE
  };
}

function validRequestKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z]{3,16}$/.test(value);
}

function drawPlayers(players, count) {
  if (players.length < count) throw fail(500, 'Oyuncu havuzu bu paket için yetersiz');
  const bag = players.slice();
  const drawn = [];
  for (let index = 0; index < count; index += 1) {
    const pick = crypto.randomInt(bag.length);
    drawn.push(bag.splice(pick, 1)[0]);
  }
  return drawn;
}

function cardsForOpen(database, openId) {
  return database.prepare(`
    SELECT id, pool_id, name, position, gen, admin_card, pack_slug
    FROM online_cards WHERE open_id = ? ORDER BY id
  `).all(openId).map(cardView);
}

function cardView(row) {
  return {
    id: asId(row.id),
    xiId: `card:${asId(row.id)}`,
    poolId: row.pool_id,
    name: row.name,
    position: row.position,
    gen: row.gen,
    packSlug: row.pack_slug,
    adminCard: Number(row.admin_card) === 1,
    listed: Number(row.listed) === 1
  };
}

function listOwnedCards(database, userId, includeAdmin = true) {
  const adminSql = includeAdmin ? '' : ' AND online_cards.admin_card = 0';
  return database.prepare(`
    SELECT online_cards.id, online_cards.pool_id, online_cards.name, online_cards.position, online_cards.gen,
      online_cards.admin_card, online_cards.pack_slug,
      CASE WHEN player_market_listings.id IS NULL THEN 0 ELSE 1 END AS listed
    FROM online_cards
    LEFT JOIN player_market_listings
      ON player_market_listings.card_id = online_cards.id AND player_market_listings.status = 'active'
    WHERE online_cards.user_id = ?${adminSql}
    ORDER BY online_cards.gen DESC, online_cards.id
  `).all(userId).map(cardView);
}

function replayOpen(database, existing) {
  return {
    replayed: true,
    openId: asId(existing.id),
    slug: existing.slug,
    price: existing.price,
    currency: existing.currency,
    tag: existing.tag,
    cards: cardsForOpen(database, existing.id)
  };
}

function openPack(database, user, input, now, adminEmail) {
  const slug = validSlug(input?.slug) ? input.slug : '';
  const requestKey = validRequestKey(input?.requestKey) ? input.requestKey : '';
  if (!slug) throw fail(400, 'Paket seçimi geçersiz');
  if (!requestKey) throw fail(400, 'İstek anahtarı geçersiz');
  const passwordAccepted = input?.passwordAccepted === true;
  const admin = isAdmin(user, adminEmail);
  return withImmediate(database, () => {
    const existing = database.prepare(`
      SELECT id, slug, price, currency, tag FROM online_pack_opens WHERE user_id = ? AND request_key = ?
    `).get(user.id, requestKey);
    if (existing) {
      if (existing.slug !== slug) throw fail(409, 'Bu istek başka bir pakete ait');
      const replay = replayOpen(database, existing);
      return { ...replay, balances: publicBalances(database, user, adminEmail), daily: dailyUsage(database, user.id, now) };
    }
    const row = database.prepare('SELECT * FROM online_pack_catalog WHERE slug = ?').get(slug);
    if (!row) throw fail(404, 'Paket bulunamadı');
    const pack = packRow(row);
    if (pack.sale !== 'open' || pack.currency === 'real') throw fail(409, 'Bu paket satışa kapalı');
    if (admin && !passwordAccepted) throw fail(403, 'Ücretsiz açılış için şifreni yeniden gir');
    if (!admin) grantStartingOmni(database, user, now.toISOString(), adminEmail);
    const day = istanbulParts(now).date;
    if (!admin) {
      const used = Number(database.prepare(`
        SELECT COUNT(*) AS total FROM online_pack_opens
        WHERE user_id = ? AND day_key = ? AND tag = 'user'
      `).get(user.id, day).total);
      if (used >= DAILY_PACK_LIMIT) throw fail(429, 'Günlük paket sınırı doldu');
    }
    const drawn = drawPlayers(eligiblePlayers(pack), pack.playerCount);
    const tag = admin ? 'admin' : 'user';
    const created = database.prepare(`
      INSERT INTO online_pack_opens (user_id, slug, request_key, price, currency, tag, day_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, pack.slug, requestKey, admin ? 0 : pack.price, pack.currency, tag, day, now.toISOString());
    const openId = asId(created.lastInsertRowid);
    const insertCard = database.prepare(`
      INSERT INTO online_cards (user_id, pool_id, name, position, gen, pack_slug, open_id, admin_card, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const player of drawn) {
      insertCard.run(
        user.id,
        player.id,
        player.name,
        player.position,
        player.gen,
        pack.slug,
        openId,
        admin ? 1 : 0,
        now.toISOString()
      );
    }
    const reason = admin ? `Yönetici paket açılışı: ${pack.name}` : `Paket: ${pack.name}`;
    const refKey = `pack:${user.id}:${requestKey}`;
    if (admin) {
      recordAdminZero(database, user.id, pack.currency, reason, refKey, now.toISOString());
    } else {
      applyBalanceChange(
        database,
        user.id,
        -pack.price,
        pack.currency,
        reason,
        refKey,
        now.toISOString(),
        'user'
      );
    }
    return {
      replayed: false,
      openId,
      slug: pack.slug,
      price: admin ? 0 : pack.price,
      currency: pack.currency,
      tag,
      cards: cardsForOpen(database, openId),
      balances: publicBalances(database, user, adminEmail),
      daily: dailyUsage(database, user.id, now)
    };
  });
}

function publicBalances(database, user) {
  const balances = balancesOf(database, user.id);
  return { unlimited: false, coins: balances.coins, omniDolar: balances.omniDolar };
}

function updatePackPrice(database, slug, price, after) {
  if (!validSlug(slug)) throw fail(400, 'Paket seçimi geçersiz');
  if (!Number.isInteger(price) || price < 0 || price > 1_000_000) throw fail(400, 'Fiyat 0 ile 1.000.000 arasında tam sayı olmalı');
  return withImmediate(database, () => {
    const row = database.prepare('SELECT * FROM online_pack_catalog WHERE slug = ?').get(slug);
    if (!row) throw fail(404, 'Paket bulunamadı');
    if (row.sale !== 'open' || row.currency === 'real') throw fail(409, 'Satışa kapalı paketin fiyatı değişmez');
    database.prepare('UPDATE online_pack_catalog SET price = ? WHERE slug = ?').run(price, slug);
    const pack = publicPack(database.prepare('SELECT * FROM online_pack_catalog WHERE slug = ?').get(slug));
    if (typeof after === 'function') after({ slug, oldPrice: Number(row.price), price: pack.price });
    return pack;
  });
}

function refuseCardTransfer(database, userId, cardId) {
  const id = asId(cardId);
  const card = database.prepare('SELECT id, user_id, admin_card FROM online_cards WHERE id = ?').get(id);
  if (!card || asId(card.user_id) !== asId(userId)) throw fail(404, 'Kart bulunamadı');
  if (Number(card.admin_card) === 1) throw fail(403, 'Yönetici kartları devredilemez ve satılamaz');
  throw fail(409, 'Oyuncu pazarı henüz kapalı');
}

module.exports = {
  DAILY_PACK_LIMIT,
  PACK_DEFAULTS,
  PLAYER_POOL,
  installPackSchema,
  listPacks,
  dailyUsage,
  openPack,
  updatePackPrice,
  refuseCardTransfer,
  listOwnedCards,
  publicBalances,
  cardView
};
