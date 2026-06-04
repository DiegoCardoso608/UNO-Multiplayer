// ============================================================
//  DATABASE — lowdb (JSON puro, zero dependências nativas)
//  Arquivo: data/db.json
// ============================================================

const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path     = require('path');
const fs       = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(path.join(dataDir, 'db.json'));
const db      = low(adapter);

db.defaults({
  players: [],
  matches: [],
}).write();

// ── Players ───────────────────────────────────────────────

function upsertPlayer({ id, name, avatar, provider, providerId }) {
  const existing = db.get('players').find({ id }).value();
  const now = Date.now();
  if (existing) {
    db.get('players').find({ id }).assign({ name, avatar, lastSeen: now }).write();
  } else {
    db.get('players').push({ id, name, avatar, provider, providerId, createdAt: now, lastSeen: now }).write();
  }
  return db.get('players').find({ id }).value();
}

function getPlayer(id) {
  return db.get('players').find({ id }).value();
}

function getPlayerByProvider(provider, providerId) {
  return db.get('players').find({ provider, providerId }).value();
}

// ── Matches ───────────────────────────────────────────────

function createMatch({ roomId, players }) {
  const match = {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    roomId,
    players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
    startedAt: Date.now(),
    endedAt: null,
    winnerId: null,
    winnerName: null,
    rounds: 0,
  };
  db.get('matches').push(match).write();
  return match;
}

function endMatch(matchId, { winnerId, winnerName, rounds }) {
  db.get('matches').find({ id: matchId }).assign({
    endedAt: Date.now(), winnerId, winnerName, rounds,
  }).write();
}

function getRecentMatchesForPlayer(playerId, limit = 10) {
  return db.get('matches')
    .filter(m => m.players.some(p => p.id === playerId) && m.endedAt)
    .sortBy(m => -m.endedAt)
    .take(limit)
    .value();
}

function getAllMatches(limit = 50) {
  return db.get('matches')
    .filter(m => m.endedAt)
    .sortBy(m => -m.endedAt)
    .take(limit)
    .value();
}

module.exports = {
  upsertPlayer, getPlayer, getPlayerByProvider,
  createMatch, endMatch, getRecentMatchesForPlayer, getAllMatches,
};