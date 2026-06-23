const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 25000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();

const MODES = {
  pvp1v1: { label: '1v1 Spieler gegen Spieler', maxHumans: 2, minHumans: 2, bots: 0 },
  bots2v2: { label: '2v2 Menschen vs 2 gute Bots', maxHumans: 2, minHumans: 1, bots: 2 },
  bots3v3: { label: '3v3 Menschen vs 3 gute Bots', maxHumans: 3, minHumans: 1, bots: 3 },
  bots4v4: { label: '4v4 Menschen vs 4 gute Bots', maxHumans: 4, minHumans: 1, bots: 4 }
};

const DEFAULT_SETTINGS = {
  visibility: 'public',
  botDifficulty: 'pro',
  matchTime: 300,
  maxGoals: 0,
  boostMode: 'normal',
  replayEnabled: true
};

app.use(express.static(PUBLIC_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, now: Date.now() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value, fallback = 'Spieler') {
  return String(value || fallback)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16) || fallback;
}

function cleanCode(value) {
  return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
}

function cleanToken(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
}

function getMode(mode) {
  return MODES[mode] ? mode : 'pvp1v1';
}

function cleanSettings(value = {}) {
  const matchTime = Number(value.matchTime);
  const maxGoals = Number(value.maxGoals);
  return {
    visibility: value.visibility === 'private' ? 'private' : 'public',
    botDifficulty: ['easy', 'normal', 'hard', 'pro'].includes(value.botDifficulty) ? value.botDifficulty : DEFAULT_SETTINGS.botDifficulty,
    matchTime: [180, 300, 420, 600].includes(matchTime) ? matchTime : DEFAULT_SETTINGS.matchTime,
    maxGoals: [0, 3, 5, 10].includes(maxGoals) ? maxGoals : DEFAULT_SETTINGS.maxGoals,
    boostMode: ['normal', 'fast', 'unlimited'].includes(value.boostMode) ? value.boostMode : DEFAULT_SETTINGS.boostMode,
    replayEnabled: value.replayEnabled === false ? false : true
  };
}

function getRoom(code) {
  return rooms.get(cleanCode(code));
}

function activePlayers(room) {
  return room.players.filter(p => p.role !== 'spectator');
}

function connectedPlayers(room) {
  return room.players.filter(p => p.connected !== false);
}

function socketByToken(token) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.playerToken === token) return socket;
  }
  return null;
}

function playerPublic(player) {
  return {
    id: player.token,
    name: player.name,
    ready: !!player.ready,
    isHost: !!player.isHost,
    connected: !!player.connected,
    team: player.team || 'blue',
    role: player.role || 'player',
    ping: Number(player.ping) || 0
  };
}

function roomState(room) {
  const modeInfo = MODES[room.mode];
  const playerCount = activePlayers(room).length;
  return {
    code: room.code,
    mode: room.mode,
    modeLabel: modeInfo.label,
    status: room.status,
    hostId: room.hostId,
    players: room.players.map(playerPublic),
    maxHumans: modeInfo.maxHumans,
    minHumans: modeInfo.minHumans,
    botCount: modeInfo.bots,
    playerCount,
    settings: room.settings,
    chat: room.chat.slice(-20),
    createdAt: room.createdAt,
    startedAt: room.startedAt || null
  };
}

function roomListPayload() {
  return [...rooms.values()]
    .filter(room => room.status === 'lobby' && room.settings.visibility !== 'private')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map(room => {
      const modeInfo = MODES[room.mode];
      const players = activePlayers(room);
      return {
        code: room.code,
        mode: room.mode,
        modeLabel: modeInfo.label,
        hostName: room.players.find(p => p.token === room.hostId)?.name || 'Host',
        players: players.length,
        spectators: room.players.filter(p => p.role === 'spectator').length,
        maxHumans: modeInfo.maxHumans,
        ready: players.filter(p => p.ready).length,
        botDifficulty: room.settings.botDifficulty,
        matchTime: room.settings.matchTime,
        maxGoals: room.settings.maxGoals,
        updatedAt: room.updatedAt
      };
    });
}

function broadcastRoomList() {
  io.emit('rooms_list', roomListPayload());
}

function emitRoom(room) {
  io.to(room.code).emit('room_state', roomState(room));
  broadcastRoomList();
}

function getCurrentRoomForSocket(socket) {
  const token = socket.data.playerToken;
  if (!token) return null;
  for (const room of rooms.values()) {
    if (room.players.some(p => p.token === token)) return room;
  }
  return null;
}

function hardRemovePlayerFromRoom(room, token) {
  const idx = room.players.findIndex(p => p.token === token);
  if (idx === -1) return;
  const wasHost = room.players[idx].isHost;
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    broadcastRoomList();
    return;
  }
  if (wasHost) promoteHost(room);
  room.updatedAt = Date.now();
  emitRoom(room);
}

function removePlayer(socket) {
  const token = socket.data.playerToken;
  if (!token) return;
  const room = getCurrentRoomForSocket(socket);
  if (!room) return;
  socket.leave(room.code);
  hardRemovePlayerFromRoom(room, token);
}

function promoteHost(room) {
  const next = room.players.find(p => p.connected) || room.players[0];
  if (!next) return;
  room.players.forEach(p => { p.isHost = false; p.ready = false; });
  next.isHost = true;
  room.hostId = next.token;
  const hostSocket = socketByToken(next.token);
  if (hostSocket) hostSocket.emit('you_are_host');
}

function softDisconnect(socket) {
  const token = socket.data.playerToken;
  if (!token) return;
  const room = getCurrentRoomForSocket(socket);
  if (!room) return;
  const player = room.players.find(p => p.token === token);
  if (!player) return;
  player.connected = false;
  player.ready = false;
  player.socketId = null;
  player.disconnectedAt = Date.now();
  room.updatedAt = Date.now();
  socket.leave(room.code);
  emitRoom(room);
}

function normalizeTeams(room) {
  if (room.mode === 'pvp1v1') {
    const players = activePlayers(room);
    if (players.length === 1 && !players[0].team) players[0].team = 'blue';
    if (players.length >= 2) {
      const blueCount = players.filter(p => p.team === 'blue').length;
      const orangeCount = players.filter(p => p.team === 'orange').length;
      if (blueCount === 0) players[0].team = 'blue';
      if (orangeCount === 0) players.find(p => p.team !== 'blue').team = 'orange';
    }
  } else {
    for (const p of activePlayers(room)) p.team = 'blue';
  }
}

function canStart(room) {
  const info = MODES[room.mode];
  const players = activePlayers(room).filter(p => p.connected);
  if (players.length < info.minHumans) return { ok: false, message: `Es fehlen noch ${info.minHumans - players.length} Spieler.` };
  if (players.length > info.maxHumans) return { ok: false, message: `Zu viele Spieler für diesen Modus.` };
  if (room.mode === 'pvp1v1') {
    if (!players.some(p => p.team === 'blue') || !players.some(p => p.team === 'orange')) {
      return { ok: false, message: 'Für 1v1 muss ein Spieler Blau und einer Orange sein.' };
    }
  }
  const notReady = players.filter(p => !p.ready);
  if (notReady.length) return { ok: false, message: `Noch nicht ready: ${notReady.map(p => p.name).join(', ')}` };
  return { ok: true, message: 'Alle sind ready.' };
}

function joinExistingOrAdd(socket, room, name, role = 'player') {
  const token = socket.data.playerToken;
  let player = room.players.find(p => p.token === token);
  if (player) {
    player.name = cleanName(name, player.name);
    player.connected = true;
    player.socketId = socket.id;
    player.disconnectedAt = null;
    player.ready = false;
  } else {
    const info = MODES[room.mode];
    const humans = activePlayers(room).length;
    const safeRole = role === 'spectator' ? 'spectator' : 'player';
    if (safeRole === 'player' && humans >= info.maxHumans) {
      socket.emit('room_error', { message: 'Raum ist voll. Du kannst als Zuschauer beitreten.' });
      return false;
    }
    player = {
      token,
      socketId: socket.id,
      name: cleanName(name, 'Spieler'),
      ready: false,
      isHost: false,
      connected: true,
      team: room.mode === 'pvp1v1' && humans === 1 ? 'orange' : 'blue',
      role: safeRole,
      ping: 0,
      joinedAt: Date.now()
    };
    room.players.push(player);
  }
  socket.join(room.code);
  socket.data.roomCode = room.code;
  normalizeTeams(room);
  return true;
}

function emitChat(room, player, text, system = false) {
  const msg = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: system ? 'System' : cleanName(player?.name, 'Spieler'),
    text: String(text || '').replace(/[<>]/g, '').trim().slice(0, 180),
    system: !!system,
    at: Date.now()
  };
  if (!msg.text) return;
  room.chat.push(msg);
  room.chat = room.chat.slice(-30);
  io.to(room.code).emit('chat_message', msg);
}

io.on('connection', socket => {
  socket.emit('server_hello', { id: socket.id, modes: MODES, defaults: DEFAULT_SETTINGS });
  socket.emit('rooms_list', roomListPayload());

  socket.on('identify', ({ token, name } = {}) => {
    let clean = cleanToken(token);
    if (!clean) clean = `${socket.id}-${Math.random().toString(36).slice(2, 10)}`;
    socket.data.playerToken = clean;
    socket.data.name = cleanName(name, 'Spieler');
    socket.emit('player_identified', { playerId: clean, name: socket.data.name });

    // Reconnect in den alten Raum.
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.token === clean);
      if (!player) continue;
      player.socketId = socket.id;
      player.connected = true;
      player.disconnectedAt = null;
      player.name = socket.data.name || player.name;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.emit('room_joined', roomState(room));
      emitChat(room, player, `${player.name} ist wieder verbunden.`, true);
      emitRoom(room);
      break;
    }
  });

  socket.on('list_rooms', () => socket.emit('rooms_list', roomListPayload()));

  socket.on('create_room', ({ name, mode, settings } = {}) => {
    if (!socket.data.playerToken) return socket.emit('room_error', { message: 'Bitte zuerst Namen speichern.' });
    removePlayer(socket);
    const selectedMode = getMode(mode);
    const code = makeRoomCode();
    const room = {
      code,
      mode: selectedMode,
      status: 'lobby',
      hostId: socket.data.playerToken,
      players: [{
        token: socket.data.playerToken,
        socketId: socket.id,
        name: cleanName(name, socket.data.name || 'Host'),
        ready: false,
        isHost: true,
        connected: true,
        team: 'blue',
        role: 'player',
        ping: 0,
        joinedAt: Date.now()
      }],
      settings: cleanSettings({ ...DEFAULT_SETTINGS, ...(settings || {}) }),
      chat: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    emitChat(room, room.players[0], `${room.players[0].name} hat den Raum erstellt.`, true);
    socket.emit('room_created', roomState(room));
    emitRoom(room);
  });

  socket.on('join_room', ({ roomCode, name, role } = {}) => {
    if (!socket.data.playerToken) return socket.emit('room_error', { message: 'Bitte zuerst Namen speichern.' });
    const code = cleanCode(roomCode);
    const room = getRoom(code);
    if (!room) return socket.emit('room_error', { message: 'Raum nicht gefunden.' });
    if (room.status !== 'lobby') {
      // Zuschauer dürfen auch in laufende Spiele.
      if (role !== 'spectator') return socket.emit('room_error', { message: 'Dieses Spiel läuft schon. Du kannst nur zuschauen.' });
    }
    removePlayer(socket);
    const ok = joinExistingOrAdd(socket, room, name || socket.data.name, role);
    if (!ok) return;
    room.updatedAt = Date.now();
    const player = room.players.find(p => p.token === socket.data.playerToken);
    emitChat(room, player, `${player.name} ist beigetreten.`, true);
    socket.emit('room_joined', roomState(room));
    emitRoom(room);
  });

  socket.on('leave_room', () => removePlayer(socket));

  socket.on('set_mode', ({ mode } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    const selectedMode = getMode(mode);
    const info = MODES[selectedMode];
    if (activePlayers(room).length > info.maxHumans) {
      return socket.emit('room_error', { message: `Für diesen Modus sind nur ${info.maxHumans} Spieler erlaubt.` });
    }
    room.mode = selectedMode;
    normalizeTeams(room);
    room.players.forEach(p => { p.ready = false; });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('set_settings', ({ settings } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    room.settings = cleanSettings({ ...room.settings, ...(settings || {}) });
    room.players.forEach(p => { p.ready = false; });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('set_team', ({ team, role } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    if (!player) return;
    player.ready = false;
    player.role = role === 'spectator' ? 'spectator' : 'player';
    player.team = team === 'orange' ? 'orange' : 'blue';
    if (room.mode !== 'pvp1v1' && player.role === 'player') player.team = 'blue';
    normalizeTeams(room);
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('set_ready', ({ ready } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    if (!player || player.role === 'spectator') return;
    player.ready = !!ready;
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    const result = canStart(room);
    if (!result.ok) return socket.emit('room_error', { message: result.message });
    room.status = 'playing';
    room.startedAt = Date.now();
    room.updatedAt = Date.now();
    io.to(room.code).emit('game_start', roomState(room));
    broadcastRoomList();
  });

  socket.on('back_to_lobby', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken) return;
    room.status = 'lobby';
    room.startedAt = null;
    room.players.forEach(p => { p.ready = false; });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('player_input', ({ input, seq, clientTime } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const host = room.players.find(p => p.token === room.hostId && p.connected);
    const hostSocket = host ? socketByToken(host.token) : null;
    if (!hostSocket) return;
    hostSocket.emit('player_input', {
      playerId: socket.data.playerToken,
      input: {
        up: !!input?.up,
        down: !!input?.down,
        left: !!input?.left,
        right: !!input?.right,
        boost: !!input?.boost
      },
      seq: Number(seq) || 0,
      clientTime: Number(clientTime) || 0
    });
  });

  socket.on('host_snapshot', ({ snapshot } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.hostId !== socket.data.playerToken) return;
    socket.to(room.code).volatile.emit('host_snapshot', snapshot);
  });

  socket.on('chat_send', ({ text } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    emitChat(room, player, text, false);
  });

  socket.on('quick_chat', ({ text } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    emitChat(room, player, text, false);
  });

  socket.on('ping_check', ({ sent } = {}) => {
    socket.emit('pong_check', { sent, now: Date.now() });
    const room = getRoom(socket.data.roomCode);
    if (room) {
      const p = room.players.find(x => x.token === socket.data.playerToken);
      if (p && Number(sent)) p.ping = Math.max(0, Math.min(999, Date.now() - Number(sent)));
      emitRoom(room);
    }
  });

  socket.on('disconnect', () => softDisconnect(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    room.players = room.players.filter(p => p.connected || now - (p.disconnectedAt || now) < 1000 * 60 * 3);
    if (room.players.length === 0 || now - room.updatedAt > 1000 * 60 * 120) {
      rooms.delete(code);
      continue;
    }
    if (!room.players.some(p => p.token === room.hostId)) promoteHost(room);
    if (room.status === 'lobby') normalizeTeams(room);
  }
  broadcastRoomList();
}, 30_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rocket League 2D Pro Online V7 läuft auf Port ${PORT}`);
});
