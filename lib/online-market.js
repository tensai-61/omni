const {
  fail,
  withImmediate,
  asId,
  isAdmin,
  applyBalanceChange,
  recordAdminZero,
  balancesOf,
  configuredInteger,
  grantStartingOmni,
  cleanText,
  publicName
} = require('./online-league');
const { cardView } = require('./online-packs');

const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];
const PLACEHOLDERS = [
  ['Örnek Kaleci Poyraz', 'GK', 76, 2200],
  ['Örnek Stoper Kıyı', 'DEF', 73, 1800],
  ['Örnek Bek Vadi', 'DEF', 70, 1500],
  ['Örnek Orta Saha Ada', 'MID', 79, 2800],
  ['Örnek On Numara Yelken', 'MID', 84, 4200],
  ['Örnek Kanat Bozkır', 'FWD', 77, 2600],
  ['Örnek Forvet Işık', 'FWD', 88, 6400],
  ['Örnek Libero Tepe', 'DEF', 81, 3400]
];

function isUnique(error) {
  if (Number(error?.errcode) === 2067) return true;
  return /UNIQUE constraint/i.test(String(error?.message || ''));
}

function installMarketSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS omni_market_catalog (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT NOT NULL CHECK (position IN ('GK', 'DEF', 'MID', 'FWD')),
      gen INTEGER NOT NULL CHECK (gen BETWEEN 40 AND 99),
      price INTEGER NOT NULL CHECK (price > 0 AND price <= 1000000),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS omni_market_sales (
      id INTEGER PRIMARY KEY,
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      catalog_id INTEGER NOT NULL,
      card_id INTEGER NOT NULL REFERENCES online_cards(id),
      player_name TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price > 0),
      request_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (buyer_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS player_market_listings (
      id INTEGER PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id),
      card_id INTEGER NOT NULL REFERENCES online_cards(id),
      price INTEGER NOT NULL CHECK (price > 0 AND price <= 1000000),
      currency TEXT NOT NULL DEFAULT 'omni' CHECK (currency = 'omni'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
      buyer_id INTEGER,
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS player_market_one_active
      ON player_market_listings(card_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS player_market_active_seller
      ON player_market_listings(status, seller_id);
    CREATE TABLE IF NOT EXISTS player_market_sales (
      id INTEGER PRIMARY KEY,
      listing_id INTEGER NOT NULL UNIQUE,
      seller_id INTEGER NOT NULL,
      buyer_id INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      price INTEGER NOT NULL CHECK (price > 0),
      currency TEXT NOT NULL DEFAULT 'omni' CHECK (currency = 'omni'),
      created_at TEXT NOT NULL
    );
  `);
  const count = Number(database.prepare('SELECT COUNT(*) AS total FROM omni_market_catalog').get().total);
  if (count === 0) {
    const now = new Date().toISOString();
    const insert = database.prepare(`
      INSERT INTO omni_market_catalog (name, position, gen, price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [name, position, gen, price] of PLACEHOLDERS) insert.run(name, position, gen, price, now, now);
  }
}

function priceBand(gen) {
  const rating = Number(gen);
  const perMin = Math.max(1, configuredInteger('MARKET_MIN_PER_GEN', 25, 100_000));
  const perMax = Math.max(perMin, configuredInteger('MARKET_MAX_PER_GEN', 80, 100_000));
  const min = Math.min(1_000_000, rating * perMin);
  let max = Math.min(1_000_000, rating * perMax);
  if (max < min) max = min;
  return { min, max };
}

function assertTrader(user, adminEmail) {
  if (isAdmin(user, adminEmail)) throw fail(403, 'Yönetici oyuncu pazarında alım satım yapamaz');
}

function assertCatalogEditor(user, adminEmail) {
  if (!isAdmin(user, adminEmail)) throw fail(403, 'Bu işlem için yönetici yetkisi gerekiyor');
}

function userIsBanned(database, userId) {
  const row = database.prepare('SELECT banned, isBanned FROM users WHERE id = ?').get(userId);
  if (!row) return true;
  return Number(row.banned) === 1 || Number(row.isBanned) === 1;
}

function assertCanTrade(database, user, adminEmail) {
  assertTrader(user, adminEmail);
  if (userIsBanned(database, user.id)) throw fail(403, 'Banlı hesap pazarı kullanamaz');
}

function releaseBannedListings(database, nowIso) {
  database.prepare(`
    UPDATE player_market_listings
    SET status = 'cancelled', closed_at = ?
    WHERE status = 'active'
      AND seller_id IN (
        SELECT id FROM users WHERE IFNULL(banned, 0) = 1 OR IFNULL(isBanned, 0) = 1
      )
  `).run(nowIso);
}

function cancelListingsForUser(database, userId, nowIso) {
  database.prepare(`
    UPDATE player_market_listings
    SET status = 'cancelled', closed_at = ?
    WHERE seller_id = ? AND status = 'active'
  `).run(nowIso, asId(userId));
}

function catalogName(value) {
  if (typeof value === 'string' && /[<>]/.test(value)) {
    throw fail(400, 'Oyuncu adında < veya > kullanılamaz');
  }
  const name = cleanText(value, 2, 40);
  if (!name || name.includes('$')) return '';
  return name;
}

function catalogPosition(value) {
  return POSITIONS.includes(value) ? value : '';
}

function catalogGen(value) {
  const gen = Number(value);
  if (!Number.isInteger(gen) || gen < 40 || gen > 99) return 0;
  return gen;
}

function catalogPrice(value) {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 1 || price > 1_000_000) return 0;
  return price;
}

function publicCatalog(row) {
  return {
    id: asId(row.id),
    name: row.name,
    position: row.position,
    gen: row.gen,
    price: row.price,
    currency: 'omni'
  };
}

function filterGen(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const gen = Number(value);
  if (!Number.isInteger(gen) || gen < 40 || gen > 99) return fallback;
  return gen;
}

function readFilters(input) {
  const q = typeof input?.q === 'string'
    ? input.q.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>$]/g, '').trim().slice(0, 40)
    : '';
  const position = catalogPosition(input?.position);
  let genMin = filterGen(input?.genMin, 40);
  let genMax = filterGen(input?.genMax, 99);
  if (genMin > genMax) {
    const swap = genMin;
    genMin = genMax;
    genMax = swap;
  }
  return { q, position, genMin, genMax };
}

function matchesFilter(row, filters) {
  if (filters.position && row.position !== filters.position) return false;
  const gen = Number(row.gen);
  if (gen < filters.genMin || gen > filters.genMax) return false;
  if (!filters.q) return true;
  const needle = filters.q.toLocaleLowerCase('tr-TR');
  return String(row.name || '').toLocaleLowerCase('tr-TR').includes(needle);
}

function listCatalog(database, filters) {
  const rows = database.prepare('SELECT id, name, position, gen, price FROM omni_market_catalog ORDER BY gen DESC, name, id').all();
  return rows.filter(row => matchesFilter(row, filters)).map(publicCatalog);
}

function addCatalogItem(database, user, input, now, adminEmail) {
  assertCatalogEditor(user, adminEmail);
  const name = catalogName(input?.name);
  const position = catalogPosition(input?.position);
  const gen = catalogGen(input?.gen);
  const price = catalogPrice(input?.price);
  if (!name) throw fail(400, 'Oyuncu adı 2-40 karakter olmalı');
  if (!position) throw fail(400, 'Mevki geçersiz');
  if (!gen) throw fail(400, 'GEN 40 ile 99 arasında olmalı');
  if (!price) throw fail(400, 'Fiyat 1 ile 1.000.000 arasında Omni Dolar olmalı');
  const created = database.prepare(`
    INSERT INTO omni_market_catalog (name, position, gen, price, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, position, gen, price, now.toISOString(), now.toISOString());
  return publicCatalog(database.prepare('SELECT id, name, position, gen, price FROM omni_market_catalog WHERE id = ?').get(created.lastInsertRowid));
}

function updateCatalogItem(database, user, catalogId, input, now, adminEmail) {
  assertCatalogEditor(user, adminEmail);
  const id = asId(catalogId);
  const current = database.prepare('SELECT id, name, position, gen, price FROM omni_market_catalog WHERE id = ?').get(id);
  if (!current) throw fail(404, 'Katalog kartı bulunamadı');
  const name = input?.name === undefined ? current.name : catalogName(input.name);
  const position = input?.position === undefined ? current.position : catalogPosition(input.position);
  const gen = input?.gen === undefined ? current.gen : catalogGen(input.gen);
  const price = input?.price === undefined ? current.price : catalogPrice(input.price);
  if (!name) throw fail(400, 'Oyuncu adı 2-40 karakter olmalı');
  if (!position) throw fail(400, 'Mevki geçersiz');
  if (!gen) throw fail(400, 'GEN 40 ile 99 arasında olmalı');
  if (!price) throw fail(400, 'Fiyat 1 ile 1.000.000 arasında Omni Dolar olmalı');
  database.prepare(`
    UPDATE omni_market_catalog SET name = ?, position = ?, gen = ?, price = ?, updated_at = ? WHERE id = ?
  `).run(name, position, gen, price, now.toISOString(), id);
  return publicCatalog(database.prepare('SELECT id, name, position, gen, price FROM omni_market_catalog WHERE id = ?').get(id));
}

function removeCatalogItem(database, user, catalogId, adminEmail) {
  assertCatalogEditor(user, adminEmail);
  const id = asId(catalogId);
  const removed = database.prepare('DELETE FROM omni_market_catalog WHERE id = ?').run(id);
  if (removed.changes !== 1) throw fail(404, 'Katalog kartı bulunamadı');
  return { removed: true, id };
}

function validRequestKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function cardById(database, cardId) {
  return database.prepare(`
    SELECT id, user_id, pool_id, name, position, gen, admin_card, pack_slug
    FROM online_cards WHERE id = ?
  `).get(cardId);
}

function balancesFor(database, user) {
  const balances = balancesOf(database, user.id);
  return { unlimited: false, coins: balances.coins, omniDolar: balances.omniDolar };
}

function replayCatalogSale(database, sale, user, adminEmail) {
  const card = cardById(database, sale.card_id);
  const view = card ? cardView(card) : null;
  const free = Boolean(view?.adminCard);
  return {
    replayed: true,
    price: free ? 0 : sale.price,
    catalogPrice: sale.price,
    free,
    tag: free ? 'admin' : 'user',
    currency: 'omni',
    card: view,
    balances: balancesFor(database, user, adminEmail)
  };
}

function performCatalogBuy(database, user, catalogId, requestKey, now, adminEmail, passwordAccepted) {
  if (isAdmin(user, adminEmail) && passwordAccepted !== true) throw fail(403, 'Ücretsiz açılış için şifreni yeniden gir');
  const existing = database.prepare(`
    SELECT id, catalog_id, card_id, price FROM omni_market_sales WHERE buyer_id = ? AND request_key = ?
  `).get(user.id, requestKey);
  if (existing) {
    if (asId(existing.catalog_id) !== catalogId) throw fail(409, 'Bu istek başka bir karta ait');
    return replayCatalogSale(database, existing, user, adminEmail);
  }
  const item = database.prepare('SELECT id, name, position, gen, price FROM omni_market_catalog WHERE id = ?').get(catalogId);
  if (!item) throw fail(404, 'Katalog kartı bulunamadı');
  const adminPurchase = isAdmin(user, adminEmail);
  if (!adminPurchase) grantStartingOmni(database, user, now.toISOString(), adminEmail);
  const price = Number(item.price);
  const created = database.prepare(`
    INSERT INTO online_cards (user_id, pool_id, name, position, gen, pack_slug, open_id, admin_card, origin, created_at)
    VALUES (?, ?, ?, ?, ?, '', NULL, ?, 'omni', ?)
  `).run(user.id, `omni-${asId(item.id)}`, item.name, item.position, item.gen, adminPurchase ? 1 : 0, now.toISOString());
  const cardId = asId(created.lastInsertRowid);
  const refKey = `omni-market:${user.id}:${requestKey}`;
  if (adminPurchase) {
    recordAdminZero(database, user.id, 'omni', `Yönetici Omni Market: ${item.name}`, refKey, now.toISOString());
  } else {
    applyBalanceChange(
      database,
      user.id,
      -price,
      'omni',
      `Omni Market: ${item.name}`,
      refKey,
      now.toISOString(),
      'user'
    );
  }
  database.prepare(`
    INSERT INTO omni_market_sales (buyer_id, catalog_id, card_id, player_name, price, request_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, item.id, cardId, item.name, price, requestKey, now.toISOString());
  return {
    replayed: false,
    price: adminPurchase ? 0 : price,
    catalogPrice: price,
    free: adminPurchase,
    tag: adminPurchase ? 'admin' : 'user',
    currency: 'omni',
    card: cardView(cardById(database, cardId)),
    balances: balancesFor(database, user, adminEmail)
  };
}

function buyCatalog(database, user, input, now, adminEmail) {
  if (userIsBanned(database, user.id)) throw fail(403, 'Banlı hesap pazarı kullanamaz');
  const catalogId = asId(input?.catalogId);
  const requestKey = validRequestKey(input?.requestKey) ? input.requestKey : '';
  if (!catalogId) throw fail(400, 'Kart seçimi geçersiz');
  if (!requestKey) throw fail(400, 'İstek anahtarı geçersiz');
  try {
    return withImmediate(database, () => performCatalogBuy(
      database, user, catalogId, requestKey, now, adminEmail, input?.passwordAccepted === true
    ));
  } catch (error) {
    if (!isUnique(error)) throw error;
    const existing = database.prepare(`
      SELECT id, catalog_id, card_id, price FROM omni_market_sales WHERE buyer_id = ? AND request_key = ?
    `).get(user.id, requestKey);
    if (!existing) throw error;
    if (asId(existing.catalog_id) !== catalogId) throw fail(409, 'Bu istek başka bir karta ait');
    return replayCatalogSale(database, existing, user, adminEmail);
  }
}

function publicListing(row) {
  return {
    id: asId(row.id),
    cardId: asId(row.card_id),
    name: row.name,
    position: row.position,
    gen: row.gen,
    price: row.price,
    currency: 'omni',
    sellerId: asId(row.seller_id),
    seller: publicName(row.username)
  };
}

function listPlayerMarket(database, user, filters, now) {
  return withImmediate(database, () => {
    releaseBannedListings(database, now.toISOString());
    const rows = database.prepare(`
      SELECT player_market_listings.id, player_market_listings.card_id, player_market_listings.price,
        player_market_listings.seller_id, online_cards.name, online_cards.position, online_cards.gen,
        users.username
      FROM player_market_listings
      JOIN online_cards ON online_cards.id = player_market_listings.card_id
      JOIN users ON users.id = player_market_listings.seller_id
      WHERE player_market_listings.status = 'active'
        AND player_market_listings.seller_id != ?
        AND IFNULL(users.banned, 0) = 0
        AND IFNULL(users.isBanned, 0) = 0
      ORDER BY player_market_listings.price, player_market_listings.id
    `).all(user.id);
    const mineRows = database.prepare(`
      SELECT online_cards.id, online_cards.pool_id, online_cards.name, online_cards.position, online_cards.gen,
        online_cards.admin_card, online_cards.pack_slug,
        player_market_listings.id AS listing_id, player_market_listings.price AS listing_price
      FROM online_cards
      LEFT JOIN player_market_listings
        ON player_market_listings.card_id = online_cards.id
       AND player_market_listings.status = 'active'
       AND player_market_listings.seller_id = online_cards.user_id
      WHERE online_cards.user_id = ?
      ORDER BY online_cards.gen DESC, online_cards.id
    `).all(user.id);
    return {
      listings: rows.filter(row => matchesFilter(row, filters)).map(publicListing),
      mine: mineRows.map(row => {
        const card = cardView({ ...row, listed: row.listing_id ? 1 : 0 });
        const band = priceBand(row.gen);
        return {
          ...card,
          listingId: row.listing_id ? asId(row.listing_id) : null,
          listingPrice: row.listing_price ? Number(row.listing_price) : null,
          minPrice: band.min,
          maxPrice: band.max,
          listable: !card.adminCard && !card.listed
        };
      })
    };
  });
}

function listPlayerMarketFor(database, user, filters, now, adminEmail) {
  const payload = listPlayerMarket(database, user, filters, now);
  payload.admin = isAdmin(user, adminEmail);
  return payload;
}

function listingPrice(value) {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 1 || price > 1_000_000) return 0;
  return price;
}

function cardIsInXi(database, userId, cardId) {
  const row = database.prepare('SELECT starting_xi FROM user_squads WHERE user_id = ?').get(userId);
  if (!row) return false;
  let ids = [];
  try { ids = JSON.parse(row.starting_xi); } catch { ids = []; }
  return Array.isArray(ids) && ids.includes(`card:${cardId}`);
}

function listedXiIds(database, userId) {
  const rows = database.prepare(`
    SELECT card_id FROM player_market_listings WHERE seller_id = ? AND status = 'active'
  `).all(userId);
  return new Set(rows.map(row => `card:${asId(row.card_id)}`));
}

function listCard(database, user, input, now, adminEmail) {
  assertCanTrade(database, user, adminEmail);
  const cardId = asId(input?.cardId);
  const price = listingPrice(input?.price);
  if (!cardId) throw fail(400, 'Kart seçimi geçersiz');
  if (!price) throw fail(400, 'Liste fiyatı geçersiz');
  return withImmediate(database, () => {
    releaseBannedListings(database, now.toISOString());
    const card = cardById(database, cardId);
    if (!card || asId(card.user_id) !== asId(user.id)) throw fail(404, 'Kart bulunamadı');
    if (Number(card.admin_card) === 1) throw fail(403, 'Yönetici kartları devredilemez ve satılamaz');
    if (cardIsInXi(database, user.id, cardId)) throw fail(409, 'İlk 11’deki kart satışa çıkarılamaz');
    const band = priceBand(card.gen);
    if (price < band.min || price > band.max) throw fail(400, `Bu kart ${band.min} ile ${band.max} Omni Dolar arasında listelenebilir`);
    const active = database.prepare(`
      SELECT id FROM player_market_listings WHERE card_id = ? AND status = 'active'
    `).get(cardId);
    if (active) throw fail(409, 'Bu kart zaten satışta');
    let listingId = 0;
    try {
      const created = database.prepare(`
        INSERT INTO player_market_listings (seller_id, card_id, price, currency, status, created_at)
        VALUES (?, ?, ?, 'omni', 'active', ?)
      `).run(user.id, cardId, price, now.toISOString());
      listingId = asId(created.lastInsertRowid);
    } catch (error) {
      if (isUnique(error)) throw fail(409, 'Bu kart zaten satışta');
      throw error;
    }
    return {
      listing: {
        id: listingId,
        cardId,
        price,
        currency: 'omni',
        minPrice: band.min,
        maxPrice: band.max
      }
    };
  });
}

function cancelListing(database, user, listingId, now, adminEmail) {
  assertCanTrade(database, user, adminEmail);
  const id = asId(listingId);
  if (!id) throw fail(400, 'İlan seçimi geçersiz');
  return withImmediate(database, () => {
    const listing = database.prepare('SELECT id, seller_id, status FROM player_market_listings WHERE id = ?').get(id);
    if (!listing || asId(listing.seller_id) !== asId(user.id)) throw fail(404, 'İlan bulunamadı');
    if (listing.status !== 'active') throw fail(409, 'İlan artık aktif değil');
    const updated = database.prepare(`
      UPDATE player_market_listings SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'active' AND seller_id = ?
    `).run(now.toISOString(), id, user.id);
    if (updated.changes !== 1) throw fail(409, 'İlan artık aktif değil');
    return { cancelled: true, id };
  });
}

function replayPlayerSale(database, listing, user, adminEmail) {
  const card = cardById(database, listing.card_id);
  return {
    replayed: true,
    price: Number(listing.price),
    currency: 'omni',
    card: card ? cardView(card) : null,
    balances: balancesFor(database, user, adminEmail)
  };
}

function buyListing(database, user, listingId, now, adminEmail) {
  assertCanTrade(database, user, adminEmail);
  const id = asId(listingId);
  if (!id) throw fail(400, 'İlan seçimi geçersiz');
  return withImmediate(database, () => {
    releaseBannedListings(database, now.toISOString());
    const listing = database.prepare(`
      SELECT id, seller_id, card_id, price, status, buyer_id FROM player_market_listings WHERE id = ?
    `).get(id);
    if (!listing) throw fail(404, 'İlan bulunamadı');
    if (listing.status === 'sold' && asId(listing.buyer_id) === asId(user.id)) return replayPlayerSale(database, listing, user, adminEmail);
    if (listing.status !== 'active') throw fail(409, 'İlan artık satılık değil');
    if (asId(listing.seller_id) === asId(user.id)) throw fail(403, 'Kendi ilanını satın alamazsın');
    if (userIsBanned(database, listing.seller_id)) {
      cancelListingsForUser(database, listing.seller_id, now.toISOString());
      throw fail(409, 'İlan artık satılık değil');
    }
    const card = cardById(database, listing.card_id);
    if (!card || asId(card.user_id) !== asId(listing.seller_id)) throw fail(409, 'Kart ilanla eşleşmiyor');
    if (Number(card.admin_card) === 1) throw fail(403, 'Yönetici kartları devredilemez ve satılamaz');
    const price = Number(listing.price);
    const band = priceBand(card.gen);
    if (price < band.min || price > band.max) throw fail(409, 'İlan fiyatı artık izin verilen aralıkta değil');
    const claimed = database.prepare(`
      UPDATE player_market_listings
      SET status = 'sold', buyer_id = ?, closed_at = ?
      WHERE id = ? AND status = 'active'
    `).run(user.id, now.toISOString(), id);
    if (claimed.changes !== 1) throw fail(409, 'İlan artık satılık değil');
    let moved;
    try {
      moved = database.prepare(`
        UPDATE online_cards SET user_id = ? WHERE id = ? AND user_id = ? AND admin_card = 0
      `).run(user.id, card.id, listing.seller_id);
    } catch (error) {
      if (String(error?.message || '').includes('admin card')) throw fail(403, 'Yönetici kartları devredilemez ve satılamaz');
      throw error;
    }
    if (moved.changes !== 1) throw fail(409, 'Kart el değiştirmedi');
    if (!isAdmin(user, adminEmail)) grantStartingOmni(database, user, now.toISOString(), adminEmail);
    const note = `Oyuncu pazarı: ${String(card.name).replace(/[<>]/g, '').slice(0, 80)}`;
    applyBalanceChange(database, user.id, -price, 'omni', note, `player-buy:${id}`, now.toISOString(), 'user');
    applyBalanceChange(database, listing.seller_id, price, 'omni', note, `player-sell:${id}`, now.toISOString(), 'user');
    database.prepare(`
      INSERT INTO player_market_sales (listing_id, seller_id, buyer_id, card_id, price, currency, created_at)
      VALUES (?, ?, ?, ?, ?, 'omni', ?)
    `).run(id, listing.seller_id, user.id, card.id, price, now.toISOString());
    return {
      replayed: false,
      price,
      currency: 'omni',
      card: cardView(cardById(database, card.id)),
      balances: balancesFor(database, user, adminEmail)
    };
  });
}

module.exports = {
  PLACEHOLDERS,
  installMarketSchema,
  priceBand,
  listCatalog,
  addCatalogItem,
  updateCatalogItem,
  removeCatalogItem,
  buyCatalog,
  listPlayerMarketFor,
  listCard,
  cancelListing,
  buyListing,
  cancelListingsForUser,
  listedXiIds,
  readFilters,
  releaseBannedListings
};
