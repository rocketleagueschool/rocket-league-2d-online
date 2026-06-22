const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
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

function getMode(mode) {
  return MODES[mode] ? mode : 'pvp1v1';
}

function getRoom(code) {
  return rooms.get(cleanCode(code));
}

function playerPublic(player) {
  return {
    id: player.id,
    name: player.name,
    ready: !!player.ready,
    isHost: !!player.isHost,
    connected: true
  };
}

function roomState(room) {
  const modeInfo = MODES[room.mode];
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
    createdAt: room.createdAt,
    startedAt: room.startedAt || null
  };
}

function roomListPayload() {
  return [...rooms.values()]
    .filter(room => room.status === 'lobby')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map(room => {
      const modeInfo = MODES[room.mode];
      return {
        code: room.code,
        mode: room.mode,
        modeLabel: modeInfo.label,
        hostName: room.players.find(p => p.id === room.hostId)?.name || 'Host',
        players: room.players.length,
        maxHumans: modeInfo.maxHumans,
        ready: room.players.filter(p => p.ready).length,
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

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = getRoom(code);
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx === -1) return;
  const wasHost = room.players[idx].isHost;
  room.players.splice(idx, 1);
  socket.leave(room.code);
  socket.data.roomCode = null;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    broadcastRoomList();
    return;
  }

  if (wasHost) {
    if (room.status === 'playing') {
      io.to(room.code).emit('room_closed', { message: 'Host ist gegangen. Das Spiel wurde beendet.' });
      for (const p of room.players) {
        const s = io.sockets.sockets.get(p.id);
        if (s) {
          s.leave(room.code);
          s.data.roomCode = null;
        }
      }
      rooms.delete(room.code);
      broadcastRoomList();
      return;
    }

    room.players[0].isHost = true;
    room.hostId = room.players[0].id;
    room.players.forEach(p => { p.ready = false; });
    io.to(room.hostId).emit('you_are_host');
  }

  room.updatedAt = Date.now();
  emitRoom(room);
}

function allReady(room) {
  return room.players.length >= MODES[room.mode].minHumans && room.players.every(p => p.ready);
}

io.on('connection', socket => {
  socket.emit('server_hello', { id: socket.id, modes: MODES });
  socket.emit('rooms_list', roomListPayload());

  socket.on('list_rooms', () => socket.emit('rooms_list', roomListPayload()));

  socket.on('create_room', ({ name, mode } = {}) => {
    removePlayer(socket);

    const selectedMode = getMode(mode);
    const code = makeRoomCode();
    const room = {
      code,
      mode: selectedMode,
      status: 'lobby',
      hostId: socket.id,
      players: [{ id: socket.id, name: cleanName(name, 'Host'), ready: false, isHost: true }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', roomState(room));
    emitRoom(room);
  });

  socket.on('join_room', ({ roomCode, name } = {}) => {
    const code = cleanCode(roomCode);
    const room = getRoom(code);
    if (!room) return socket.emit('room_error', { message: 'Raum nicht gefunden.' });
    if (room.status !== 'lobby') return socket.emit('room_error', { message: 'Dieses Spiel läuft schon.' });

    const modeInfo = MODES[room.mode];
    if (room.players.length >= modeInfo.maxHumans) {
      return socket.emit('room_error', { message: 'Raum ist voll.' });
    }
    if (room.players.some(p => p.id === socket.id)) {
      return socket.emit('room_joined', roomState(room));
    }

    removePlayer(socket);
    room.players.push({ id: socket.id, name: cleanName(name, 'Spieler'), ready: false, isHost: false });
    room.updatedAt = Date.now();
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', roomState(room));
    emitRoom(room);
  });

  socket.on('leave_room', () => removePlayer(socket));

  socket.on('set_mode', ({ mode } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    const selectedMode = getMode(mode);
    const modeInfo = MODES[selectedMode];
    if (room.players.length > modeInfo.maxHumans) {
      return socket.emit('room_error', { message: `Für diesen Modus sind nur ${modeInfo.maxHumans} Spieler erlaubt.` });
    }
    room.mode = selectedMode;
    room.players.forEach(p => { p.ready = false; });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('set_ready', ({ ready } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = !!ready;
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (!allReady(room)) {
      return socket.emit('room_error', { message: 'Alle Spieler müssen zuerst bereit sein.' });
    }
    room.status = 'playing';
    room.startedAt = Date.now();
    room.updatedAt = Date.now();
    const state = roomState(room);
    io.to(room.code).emit('game_start', state);
    broadcastRoomList();
  });

  socket.on('back_to_lobby', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.status = 'lobby';
    room.startedAt = null;
    room.players.forEach(p => { p.ready = false; });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on('player_input', ({ input } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    io.to(room.hostId).emit('player_input', {
      playerId: socket.id,
      input: {
        up: !!input?.up,
        down: !!input?.down,
        left: !!input?.left,
        right: !!input?.right,
        boost: !!input?.boost
      }
    });
  });

  socket.on('host_snapshot', ({ snapshot } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.hostId !== socket.id) return;
    socket.to(room.code).volatile.emit('host_snapshot', snapshot);
  });

  socket.on('disconnect', () => removePlayer(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const livePlayers = room.players.filter(p => io.sockets.sockets.has(p.id));
    if (livePlayers.length === 0 || now - room.updatedAt > 1000 * 60 * 90) {
      rooms.delete(code);
    }
  }
  broadcastRoomList();
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rocket League 2D Online V2 läuft auf Port ${PORT}`);
});
