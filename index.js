// ============================================================
//  UNO GAME — SERVIDOR PRINCIPAL v5
//
//  CORREÇÕES NESTA VERSÃO:
//
//  [FIX-A] _beginColorForPlayer — função centralizada no servidor
//    para iniciar a fase de cor. Usa game._beginColorPhase().
//    Elimina duplicação entre game:play_card, game:end_chain,
//    game:play_multiple e game:jump_in.
//
//  [FIX-B] Timer de turno NÃO é iniciado enquanto há
//    pendingColorChoice. Verificação em startTurnTimer.
//
//  [FIX-C] game:color_timeout fecha o modal para TODOS incluindo
//    o próprio jogador (cliente atualizado em game.html).
//
//  [FIX-D] endChain com needsColor chama _beginColorForPlayer
//    em vez de forçar pendingColorChoice diretamente.
//
//  [FIX-E] autoPlayAfk retorna colorTimedOut — servidor emite
//    game:color_timeout para fechar modal nos outros clientes.
//
//  [FIX-F] game:play_card não passa mais chosenColor — a cor
//    vem exclusivamente via game:choose_color.
// ============================================================

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const session  = require('express-session');
const passport = require('passport');
const crypto   = require('crypto');
const path     = require('path');

const config   = require('./config');
const { UnoGame } = require('./game');
const db       = require('./server/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Middlewares ───────────────────────────────────────────
const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Google OAuth2 ─────────────────────────────────────────
try {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  if (config.GOOGLE_CLIENT_ID && !config.GOOGLE_CLIENT_ID.includes('SEU_')) {
    passport.use(new GoogleStrategy({
      clientID: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: `${config.BASE_URL}/auth/google/callback`,
    }, (accessToken, refreshToken, profile, done) => {
      const user = { id: `google_${profile.id}`, name: profile.displayName, avatar: profile.photos?.[0]?.value || null, provider: 'google', providerId: profile.id };
      try { db.upsertPlayer(user); } catch(e) {}
      return done(null, user);
    }));
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
    app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?error=google' }), (req, res) => res.redirect('/lobby'));
  } else {
    console.warn('[auth] Google OAuth não configurado.');
    app.get('/auth/google',          (req, res) => res.redirect('/?error=google_not_configured'));
    app.get('/auth/google/callback', (req, res) => res.redirect('/?error=google_not_configured'));
  }
} catch(e) {
  console.warn('[auth] passport-google-oauth20 não instalado:', e.message);
  app.get('/auth/google',          (req, res) => res.redirect('/?error=google_not_configured'));
  app.get('/auth/google/callback', (req, res) => res.redirect('/?error=google_not_configured'));
}

// ── Steam OpenID ──────────────────────────────────────────
try {
  const SteamStrategy = require('passport-steam').Strategy;
  if (config.STEAM_API_KEY && !config.STEAM_API_KEY.includes('SUA_')) {
    passport.use(new SteamStrategy({
      returnURL: `${config.BASE_URL}/auth/steam/return`,
      realm: `${config.BASE_URL}/`, apiKey: config.STEAM_API_KEY,
    }, (identifier, profile, done) => {
      const user = { id: `steam_${profile.id}`, name: profile.displayName, avatar: profile.photos?.[2]?.value || profile.photos?.[0]?.value || null, provider: 'steam', providerId: profile.id };
      try { db.upsertPlayer(user); } catch(e) {}
      return done(null, user);
    }));
    app.get('/auth/steam',        passport.authenticate('steam'));
    app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/?error=steam' }), (req, res) => res.redirect('/lobby'));
  } else {
    console.warn('[auth] Steam OAuth não configurado.');
    app.get('/auth/steam',        (req, res) => res.redirect('/?error=steam_not_configured'));
    app.get('/auth/steam/return', (req, res) => res.redirect('/?error=steam_not_configured'));
  }
} catch(e) {
  console.warn('[auth] passport-steam não instalado:', e.message);
  app.get('/auth/steam',        (req, res) => res.redirect('/?error=steam_not_configured'));
  app.get('/auth/steam/return', (req, res) => res.redirect('/?error=steam_not_configured'));
}

// ── Rotas Auth ────────────────────────────────────────────
app.get('/auth/user', (req, res) => {
  if (req.isAuthenticated() && req.user) return res.json({ authenticated: true, user: req.user });
  if (req.session?.guestUser)            return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});
app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated() && req.user) return res.json({ authenticated: true, user: req.user });
  if (req.session?.guestUser)            return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});
app.get('/auth/logout', (req, res) => {
  req.logout(() => req.session.destroy(() => res.redirect('/')));
});
app.post('/auth/guest', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const id   = `guest_${crypto.randomBytes(8).toString('hex')}`;
  const user = { id, name: name.trim().substring(0, 20), avatar: null, provider: 'guest', providerId: id };
  try { db.upsertPlayer(user); } catch(e) {}
  req.session.guestUser = user;
  req.session.save(() => res.json({ success: true, user }));
});
app.get('/auth/guest/session', (req, res) => {
  if (req.session?.guestUser) return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});

// ── API ───────────────────────────────────────────────────
app.get('/api/stats/:playerId', (req, res) => {
  try {
    const matches = db.getRecentMatchesForPlayer(req.params.playerId, 100);
    const wins = matches.filter(m => m.winnerId === req.params.playerId).length;
    const losses = matches.length - wins;
    const winRate = matches.length > 0 ? Math.round((wins / matches.length) * 100) : 0;
    let streak = 0;
    for (const m of [...matches].reverse()) { if (m.winnerId === req.params.playerId) streak++; else break; }
    res.json({ wins, losses, total: matches.length, winRate, streak });
  } catch(e) { res.json({ wins: 0, losses: 0, total: 0, winRate: 0, streak: 0 }); }
});
app.get('/api/history/:playerId', (req, res) => {
  try { res.json(db.getRecentMatchesForPlayer(req.params.playerId)); } catch(e) { res.json([]); }
});
app.get('/api/history', (req, res) => {
  try { res.json(db.getAllMatches(30)); } catch(e) { res.json([]); }
});

const fs = require('fs');
const BG_SUPPORTED = ['.jpg','.jpeg','.png','.webp','.gif','.mp4','.webm','.ogg'];
app.get('/api/backgrounds', (req, res) => {
  try {
    const bgDir = path.join(__dirname, 'public', 'background');
    if (!fs.existsSync(bgDir)) return res.json([]);
    const files = fs.readdirSync(bgDir)
      .filter(f => BG_SUPPORTED.some(ext => f.toLowerCase().endsWith(ext)))
      .map(f => ({ url: `/background/${f}`, name: f }));
    res.json(files);
  } catch(e) { res.json([]); }
});

app.get('/',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/lobby', (_, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));
app.get('/game',  (_, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ── Estado em memória ─────────────────────────────────────
const rooms        = new Map();
const playerRoom   = new Map();
const socketPlayer = new Map();

const turnTimers         = new Map();
const table9Timers       = new Map();
const chainTimers        = new Map();
const gameTimerIntervals = new Map();

// ─── [FIX-A] Iniciar fase de cor — função centralizada ───
// Chamada sempre que uma carta wild/+4 precisa de escolha de cor.
// Garante que o timer de turno NÃO está rodando durante a escolha.

function _beginColorForPlayer(room, roomId, playerId, colorAdvance) {
  clearTurnTimer(roomId); // [FIX-B] para o timer de turno
  clearChainTimer(roomId);

  room.game._beginColorPhase(playerId, null, colorAdvance || { skip: false }, (adv) => {
    // Timer de cor expirou — sem escolha
    const r = room.game.resolveColorTimeout(playerId, adv);

    // [FIX-C] Notifica TODOS (incluindo o próprio jogador) para fechar o modal
    io.to(roomId).emit('game:color_timeout', { playerId });

    if (r.drewCards && r.drewCards.length > 0) {
      const penalizedId = room.game.currentPlayer()?.id; // já avançou
      io.to(roomId).emit('game:effect', { effect: 'wild4_instant', playerId, pendingDraw: 0 });
      io.to(roomId).emit('game:opponent_drew', { playerId: penalizedId, count: r.drewCards.length, forced: true });
    }

    broadcastGameState(room, roomId);
    startTurnTimer(room, roomId);
  });

  broadcastGameState(room, roomId);
  // Não inicia timer de turno aqui — aguarda escolha ou timeout
}

// ── Timers ────────────────────────────────────────────────

function startGameTimer(roomId) {
  if (gameTimerIntervals.has(roomId)) return;
  const interval = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room?.game?.started || room.game.gameOver) { clearInterval(interval); gameTimerIntervals.delete(roomId); return; }
    const elapsed = room.game.startedAt ? Math.floor((Date.now() - room.game.startedAt) / 1000) : 0;
    io.to(roomId).emit('game:elapsed', { seconds: elapsed });
  }, 1000);
  gameTimerIntervals.set(roomId, interval);
}

function stopGameTimer(roomId) {
  if (gameTimerIntervals.has(roomId)) { clearInterval(gameTimerIntervals.get(roomId)); gameTimerIntervals.delete(roomId); }
}

const CHAIN_SECONDS = 10;

function clearChainTimer(roomId) {
  if (chainTimers.has(roomId)) { clearTimeout(chainTimers.get(roomId)); chainTimers.delete(roomId); }
}

function startChainTimer(room, roomId) {
  clearChainTimer(roomId);
  if (!room.game?.pendingChain) return;
  const chainPlayerId = room.game.pendingChain.playerId;
  chainTimers.set(roomId, setTimeout(() => {
    if (!room.game?.pendingChain || room.game.pendingChain.playerId !== chainPlayerId) return;
    const r = room.game.endChain(chainPlayerId);
    if (r.error) return;

    // [FIX-D] chain de wild/+4 — usa _beginColorForPlayer
    if (r.needsColor) {
      _beginColorForPlayer(room, roomId, chainPlayerId, r.colorAdvance);
      return;
    }
    if (r.drewCards?.length > 0) {
      io.to(roomId).emit('game:effect', { effect: 'draw2_instant', playerId: chainPlayerId, pendingDraw: 0 });
      io.to(roomId).emit('game:opponent_drew', { playerId: room.game.currentPlayer()?.id, count: r.drewCards.length, forced: true });
    }
    io.to(roomId).emit('game:effect', { effect: 'timeout', playerId: chainPlayerId });
    broadcastGameState(room, roomId);
    startTurnTimer(room, roomId);
  }, CHAIN_SECONDS * 1000));
}

function clearTable9Timer(roomId) {
  if (table9Timers.has(roomId)) { clearTimeout(table9Timers.get(roomId)); table9Timers.delete(roomId); }
}

function startTable9Timer(room, roomId) {
  clearTable9Timer(roomId);
  table9Timers.set(roomId, setTimeout(() => {
    if (!room.game?.pendingTable9) { broadcastGameState(room, roomId); return; }
    const hitters = new Set(room.game.pendingTable9.hitters || []);
    const missed  = room.game.players.filter(p => !hitters.has(p.id));
    missed.forEach(p => {
      const penalty = room.game.cm.draw(p.id, 2);
      io.to(roomId).emit('game:table_missed', { targetId: p.id, drew: penalty });
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('game:drew', { drew: penalty, forced: true, skipTurn: false });
      io.to(roomId).emit('game:opponent_drew', { playerId: p.id, count: 2, forced: true });
    });
    room.game.clearTable9();
    broadcastGameState(room, roomId);
  }, 10000));
}

const TURN_SECONDS     = 30;
const AFK_KICK_STRIKES = 8;
const CHAIN_COMBO_SECONDS = 10;

function resolveAfkTurn(room, roomId, playerId) {
  if (!room.game || room.game.gameOver) return;
  if (room.game.currentPlayer()?.id !== playerId) return;
  if (room.game.pendingTable9) return;

  // Se há cadeia ativa (MultiPlay), encerra o combo sem jogar mais cartas
  if (room.game.pendingChain && room.game.pendingChain.playerId === playerId) {
    clearChainTimer(roomId);
    const r = room.game.endChain(playerId);
    if (!r.error) {
      if (r.needsColor) {
        _beginColorForPlayer(room, roomId, playerId, r.colorAdvance);
        return;
      }
      if (r.drewCards?.length > 0) {
        io.to(roomId).emit('game:effect', { effect: 'draw2_instant', playerId, pendingDraw: 0 });
        io.to(roomId).emit('game:opponent_drew', { playerId: room.game.currentPlayer()?.id, count: r.drewCards.length, forced: true });
      }
      if (r.pendingSwap) {
        io.to(roomId).emit('game:effect', { effect: '7swap_pending', playerId });
        broadcastGameState(room, roomId);
        return;
      }
      if (r.pendingTable9) {
        io.to(roomId).emit('game:effect', { effect: '9table', playerId });
        broadcastGameState(room, roomId);
        startTable9Timer(room, roomId);
        return;
      }
      broadcastGameState(room, roomId);
      startTurnTimer(room, roomId);
    }
    return;
  }

  const r = room.game.autoPlayAfk(playerId);
  if (r.error) return;

  // [FIX-E] Se havia cor pendente, fecha modal para todos
  if (r.colorTimedOut) {
    io.to(roomId).emit('game:color_timeout', { playerId });
    if (r.drewCards?.length > 0) {
      io.to(roomId).emit('game:effect', { effect: 'wild4_instant', playerId, pendingDraw: 0 });
    }
  }

  io.to(roomId).emit('game:effect', { effect: 'timeout', playerId });

  if (r.playedCard) {
    io.to(roomId).emit('game:card_played', { playerId, card: r.playedCard, effect: r.effect });
    io.to(roomId).emit('game:effect', { effect: r.effect, card: r.playedCard, playerId });
  }
  if (r.drew?.length > 0) {
    io.to(roomId).emit('game:opponent_drew', { playerId, count: r.drew.length, forced: r.forced || false });
  }

  if (r.gameOver) {
    clearTurnTimer(roomId); stopGameTimer(roomId);
    try { if (room.matchId) db.endMatch(room.matchId, { winnerId: room.players.find(p => p.socketId === r.winner.id)?.playerId, winnerName: r.winner.name, rounds: r.state.turnCount || 0 }); } catch(e) {}
    io.to(roomId).emit('game:over', { winner: r.winner, state: r.state });
    return;
  }

  if ((r.afkStrikes || 0) >= AFK_KICK_STRIKES) {
    const kickedPlayer = room.players.find(p => p.socketId === playerId);
    if (kickedPlayer) {
      io.to(roomId).emit('game:player_disconnected', { playerName: kickedPlayer.name, reason: 'afk' });
      const kickSock = io.sockets.sockets.get(playerId);
      if (kickSock) { kickSock.emit('room:left'); kickSock.leave(roomId); }
      removePlayerFromRoom(kickedPlayer.playerId, playerId);
      return;
    }
  }

  broadcastGameState(room, roomId);
  startTurnTimer(room, roomId);
}

function clearTurnTimer(roomId) {
  if (turnTimers.has(roomId)) { clearTimeout(turnTimers.get(roomId)); turnTimers.delete(roomId); }
}

function startTurnTimer(room, roomId) {
  clearTurnTimer(roomId);
  if (!room.game?.rules?.turnTimer) return;
  if (room.game.gameOver) return;
  // [FIX-B] Não inicia timer durante escolha de cor ou evento do 9
  if (room.game.isPendingColor()) return;
  if (room.game.pendingTable9) return;

  const currentId    = room.game.currentPlayer()?.id;
  if (!currentId) return;
  const expectedTurn = room.game.turnCount;

  io.to(roomId).emit('game:turn_timer', { playerId: currentId, seconds: TURN_SECONDS });

  turnTimers.set(roomId, setTimeout(() => {
    if (!room.game || room.game.gameOver) return;
    if (room.game.turnCount !== expectedTurn) return;
    if (room.game.currentPlayer()?.id !== currentId) return;
    resolveAfkTurn(room, roomId, currentId);
  }, TURN_SECONDS * 1000));
}

function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

function getRoomList() {
  const list = [];
  rooms.forEach((room, id) => {
    if (!room.game?.started && room.players.length < config.MAX_PLAYERS_PER_ROOM)
      list.push({ id, playerCount: room.players.length, maxPlayers: config.MAX_PLAYERS_PER_ROOM, hostName: room.players[0]?.name || '?' });
  });
  return list;
}
function broadcastRoomList() { io.emit('room:list', getRoomList()); }

function broadcastGameState(room, roomId) {
  if (!room?.game) return;
  const state = room.game.getState();
  io.to(roomId).emit('game:update', state);
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit('game:hand', room.game.getHand(p.socketId));
      sock.emit('game:my_id', { mySocketId: p.socketId });
    }
  });
}

function removePlayerFromRoom(playerId, socketId) {
  socketPlayer.delete(socketId);
  const roomId = playerRoom.get(playerId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) { playerRoom.delete(playerId); return; }
  const idx = room.players.findIndex(p => p.playerId === playerId);
  if (idx === -1) { playerRoom.delete(playerId); return; }
  const leaving = room.players[idx];
  room.players.splice(idx, 1);
  playerRoom.delete(playerId);

  if (room.players.length === 0) { rooms.delete(roomId); broadcastRoomList(); return; }
  room.players[0].isHost = true;

  if (room.game?.started && !room.game.gameOver) {
    room.game.removePlayerFromGame(leaving.socketId);
    io.to(roomId).emit('game:player_disconnected', { playerName: leaving.name });
    if (room.game.players.length < 2) {
      const winner = room.game.players[0] || null;
      room.game.gameOver = true; room.game.winner = winner;
      const state = room.game.getState();
      stopGameTimer(roomId);
      if (room.matchId && winner) {
        try { db.endMatch(room.matchId, { winnerId: room.players.find(p => p.socketId === winner.id)?.playerId, winnerName: winner.name, rounds: state.turnCount || 0 }); } catch(e) {}
      }
      io.to(roomId).emit('game:over', { winner, reason: 'abandon', state });
      return;
    }
    if (room.game.currentPlayerIndex >= room.game.players.length) room.game.currentPlayerIndex = 0;
    broadcastGameState(room, roomId);
  } else {
    io.to(roomId).emit('room:player_left', { playerId, playerName: leaving.name, players: room.players, newHost: room.players[0] });
  }
  broadcastRoomList();
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const req      = socket.request;
  const authUser = req?.session?.passport?.user || req?.session?.guestUser || null;

  socket.emit('room:list', getRoomList());

  socket.on('room:create', ({ playerName, playerAvatar, guestId }) => {
    const playerId = authUser?.id || guestId;
    if (!playerId) return socket.emit('error', 'Sessão expirada.');
    if (playerRoom.has(playerId)) removePlayerFromRoom(playerId, socket.id);
    const roomId = generateRoomId();
    const player = { playerId, id: socket.id, socketId: socket.id, name: authUser?.name || playerName || 'Jogador', avatar: authUser?.avatar || playerAvatar || null, isHost: true };
    const defaultRules = { startCards: 7, stackDraw2: false, stackDraw4: false, stackMix: false, stackFree: false, rule7: false, rule0: false, rule9: false, drawUntilPlay: false, drawInfinite: false, deckInfinite: false, jumpIn: false, multiPlay: false, multiPlaySpecial: false, wild4NoRestriction: true, glowCards: true, turnTimer: true };
    rooms.set(roomId, { players: [player], game: null, chat: [], matchId: null, rules: defaultRules, background: null, backgroundVotes: {} });
    playerRoom.set(playerId, roomId);
    socketPlayer.set(socket.id, { playerId, roomId });
    socket.join(roomId);
    socket.emit('room:joined', { roomId, players: [player], isHost: true, you: player, rules: defaultRules, background: null, backgroundVotes: {} });
    broadcastRoomList();
  });

  socket.on('room:join', ({ roomId, playerName, playerAvatar, guestId }) => {
    const playerId = authUser?.id || guestId;
    if (!playerId) return socket.emit('error', 'Sessão expirada.');
    const room = rooms.get(roomId);
    if (!room)              return socket.emit('error', 'Sala não encontrada');
    if (room.game?.started) return socket.emit('error', 'Partida já iniciada');
    if (room.players.length >= config.MAX_PLAYERS_PER_ROOM) return socket.emit('error', 'Sala cheia');

    if (playerRoom.has(playerId) && playerRoom.get(playerId) === roomId) {
      const existing = room.players.find(p => p.playerId === playerId);
      if (existing) {
        socketPlayer.delete(existing.socketId);
        existing.socketId = socket.id; existing.id = socket.id;
        socketPlayer.set(socket.id, { playerId, roomId });
        socket.join(roomId);
        const bgVc = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ bgVc[k]=s.size; });
        socket.emit('room:joined', { roomId, players: room.players, isHost: existing.isHost, you: existing, rules: room.rules || {}, background: room.background || null, backgroundVotes: bgVc });
        return;
      }
    }

    if (playerRoom.has(playerId)) removePlayerFromRoom(playerId, socket.id);

    const alreadyIn = room.players.find(p => p.playerId === playerId);
    if (alreadyIn) {
      socketPlayer.delete(alreadyIn.socketId);
      alreadyIn.socketId = socket.id; alreadyIn.id = socket.id;
      socketPlayer.set(socket.id, { playerId, roomId });
      playerRoom.set(playerId, roomId);
      socket.join(roomId);
      const bgVc2 = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ bgVc2[k]=s.size; });
      socket.emit('room:joined', { roomId, players: room.players, isHost: alreadyIn.isHost, you: alreadyIn, rules: room.rules || {}, background: room.background || null, backgroundVotes: bgVc2 });
      return;
    }

    const player = { playerId, id: socket.id, socketId: socket.id, isHost: false, name: authUser?.name || playerName || 'Jogador', avatar: authUser?.avatar || playerAvatar || null };
    room.players.push(player);
    playerRoom.set(playerId, roomId);
    socketPlayer.set(socket.id, { playerId, roomId });
    socket.join(roomId);
    const bgVc3 = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ bgVc3[k]=s.size; });
    socket.emit('room:joined', { roomId, players: room.players, isHost: false, you: player, rules: room.rules || {}, background: room.background || null, backgroundVotes: bgVc3 });
    socket.to(roomId).emit('room:player_joined', { players: room.players, newPlayer: player });
    broadcastRoomList();
  });

  socket.on('room:leave', () => {
    const sp = socketPlayer.get(socket.id);
    if (sp) { socket.leave(sp.roomId); removePlayerFromRoom(sp.playerId, socket.id); }
    socket.emit('room:left');
  });

  socket.on('room:update_rules', ({ rules }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room) return;
    if (room.players[0].socketId !== socket.id) return socket.emit('error', 'Apenas o host pode alterar regras');
    room.rules = { ...room.rules, ...rules };
    io.to(sp.roomId).emit('room:rules_updated', { rules: room.rules });
  });

  socket.on('room:set_background', ({ url }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room) return;
    if (room.players[0].socketId !== socket.id) return socket.emit('error', 'Apenas o host pode definir');
    room.background = url || null;
    io.to(sp.roomId).emit('room:background_set', { url: room.background });
  });

  socket.on('room:vote_background', ({ url }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room) return;
    if (!room.backgroundVotes) room.backgroundVotes = {};
    const key = url || 'default';
    Object.keys(room.backgroundVotes).forEach(k => { if (room.backgroundVotes[k]) room.backgroundVotes[k].delete(socket.id); });
    if (!room.backgroundVotes[key]) room.backgroundVotes[key] = new Set();
    room.backgroundVotes[key].add(socket.id);
    const voteCounts = {}; Object.entries(room.backgroundVotes).forEach(([k, s]) => { voteCounts[k] = s.size; });
    io.to(sp.roomId).emit('room:background_votes', { votes: voteCounts });
  });

  socket.on('game:start', ({ rules: clientRules } = {}) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room) return socket.emit('error', 'Sala não encontrada');
    if (room.players[0].socketId !== socket.id) return socket.emit('error', 'Apenas o host pode iniciar');
    if (room.players.length < config.MIN_PLAYERS_TO_START) return socket.emit('error', `Mínimo ${config.MIN_PLAYERS_TO_START} jogadores`);
    if (room.game?.started) return socket.emit('error', 'Partida já iniciada');

    const effectiveRules = Object.assign({}, clientRules || {}, room.rules || {});
    const gamePlayers = room.players.map(p => ({ id: p.socketId, name: p.name, avatar: p.avatar }));
    const game = new UnoGame(sp.roomId, gamePlayers, effectiveRules);
    room.game = game;
    game.start();

    console.log(`[game:start] roomId=${sp.roomId} startCards=${effectiveRules.startCards} players=${gamePlayers.length}`);

    try { room.matchId = db.createMatch({ roomId: sp.roomId, players: room.players.map(p => ({ id: p.playerId, name: p.name, avatar: p.avatar })) }).id; } catch(e) {}

    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('game:started', { ...game.getPlayerState(p.socketId), mySocketId: p.socketId });
    });

    broadcastRoomList();
    setTimeout(() => startTurnTimer(room, sp.roomId), 700);
    startGameTimer(sp.roomId);
  });

  // ── [FIX-F] Jogar carta — sem chosenColor ────────────────
  socket.on('game:play_card', ({ cardId }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');

    const result = room.game.playCard(socket.id, cardId);
    if (result.error) return socket.emit('error', result.error);

    clearTurnTimer(sp.roomId);

    io.to(sp.roomId).emit('game:card_played', { playerId: socket.id, card: result.played, effect: result.effect });
    io.to(sp.roomId).emit('game:effect', { effect: result.effect, card: result.played, playerId: socket.id, nextPlayer: result.nextPlayer?.id, pendingDraw: result.pendingDraw });

    // [FIX-A] Carta precisa de cor: usa _beginColorForPlayer
    if (result.needsColor && !String(result.effect).includes('chain')) {
      _beginColorForPlayer(room, sp.roomId, socket.id, result._colorAdvance || { skip: false });
      return;
    }

    if (result.gameOver) {
      try { if (room.matchId) db.endMatch(room.matchId, { winnerId: room.players.find(p => p.socketId === result.winner.id)?.playerId, winnerName: result.winner.name, rounds: result.state.turnCount || 0 }); } catch(e) {}
      stopGameTimer(sp.roomId);
      io.to(sp.roomId).emit('game:over', { winner: result.winner, state: result.state });
      return;
    }

    broadcastGameState(room, sp.roomId);

    if (result.effect === '0rotate') {
      const order = room.game.playerOrder, n = order.length, dir = room.game.direction;
      const fromTo = order.map((pid, i) => { const nextIdx = ((i + dir) % n + n) % n; return { from: pid, to: order[nextIdx] }; });
      io.to(sp.roomId).emit('game:zero_rotate', { fromTo, direction: dir });
    }

    if (result.effect === 'numeric_chain') {
      clearChainTimer(sp.roomId);
      startChainTimer(room, sp.roomId);
    } else if (result.effect === '9table') {
      startTable9Timer(room, sp.roomId);
    } else {
      clearChainTimer(sp.roomId);
      const noTimerEffects = ['draw2_instant', 'wild4_instant', 'numeric_chain'];
      if (!noTimerEffects.includes(result.effect)) startTurnTimer(room, sp.roomId);
    }
  });

  // ── Escolha de cor ───────────────────────────────────────
  socket.on('game:choose_color', ({ color }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');

    if (!room.game.pendingColorChoice) return socket.emit('error', 'Sem escolha de cor pendente');
    if (room.game.pendingColorChoice.playerId !== socket.id) return socket.emit('error', 'Não é você que escolhe a cor');

    const r = room.game.resolveColorChoice(socket.id, color);
    if (r.error) return socket.emit('error', r.error);

    io.to(sp.roomId).emit('game:color_chosen', { playerId: socket.id, color, auto: false });

    if (r.drewCards?.length > 0) {
      const penalizedId = room.game.currentPlayer()?.id;
      io.to(sp.roomId).emit('game:effect', { effect: 'wild4_instant', playerId: socket.id, pendingDraw: 0 });
      io.to(sp.roomId).emit('game:opponent_drew', { playerId: penalizedId, count: r.drewCards.length, forced: true });
    }

    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── Comprar carta ────────────────────────────────────────
  socket.on('game:draw_card', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');

    const result = room.game.drawCard(socket.id);

    if (result.error && result.hasStackable) return socket.emit('error', result.error);
    if (result.error && result.mustPlay) { socket.emit('error', result.error); broadcastGameState(room, sp.roomId); return; }
    if (result.error) return socket.emit('error', result.error);

    if (result.forced && result.skipTurn) {
      socket.emit('game:drew', { drew: result.drew, canPlay: false, forced: true, skipTurn: true });
      socket.to(sp.roomId).emit('game:opponent_drew', { playerId: socket.id, count: result.drew?.length || 0, forced: true });
      broadcastGameState(room, sp.roomId);
      startTurnTimer(room, sp.roomId);
      return;
    }

    socket.emit('game:drew', {
      drew:     result.drew,
      canPlay:  result.canPlay,
      mustPlay: result.mustPlay || false,
      forced:   result.forced   || false,
      skipTurn: result.skipTurn || false,
    });
    socket.to(sp.roomId).emit('game:opponent_drew', { playerId: socket.id, count: result.drew?.length || 0, forced: result.forced || false });

    broadcastGameState(room, sp.roomId);
    if (result.skipTurn) startTurnTimer(room, sp.roomId);
  });

  // ── Pular vez ────────────────────────────────────────────
  socket.on('game:skip_turn', () => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');
    const r = room.game.skipTurn(socket.id);
    if (r.error) return socket.emit('error', r.error);
    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── [FIX-D] Encerrar cadeia ──────────────────────────────
  socket.on('game:end_chain', () => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');
    clearChainTimer(sp.roomId);
    const r = room.game.endChain(socket.id);
    if (r.error) return socket.emit('error', r.error);

    // wild/+4 chain precisa de cor
    if (r.needsColor) {
      _beginColorForPlayer(room, sp.roomId, socket.id, r.colorAdvance);
      return;
    }

    if (r.drewCards?.length > 0) {
      io.to(sp.roomId).emit('game:effect', { effect: 'draw2_instant', playerId: socket.id, pendingDraw: 0 });
      io.to(sp.roomId).emit('game:opponent_drew', { playerId: room.game.currentPlayer()?.id, count: r.drewCards.length, forced: true });
    }

    // Evento do 7 — troca de mão
    if (r.pendingSwap) {
      io.to(sp.roomId).emit('game:effect', { effect: '7swap_pending', playerId: socket.id });
      broadcastGameState(room, sp.roomId);
      // Não inicia timer de turno — aguarda resolução da troca
      return;
    }

    // Evento do 9 — bater na mesa
    if (r.pendingTable9) {
      io.to(sp.roomId).emit('game:effect', { effect: '9table', playerId: socket.id });
      broadcastGameState(room, sp.roomId);
      startTable9Timer(room, sp.roomId);
      return;
    }

    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── UNO ──────────────────────────────────────────────────
  socket.on('game:uno', () => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.sayUno(socket.id);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:uno_called', { playerId: socket.id });
    broadcastGameState(room, sp.roomId);
  });

  socket.on('game:call_uno_violation', ({ targetId }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.callUnoViolation(socket.id, targetId);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:uno_violation', { callerId: socket.id, targetId, drew: r.drew });
    broadcastGameState(room, sp.roomId);
  });

  // ── Trocar de mão ────────────────────────────────────────
  socket.on('game:swap', ({ targetId }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.executeSwap(socket.id, targetId);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:swapped', { initiatorId: socket.id, targetId, state: r.state });
    broadcastGameState(room, sp.roomId);
  });

  socket.on('game:decline_swap', () => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.declineSwap(socket.id);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:swap_declined', { initiatorId: socket.id });
    broadcastGameState(room, sp.roomId);
  });

  // ── Regra 9 ──────────────────────────────────────────────
  socket.on('game:hit_table', () => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.hitTable(socket.id);
    if (r.error) return socket.emit('error', r.error);
    if (r.alreadyHit) return;
    io.to(sp.roomId).emit('game:table_hit', { playerId: socket.id, allHit: r.allHit });
    if (r.allHit) {
      clearTable9Timer(sp.roomId);
      if (r.lastPlayerId && r.penalty?.length > 0) {
        io.to(sp.roomId).emit('game:table_last_penalized', { playerId: r.lastPlayerId, drew: r.penalty });
        const penalizedSock = io.sockets.sockets.get(r.lastPlayerId);
        if (penalizedSock) penalizedSock.emit('game:drew', { drew: r.penalty, forced: true, skipTurn: false });
        io.to(sp.roomId).emit('game:opponent_drew', { playerId: r.lastPlayerId, count: r.penalty.length, forced: true });
      }
      io.to(sp.roomId).emit('game:table_all_hit', {});
    }
    broadcastGameState(room, sp.roomId);
  });

  socket.on('game:missed_table', ({ targetId }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room?.game) return;
    const r = room.game.applyMissedTable(targetId || socket.id);
    if (r.error || r.alreadyClear || r.alreadyHit) return;
    io.to(sp.roomId).emit('game:table_missed', { targetId: targetId || socket.id, drew: r.drew });
    broadcastGameState(room, sp.roomId);
  });

  // ── MultiPlay manual (legado) ─────────────────────────────
  socket.on('game:play_multiple', ({ cardIds }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');

    const result = room.game.playMultiple(socket.id, cardIds);
    if (result.error) return socket.emit('error', result.error);

    io.to(sp.roomId).emit('game:cards_played_multi', { playerId: socket.id, cards: result.played, effect: result.effect });
    io.to(sp.roomId).emit('game:effect', { effect: result.effect, cards: result.played, playerId: socket.id });

    // [FIX-A] needsColor usa _beginColorForPlayer
    if (result.needsColor) {
      _beginColorForPlayer(room, sp.roomId, socket.id, result.colorAdvance || { skip: false });
      return;
    }

    if (result.pendingTable9 || result.effect === '9table') startTable9Timer(room, sp.roomId);

    if (result.gameOver) {
      stopGameTimer(sp.roomId);
      try { if (room.matchId) db.endMatch(room.matchId, { winnerId: room.players.find(p => p.socketId === result.winner.id)?.playerId, winnerName: result.winner.name, rounds: result.state.turnCount || 0 }); } catch(e) {}
      io.to(sp.roomId).emit('game:over', { winner: result.winner, state: result.state });
      return;
    }

    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── [FIX-7] Jump-In ─────────────────────────────────────
  socket.on('game:jump_in', ({ cardId }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');

    const result = room.game.jumpIn(socket.id, cardId);
    if (result.error) return socket.emit('error', result.error);

    io.to(sp.roomId).emit('game:card_played', { playerId: socket.id, card: result.played, effect: result.effect, jumpIn: true });
    io.to(sp.roomId).emit('game:effect', { effect: 'jump_in', card: result.played, playerId: socket.id });

    // [FIX-A] needsColor usa _beginColorForPlayer
    if (result.needsColor) {
      _beginColorForPlayer(room, sp.roomId, socket.id, result.colorAdvance || { skip: false });
      return;
    }

    if (result.gameOver) {
      clearTurnTimer(sp.roomId); stopGameTimer(sp.roomId);
      try { if (room.matchId) db.endMatch(room.matchId, { winnerId: room.players.find(p => p.socketId === result.winner.id)?.playerId, winnerName: result.winner.name, rounds: result.state.turnCount || 0 }); } catch(e) {}
      io.to(sp.roomId).emit('game:over', { winner: result.winner, state: result.state });
      return;
    }

    clearTurnTimer(sp.roomId);
    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── Rejoin ───────────────────────────────────────────────
  socket.on('game:rejoin', ({ roomId: rId, playerId, playerName, playerAvatar }) => {
    if (!rId || !playerId) return;
    const room = rooms.get(rId);
    if (!room) return socket.emit('error', 'Sala não encontrada');
    if (!room.game?.started) return socket.emit('error', 'Jogo não iniciado');

    let player = room.players.find(p => p.playerId === playerId);
    if (!player) {
      const gamePlayer = room.game.players.find(p => p.name === playerName);
      if (!gamePlayer) return socket.emit('error', 'Jogador não encontrado na partida');
      player = { playerId, id: socket.id, socketId: socket.id, name: playerName || gamePlayer.name, avatar: playerAvatar || gamePlayer.avatar || null, isHost: room.players.length === 0 };
      room.players.push(player);
    }

    const oldSocketId = player.socketId;
    socketPlayer.delete(oldSocketId);
    player.socketId = socket.id; player.id = socket.id;
    socketPlayer.set(socket.id, { playerId, roomId: rId });
    playerRoom.set(playerId, rId);

    const gamePlayer = room.game.players.find(p => p.id === oldSocketId);
    if (gamePlayer) gamePlayer.id = socket.id;

    if (room.game.playerOrder) {
      const orderIdx = room.game.playerOrder.indexOf(oldSocketId);
      if (orderIdx !== -1) room.game.playerOrder[orderIdx] = socket.id;
    }
    if (room.game.cm?.hands?.has(oldSocketId)) {
      const hand = room.game.cm.hands.get(oldSocketId);
      room.game.cm.hands.set(socket.id, hand);
      room.game.cm.hands.delete(oldSocketId);
      console.log(`[rejoin] migrou ${hand.length} cartas ${oldSocketId} → ${socket.id} (${playerName})`);
    }
    if (room.game.pendingColorChoice?.playerId === oldSocketId) {
      room.game.pendingColorChoice.playerId = socket.id;
    }

    socket.join(rId);
    if (player.reconnectTimer) { clearTimeout(player.reconnectTimer); player.reconnectTimer = null; }
    player.reconnecting = false;

    socket.emit('game:started', { ...room.game.getPlayerState(socket.id), mySocketId: socket.id });
    socket.to(rId).emit('game:update', room.game.getState());
    room.players.forEach(p => {
      if (p.socketId === socket.id) return;
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) { sock.emit('game:hand', room.game.getHand(p.socketId)); sock.emit('game:my_id', { mySocketId: p.socketId }); }
    });
    console.log('[rejoin] ' + playerName + ' (' + playerId + ') reconectou como ' + socket.id);
  });

  // ── Chat ─────────────────────────────────────────────────
  socket.on('chat:message', ({ text }) => {
    const sp = socketPlayer.get(socket.id); if (!sp) return;
    const room = rooms.get(sp.roomId); if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    const msg = { from: player?.name || 'Anônimo', avatar: player?.avatar || null, text: String(text).substring(0, 200), time: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(sp.roomId).emit('chat:message', msg);
  });

  // ── Desconexão ───────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    console.log('[socket] disconnect: ' + socket.id + ' (' + reason + ') — player ' + sp.playerId);
    const room = rooms.get(sp.roomId);

    if (room?.game?.started && !room.game.gameOver) {
      socketPlayer.delete(socket.id);
      const player = room.players.find(p => p.playerId === sp.playerId);
      if (player) {
        player.reconnecting = true;
        if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
        player.reconnectTimer = setTimeout(() => {
          if (player.reconnecting) { console.log('[socket] timeout reconexao: ' + sp.playerId); removePlayerFromRoom(sp.playerId, socket.id); }
        }, 8000);
      }
      return;
    }

    removePlayerFromRoom(sp.playerId, socket.id);
  });
});

// ── Start ─────────────────────────────────────────────────
server.listen(config.PORT, () => {
  console.log(`\n🎴  UNO Game rodando em: ${config.BASE_URL}`);
  console.log(`📋  Acesse: http://localhost:${config.PORT}`);
  console.log(`💾  Banco: data/db.json\n`);
  console.log('🔐  Auth:');
  console.log(`    Google: ${config.GOOGLE_CLIENT_ID.includes('SEU_') ? '❌ NÃO CONFIGURADO' : '✅ OK'}`);
  console.log(`    Steam:  ${config.STEAM_API_KEY.includes('SUA_')    ? '❌ NÃO CONFIGURADO' : '✅ OK'}`);
  console.log(`    Guest:  ✅ OK\n`);
});
