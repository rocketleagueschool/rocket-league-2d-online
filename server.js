const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingTimeout: 20000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value, fallback) {
  return String(value || fallback).replace(/[<>]/g, '').trim().slice(0, 14) || fallback;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

io.on('connection', socket => {
  socket.on('create_room', ({ name } = {}) => {
    const oldCode = socket.data.roomCode;
    if (socket.data.role === 'host' && oldCode) rooms.delete(oldCode);

    const roomCode = makeRoomCode();
    const hostName = cleanName(name, 'Host');
    rooms.set(roomCode, { host: socket.id, guest: null, hostName, guestName: null, lastSeen: Date.now() });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.role = 'host';
    socket.emit('room_created', { roomCode });
  });

  socket.on('join_room', ({ roomCode, name } = {}) => {
    const code = String(roomCode || '').toUpperCase();
    const room = getRoom(code);
    if (!room) return socket.emit('room_error', { message: 'Raum nicht gefunden.' });
    if (room.guest && io.sockets.sockets.has(room.guest)) {
      return socket.emit('room_error', { message: 'Raum ist schon voll.' });
    }
    if (room.host === socket.id) return socket.emit('room_error', { message: 'Du bist schon der Host.' });

    const guestName = cleanName(name, 'Gast');
    room.guest = socket.id;
    room.guestName = guestName;
    room.lastSeen = Date.now();

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'guest';

    socket.emit('room_joined', { roomCode: code, hostName: room.hostName });
    io.to(room.host).emit('guest_joined', { roomCode: code, guestName });
  });

  socket.on('guest_input', ({ roomCode, input } = {}) => {
    const room = getRoom(roomCode || socket.data.roomCode);
    if (!room || room.guest !== socket.id) return;
    io.to(room.host).emit('guest_input', {
      input: {
        up: !!input?.up,
        down: !!input?.down,
        left: !!input?.left,
        right: !!input?.right,
        boost: !!input?.boost
      }
    });
  });

  socket.on('host_state', data => {
    const room = getRoom(data?.roomCode || socket.data.roomCode);
    if (!room || room.host !== socket.id || !room.guest) return;
    room.lastSeen = Date.now();
    io.to(room.guest).emit('host_state', data);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const role = socket.data.role;
    if (!code || !role) return;
    const room = getRoom(code);
    if (!room) return;

    if (role === 'host' && room.host === socket.id) {
      if (room.guest) io.to(room.guest).emit('host_left');
      rooms.delete(code);
      return;
    }

    if (role === 'guest' && room.guest === socket.id) {
      room.guest = null;
      room.guestName = null;
      io.to(room.host).emit('guest_left');
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hostConnected = io.sockets.sockets.has(room.host);
    if (!hostConnected || now - room.lastSeen > 1000 * 60 * 60) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Rocket League 2D Online läuft auf http://localhost:${PORT}`);
});
