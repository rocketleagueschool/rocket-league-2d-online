const express = require('express');
const http = require('http');
const path = require('path');
const { performance } = require('perf_hooks');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 25000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6,
  transports: ['websocket', 'polling'],
  connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: true }
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
  replayEnabled: true,
  gameSpeed: 'normal',
  ballSpeed: 'normal',
  contactAssist: 'normal',
  startCountdown: true
};

const COLOR_PRESETS = {
  blue: ['#00b7ff', '#38ddff', '#1ad1b8', '#7ee7ff', '#9a7bff', '#34ff9f'],
  orange: ['#ff8a1d', '#ffad3c', '#ff6d2a', '#ffc04f', '#ff3c7b', '#ffea61']
};
const BOOST_COLORS = ['#7ee7ff', '#ffd447', '#ff8a1d', '#34ff9f', '#ff3c7b', '#ffffff'];

// Spielfeld-Konstanten wie im Original-Canvas.
const W = 1240;
const H = 760;
const WALL = 66;
const GOAL_H = 236;
const GOAL_Y = H / 2 - GOAL_H / 2;
const GOAL_TOP = GOAL_Y;
const GOAL_BOTTOM = GOAL_Y + GOAL_H;
const GOAL_DEPTH = 36;
const FIELD_L = WALL;
const FIELD_R = W - WALL;
const FIELD_T = WALL;
const FIELD_B = H - WALL;
const TICK_RATE = 60;
const SNAP_RATE = 60;
const STEP = 1 / TICK_RATE;

app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, now: Date.now(), netcode: 'server-authoritative-v9', tickRate: TICK_RATE, snapshotRate: SNAP_RATE }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const lerp = (a, b, t) => a + (b - a) * t;
const hypot = Math.hypot;
const rand = (a, b) => a + Math.random() * (b - a);
const inGoalMouth = y => y > GOAL_TOP + 3 && y < GOAL_BOTTOM - 3;
const len = (x, y) => Math.hypot(x, y) || 0.00001;

function angleDiff(target, current) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  while (rooms.has(code));
  return code;
}

function cleanName(value, fallback = 'Spieler') {
  return String(value || fallback).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || fallback;
}
function cleanCode(value) { return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8); }
function cleanToken(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null; }
function getMode(mode) { return MODES[mode] ? mode : 'pvp1v1'; }

function cleanSettings(value = {}) {
  const matchTime = Number(value.matchTime);
  const maxGoals = Number(value.maxGoals);
  return {
    visibility: value.visibility === 'private' ? 'private' : 'public',
    botDifficulty: ['easy', 'normal', 'hard', 'pro'].includes(value.botDifficulty) ? value.botDifficulty : DEFAULT_SETTINGS.botDifficulty,
    matchTime: [180, 300, 420, 600, 900].includes(matchTime) ? matchTime : DEFAULT_SETTINGS.matchTime,
    maxGoals: [0, 1, 3, 5, 7, 10].includes(maxGoals) ? maxGoals : DEFAULT_SETTINGS.maxGoals,
    boostMode: ['normal', 'fast', 'unlimited'].includes(value.boostMode) ? value.boostMode : DEFAULT_SETTINGS.boostMode,
    replayEnabled: value.replayEnabled === false ? false : true,
    gameSpeed: ['slow', 'normal', 'fast'].includes(value.gameSpeed) ? value.gameSpeed : DEFAULT_SETTINGS.gameSpeed,
    ballSpeed: ['soft', 'normal', 'hard'].includes(value.ballSpeed) ? value.ballSpeed : DEFAULT_SETTINGS.ballSpeed,
    contactAssist: ['low', 'normal', 'high'].includes(value.contactAssist) ? value.contactAssist : DEFAULT_SETTINGS.contactAssist,
    startCountdown: value.startCountdown === false ? false : true
  };
}

function cleanCosmetic(cosmetic = {}) {
  const carColor = String(cosmetic.carColor || '').trim();
  const boostColor = String(cosmetic.boostColor || '').trim();
  return {
    carColor: /^#[0-9a-fA-F]{6}$/.test(carColor) ? carColor : '',
    boostColor: /^#[0-9a-fA-F]{6}$/.test(boostColor) ? boostColor : '',
    finish: ['standard', 'neon', 'gold', 'dark'].includes(cosmetic.finish) ? cosmetic.finish : 'standard',
    boostStyle: ['normal', 'flamme', 'blitz', 'regenbogen'].includes(cosmetic.boostStyle) ? cosmetic.boostStyle : 'normal'
  };
}

function getRoom(code) { return rooms.get(cleanCode(code)); }
function activePlayers(room) { return room.players.filter(p => p.role !== 'spectator'); }
function socketByToken(token) {
  for (const socket of io.sockets.sockets.values()) if (socket.data.playerToken === token) return socket;
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
    ping: Number(player.ping) || 0,
    cosmetic: player.cosmetic || cleanCosmetic()
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
    startedAt: room.startedAt || null,
    netcode: 'server-authoritative-v9'
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
        netcode: 'Server V9',
        updatedAt: room.updatedAt
      };
    });
}

function broadcastRoomList() { io.emit('rooms_list', roomListPayload()); }
function emitRoom(room) { io.to(room.code).emit('room_state', roomState(room)); broadcastRoomList(); }

function getCurrentRoomForSocket(socket) {
  const token = socket.data.playerToken;
  if (!token) return null;
  for (const room of rooms.values()) if (room.players.some(p => p.token === token)) return room;
  return null;
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

function hardRemovePlayerFromRoom(room, token) {
  const idx = room.players.findIndex(p => p.token === token);
  if (idx === -1) return;
  const wasHost = room.players[idx].isHost;
  room.players.splice(idx, 1);
  if (room.game) {
    delete room.game.inputs[token];
    const car = room.game.cars.find(c => c.netPlayerId === token);
    if (car) car.input = blankInput();
  }
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
      if (orangeCount === 0) (players.find(p => p.team !== 'blue') || players[1]).team = 'orange';
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
    if (!players.some(p => p.team === 'blue') || !players.some(p => p.team === 'orange')) return { ok: false, message: 'Für 1v1 muss ein Spieler Blau und einer Orange sein.' };
  }
  const notReady = players.filter(p => !p.ready);
  if (notReady.length) return { ok: false, message: `Noch nicht ready: ${notReady.map(p => p.name).join(', ')}` };
  return { ok: true, message: 'Alle sind ready.' };
}

function joinExistingOrAdd(socket, room, name, role = 'player', cosmetic = {}) {
  const token = socket.data.playerToken;
  let player = room.players.find(p => p.token === token);
  if (player) {
    player.name = cleanName(name, player.name);
    player.connected = true;
    player.socketId = socket.id;
    player.disconnectedAt = null;
    player.ready = false;
    player.cosmetic = cleanCosmetic({ ...player.cosmetic, ...cosmetic });
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
      lastSeq: 0,
      lastInputAt: 0,
      cosmetic: cleanCosmetic(cosmetic),
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

// -----------------------------
// Server-authoritative Game V9
// -----------------------------
function blankInput() { return { up: false, down: false, left: false, right: false, boost: false }; }

function makeCar({ slotId, name, team, isBot, netPlayerId, index, cosmetic }) {
  const side = team === 'orange' ? 'orange' : 'blue';
  const colorList = side === 'orange' ? COLOR_PRESETS.orange : COLOR_PRESETS.blue;
  const color = cosmetic?.carColor || colorList[index % colorList.length];
  let accent = side === 'orange' ? '#fff0b8' : '#d8fbff';
  if (cosmetic?.finish === 'gold') accent = '#fff4a8';
  if (cosmetic?.finish === 'dark') accent = '#141824';
  if (cosmetic?.finish === 'neon') accent = '#ffffff';
  return {
    slotId, name: cleanName(name), team: side, isBot: !!isBot, netPlayerId: netPlayerId || null,
    color, accent, boostColor: cosmetic?.boostColor || BOOST_COLORS[index % BOOST_COLORS.length], boostStyle: cosmetic?.boostStyle || 'normal',
    x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, angle: side === 'orange' ? Math.PI : 0, av: 0,
    radius: 28, width: 68, height: 38, boost: 100, maxBoost: 100, boosting: false, boostPower: 0,
    throttleInput: 0, steerInput: 0, targetSpeed: 360, supersonic: 0, demoed: false, demoTimer: 0,
    lastHit: 0, skid: 0, input: blankInput(), aiThrottle: 0, aiSteer: 0, aiBoost: 0,
    shotCooldown: 0, saveCooldown: 0, lastInputSeq: 0
  };
}

function resetCarPhysics(car, x, y, angle) {
  Object.assign(car, {
    x, y, px: x, py: y, vx: 0, vy: 0, angle, av: 0,
    boost: 100, boosting: false, boostPower: 0, throttleInput: 0, steerInput: 0, targetSpeed: 360,
    supersonic: 0, demoed: false, demoTimer: 0, lastHit: 0, skid: 0,
    shotCooldown: 0, saveCooldown: 0
  });
}

function resetBall(game, kickoff = true) {
  game.ball = { x: W / 2, y: H / 2, px: W / 2, py: H / 2, vx: 0, vy: 0, radius: 17, spin: 0, angle: 0, lastTouch: null, lastTouchTeam: null, lastTouchId: null };
  if (kickoff) {
    const side = Math.random() < .5 ? -1 : 1;
    game.ball.vx = side * rand(12, 40);
    game.ball.vy = rand(-26, 26);
  }
}

function layoutCars(game) {
  const blueList = game.cars.filter(c => c.team === 'blue');
  const orangeList = game.cars.filter(c => c.team === 'orange');
  const place = (list, side) => {
    const spacing = list.length >= 4 ? 72 : 86;
    list.forEach((car, i) => {
      const offset = (i - (list.length - 1) / 2) * spacing;
      const x = side === 'blue' ? 255 : W - 235;
      const y = clamp(H / 2 + offset, FIELD_T + car.radius + 14, FIELD_B - car.radius - 14);
      resetCarPhysics(car, x, y, side === 'blue' ? 0 : Math.PI);
    });
  };
  place(blueList, 'blue');
  place(orangeList, 'orange');
}

function resetRound(game, withCountdown = true) {
  layoutCars(game);
  resetBall(game, true);
  game.countdown = withCountdown ? 3.05 : 0;
  game.state = withCountdown ? 'countdown' : 'play';
  game.goalFreeze = 0;
}

function botSkill(room) {
  const diff = room.settings.botDifficulty || 'pro';
  return diff === 'easy' ? .68 : diff === 'normal' ? .86 : diff === 'hard' ? 1.04 : 1.22;
}
function gameSpeed(room) {
  return room.settings.gameSpeed === 'slow' ? .92 : room.settings.gameSpeed === 'fast' ? 1.08 : 1;
}
function ballSpeedMult(room) {
  return room.settings.ballSpeed === 'soft' ? .9 : room.settings.ballSpeed === 'hard' ? 1.08 : 1;
}
function contactAssist(room) {
  return room.settings.contactAssist === 'low' ? .9 : room.settings.contactAssist === 'high' ? 1.13 : 1;
}

function resetStatsForRoom(room) {
  const stats = {};
  for (const p of activePlayers(room)) {
    stats[p.token] = { id: p.token, name: p.name, team: p.team, score: 0, goals: 0, assists: 0, saves: 0, shots: 0, ping: p.ping || 0 };
  }
  return stats;
}

function createGame(room) {
  const players = activePlayers(room).filter(p => p.connected);
  normalizeTeams(room);
  const cars = [];
  players.forEach((player, i) => {
    cars.push(makeCar({ slotId: `human${i}`, name: player.name, team: room.mode === 'pvp1v1' ? player.team : 'blue', isBot: false, netPlayerId: player.token, index: i, cosmetic: player.cosmetic }));
  });
  const botCount = MODES[room.mode].bots || 0;
  for (let i = 0; i < botCount; i++) {
    cars.push(makeCar({ slotId: `bot${i}`, name: `Bot ${i + 1}`, team: 'orange', isBot: true, index: i, cosmetic: { carColor: COLOR_PRESETS.orange[i % COLOR_PRESETS.orange.length], boostColor: '#ffd447', boostStyle: 'flamme' } }));
  }
  const game = {
    state: room.settings.startCountdown === false ? 'play' : 'countdown',
    countdown: room.settings.startCountdown === false ? 0 : 3.05,
    goalFreeze: 0,
    clock: Number(room.settings.matchTime || 300),
    score: { blue: 0, orange: 0 },
    cars,
    ball: null,
    inputs: {},
    lastTouches: [],
    stats: resetStatsForRoom(room),
    ended: false,
    lastSnapshotAt: 0,
    frame: 0,
    createdAt: Date.now()
  };
  for (const p of players) game.inputs[p.token] = blankInput();
  resetRound(game, room.settings.startCountdown !== false);
  return game;
}

function statForCar(room, car) {
  if (!car || !car.netPlayerId) return null;
  if (!room.game.stats[car.netPlayerId]) {
    const p = room.players.find(x => x.token === car.netPlayerId);
    room.game.stats[car.netPlayerId] = { id: car.netPlayerId, name: p?.name || car.name, team: car.team, score: 0, goals: 0, assists: 0, saves: 0, shots: 0, ping: p?.ping || 0 };
  }
  return room.game.stats[car.netPlayerId];
}

function addScoreStat(room, car, key, amount) {
  const s = statForCar(room, car);
  if (!s) return;
  s[key] = (s[key] || 0) + 1;
  s.score = (s.goals || 0) * 100 + (s.assists || 0) * 50 + (s.saves || 0) * 50 + (s.shots || 0) * 10;
}

function rememberTouch(room, car) {
  if (!car) return;
  const game = room.game;
  game.ball.lastTouch = car.name;
  game.ball.lastTouchTeam = car.team;
  game.ball.lastTouchId = car.netPlayerId || car.slotId;
  game.lastTouches = [{ id: game.ball.lastTouchId, team: car.team, name: car.name, at: Date.now() }, ...game.lastTouches.filter(t => t.id !== (car.netPlayerId || car.slotId))].slice(0, 5);
}

function triggerGoal(room, scoringTeam) {
  const game = room.game;
  if (!game || game.ended) return;
  game.score[scoringTeam]++;
  const scorerTouch = game.lastTouches.find(t => t.team === scoringTeam);
  const scorerCar = scorerTouch ? game.cars.find(c => (c.netPlayerId || c.slotId) === scorerTouch.id) : null;
  if (scorerCar) addScoreStat(room, scorerCar, 'goals');
  const assisterTouch = game.lastTouches.find(t => t.team === scoringTeam && (!scorerTouch || t.id !== scorerTouch.id));
  const assisterCar = assisterTouch ? game.cars.find(c => (c.netPlayerId || c.slotId) === assisterTouch.id) : null;
  if (assisterCar) addScoreStat(room, assisterCar, 'assists');
  game.state = 'goal';
  game.goalFreeze = 1.65;
  game.lastTouches = [];
  const maxGoals = Number(room.settings.maxGoals || 0);
  if (maxGoals > 0 && (game.score.blue >= maxGoals || game.score.orange >= maxGoals)) {
    game.endingAfterGoal = true;
  }
}

function finishGame(room) {
  const game = room.game;
  if (!game || game.ended) return;
  game.ended = true;
  game.state = 'ended';
  room.updatedAt = Date.now();
}

function updateBotAI(room, car, dt) {
  const game = room.game;
  const skill = botSkill(room);
  const ball = game.ball;
  const teamDir = car.team === 'blue' ? 1 : -1;
  const ownGoalX = car.team === 'blue' ? FIELD_L + 70 : FIELD_R - 70;
  const distCarBall = hypot(ball.x - car.x, ball.y - car.y);
  const teammates = game.cars.filter(other => other !== car && other.team === car.team);
  const distMateBall = teammates.length ? Math.min(...teammates.map(other => hypot(ball.x - other.x, ball.y - other.y))) : 99999;
  const ownDanger = car.team === 'blue' ? ball.x < W * .42 : ball.x > W * .58;
  let tx = ball.x - teamDir * (80 + 18 / skill);
  let ty = ball.y;
  if (distMateBall + 55 < distCarBall && !ownDanger) {
    tx = lerp(ball.x, ownGoalX, .38);
    ty = clamp(ball.y + (car.slotId.endsWith('1') || car.slotId.endsWith('3') ? 95 : -95), FIELD_T + 90, FIELD_B - 90);
  }
  if (ownDanger) {
    tx = lerp(ball.x, ownGoalX, .18);
    ty = lerp(ball.y, H / 2, .18);
  }
  const behindBall = car.team === 'blue' ? car.x < ball.x - 20 : car.x > ball.x + 20;
  if (behindBall && distCarBall < 180 * skill) { tx = ball.x; ty = ball.y; }
  const desired = Math.atan2(ty - car.y, tx - car.x);
  const diff = angleDiff(desired, car.angle);
  const absDiff = Math.abs(diff);
  const distance = hypot(tx - car.x, ty - car.y);
  car.aiSteer = clamp(diff * 1.6 * skill, -1, 1);
  car.aiThrottle = absDiff > 2.25 ? -0.55 : (absDiff > 1.15 ? .35 : 1);
  const aimedAtBall = absDiff < (.36 / Math.sqrt(skill));
  const shotChance = aimedAtBall && behindBall && distCarBall < 380 * skill;
  const chaseBoost = aimedAtBall && distance > 310 && car.boost > 25;
  car.aiBoost = (shotChance || chaseBoost) ? 1 : 0;
  if (Math.random() < dt * (1.8 - Math.min(.9, skill * .45))) car.aiSteer = clamp(car.aiSteer + rand(-.08, .08), -1, 1);
  car.input = { up: car.aiThrottle > .15, down: car.aiThrottle < -.15, left: car.aiSteer < -.08, right: car.aiSteer > .08, boost: !!car.aiBoost };
}

function updateCar(room, car, dt) {
  const input = car.isBot ? car.input : (room.game.inputs[car.netPlayerId] || blankInput());
  if (!car.isBot && car.netPlayerId) {
    const pl = room.players.find(p => p.token === car.netPlayerId);
    car.lastInputSeq = pl?.lastSeq || car.lastInputSeq || 0;
  }
  car.px = car.x;
  car.py = car.y;
  const rawThrottle = (input.up ? 1 : 0) + (input.down ? -1 : 0);
  const rawSteer = (input.right ? 1 : 0) + (input.left ? -1 : 0);
  car.input = { ...input };
  const throttleSnap = rawThrottle === 0 ? 15 : 20;
  const steerSnap = rawSteer === 0 ? 18 : 24;
  car.throttleInput = lerp(car.throttleInput, rawThrottle, 1 - Math.exp(-throttleSnap * dt));
  car.steerInput = lerp(car.steerInput, rawSteer, 1 - Math.exp(-steerSnap * dt));
  let speed = hypot(car.vx, car.vy);
  const forwardX = Math.cos(car.angle);
  const forwardY = Math.sin(car.angle);
  const rightX = -forwardY;
  const rightY = forwardX;
  let forwardVel = car.vx * forwardX + car.vy * forwardY;
  let sideVel = car.vx * rightX + car.vy * rightY;
  const boostHeld = !!input.boost && car.boost > 0 && rawThrottle >= 0;
  const boostTarget = boostHeld ? 1 : 0;
  car.boostPower = lerp(car.boostPower, boostTarget, 1 - Math.exp(-(boostTarget ? 4.6 : 9) * dt));
  car.boosting = car.boostPower > .08 && boostHeld;
  const speedN = clamp(speed / 390, 0, 1);
  const grip = lerp(14, 9.1, speedN) * (rawThrottle < 0 ? 1.12 : 1) * (rawThrottle === 0 ? .82 : 1);
  car.vx -= rightX * sideVel * (1 - Math.exp(-grip * dt));
  car.vy -= rightY * sideVel * (1 - Math.exp(-grip * dt));
  car.skid = Math.abs(sideVel) / 310;
  const gs = gameSpeed(room);
  if (Math.abs(car.throttleInput) > .025) {
    const drivingForward = car.throttleInput > 0;
    const reverseSpeed = Math.max(0, -forwardVel);
    const forwardSpeed = Math.max(0, forwardVel);
    const accelBase = (drivingForward ? 620 : 535) * gs;
    const speedFade = drivingForward ? lerp(1, .42, clamp(forwardSpeed / 360, 0, 1)) : lerp(1, .50, clamp(reverseSpeed / 245, 0, 1));
    const engineForce = accelBase * car.throttleInput * speedFade;
    car.vx += forwardX * engineForce * dt;
    car.vy += forwardY * engineForce * dt;
  }
  if (car.boostPower > .02) {
    const boostCurve = car.boostPower * car.boostPower * (3 - 2 * car.boostPower);
    const boostForce = (530 + 190 * clamp(speed / 380, 0, 1)) * gs;
    car.vx += forwardX * boostForce * boostCurve * dt;
    car.vy += forwardY * boostForce * boostCurve * dt;
    if (room.settings.boostMode !== 'unlimited') car.boost = Math.max(0, car.boost - (room.settings.boostMode === 'fast' ? 20 : 31) * boostCurve * dt);
  } else {
    const regen = room.settings.boostMode === 'fast' ? 12 : 4.5;
    car.boost = Math.min(car.maxBoost, car.boost + regen * dt);
  }
  speed = hypot(car.vx, car.vy);
  forwardVel = car.vx * forwardX + car.vy * forwardY;
  const steeringOnly = rawSteer !== 0 && rawThrottle === 0;
  const pivotAssist = steeringOnly ? lerp(1.55, 1.0, clamp(speed / 140, 0, 1)) : 1;
  const steerSpeed = clamp(speed / 170, steeringOnly ? .62 : .34, 1);
  const lowSpeedHelp = lerp(1.62, 1.0, clamp(speed / 190, 0, 1));
  const highSpeedStability = lerp(1.0, .74, clamp((speed - 285) / 185, 0, 1));
  const reverseFlip = forwardVel < -32 ? -0.88 : 1;
  const turnRate = 3.55 * steerSpeed * lowSpeedHelp * highSpeedStability * reverseFlip * pivotAssist * gs;
  car.av = lerp(car.av, car.steerInput * turnRate, 1 - Math.exp((steeringOnly ? -20 : -14) * dt));
  car.angle += car.av * dt;
  const normalMax = 360 * gs;
  const boostMax = 440 * gs;
  car.targetSpeed = lerp(car.targetSpeed || normalMax, lerp(normalMax, boostMax, car.boostPower), 1 - Math.exp(-5.2 * dt));
  const drag = rawThrottle === 0 ? (rawSteer !== 0 ? 2.15 : 1.75) : .72;
  car.vx *= Math.exp(-drag * lerp(1, .74, car.boostPower) * dt);
  car.vy *= Math.exp(-drag * lerp(1, .74, car.boostPower) * dt);
  const ns = hypot(car.vx, car.vy);
  if (ns > car.targetSpeed) {
    const over = ns - car.targetSpeed;
    const soft = car.targetSpeed + over * Math.exp(-10 * dt);
    car.vx *= soft / ns;
    car.vy *= soft / ns;
  }
  const finalSpeed = hypot(car.vx, car.vy);
  car.supersonic = Math.max(0, finalSpeed - 385) / 75;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  constrainCar(car);
  car.shotCooldown = Math.max(0, car.shotCooldown - dt);
  car.saveCooldown = Math.max(0, car.saveCooldown - dt);
}

function constrainCar(car) {
  const r = car.radius;
  const bounce = .33;
  if (car.y < FIELD_T + r) { car.y = FIELD_T + r; car.vy = Math.abs(car.vy) * bounce; }
  if (car.y > FIELD_B - r) { car.y = FIELD_B - r; car.vy = -Math.abs(car.vy) * bounce; }
  const canEnterGoal = inGoalMouth(car.y);
  const leftLimit = canEnterGoal ? FIELD_L - GOAL_DEPTH * .45 + r : FIELD_L + r;
  const rightLimit = canEnterGoal ? FIELD_R + GOAL_DEPTH * .45 - r : FIELD_R - r;
  if (car.x < leftLimit) { car.x = leftLimit; car.vx = Math.abs(car.vx) * bounce; }
  if (car.x > rightLimit) { car.x = rightLimit; car.vx = -Math.abs(car.vx) * bounce; }
}

function solveCarCar(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = len(dx, dy);
  const minD = a.radius + b.radius;
  if (d >= minD) return;
  const nx = dx / d, ny = dy / d;
  const overlap = minD - d;
  a.x -= nx * overlap * .5; a.y -= ny * overlap * .5;
  b.x += nx * overlap * .5; b.y += ny * overlap * .5;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const rel = rvx * nx + rvy * ny;
  if (rel < 0) {
    const impulse = -(1 + .28) * rel / 2;
    a.vx -= nx * impulse; a.vy -= ny * impulse;
    b.vx += nx * impulse; b.vy += ny * impulse;
  }
}

function solveCarBall(room, car) {
  const ball = room.game.ball;
  const dx = ball.x - car.x, dy = ball.y - car.y;
  const d = len(dx, dy);
  const minD = car.radius + ball.radius;
  if (d >= minD) return;
  const nx = dx / d, ny = dy / d;
  const overlap = minD - d;
  ball.x += nx * overlap * .82;
  ball.y += ny * overlap * .82;
  car.x -= nx * overlap * .08;
  car.y -= ny * overlap * .08;
  const rvx = ball.vx - car.vx, rvy = ball.vy - car.vy;
  const rel = rvx * nx + rvy * ny;
  const closing = Math.max(0, -rel);
  const carSpeed = hypot(car.vx, car.vy);
  const forwardDot = Math.cos(car.angle) * nx + Math.sin(car.angle) * ny;
  const throttlePush = Math.max(0, car.throttleInput);
  const assist = contactAssist(room);
  const impulse = (closing * .78 + carSpeed * (0.18 + .17 * Math.max(0, forwardDot)) + throttlePush * 34 + car.boostPower * 65) * assist;
  ball.vx += nx * impulse + car.vx * .16;
  ball.vy += ny * impulse + car.vy * .16;
  ball.spin += (car.vx * ny - car.vy * nx) * .012;
  rememberTouch(room, car);
  // Shots / saves.
  const towardEnemy = car.team === 'blue' ? ball.vx > 145 : ball.vx < -145;
  const nearOwnGoal = car.team === 'blue' ? car.x < FIELD_L + 160 : car.x > FIELD_R - 160;
  const ballThreat = car.team === 'blue' ? ball.vx < -100 : ball.vx > 100;
  if (towardEnemy && car.shotCooldown <= 0 && car.netPlayerId) {
    addScoreStat(room, car, 'shots');
    car.shotCooldown = 1.25;
  }
  if (nearOwnGoal && ballThreat && car.saveCooldown <= 0 && car.netPlayerId) {
    addScoreStat(room, car, 'saves');
    car.saveCooldown = 2.2;
  }
}

function updateBall(room, dt) {
  const game = room.game;
  const ball = game.ball;
  ball.px = ball.x; ball.py = ball.y;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vx *= Math.exp(-.48 * dt);
  ball.vy *= Math.exp(-.48 * dt);
  ball.angle += ball.spin * dt;
  ball.spin *= Math.exp(-1.6 * dt);
  const restitution = .82;
  if (ball.y - ball.radius < FIELD_T) {
    ball.y = FIELD_T + ball.radius;
    ball.vy = Math.abs(ball.vy) * restitution;
    ball.spin += ball.vx * .012;
  }
  if (ball.y + ball.radius > FIELD_B) {
    ball.y = FIELD_B - ball.radius;
    ball.vy = -Math.abs(ball.vy) * restitution;
    ball.spin -= ball.vx * .012;
  }
  if (ball.x - ball.radius < FIELD_L) {
    if (inGoalMouth(ball.y)) triggerGoal(room, 'orange');
    else { ball.x = FIELD_L + ball.radius; ball.vx = Math.abs(ball.vx) * restitution; ball.spin -= ball.vy * .012; }
  }
  if (ball.x + ball.radius > FIELD_R) {
    if (inGoalMouth(ball.y)) triggerGoal(room, 'blue');
    else { ball.x = FIELD_R - ball.radius; ball.vx = -Math.abs(ball.vx) * restitution; ball.spin += ball.vy * .012; }
  }
  applyAntiCornerAssist(ball, dt);
  const cap = 690 * ballSpeedMult(room);
  const speed = hypot(ball.vx, ball.vy);
  if (speed > cap) { ball.vx *= cap / speed; ball.vy *= cap / speed; }
}

function applyAntiCornerAssist(ball, dt) {
  const zone = 122;
  const bevel = 88;
  const side = ball.x < W / 2 ? 1 : -1;
  const vert = ball.y < H / 2 ? 1 : -1;
  const cornerX = side > 0 ? FIELD_L + ball.radius : FIELD_R - ball.radius;
  const cornerY = vert > 0 ? FIELD_T + ball.radius : FIELD_B - ball.radius;
  const dx = Math.abs(ball.x - cornerX), dy = Math.abs(ball.y - cornerY);
  if (dx > zone || dy > zone) return;
  const closeToSideGoalOpening = (ball.x < FIELD_L + zone || ball.x > FIELD_R - zone) && inGoalMouth(ball.y);
  if (closeToSideGoalOpening) return;
  const closeness = 1 - clamp((dx + dy) / (zone * 1.35), 0, 1);
  const speed = hypot(ball.vx, ball.vy);
  const inwardVelocity = ball.vx * side + ball.vy * vert;
  const deadZone = bevel - (dx + dy);
  if (deadZone > 0) { ball.x += side * deadZone * .16; ball.y += vert * deadZone * .16; }
  if (closeness > .05 && (speed < 215 || inwardVelocity < 28 || deadZone > 0)) {
    const assist = (240 + 460 * closeness) * dt;
    ball.vx += side * assist; ball.vy += vert * assist * .92; ball.spin += side * vert * assist * .018;
  }
}

function stepGame(room, dt) {
  const game = room.game;
  if (!game || game.ended) return;
  const scale = gameSpeed(room);
  dt *= scale;
  if (game.state === 'countdown') {
    game.countdown -= dt;
    if (game.countdown <= 0) { game.countdown = 0; game.state = 'play'; }
    return;
  }
  if (game.state === 'goal') {
    game.goalFreeze -= dt;
    game.ball.x += game.ball.vx * dt * .22;
    game.ball.y += game.ball.vy * dt * .22;
    game.ball.vx *= Math.pow(.985, dt * 120);
    game.ball.vy *= Math.pow(.985, dt * 120);
    if (game.goalFreeze <= 0) {
      if (game.endingAfterGoal) finishGame(room);
      else resetRound(game, room.settings.startCountdown !== false);
    }
    return;
  }
  if (game.state !== 'play') return;
  game.clock = Math.max(0, game.clock - dt);
  if (game.clock <= 0 && game.score.blue !== game.score.orange) {
    finishGame(room);
    return;
  }
  for (const car of game.cars) {
    if (car.isBot) updateBotAI(room, car, dt);
    updateCar(room, car, dt);
  }
  for (let i = 0; i < game.cars.length; i++) for (let j = i + 1; j < game.cars.length; j++) solveCarCar(game.cars[i], game.cars[j]);
  updateBall(room, dt);
  for (let k = 0; k < 2; k++) {
    for (const car of game.cars) solveCarBall(room, car);
    for (let i = 0; i < game.cars.length; i++) for (let j = i + 1; j < game.cars.length; j++) solveCarCar(game.cars[i], game.cars[j]);
  }
  for (const p of room.players) if (room.game.stats[p.token]) room.game.stats[p.token].ping = p.ping || 0;
  game.frame++;
}

function snapCar(car) {
  return {
    x: car.x, y: car.y, px: car.px, py: car.py, vx: car.vx, vy: car.vy, angle: car.angle, av: car.av,
    boost: car.boost, boosting: car.boosting, boostPower: car.boostPower, throttleInput: car.throttleInput,
    steerInput: car.steerInput, targetSpeed: car.targetSpeed, supersonic: car.supersonic, demoed: car.demoed,
    demoTimer: car.demoTimer || 0, lastHit: car.lastHit || 0, skid: car.skid || 0
  };
}
function snapBall(ball) {
  return { x: ball.x, y: ball.y, px: ball.px, py: ball.py, vx: ball.vx, vy: ball.vy, angle: ball.angle, spin: ball.spin, lastTouch: ball.lastTouch, lastTouchTeam: ball.lastTouchTeam };
}
function collectStatsRows(room) {
  const rows = Object.values(room.game?.stats || {}).map(s => ({ ...s }));
  return { blue: rows.filter(r => r.team !== 'orange'), orange: rows.filter(r => r.team === 'orange') };
}
function gameSnapshot(room) {
  const game = room.game;
  return {
    sentAt: Date.now(),
    serverFrame: game.frame,
    serverNow: Date.now(),
    serverAuth: true,
    state: game.state,
    countdown: game.countdown,
    gameClock: game.clock,
    score: { ...game.score },
    stats: collectStatsRows(room),
    matchEnded: !!game.ended,
    ball: snapBall(game.ball),
    cars: game.cars.map(car => ({
      slotId: car.slotId,
      name: car.name,
      team: car.team,
      isBot: !!car.isBot,
      netPlayerId: car.netPlayerId || null,
      color: car.color,
      accent: car.accent,
      boostColor: car.boostColor,
      boostStyle: car.boostStyle,
      lastInputSeq: car.lastInputSeq || 0,
      snap: snapCar(car)
    }))
  };
}

io.on('connection', socket => {
  socket.emit('server_hello', { id: socket.id, modes: MODES, defaults: DEFAULT_SETTINGS, netcode: 'server-authoritative-v9' });
  socket.emit('rooms_list', roomListPayload());

  socket.on('identify', ({ token, name, cosmetic } = {}) => {
    let clean = cleanToken(token);
    if (!clean) clean = `${socket.id}-${Math.random().toString(36).slice(2, 10)}`;
    socket.data.playerToken = clean;
    socket.data.name = cleanName(name, 'Spieler');
    socket.data.cosmetic = cleanCosmetic(cosmetic);
    socket.emit('player_identified', { playerId: clean, name: socket.data.name });
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.token === clean);
      if (!player) continue;
      player.socketId = socket.id; player.connected = true; player.disconnectedAt = null; player.name = socket.data.name || player.name; player.cosmetic = cleanCosmetic({ ...player.cosmetic, ...socket.data.cosmetic });
      socket.join(room.code); socket.data.roomCode = room.code;
      socket.emit('room_joined', roomState(room));
      emitChat(room, player, `${player.name} ist wieder verbunden.`, true);
      emitRoom(room);
      break;
    }
  });

  socket.on('list_rooms', () => socket.emit('rooms_list', roomListPayload()));

  socket.on('create_room', ({ name, mode, settings, cosmetic } = {}) => {
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
        lastSeq: 0,
        lastInputAt: 0,
        cosmetic: cleanCosmetic(cosmetic || socket.data.cosmetic),
        joinedAt: Date.now()
      }],
      settings: cleanSettings({ ...DEFAULT_SETTINGS, ...(settings || {}) }),
      chat: [],
      game: null,
      createdAt: Date.now(), updatedAt: Date.now(), startedAt: null
    };
    rooms.set(code, room);
    socket.join(code); socket.data.roomCode = code;
    emitChat(room, room.players[0], `${room.players[0].name} hat den Raum erstellt.`, true);
    socket.emit('room_created', roomState(room)); emitRoom(room);
  });

  socket.on('join_room', ({ roomCode, name, role, cosmetic } = {}) => {
    if (!socket.data.playerToken) return socket.emit('room_error', { message: 'Bitte zuerst Namen speichern.' });
    const room = getRoom(roomCode);
    if (!room) return socket.emit('room_error', { message: 'Raum nicht gefunden.' });
    if (room.status !== 'lobby' && role !== 'spectator') return socket.emit('room_error', { message: 'Dieses Spiel läuft schon. Du kannst nur zuschauen.' });
    removePlayer(socket);
    const ok = joinExistingOrAdd(socket, room, name || socket.data.name, role, cosmetic || socket.data.cosmetic);
    if (!ok) return;
    room.updatedAt = Date.now();
    const player = room.players.find(p => p.token === socket.data.playerToken);
    emitChat(room, player, `${player.name} ist beigetreten.`, true);
    socket.emit('room_joined', roomState(room)); emitRoom(room);
  });

  socket.on('leave_room', () => removePlayer(socket));

  socket.on('set_mode', ({ mode } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    const selectedMode = getMode(mode);
    const info = MODES[selectedMode];
    if (activePlayers(room).length > info.maxHumans) return socket.emit('room_error', { message: `Für diesen Modus sind nur ${info.maxHumans} Spieler erlaubt.` });
    room.mode = selectedMode; normalizeTeams(room); room.players.forEach(p => { p.ready = false; }); room.updatedAt = Date.now(); emitRoom(room);
  });

  socket.on('set_settings', ({ settings } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    room.settings = cleanSettings({ ...room.settings, ...(settings || {}) });
    room.players.forEach(p => { p.ready = false; }); room.updatedAt = Date.now(); emitRoom(room);
  });

  socket.on('set_cosmetic', ({ cosmetic } = {}) => {
    const room = getRoom(socket.data.roomCode);
    socket.data.cosmetic = cleanCosmetic({ ...socket.data.cosmetic, ...cosmetic });
    if (room) {
      const player = room.players.find(p => p.token === socket.data.playerToken);
      if (player) { player.cosmetic = cleanCosmetic({ ...player.cosmetic, ...cosmetic }); player.ready = false; emitRoom(room); }
    }
  });

  socket.on('set_team', ({ team, role } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    if (!player) return;
    player.ready = false; player.role = role === 'spectator' ? 'spectator' : 'player'; player.team = team === 'orange' ? 'orange' : 'blue';
    if (room.mode !== 'pvp1v1' && player.role === 'player') player.team = 'blue';
    normalizeTeams(room); room.updatedAt = Date.now(); emitRoom(room);
  });

  socket.on('set_ready', ({ ready } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players.find(p => p.token === socket.data.playerToken);
    if (!player || player.role === 'spectator') return;
    player.ready = !!ready; room.updatedAt = Date.now(); emitRoom(room);
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken || room.status !== 'lobby') return;
    const result = canStart(room);
    if (!result.ok) return socket.emit('room_error', { message: result.message });
    room.status = 'playing'; room.startedAt = Date.now(); room.updatedAt = Date.now(); room.game = createGame(room);
    io.to(room.code).emit('game_start', roomState(room));
    io.to(room.code).volatile.emit('host_snapshot', gameSnapshot(room));
    broadcastRoomList();
  });

  socket.on('back_to_lobby', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerToken) return;
    room.status = 'lobby'; room.startedAt = null; room.game = null; room.players.forEach(p => { p.ready = false; }); room.updatedAt = Date.now(); emitRoom(room);
  });

  socket.on('player_input', ({ input, seq, clientTime } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'playing' || !room.game) return;
    const p = room.players.find(x => x.token === socket.data.playerToken);
    if (!p || p.role === 'spectator') return;
    const safe = { up: !!input?.up, down: !!input?.down, left: !!input?.left, right: !!input?.right, boost: !!input?.boost };
    const seqNum = Math.max(0, Math.floor(Number(seq) || 0));
    const nowMs = Date.now();
    room.game.inputs[socket.data.playerToken] = safe;
    p.lastSeq = Math.max(p.lastSeq || 0, seqNum);
    p.lastInputAt = nowMs;
    // Echo nur für Animation/Remote-Prediction; autoritativ bleibt der Server.
    socket.to(room.code).volatile.emit('player_input', { playerId: socket.data.playerToken, input: safe, seq: seqNum, clientTime: Number(clientTime) || 0, serverTime: nowMs });
  });

  // V9: Clients no longer authoritatively send snapshots. Kept for backwards compatibility, ignored.
  socket.on('host_snapshot', () => {});

  socket.on('chat_send', ({ text } = {}) => {
    const room = getRoom(socket.data.roomCode); if (!room) return;
    const player = room.players.find(p => p.token === socket.data.playerToken); emitChat(room, player, text, false);
  });
  socket.on('quick_chat', ({ text } = {}) => {
    const room = getRoom(socket.data.roomCode); if (!room) return;
    const player = room.players.find(p => p.token === socket.data.playerToken); emitChat(room, player, text, false);
  });
  socket.on('ping_check', ({ sent } = {}) => {
    socket.emit('pong_check', { sent, now: Date.now() });
    const room = getRoom(socket.data.roomCode);
    if (room) {
      const p = room.players.find(x => x.token === socket.data.playerToken);
      if (p && Number(sent)) p.ping = Math.max(0, Math.min(999, Date.now() - Number(sent)));
      if (room.status === 'lobby') emitRoom(room);
    }
  });
  socket.on('disconnect', () => softDisconnect(socket));
});

let lastLoop = performance.now();
let snapshotAccumulator = 0;
setInterval(() => {
  const now = performance.now();
  let dt = Math.min(0.05, (now - lastLoop) / 1000);
  lastLoop = now;
  snapshotAccumulator += dt;
  for (const room of rooms.values()) {
    if (room.status !== 'playing' || !room.game) continue;
    // Fixed-ish step to avoid physics exploding after cold hiccups.
    let left = dt;
    let safety = 0;
    while (left > 0 && safety++ < 4) {
      const step = Math.min(STEP, left);
      stepGame(room, step);
      left -= step;
    }
  }
  if (snapshotAccumulator >= 1 / SNAP_RATE) {
    snapshotAccumulator = 0;
    for (const room of rooms.values()) {
      if (room.status === 'playing' && room.game) io.to(room.code).volatile.emit('host_snapshot', gameSnapshot(room));
    }
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    room.players = room.players.filter(p => p.connected || now - (p.disconnectedAt || now) < 1000 * 60 * 3);
    if (room.players.length === 0 || now - room.updatedAt > 1000 * 60 * 120) { rooms.delete(code); continue; }
    if (!room.players.some(p => p.token === room.hostId)) promoteHost(room);
    if (room.status === 'lobby') normalizeTeams(room);
  }
  broadcastRoomList();
}, 30_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rocket League 2D Pro Online V9 läuft auf Port ${PORT} (server-authoritative v9 netcode)`);
});
