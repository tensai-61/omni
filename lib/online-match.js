const crypto = require('crypto');

const ALGORITHM = 'omni-online-1';

const EVENT_TYPES = [
  'halfTime', 'fullTime', 'goal', 'save', 'wide', 'freeKickGoal', 'freeKickSave', 'freeKickWide',
  'penaltyGoal', 'penaltyMiss', 'corner', 'cornerGoal', 'cornerSave', 'yellow', 'red', 'secondYellow',
  'offside', 'ownGoal', 'sub', 'forfeit'
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createRng(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/i.test(seedHex)) {
    throw new Error('invalid seed');
  }
  const key = Buffer.from(seedHex, 'hex');
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 32;
  function nextUint32() {
    if (offset > 28) {
      block = crypto.createHmac('sha256', key).update(Buffer.from(String(counter))).digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  }
  return {
    next() {
      return nextUint32() / 0x100000000;
    },
    chance(probability) {
      return nextUint32() / 0x100000000 < probability;
    }
  };
}

function copySide(side) {
  const squad = (Array.isArray(side?.squad) ? side.squad : []).map(player => ({
    id: String(player.id),
    name: String(player.name || 'Oyuncu'),
    position: ['GK', 'DEF', 'MID', 'FWD'].includes(player.position) ? player.position : 'MID',
    gen: clamp(Math.round(Number(player.gen) || 50), 1, 100)
  }));
  const byId = new Map(squad.map(player => [player.id, player]));
  const xi = [];
  for (const id of Array.isArray(side?.xi) ? side.xi : []) {
    const player = byId.get(String(id));
    if (player && !xi.includes(player)) xi.push(player);
  }
  return { squad, xi };
}

function averageGen(players) {
  const outfield = players.filter(player => player.position !== 'GK');
  const source = outfield.length ? outfield : players;
  if (!source.length) return 50;
  return source.reduce((total, player) => total + player.gen, 0) / source.length;
}

function weighted(rng, items, weightOf) {
  let total = 0;
  const weights = items.map(item => {
    const weight = Math.max(0.01, weightOf(item));
    total += weight;
    return weight;
  });
  let roll = rng.next() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return items[index];
  }
  return items[items.length - 1];
}

function onPitch(state, sideKey) {
  return state[sideKey].xi.filter(player => !state.sent.has(`${sideKey}:${player.id}`));
}

function keeperOf(players) {
  return players.find(player => player.position === 'GK') || players[0] || { id: 'none', name: 'Kaleci', position: 'GK', gen: 45 };
}

function attackWeight(player) {
  const position = player.position === 'FWD' ? 5 : player.position === 'MID' ? 3.2 : player.position === 'DEF' ? 1.15 : 0.2;
  return position * (player.gen / 50);
}

function chooseAttacker(state, rng) {
  const homeXi = onPitch(state, 'home');
  const awayXi = onPitch(state, 'away');
  if (!homeXi.length && !awayXi.length) return null;
  if (!homeXi.length) return 'away';
  if (!awayXi.length) return 'home';
  let homeWeight = averageGen(homeXi) + 3;
  let awayWeight = averageGen(awayXi);
  if (rng.chance(0.07)) {
    if (homeWeight >= awayWeight) awayWeight += 16;
    else homeWeight += 16;
  }
  return rng.chance(homeWeight / (homeWeight + awayWeight)) ? 'home' : 'away';
}

function pushEvent(state, event) {
  state.events.push({ upset: false, ...event });
}

function addCard(state, sideKey, player, minute, color) {
  const key = `${sideKey}:${player.id}`;
  let type = color === 'red' ? 'red' : 'yellow';
  if (type === 'yellow' && state.yellows.has(key)) type = 'secondYellow';
  if (type === 'yellow') state.yellows.add(key);
  if (type !== 'yellow') {
    state.sent.add(key);
    state.reds[sideKey] += 1;
  }
  pushEvent(state, {
    type,
    minute,
    side: sideKey,
    playerId: player.id,
    playerName: player.name,
    playerPos: player.position,
    playerGen: player.gen
  });
  if (state.reds[sideKey] >= 5) {
    state.score.home = sideKey === 'home' ? 0 : 3;
    state.score.away = sideKey === 'away' ? 0 : 3;
    state.forfeited = true;
    pushEvent(state, {
      type: 'forfeit',
      minute,
      side: sideKey,
      scoreHome: state.score.home,
      scoreAway: state.score.away
    });
  }
}

function isUpset(attackers, defenders, shooter, keeper) {
  return averageGen(attackers) + 12 < averageGen(defenders) && shooter.gen + 12 < keeper.gen;
}

function scoreGoal(state, sideKey, minute, type, shooter, keeper, assist, attackers, defenders) {
  state.score[sideKey] += 1;
  pushEvent(state, {
    type,
    minute,
    side: sideKey,
    playerId: shooter.id,
    playerName: shooter.name,
    playerPos: shooter.position,
    playerGen: shooter.gen,
    keeperId: keeper?.id || null,
    keeperName: keeper?.name || '',
    keeperGen: keeper?.gen || null,
    assistId: assist?.id || null,
    assistName: assist?.name || '',
    upset: isUpset(attackers, defenders, shooter, keeper || { gen: 50 })
  });
}

function missEvent(state, sideKey, minute, type, shooter, keeper) {
  pushEvent(state, {
    type,
    minute,
    side: sideKey,
    playerId: shooter.id,
    playerName: shooter.name,
    playerPos: shooter.position,
    playerGen: shooter.gen,
    keeperId: keeper?.id || null,
    keeperName: keeper?.name || '',
    keeperGen: keeper?.gen || null
  });
}

function pickAssist(rng, attackers, shooter) {
  const others = attackers.filter(player => player.id !== shooter.id && player.position !== 'GK');
  if (!others.length || !rng.chance(0.72)) return null;
  return weighted(rng, others, attackWeight);
}

function openPlay(state, rng, minute, sideKey) {
  const other = sideKey === 'home' ? 'away' : 'home';
  const attackers = onPitch(state, sideKey);
  const defenders = onPitch(state, other);
  const shooters = attackers.filter(player => player.position !== 'GK');
  if (!shooters.length) return;
  const shooter = weighted(rng, shooters, attackWeight);
  const keeper = keeperOf(defenders);
  if (rng.chance(0.025)) {
    const markers = defenders.filter(player => player.position !== 'GK');
    const marker = weighted(rng, markers.length ? markers : defenders, player => 120 - player.gen);
    state.score[sideKey] += 1;
    pushEvent(state, {
      type: 'ownGoal',
      minute,
      side: other,
      playerId: marker.id,
      playerName: marker.name,
      playerPos: marker.position,
      playerGen: marker.gen
    });
    return;
  }
  const onTarget = clamp(
    (shooter.position === 'FWD' ? 0.46 : shooter.position === 'MID' ? 0.36 : 0.24) + (shooter.gen - keeper.gen) / 100 * 0.34,
    0.1,
    0.78
  );
  if (!rng.chance(onTarget)) {
    missEvent(state, sideKey, minute, 'wide', shooter, keeper);
    return;
  }
  const goal = clamp(
    (shooter.position === 'FWD' ? 0.32 : shooter.position === 'MID' ? 0.22 : 0.14) + (shooter.gen - keeper.gen) / 100 * 0.28,
    0.07,
    0.6
  );
  if (rng.chance(goal)) scoreGoal(state, sideKey, minute, 'goal', shooter, keeper, pickAssist(rng, attackers, shooter), attackers, defenders);
  else missEvent(state, sideKey, minute, 'save', shooter, keeper);
}

function setPieceCard(state, rng, minute, defendingKey) {
  const roll = rng.next();
  const color = roll < 0.62 ? null : roll < 0.94 ? 'yellow' : 'red';
  if (!color) return;
  const defenders = onPitch(state, defendingKey).filter(player => player.position !== 'GK');
  const pool = defenders.length ? defenders : onPitch(state, defendingKey);
  if (!pool.length) return;
  const player = weighted(rng, pool, item => (item.position === 'DEF' ? 4 : item.position === 'MID' ? 2.2 : 1) * ((110 - item.gen) / 40));
  addCard(state, defendingKey, player, minute, color);
}

function freeKick(state, rng, minute, sideKey) {
  const other = sideKey === 'home' ? 'away' : 'home';
  setPieceCard(state, rng, minute, other);
  if (state.forfeited) return;
  const attackers = onPitch(state, sideKey);
  const takers = attackers.filter(player => player.position === 'MID' || player.position === 'FWD');
  const pool = takers.length ? takers : attackers;
  if (!pool.length) return;
  const taker = weighted(rng, pool, attackWeight);
  const keeper = keeperOf(onPitch(state, other));
  const goal = clamp(0.1 + (taker.gen - keeper.gen) * 0.0035, 0.04, 0.38);
  const roll = rng.next();
  if (roll < goal) scoreGoal(state, sideKey, minute, 'freeKickGoal', taker, keeper, null, attackers, onPitch(state, other));
  else if (roll < goal + 0.34) missEvent(state, sideKey, minute, 'freeKickSave', taker, keeper);
  else missEvent(state, sideKey, minute, 'freeKickWide', taker, keeper);
}

function penalty(state, rng, minute, sideKey) {
  const other = sideKey === 'home' ? 'away' : 'home';
  setPieceCard(state, rng, minute, other);
  if (state.forfeited) return;
  const attackers = onPitch(state, sideKey);
  const kickers = attackers.filter(player => player.position === 'FWD' || player.position === 'MID');
  const pool = kickers.length ? kickers : attackers;
  if (!pool.length) return;
  const kicker = weighted(rng, pool, attackWeight);
  const keeper = keeperOf(onPitch(state, other));
  const goal = clamp(0.72 + (kicker.gen - keeper.gen) * 0.004, 0.48, 0.92);
  if (rng.chance(goal)) scoreGoal(state, sideKey, minute, 'penaltyGoal', kicker, keeper, null, attackers, onPitch(state, other));
  else missEvent(state, sideKey, minute, 'penaltyMiss', kicker, keeper);
}

function corner(state, rng, minute, sideKey) {
  const other = sideKey === 'home' ? 'away' : 'home';
  const attackers = onPitch(state, sideKey);
  const targets = attackers.filter(player => player.position === 'FWD' || player.position === 'DEF');
  const pool = targets.length ? targets : attackers;
  if (!pool.length) return;
  const attacker = weighted(rng, pool, attackWeight);
  const keeper = keeperOf(onPitch(state, other));
  const goal = clamp(0.08 + (attacker.gen - keeper.gen) * 0.003, 0.03, 0.26);
  const roll = rng.next();
  if (roll < goal) scoreGoal(state, sideKey, minute, 'cornerGoal', attacker, keeper, null, attackers, onPitch(state, other));
  else if (roll < goal + 0.28) missEvent(state, sideKey, minute, 'cornerSave', attacker, keeper);
  else missEvent(state, sideKey, minute, 'corner', attacker, keeper);
}

function cardOnly(state, rng, minute, sideKey) {
  const players = onPitch(state, sideKey);
  if (!players.length) return;
  const player = weighted(rng, players, item => (item.position === 'DEF' ? 3.4 : item.position === 'MID' ? 2.4 : item.position === 'FWD' ? 1.3 : 0.4) * ((108 - item.gen) / 50));
  addCard(state, sideKey, player, minute, rng.chance(0.9) ? 'yellow' : 'red');
}

function offside(state, rng, minute, sideKey) {
  const forwards = onPitch(state, sideKey).filter(player => player.position === 'FWD' || player.position === 'MID');
  if (!forwards.length) return;
  const player = weighted(rng, forwards, attackWeight);
  missEvent(state, sideKey, minute, 'offside', player, null);
}

function substitution(state, rng, minute, sideKey) {
  if (minute < 55 || minute > 85 || state.subs[sideKey] >= 5) return;
  const side = state[sideKey];
  const starters = onPitch(state, sideKey);
  const bench = side.squad.filter(player => !side.xi.includes(player) && !state.sent.has(`${sideKey}:${player.id}`));
  if (!starters.length || !bench.length) return;
  const outgoing = weighted(rng, starters.filter(player => player.position !== 'GK').length ? starters.filter(player => player.position !== 'GK') : starters, player => 110 - player.gen);
  const same = bench.filter(player => player.position === outgoing.position);
  const incoming = weighted(rng, same.length ? same : bench, player => player.gen);
  const index = side.xi.indexOf(outgoing);
  if (index >= 0) side.xi.splice(index, 1, incoming);
  state.subs[sideKey] += 1;
  pushEvent(state, {
    type: 'sub',
    minute,
    side: sideKey,
    playerId: incoming.id,
    playerName: incoming.name,
    playerPos: incoming.position,
    playerGen: incoming.gen,
    outId: outgoing.id,
    outName: outgoing.name
  });
}

function playMinute(state, rng, minute) {
  const sideKey = chooseAttacker(state, rng);
  if (!sideKey) return;
  const roll = rng.next();
  if (roll < 0.46) openPlay(state, rng, minute, sideKey);
  else if (roll < 0.62) corner(state, rng, minute, sideKey);
  else if (roll < 0.76) freeKick(state, rng, minute, sideKey);
  else if (roll < 0.80) penalty(state, rng, minute, sideKey);
  else if (roll < 0.90) cardOnly(state, rng, minute, sideKey);
  else if (roll < 0.96) offside(state, rng, minute, sideKey);
  else substitution(state, rng, minute, sideKey);
}

function simulateOnlineMatch({ home, away, seed }) {
  const rng = createRng(seed);
  const state = {
    home: copySide(home),
    away: copySide(away),
    events: [],
    score: { home: 0, away: 0 },
    yellows: new Set(),
    reds: { home: 0, away: 0 },
    subs: { home: 0, away: 0 },
    sent: new Set(),
    forfeited: false
  };
  for (let minute = 1; minute <= 90; minute += 1) {
    if (state.forfeited) break;
    if (minute === 46) {
      pushEvent(state, { type: 'halfTime', minute: 45, scoreHome: state.score.home, scoreAway: state.score.away });
    }
    if (!rng.chance(0.34)) continue;
    playMinute(state, rng, minute);
    if (state.forfeited) break;
  }
  if (!state.forfeited) {
    pushEvent(state, { type: 'fullTime', minute: 90, scoreHome: state.score.home, scoreAway: state.score.away });
  }
  return {
    algorithm: ALGORITHM,
    homeScore: state.score.home,
    awayScore: state.score.away,
    events: state.events
  };
}

module.exports = {
  ALGORITHM,
  EVENT_TYPES,
  createRng,
  simulateOnlineMatch
};
