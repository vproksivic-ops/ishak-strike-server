const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.status(200).send('ISHAK STRIKE multiplayer server is online.'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, players: io.engine.clientsCount }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] }, pingInterval: 25000, pingTimeout: 20000 });
const rooms = new Map();
const MAX_PLAYERS = 10;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do { code = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function cleanName(value) {
  const name = String(value || 'Игрок').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Игрок';
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, weapon: p.weapon, skin: p.skin, hp: p.hp, kills: p.kills, deaths: p.deaths };
}
function broadcastPlayers(room) {
  io.to(room.code).emit('room:players', [...room.players.values()].map(publicPlayer));
}
function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  socket.to(code).emit('player:left', { id: socket.id });
  if (room.players.size === 0) rooms.delete(code);
  else broadcastPlayers(room);
}
function spawnPoint() {
  const points = [[0, 0], [4, 4], [-4, 4], [4, -4], [-4, -4], [0, 7], [7, 0], [-7, 0]];
  const [x, z] = points[Math.floor(Math.random() * points.length)];
  return { x, y: 1.65, z, yaw: 0, pitch: 0 };
}
function joinRoom(socket, code, name, map, ack) {
  const room = rooms.get(code);
  if (!room) return ack?.({ ok: false, error: 'Комната не найдена. Проверь код.' });
  if (room.players.size >= MAX_PLAYERS) return ack?.({ ok: false, error: 'Комната заполнена (максимум 10 игроков).' });
  if (socket.data.roomCode) removePlayer(socket);
  const spawn = spawnPoint();
  const p = { id: socket.id, name: cleanName(name), ...spawn, weapon: 'rifle', skin: 'default', hp: 100, kills: 0, deaths: 0 };
  room.players.set(socket.id, p);
  socket.data.roomCode = code;
  socket.join(code);
  const players = [...room.players.values()].filter(v => v.id !== socket.id).map(publicPlayer);
  ack?.({ ok: true, id: socket.id, code, map: room.map, self: spawn, players });
  socket.to(code).emit('player:update', publicPlayer(p));
  broadcastPlayers(room);
}

io.on('connection', socket => {
  socket.on('room:create', (payload = {}, ack) => {
    if (socket.data.roomCode) removePlayer(socket);
    const code = makeCode();
    const room = { code, map: String(payload.map || 'sandstone').slice(0, 32), players: new Map(), createdAt: Date.now() };
    rooms.set(code, room);
    joinRoom(socket, code, payload.name, room.map, ack);
  });

  socket.on('room:join', (payload = {}, ack) => {
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    joinRoom(socket, code, payload.name, payload.map, ack);
  });

  socket.on('player:update', data => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!p || !data || typeof data !== 'object') return;
    p.x = clampNumber(data.x, -100, 100, p.x);
    p.y = clampNumber(data.y, 0, 20, p.y);
    p.z = clampNumber(data.z, -100, 100, p.z);
    p.yaw = clampNumber(data.yaw, -1000, 1000, p.yaw);
    p.pitch = clampNumber(data.pitch, -2, 2, p.pitch);
    p.weapon = ['rifle', 'pistol', 'awp', 'knife'].includes(data.weapon) ? data.weapon : p.weapon;
    p.skin = String(data.skin || 'default').slice(0, 32);
    socket.to(room.code).emit('player:update', publicPlayer(p));
  });

  socket.on('player:shoot', ({ targetId, weapon } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const shooter = room?.players.get(socket.id);
    const target = room?.players.get(String(targetId || ''));
    if (!shooter || !target || target.id === shooter.id || target.hp <= 0) return;
    const allowed = ['rifle', 'pistol', 'awp', 'knife'];
    if (!allowed.includes(weapon)) return;
    const distance = Math.hypot(shooter.x - target.x, shooter.z - target.z);
    const maxDistance = weapon === 'knife' ? 3.2 : weapon === 'awp' ? 90 : 55;
    if (distance > maxDistance) return;
    const now = Date.now();
    const cooldown = weapon === 'rifle' ? 100 : weapon === 'pistol' ? 260 : weapon === 'awp' ? 850 : 450;
    if (shooter.lastShot && now - shooter.lastShot < cooldown) return;
    shooter.lastShot = now;
    const damage = weapon === 'knife' || weapon === 'awp' ? 100 : weapon === 'pistol' ? 45 : 25;
    target.hp = Math.max(0, target.hp - damage);
    io.to(room.code).emit('player:health', { id: target.id, hp: target.hp });
    if (target.hp <= 0) {
      shooter.kills++;
      target.deaths++;
      io.to(room.code).emit('player:stats', { id: shooter.id, kills: shooter.kills, deaths: shooter.deaths });
      io.to(room.code).emit('player:stats', { id: target.id, kills: target.kills, deaths: target.deaths });
    }
  });

  socket.on('player:respawn', () => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!p || p.hp > 0) return;
    const spawn = spawnPoint();
    Object.assign(p, spawn, { hp: 100 });
    io.to(room.code).emit('player:respawned', { id: p.id, ...spawn });
    io.to(room.code).emit('player:health', { id: p.id, hp: 100 });
    broadcastPlayers(room);
  });

  socket.on('room:leave', () => removePlayer(socket));
  socket.on('disconnect', () => removePlayer(socket));
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`ISHAK STRIKE server listening on ${port}`));
