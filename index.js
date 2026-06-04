// ============================================================
//  UNO GAME — SERVIDOR PRINCIPAL
//  Fixes:
//    • Google OAuth callback URL correta
//    • Steam realm corrigido
//    • Sessão compartilhada com socket.io (player ID real)
//    • Turn sync: broadcastGameState helper centralizado
//    • Deduplicação de jogadores (sem entradas duplicadas)
//    • Socket-session link via socket.request.session
//    • Cannot GET corrigido (ordem das rotas + static files)
//    • removePlayerFromRoom com ajuste de índice de turno
// ============================================================

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const session  = require('express-session');
const passport = require('passport');
const crypto   = require('crypto');
const path     = require('path');

const config   = require('./config');
const { UnoGame } = require('./server/game');
const db       = require('./server/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // Aumentar timeout para evitar desconexões falsas em redes lentas
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Middlewares ───────────────────────────────────────────
const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Cookie dura 30 dias — persiste login do Google/Steam entre reinicializações do servidor
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
// Servir arquivos estáticos da pasta public/
app.use(express.static(path.join(__dirname, 'public')));

// Compartilhar sessão com socket.io (FIX: auth por sessão no socket)
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

// ── Passport ─────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Google OAuth2 ─────────────────────────────────────────
// FIX: callbackURL deve bater exatamente com o Google Console
// No Google Console: Credenciais → OAuth → URIs de redirecionamento autorizados
// Adicione: http://localhost:3002/auth/google/callback (dev)
//           https://seudominio.com/auth/google/callback (prod)
try {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  if (config.GOOGLE_CLIENT_ID && !config.GOOGLE_CLIENT_ID.includes('SEU_')) {
    passport.use(new GoogleStrategy({
      clientID:     config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${config.BASE_URL}/auth/google/callback`,
    }, (accessToken, refreshToken, profile, done) => {
      const user = {
        id:         `google_${profile.id}`,
        name:       profile.displayName,
        avatar:     profile.photos?.[0]?.value || null,
        provider:   'google',
        providerId: profile.id,
      };
      try { db.upsertPlayer(user); } catch(e) {}
      return done(null, user);
    }));

    app.get('/auth/google',
      passport.authenticate('google', { scope: ['profile'] })
    );
    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/?error=google' }),
      (req, res) => res.redirect('/lobby')
    );
  } else {
    console.warn('[auth] Google OAuth não configurado. Edite GOOGLE_CLIENT_ID no config.js');
    app.get('/auth/google',          (req, res) => res.redirect('/?error=google_not_configured'));
    app.get('/auth/google/callback', (req, res) => res.redirect('/?error=google_not_configured'));
  }
} catch(e) {
  console.warn('[auth] passport-google-oauth20 não instalado:', e.message);
  app.get('/auth/google',          (req, res) => res.redirect('/?error=google_not_configured'));
  app.get('/auth/google/callback', (req, res) => res.redirect('/?error=google_not_configured'));
}

// ── Steam OpenID ──────────────────────────────────────────
// FIX: realm deve terminar com / e returnURL deve ser URL absoluta
// Steam Console: https://steamcommunity.com/dev/apikey
// Domain: localhost (dev) ou seu domínio (prod)
try {
  const SteamStrategy = require('passport-steam').Strategy;
  if (config.STEAM_API_KEY && !config.STEAM_API_KEY.includes('SUA_')) {
    passport.use(new SteamStrategy({
      returnURL: `${config.BASE_URL}/auth/steam/return`,
      realm:     `${config.BASE_URL}/`,
      apiKey:    config.STEAM_API_KEY,
    }, (identifier, profile, done) => {
      const user = {
        id:         `steam_${profile.id}`,
        name:       profile.displayName,
        avatar:     profile.photos?.[2]?.value || profile.photos?.[0]?.value || null,
        provider:   'steam',
        providerId: profile.id,
      };
      try { db.upsertPlayer(user); } catch(e) {}
      return done(null, user);
    }));

    app.get('/auth/steam', passport.authenticate('steam'));
    app.get('/auth/steam/return',
      passport.authenticate('steam', { failureRedirect: '/?error=steam' }),
      (req, res) => res.redirect('/lobby')
    );
  } else {
    console.warn('[auth] Steam OAuth não configurado. Edite STEAM_API_KEY no config.js');
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
  // Verifica passport (Google/Steam) ou guestUser na sessão
  if (req.isAuthenticated() && req.user)
    return res.json({ authenticated: true, user: req.user });
  if (req.session?.guestUser)
    return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});

// Alias para compatibilidade
app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated() && req.user)
    return res.json({ authenticated: true, user: req.user });
  if (req.session?.guestUser)
    return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => res.redirect('/'));
  });
});

// Convidado
app.post('/auth/guest', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const id   = `guest_${crypto.randomBytes(8).toString('hex')}`;
  const user = {
    id,
    name:       name.trim().substring(0, 20),
    avatar:     null,
    provider:   'guest',
    providerId: id,
  };
  try { db.upsertPlayer(user); } catch(e) {}
  req.session.guestUser = user;
  req.session.save(() => res.json({ success: true, user }));
});

app.get('/auth/guest/session', (req, res) => {
  if (req.session?.guestUser)
    return res.json({ authenticated: true, user: req.session.guestUser });
  res.json({ authenticated: false });
});

// ── API Stats do Jogador ──────────────────────────────────
app.get('/api/stats/:playerId', (req, res) => {
  try {
    const matches = db.getRecentMatchesForPlayer(req.params.playerId, 100);
    const wins = matches.filter(m => m.winnerId === req.params.playerId).length;
    const losses = matches.length - wins;
    const winRate = matches.length > 0 ? Math.round((wins / matches.length) * 100) : 0;
    // Sequência atual de vitórias
    let streak = 0;
    for (const m of [...matches].reverse()) {
      if (m.winnerId === req.params.playerId) streak++;
      else break;
    }
    res.json({ wins, losses, total: matches.length, winRate, streak });
  } catch(e) { res.json({ wins: 0, losses: 0, total: 0, winRate: 0, streak: 0 }); }
});

// ── API Histórico ─────────────────────────────────────────
app.get('/api/history/:playerId', (req, res) => {
  try { res.json(db.getRecentMatchesForPlayer(req.params.playerId)); }
  catch(e) { res.json([]); }
});
app.get('/api/history', (req, res) => {
  try { res.json(db.getAllMatches(30)); }
  catch(e) { res.json([]); }
});

// ── API Backgrounds ───────────────────────────────────────
// Lista todos os arquivos em public/background/ (imagens + vídeos)
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

// ── Páginas (DEVEM VIR DEPOIS DOS STATICS E APÓS AS ROTAS DE API) ──
// FIX: Cannot GET — rota catch-all para SPA
app.get('/',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/lobby', (_, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));
app.get('/game',  (_, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ── Estado em memória ─────────────────────────────────────
const rooms        = new Map(); // roomId → room
const playerRoom   = new Map(); // playerId → roomId
const socketPlayer = new Map(); // socketId → { playerId, roomId }

// ── Timer de turno (30s) ──────────────────────────────────
const turnTimers   = new Map(); // roomId → timeout
const table9Timers = new Map(); // roomId → timeout da regra 9
const chainTimers  = new Map(); // roomId → timeout do chain (MultiPlay)

const CHAIN_SECONDS = 5; // tempo para jogar próxima carta do chain

function clearChainTimer(roomId) {
  if (chainTimers.has(roomId)) {
    clearTimeout(chainTimers.get(roomId));
    chainTimers.delete(roomId);
  }
}

// BUG-002 FIX: servidor controla o timeout do chain.
// Quando o tempo expira, encerra a cadeia e passa a vez.
function startChainTimer(room, roomId) {
  clearChainTimer(roomId);
  if (!room.game?.pendingChain) return;
  const chainPlayerId = room.game.pendingChain.playerId;
  chainTimers.set(roomId, setTimeout(() => {
    if (!room.game || !room.game.pendingChain) return;
    if (room.game.pendingChain.playerId !== chainPlayerId) return;
    const r = room.game.endChain(chainPlayerId);
    if (!r.error) {
      broadcastGameState(room, roomId);
      startTurnTimer(room, roomId);
    }
  }, CHAIN_SECONDS * 1000));
}

function clearTable9Timer(roomId) {
  if (table9Timers.has(roomId)) {
    clearTimeout(table9Timers.get(roomId));
    table9Timers.delete(roomId);
  }
}

function startTable9Timer(room, roomId) {
  clearTable9Timer(roomId);
  // 10 segundos para todos baterem
  table9Timers.set(roomId, setTimeout(() => {
    if (!room.game) return;
    // Se pendingTable9 já foi limpo (todos bateram), não faz nada
    if (!room.game.pendingTable9) { broadcastGameState(room, roomId); return; }
    // Captura quem bateu ANTES de penalizar
    const hitters = new Set(room.game.pendingTable9.hitters || []);
    const missed = room.game.players.filter(p => !hitters.has(p.id));
    // Penaliza quem não bateu
    // BUG-004 FIX: usar _drawFromDeck (método privado correto da classe)
    missed.forEach(p => {
      const penalty = room.game._drawFromDeck(2);
      p.hand.push(...penalty);
      io.to(roomId).emit('game:table_missed', { targetId: p.id, drew: penalty });
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('game:drew', { drew: penalty, forced: true, skipTurn: false });
      // BUG-004 FIX: usar io.to() em vez de socket.to() — socket não existe neste escopo
      io.to(roomId).emit('game:opponent_drew', { playerId: p.id, count: 2, forced: true });
    });
    // Limpa estado da regra 9
    room.game.clearTable9();
    broadcastGameState(room, roomId);
  }, 10000));
}
const TURN_SECONDS = 30; // duração do turno
const AFK_WARN_STRIKES  = 3;  // indica AFK visualmente
const AFK_KICK_STRIKES  = 8;  // expulsa da partida

function resolveAfkTurn(room, roomId, playerId) {
  if (!room.game || room.game.gameOver) return;
  if (room.game.currentPlayer()?.id !== playerId) return;

  const r = room.game.autoPlayAfk(playerId);
  if (r.error) return;

  // Notifica AFK para todos
  io.to(roomId).emit('game:effect', { effect: 'timeout', playerId });

  // Atualiza o visual do afkStrikes para todos
  io.to(roomId).emit('game:update', r.state);

  // Se jogou uma carta, notifica
  if (r.playedCard) {
    io.to(roomId).emit('game:card_played', { playerId, card: r.playedCard, effect: r.effect });
    io.to(roomId).emit('game:effect', { effect: r.effect, card: r.playedCard, playerId });
  }

  // Se comprou carta(s), notifica os outros
  if (r.drew && r.drew.length > 0) {
    io.to(roomId).emit('game:opponent_drew', { playerId, count: r.drew.length, forced: r.forced || false });
  }

  if (r.gameOver) {
    clearTurnTimer(roomId);
    try {
      if (room.matchId) db.endMatch(room.matchId, {
        winnerId:   room.players.find(p => p.socketId === r.winner.id)?.playerId,
        winnerName: r.winner.name,
        rounds:     r.state.turnCount || 0,
      });
    } catch(e) {}
    io.to(roomId).emit('game:over', { winner: r.winner, state: r.state });
    return;
  }

  // Expulsão por AFK após 8 rounds sem jogar
  if ((r.afkStrikes || 0) >= AFK_KICK_STRIKES) {
    const kickedPlayer = room.players.find(p => p.socketId === playerId);
    if (kickedPlayer) {
      // Devolve cartas ao deck antes de remover
      const gp = room.game.players.find(p => p.id === playerId);
      if (gp) {
        room.game.deck.push(...gp.hand);
        room.game.deck = shuffle(room.game.deck);
        gp.hand = [];
      }
      io.to(roomId).emit('game:player_disconnected', { playerName: kickedPlayer.name, reason: 'afk' });
      const kickSock = io.sockets.sockets.get(playerId);
      if (kickSock) {
        kickSock.emit('room:left');
        kickSock.leave(roomId);
      }
      removePlayerFromRoom(kickedPlayer.playerId, playerId);
      return;
    }
  }

  broadcastGameState(room, roomId);
  startTurnTimer(room, roomId);
}

// Adicione também shuffle acessível no escopo do index.js — como o motor não exporta,
// use essa versão local:
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


function clearTurnTimer(roomId) {
  if (turnTimers.has(roomId)) {
    clearTimeout(turnTimers.get(roomId));
    turnTimers.delete(roomId);
  }
}

function startTurnTimer(room, roomId) {
  clearTurnTimer(roomId);
  if (!room.game?.rules?.turnTimer) return;
  if (room.game.gameOver) return;

  const currentId = room.game.currentPlayer()?.id;
  if (!currentId) return;

  // Guarda o turno atual para evitar que um timer atrasado
  // execute sobre um turno diferente
  const expectedTurn = room.game.turnCount;

  io.to(roomId).emit('game:turn_timer', { playerId: currentId, seconds: TURN_SECONDS });

  turnTimers.set(roomId, setTimeout(() => {
    if (!room.game || room.game.gameOver) return;
    // BUG-018 FIX: se o turno já avançou, este timer está obsoleto
    if (room.game.turnCount !== expectedTurn) return;
    if (room.game.currentPlayer()?.id !== currentId) return;

    resolveAfkTurn(room, roomId, currentId);
  }, TURN_SECONDS * 1000));
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomList() {
  const list = [];
  rooms.forEach((room, id) => {
    if (!room.game?.started && room.players.length < config.MAX_PLAYERS_PER_ROOM) {
      list.push({
        id,
        playerCount: room.players.length,
        maxPlayers:  config.MAX_PLAYERS_PER_ROOM,
        hostName:    room.players[0]?.name || '?',
      });
    }
  });
  return list;
}

function broadcastRoomList() {
  io.emit('room:list', getRoomList());
}

// ── FIX: helper centralizado para enviar estado do jogo ──
// Garante que TODOS os clientes recebem estado atualizado
// e cada jogador recebe SUA mão individual
function broadcastGameState(room, roomId) {
  if (!room?.game) return;
  const state = room.game.getState();
  io.to(roomId).emit('game:update', state);
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      const playerHand = room.game.getPlayerState(p.socketId).myHand;
      sock.emit('game:hand', playerHand);
      sock.emit('game:my_id', { mySocketId: p.socketId });
    }
  });
}

// ── FIX: remover jogador e ajustar índice de turno ───────
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

  if (room.players.length === 0) {
    rooms.delete(roomId);
    broadcastRoomList();
    return;
  }

  // Novo host é o primeiro da lista
  room.players[0].isHost = true;

  // ── Jogo em andamento ──────────────────────────────────
  if (room.game && room.game.started && !room.game.gameOver) {
    const gi = room.game.players.findIndex(p => p.id === leaving.socketId);
    if (gi !== -1) {
      // Ajusta índice ANTES de remover
      if (room.game.currentPlayerIndex === gi) {
        room.game.currentPlayerIndex = gi % Math.max(room.game.players.length - 1, 1);
      } else if (room.game.currentPlayerIndex > gi) {
        room.game.currentPlayerIndex--;
      }
      room.game.players.splice(gi, 1);
    }

    io.to(roomId).emit('game:player_disconnected', { playerName: leaving.name });

    if (room.game.players.length < 2) {
      const winner = room.game.players[0] || null;
      room.game.gameOver = true;
      room.game.winner   = winner;
      const state = room.game.getState();
      if (room.matchId && winner) {
        try {
          db.endMatch(room.matchId, {
            winnerId:   room.players.find(p => p.socketId === winner.id)?.playerId,
            winnerName: winner.name,
            rounds:     state.turnCount || 0,
          });
        } catch(e) {}
      }
      io.to(roomId).emit('game:over', { winner, reason: 'abandon', state });
      return;
    }

    // Garante índice válido após remoção
    if (room.game.currentPlayerIndex >= room.game.players.length) {
      room.game.currentPlayerIndex = 0;
    }

    broadcastGameState(room, roomId);
  } else {
    // Lobby
    io.to(roomId).emit('room:player_left', {
      playerId,
      playerName: leaving.name,
      players:    room.players,
      newHost:    room.players[0],
    });
  }

  broadcastRoomList();
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  // FIX: Lê o usuário da sessão compartilhada com Express
  const req      = socket.request;
  const authUser = req?.session?.passport?.user || req?.session?.guestUser || null;

  socket.emit('room:list', getRoomList());

  // ── Criar sala ───────────────────────────────────────
  socket.on('room:create', ({ playerName, playerAvatar, guestId }) => {
    // FIX: usa o ID do usuário autenticado OU o guestId enviado pelo cliente
    const playerId = authUser?.id || guestId;
    if (!playerId) return socket.emit('error', 'Sessão expirada. Faça login novamente.');

    // Remove de sala anterior se existir
    if (playerRoom.has(playerId)) removePlayerFromRoom(playerId, socket.id);

    const roomId = generateRoomId();
    const player = {
      playerId,
      id:       socket.id,
      socketId: socket.id,
      name:     authUser?.name || playerName || 'Jogador',
      avatar:   authUser?.avatar || playerAvatar || null,
      isHost:   true,
    };

    const defaultRules = { startCards:7, stackDraw2:false, stackDraw4:false, stackMix:false, rule7:false, rule0:false, rule9:false, drawUntilPlay:false, multiPlay:false, wild4NoRestriction:true, glowCards:true, turnTimer:true };
    rooms.set(roomId, { players: [player], game: null, chat: [], matchId: null, rules: defaultRules, background: null, backgroundVotes: {} });
    playerRoom.set(playerId, roomId);
    socketPlayer.set(socket.id, { playerId, roomId });

    socket.join(roomId);
    socket.emit('room:joined', { roomId, players: [player], isHost: true, you: player, rules: defaultRules, background: null, backgroundVotes: {} });
    broadcastRoomList();
  });

  // ── Entrar em sala ───────────────────────────────────
  socket.on('room:join', ({ roomId, playerName, playerAvatar, guestId }) => {
    const playerId = authUser?.id || guestId;
    if (!playerId) return socket.emit('error', 'Sessão expirada. Faça login novamente.');

    const room = rooms.get(roomId);
    if (!room)              return socket.emit('error', 'Sala não encontrada');
    if (room.game?.started) return socket.emit('error', 'Partida já iniciada');
    if (room.players.length >= config.MAX_PLAYERS_PER_ROOM)
                            return socket.emit('error', 'Sala cheia');

    // FIX: Reconexão na mesma sala — atualiza socketId sem duplicar
    if (playerRoom.has(playerId) && playerRoom.get(playerId) === roomId) {
      const existing = room.players.find(p => p.playerId === playerId);
      if (existing) {
        socketPlayer.delete(existing.socketId);
        existing.socketId = socket.id;
        existing.id       = socket.id;
        socketPlayer.set(socket.id, { playerId, roomId });
        socket.join(roomId);
        socket.emit('room:joined', {
          roomId,
          players:  room.players,
          isHost:   existing.isHost,
          you:      existing,
          rules:    room.rules || {},
          background: room.background || null,
          backgroundVotes: (() => { const v = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ v[k]=s.size; }); return v; })(),
        });
        return;
      }
    }

    // FIX: Garante que não vai duplicar — sai de sala anterior primeiro
    if (playerRoom.has(playerId)) removePlayerFromRoom(playerId, socket.id);

    // FIX: Verifica se já existe na sala (deduplicação extra)
    const alreadyIn = room.players.find(p => p.playerId === playerId);
    if (alreadyIn) {
      socketPlayer.delete(alreadyIn.socketId);
      alreadyIn.socketId = socket.id;
      alreadyIn.id       = socket.id;
      socketPlayer.set(socket.id, { playerId, roomId });
      playerRoom.set(playerId, roomId);
      socket.join(roomId);
      const bgVc2 = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ bgVc2[k]=s.size; });
      socket.emit('room:joined', {
        roomId,
        players: room.players,
        isHost:  alreadyIn.isHost,
        you:     alreadyIn,
        rules:   room.rules || {},
        background: room.background || null,
        backgroundVotes: bgVc2,
      });
      return;
    }

    const player = {
      playerId,
      id:       socket.id,
      socketId: socket.id,
      isHost:   false,
      name:     authUser?.name || playerName || 'Jogador',
      avatar:   authUser?.avatar || playerAvatar || null,
    };

    room.players.push(player);
    playerRoom.set(playerId, roomId);
    socketPlayer.set(socket.id, { playerId, roomId });

    socket.join(roomId);
    const bgVc3 = {}; Object.entries(room.backgroundVotes||{}).forEach(([k,s])=>{ bgVc3[k]=s.size; });
    socket.emit('room:joined', { roomId, players: room.players, isHost: false, you: player, rules: room.rules || {}, background: room.background||null, backgroundVotes: bgVc3 });
    socket.to(roomId).emit('room:player_joined', { players: room.players, newPlayer: player });
    broadcastRoomList();
  });

  // ── Sair da sala ────────────────────────────────────
  socket.on('room:leave', () => {
    const sp = socketPlayer.get(socket.id);
    if (sp) {
      socket.leave(sp.roomId);
      removePlayerFromRoom(sp.playerId, socket.id);
    }
    socket.emit('room:left');
  });

  // ── Atualizar regras da sala ─────────────────────────
  socket.on('room:update_rules', ({ rules }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room) return;
    if (room.players[0].socketId !== socket.id) return socket.emit('error', 'Apenas o host pode alterar regras');
    room.rules = { ...room.rules, ...rules };
    io.to(sp.roomId).emit('room:rules_updated', { rules: room.rules });
  });

  // ── Background da sala (host define, todos votam) ────
  socket.on('room:set_background', ({ url }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room) return;
    if (room.players[0].socketId !== socket.id) return socket.emit('error', 'Apenas o host pode definir');
    // url === null significa "padrão"
    room.background = url || null;
    io.to(sp.roomId).emit('room:background_set', { url: room.background });
  });

  socket.on('room:vote_background', ({ url }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room) return;
    if (!room.backgroundVotes) room.backgroundVotes = {};
    const key = url || 'default';
    // Remove voto anterior deste socket
    Object.keys(room.backgroundVotes).forEach(k => {
      if (room.backgroundVotes[k]) room.backgroundVotes[k].delete(socket.id);
    });
    if (!room.backgroundVotes[key]) room.backgroundVotes[key] = new Set();
    room.backgroundVotes[key].add(socket.id);
    // Converte Sets para contagens para broadcast
    const voteCounts = {};
    Object.entries(room.backgroundVotes).forEach(([k, s]) => { voteCounts[k] = s.size; });
    io.to(sp.roomId).emit('room:background_votes', { votes: voteCounts });
  });

  // ── Iniciar jogo ─────────────────────────────────────
  socket.on('game:start', ({ rules } = {}) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room) return socket.emit('error', 'Sala não encontrada');

    // Só o host pode iniciar
    if (room.players[0].socketId !== socket.id)
      return socket.emit('error', 'Apenas o host pode iniciar');
    if (room.players.length < config.MIN_PLAYERS_TO_START)
      return socket.emit('error', `Mínimo ${config.MIN_PLAYERS_TO_START} jogadores`);
    if (room.game?.started)
      return socket.emit('error', 'Partida já iniciada');

    // Cria jogadores para o motor usando o socketId como ID
    const gamePlayers = room.players.map(p => ({
      id:     p.socketId,
      name:   p.name,
      avatar: p.avatar,
    }));

    const game = new UnoGame(sp.roomId, gamePlayers, room.rules || rules || {});
    room.game = game;
    game.start();

    try {
      room.matchId = db.createMatch({
        roomId:  sp.roomId,
        players: room.players.map(p => ({ id: p.playerId, name: p.name, avatar: p.avatar })),
      }).id;
    } catch(e) {}

    // FIX: envia estado INDIVIDUAL para cada jogador (com a mão dele)
    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) {
        const playerState = game.getPlayerState(p.socketId);
        // mySocketId permite o cliente identificar quem é ele mesmo na lista de players
        sock.emit('game:started', { ...playerState, mySocketId: p.socketId });
      }
    });

    broadcastRoomList();
    // FIX 5: delay 700ms para o cliente processar game:started antes do timer
    setTimeout(() => startTurnTimer(room, sp.roomId), 700);
  });

  // ── Jogar carta ──────────────────────────────────────
  socket.on('game:play_card', ({ cardId, chosenColor }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');

    // FIX: Validação de turno no servidor — só quem é o jogador atual pode jogar
    if (room.game.currentPlayer()?.id !== socket.id)
      return socket.emit('error', 'Não é sua vez');

    const result = room.game.playCard(socket.id, cardId, chosenColor);
    if (result.error) return socket.emit('error', result.error);

    // Animação da carta voando para TODOS
    io.to(sp.roomId).emit('game:card_played', {
      playerId: socket.id,
      card:     result.played,
      effect:   result.effect,
    });

    // Efeito notificado para todos
    io.to(sp.roomId).emit('game:effect', {
      effect:      result.effect,
      card:        result.played,
      playerId:    socket.id,
      nextPlayer:  result.nextPlayer?.id,
      pendingDraw: result.pendingDraw,
    });

    if (result.gameOver) {
      try {
        if (room.matchId) {
          db.endMatch(room.matchId, {
            winnerId:   room.players.find(p => p.socketId === result.winner.id)?.playerId,
            winnerName: result.winner.name,
            rounds:     result.state.turnCount || 0,
          });
        }
      } catch(e) {}
      clearTurnTimer(sp.roomId);
      io.to(sp.roomId).emit('game:over', { winner: result.winner, state: result.state });
      return;
    }

    // FIX: helper centralizado garante estado correto para todos
    broadcastGameState(room, sp.roomId);
    // Não inicia timer de turno durante chain (pendingChain ativo)
    // nem durante efeitos instantâneos de compra
    var noTimerEffects = ['draw2_instant', 'wild4_instant', 'numeric_chain'];
    if (result.effect === 'numeric_chain') {
      // BUG-002 FIX: limpa timer anterior e inicia novo para a próxima carta do chain
      clearChainTimer(sp.roomId);
      startChainTimer(room, sp.roomId);
    } else if (result.effect === '9table') {
      // Regra do 9: inicia timer para todos baterem na mesa
      startTable9Timer(room, sp.roomId);
    } else {
      clearChainTimer(sp.roomId);
      if (!noTimerEffects.includes(result.effect)) {
        startTurnTimer(room, sp.roomId);
      }
    }
  });

  // ── Comprar carta ────────────────────────────────────
  socket.on('game:draw_card', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');

    // FIX: validação de turno no servidor
    if (room.game.currentPlayer()?.id !== socket.id)
      return socket.emit('error', 'Não é sua vez');

    const result = room.game.drawCard(socket.id);
    if (result.error) return socket.emit('error', result.error);

    // Notifica o jogador sobre as cartas que comprou
// Notifica o jogador sobre as cartas que comprou
// Notifica o jogador sobre as cartas que comprou
    socket.emit('game:drew', {
      drew:     result.drew,
      canPlay:  result.canPlay,
      forced:   result.forced,
      skipTurn: result.skipTurn || false,
    });

    // Notifica os OUTROS jogadores com animação de compra
    socket.to(sp.roomId).emit('game:opponent_drew', {
      playerId: socket.id,
      count:    result.drew?.length || 0,
      forced:   result.forced || false,
    });

    broadcastGameState(room, sp.roomId);
    if (result.skipTurn || result.forced) startTurnTimer(room, sp.roomId);
  });

  // ── Pular vez (após comprar sem querer jogar) ─────────
  socket.on('game:skip_turn', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    if (room.game.currentPlayer()?.id !== socket.id)
      return socket.emit('error', 'Não é sua vez');
    const r = room.game.skipTurn(socket.id);
    if (r.error) return socket.emit('error', r.error);
    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── Encerrar cadeia MultiPlay (jogador passou) ───────
  socket.on('game:end_chain', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    if (room.game.currentPlayer()?.id !== socket.id)
      return socket.emit('error', 'Não é sua vez');
    clearChainTimer(sp.roomId);
    const r = room.game.endChain(socket.id);
    if (r.error) return socket.emit('error', r.error);
    broadcastGameState(room, sp.roomId);
    startTurnTimer(room, sp.roomId);
  });

  // ── UNO ──────────────────────────────────────────────
  socket.on('game:uno', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.sayUno(socket.id);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:uno_called', { playerId: socket.id });
    // Atualiza o estado para todos verem o badge UNO
    broadcastGameState(room, sp.roomId);
  });

  // ── Violação UNO ─────────────────────────────────────
  socket.on('game:call_uno_violation', ({ targetId }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.callUnoViolation(socket.id, targetId);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:uno_violation', {
      callerId: socket.id,
      targetId,
      drew:     r.drew,
    });
    broadcastGameState(room, sp.roomId);
  });

  // ── Trocar de mão (regra 7) ──────────────────────────
  socket.on('game:swap', ({ targetId }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.executeSwap(socket.id, targetId);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:swapped', { initiatorId: socket.id, targetId, state: r.state });
    broadcastGameState(room, sp.roomId);
  });

  socket.on('game:decline_swap', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.declineSwap(socket.id);
    if (r.error) return socket.emit('error', r.error);
    io.to(sp.roomId).emit('game:swap_declined', { initiatorId: socket.id });
    broadcastGameState(room, sp.roomId);
  });

  // ── Bater na mesa (regra 9) ──────────────────────────
  socket.on('game:hit_table', () => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.hitTable(socket.id);
    if (r.error) return socket.emit('error', r.error);
    if (r.alreadyHit) return;
    io.to(sp.roomId).emit('game:table_hit', { playerId: socket.id, allHit: r.allHit });
    if (r.allHit) {
      clearTable9Timer(sp.roomId);
      // BUG-005 FIX: notificar penalidade do último a bater
      if (r.lastPlayerId && r.penalty && r.penalty.length > 0) {
        io.to(sp.roomId).emit('game:table_last_penalized', { playerId: r.lastPlayerId, drew: r.penalty });
        const penalizedSock = io.sockets.sockets.get(r.lastPlayerId);
        if (penalizedSock) penalizedSock.emit('game:drew', { drew: r.penalty, forced: true, skipTurn: false });
        io.to(sp.roomId).emit('game:opponent_drew', { playerId: r.lastPlayerId, count: r.penalty.length, forced: true });
      }
      io.to(sp.roomId).emit('game:table_all_hit', {});
    }
    broadcastGameState(room, sp.roomId);
  });
  // ── Penalidade: não bateu na mesa ────────────────────
socket.on('game:missed_table', ({ targetId }) => {
    // Mantido como fallback — penalidade agora é gerenciada pelo startTable9Timer
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room?.game) return;
    const r = room.game.applyMissedTable(targetId || socket.id);
    if (r.error || r.alreadyClear || r.alreadyHit) return;
    io.to(sp.roomId).emit('game:table_missed', { targetId: targetId || socket.id, drew: r.drew });
    broadcastGameState(room, sp.roomId);
  });

  // ── Jogar múltiplas cartas ───────────────────────────
  socket.on('game:play_multiple', ({ cardIds }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return socket.emit('error', 'Você não está em uma sala');
    const room = rooms.get(sp.roomId);
    if (!room?.game) return socket.emit('error', 'Jogo não encontrado');
    if (room.game.currentPlayer()?.id !== socket.id) return socket.emit('error', 'Não é sua vez');
    const result = room.game.playMultiple(socket.id, cardIds);
    if (result.error) return socket.emit('error', result.error);

    io.to(sp.roomId).emit('game:cards_played_multi', {
      playerId: socket.id,
      cards:    result.played,
      effect:   result.effect,
    });
    io.to(sp.roomId).emit('game:effect', {
      effect:     result.effect,
      cards:      result.played,
      playerId:   socket.id,
    });
    // Inicia timer da regra 9 se necessário
    if (result.pendingTable9 || (result.effect === '9table')) {
      startTable9Timer(room, sp.roomId);
    }
    if (result.gameOver) {
      try {
        if (room.matchId) db.endMatch(room.matchId, {
          winnerId:   room.players.find(p => p.socketId === result.winner.id)?.playerId,
          winnerName: result.winner.name,
          rounds:     result.state.turnCount || 0,
        });
      } catch(e) {}
      io.to(sp.roomId).emit('game:over', { winner: result.winner, state: result.state });
      return;
    }
    broadcastGameState(room, sp.roomId);
  });

  // ── Rejoin: game.html conecta com novo socket após redirect ─────────────
  // O cliente envia playerId para o servidor localizar o jogador na sala
  // e registrar o novo socketId, permitindo jogar normalmente
  socket.on('game:rejoin', ({ roomId: rId, playerId, playerName, playerAvatar }) => {
    if (!rId || !playerId) return;
    const room = rooms.get(rId);
    if (!room) return socket.emit('error', 'Sala não encontrada');
    if (!room.game || !room.game.started) return socket.emit('error', 'Jogo não iniciado');

    // Localiza o jogador na sala pelo playerId persistente
    let player = room.players.find(p => p.playerId === playerId);

    if (!player) {
      // Jogador não está na sala — pode ter sido removido por desconexão
      // Reinsere se o jogo ainda tiver o jogador no motor
      const gamePlayer = room.game.players.find(p => p.name === playerName);
      if (!gamePlayer) return socket.emit('error', 'Jogador não encontrado na partida');

      // Recria entrada na sala
      player = {
        playerId,
        id:       socket.id,
        socketId: socket.id,
        name:     playerName || gamePlayer.name,
        avatar:   playerAvatar || gamePlayer.avatar || null,
        isHost:   room.players.length === 0,
      };
      room.players.push(player);
    }

    // Atualiza o socketId para o novo socket (após redirect)
    const oldSocketId = player.socketId;
    socketPlayer.delete(oldSocketId);
    player.socketId = socket.id;
    player.id       = socket.id;
    socketPlayer.set(socket.id, { playerId, roomId: rId });
    playerRoom.set(playerId, rId);

    // Atualiza o ID no motor de jogo também
    const gamePlayer = room.game.players.find(p => p.id === oldSocketId);
    if (gamePlayer) {
      gamePlayer.id = socket.id;
    }
    // BUG-004 FIX: atualizar playerOrder com o novo socketId
    // Sem isso, getState() retorna o oldSocketId no playerOrder e o cliente
    // não acha mySocketId na lista, causando renderização errada dos oponentes
    if (room.game.playerOrder) {
      const orderIdx = room.game.playerOrder.indexOf(oldSocketId);
      if (orderIdx !== -1) room.game.playerOrder[orderIdx] = socket.id;
    }

    socket.join(rId);

    // Cancela o timer de remocao (reconexao bem-sucedida)
    if (player.reconnectTimer) {
      clearTimeout(player.reconnectTimer);
      player.reconnectTimer = null;
    }
    player.reconnecting = false;

    // 1) Envia estado individual primeiro (define mySocketId no cliente)
    const playerState = room.game.getPlayerState(socket.id);
    socket.emit('game:started', { ...playerState, mySocketId: socket.id });

    // 2) Depois atualiza todos os outros (IDs ja estao corretos no motor)
    socket.to(rId).emit('game:update', room.game.getState());
    // Envia maos individuais para os outros jogadores
    room.players.forEach(p => {
      if (p.socketId === socket.id) return; // ja recebeu game:started
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) {
        const hand = room.game.getPlayerState(p.socketId).myHand;
        sock.emit('game:hand', hand);
        sock.emit('game:my_id', { mySocketId: p.socketId });
      }
    });

    console.log('[rejoin] ' + playerName + ' (' + playerId + ') reconectou como ' + socket.id);
  });

  // ── Chat ─────────────────────────────────────────────
  socket.on('chat:message', ({ text }) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    const room = rooms.get(sp.roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    const msg = {
      from:   player?.name || 'Anônimo',
      avatar: player?.avatar || null,
      text:   String(text).substring(0, 200),
      time:   Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift(); // Limita histórico
    io.to(sp.roomId).emit('chat:message', msg);
  });

  // ── Desconexão ───────────────────────────────────────
  // IMPORTANTE: durante jogo ativo, nao remove imediatamente.
  // O jogador pode estar fazendo redirect lobby→game (novo socket).
  // Aguarda 8s para reconexao via game:rejoin antes de remover.
  socket.on('disconnect', (reason) => {
    const sp = socketPlayer.get(socket.id);
    if (!sp) return;
    console.log('[socket] disconnect: ' + socket.id + ' (' + reason + ') — player ' + sp.playerId);

    const room = rooms.get(sp.roomId);

    if (room && room.game && room.game.started && !room.game.gameOver) {
      socketPlayer.delete(socket.id);
      const player = room.players.find(p => p.playerId === sp.playerId);
      if (player) {
        player.reconnecting = true;
        if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
        player.reconnectTimer = setTimeout(() => {
          if (player.reconnecting) {
            console.log('[socket] timeout reconexao: ' + sp.playerId);
            removePlayerFromRoom(sp.playerId, socket.id);
          }
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