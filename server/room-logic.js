// ============================================================
//  ROOM LOGIC — Gerenciamento de salas, host e saída durante jogo
//  Cole este trecho no seu server.js onde ficam os eventos Socket.IO
//  (dentro de io.on('connection', socket => { ... }))
// ============================================================

// Estrutura esperada para cada sala em `rooms` (Map):
// rooms.get(roomId) = {
//   id, hostId, players: [{id, name, avatar, socketId}],
//   game: UnoGame | null,
//   started: boolean
// }

// ── HELPER: transferir host ─────────────────────────────────
function transferHost(room) {
  if (!room.players.length) return null;
  room.hostId = room.players[0].id;
  return room.players[0];
}

// ── HELPER: broadcast estado da sala ───────────────────────
function broadcastRoomUpdate(io, room) {
  const playersPayload = room.players.map(p => ({
    ...p,
    isHost: p.id === room.hostId,
  }));
  room.players.forEach(p => {
    io.to(p.socketId).emit('room:player_left', {
      players: playersPayload,
      newHost: room.players.find(x => x.id === room.hostId) || null,
    });
  });
}

// ── HELPER: retornar ao lobby após jogo ────────────────────
function returnToLobby(io, room) {
  room.started = false;
  room.game    = null;
  const playersPayload = room.players.map(p => ({
    ...p,
    isHost: p.id === room.hostId,
  }));
  room.players.forEach(p => {
    io.to(p.socketId).emit('game:returned_to_lobby', {
      roomId:  room.id,
      players: playersPayload,
      isHost:  p.id === room.hostId,
    });
  });
}

// ── EVENTO: sair da sala / partida ─────────────────────────
//
// Cole dentro do seu io.on('connection', socket => { ... }):
//
//   socket.on('room:leave', () => handleLeave(socket));
//   socket.on('disconnect',  () => handleLeave(socket));

function handleLeave(socket, io, rooms, socketToRoom) {
  const roomId = socketToRoom.get(socket.id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) { socketToRoom.delete(socket.id); return; }

  // Remover jogador
  const leavingIdx  = room.players.findIndex(p => p.socketId === socket.id);
  const leavingName = leavingIdx >= 0 ? room.players[leavingIdx].name : 'Alguém';
  if (leavingIdx >= 0) room.players.splice(leavingIdx, 1);
  socketToRoom.delete(socket.id);
  socket.leave(roomId);

  // Se não sobrou ninguém → apagar sala
  if (room.players.length === 0) {
    rooms.delete(roomId);
    // Atualizar lista pública de salas
    broadcastRoomList(io, rooms);
    return;
  }

  // Se era o host → passar para o próximo
  const wasHost = room.hostId === socket.id ||
                  !room.players.find(p => p.id === room.hostId);
  if (wasHost) transferHost(room);

  // ── Partida em andamento ────────────────────────────────
  if (room.started && room.game) {
    // Remover o jogador do motor de jogo
    const gamePlayerIdx = room.game.players.findIndex(p => p.id === socket.id);
    if (gamePlayerIdx >= 0) room.game.players.splice(gamePlayerIdx, 1);

    // Notificar os que ficaram
    io.to(roomId).emit('game:player_disconnected', { playerName: leavingName });

    // Se ficou só 1 jogador → ele venceu por WO
    if (room.game.players.length < 2) {
      const winner = room.game.players[0] || null;
      io.to(roomId).emit('game:over', {
        winner,
        reason: 'abandon',
        state:  room.game?.getState?.() || {},
      });
      // Dar um tempo e retornar ao lobby
      setTimeout(() => {
        if (rooms.has(roomId)) returnToLobby(io, room);
      }, 4000);
      return;
    }

    // Ajustar índice do jogador atual se necessário
    if (room.game.currentPlayerIndex >= room.game.players.length) {
      room.game.currentPlayerIndex = 0;
    }

    // Transmitir estado atualizado
    room.game.players.forEach(p => {
      const pSocket = room.players.find(r => r.id === p.id);
      if (pSocket) {
        io.to(pSocket.socketId).emit('game:update', room.game.getPlayerState(p.id));
      }
    });
    return;
  }

  // ── No lobby (aguardando) ───────────────────────────────
  broadcastRoomUpdate(io, room);
  broadcastRoomList(io, rooms);
}

// ── HELPER: lista pública de salas ─────────────────────────
function broadcastRoomList(io, rooms) {
  const list = [];
  rooms.forEach(r => {
    if (!r.started) {
      const host = r.players.find(p => p.id === r.hostId);
      list.push({
        id:          r.id,
        hostName:    host?.name || '?',
        playerCount: r.players.length,
        maxPlayers:  10,
      });
    }
  });
  io.emit('room:list', list);
}

module.exports = { handleLeave, transferHost, returnToLobby, broadcastRoomList };
