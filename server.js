const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Constants ───────────────────────────────────────────────────────────────
const MULTIPLIER = 2;     // NORMAL RISK x2
const MAX_ATTEMPTS = 3;
const EARN_TABLE = [4, 3, 2]; // points per attempt index (multiplied by MULTIPLIER)
const LOSS_POINTS = -2 * MULTIPLIER;

// ─── State ───────────────────────────────────────────────────────────────────
const rooms = {};      // roomCode -> Room
const players = {};    // socketId -> { name, roomCode }

// ─── Leaderboard ─────────────────────────────────────────────────────────────
// File-based persistence so wins survive restarts (Render's free disk is
// ephemeral but persists for the lifetime of the running instance, which is
// good enough for now; swap for a real DB later if needed).
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = {
  allTime: {},           // playerName -> wins
  weekly: {},            // playerName -> wins (reset every Monday UTC)
  weeklyStartedAt: null, // ISO date of the Monday that started this week
};

function getMondayMidnightUtc(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();          // 0 Sun ... 6 Sat
  const offset = (day + 6) % 7;       // days since Monday (Mon=0, Sun=6)
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    leaderboard = {
      allTime: parsed.allTime || {},
      weekly: parsed.weekly || {},
      weeklyStartedAt: parsed.weeklyStartedAt || null,
    };
  } catch {
    // first run — keep defaults
  }
  ensureWeeklyFresh();
}

function saveLeaderboard() {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
  } catch (e) {
    console.error('Failed to save leaderboard:', e);
  }
}

function ensureWeeklyFresh() {
  const currentMonday = getMondayMidnightUtc(new Date()).toISOString();
  if (leaderboard.weeklyStartedAt !== currentMonday) {
    leaderboard.weekly = {};
    leaderboard.weeklyStartedAt = currentMonday;
    saveLeaderboard();
  }
}

function recordWin(playerName) {
  ensureWeeklyFresh();
  const name = (playerName || '').trim();
  if (!name) return;
  leaderboard.allTime[name] = (leaderboard.allTime[name] || 0) + 1;
  leaderboard.weekly[name] = (leaderboard.weekly[name] || 0) + 1;
  saveLeaderboard();
}

function getLeaderboard() {
  ensureWeeklyFresh();
  const toSorted = (map) =>
    Object.entries(map)
      .map(([name, wins]) => ({ name, wins }))
      .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 50);
  return {
    weekly: toSorted(leaderboard.weekly),
    allTime: toSorted(leaderboard.allTime),
    weeklyStartedAt: leaderboard.weeklyStartedAt,
  };
}

loadLeaderboard();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateSecretNumber() {
  const digits = [];
  while (digits.length < 5) {
    const d = Math.floor(Math.random() * 10);
    if (!digits.includes(d)) digits.push(d);
  }
  return digits.join('');
}

function generateSystemHints(secret) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const digits = [];
    while (digits.length < 5) {
      const d = Math.floor(Math.random() * 10);
      if (!digits.includes(d)) digits.push(d);
    }
    rows.push(digits.map((d, i) => cellFor(String(d), i, secret)));
  }
  return rows;
}

function cellFor(digit, index, secret) {
  if (secret[index] === digit) return { digit, status: 'exact' };
  if (secret.includes(digit)) return { digit, status: 'misplaced' };
  return { digit, status: 'absent' };
}

function checkGuess(secret, guess) {
  let exact = 0;
  let misplaced = 0;
  const cells = [];
  for (let i = 0; i < 5; i++) {
    const cell = cellFor(guess[i], i, secret);
    cells.push(cell);
    if (cell.status === 'exact') exact++;
    else if (cell.status === 'misplaced') misplaced++;
  }
  return { exact, misplaced, cells };
}

function calcPoints(attemptIndex, won) {
  if (!won) return LOSS_POINTS;
  const base = EARN_TABLE[attemptIndex] ?? 0;
  return base * MULTIPLIER;
}

function newRoom({ code, singlePlayer }) {
  return {
    code,
    maxAttempts: MAX_ATTEMPTS,
    state: 'waiting',         // waiting | choosing_number | playing | finished
    secretNumber: null,
    secretSetBy: null,        // 'system' | socketId
    currentTurn: null,
    turnIndex: 0,
    hintRows: [],
    systemHints: [],
    players: [],
    singlePlayer: !!singlePlayer,
  };
}

function newPlayer({ id, name }) {
  return { id, name, score: 0, attempts: 0, guesses: [] };
}

function getRoomInfo(room) {
  return {
    code: room.code,
    state: room.state,
    currentTurn: room.currentTurn,
    singlePlayer: room.singlePlayer,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      attempts: p.attempts,
      maxAttempts: room.maxAttempts,
    })),
    hintRows: room.hintRows,
    systemHints: room.systemHints || [],
  };
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── 1. CREATE ROOM (2-player) ─────────────────────────────────────────────
  socket.on('create_room', ({ playerName }) => {
    const code = generateRoomCode();
    rooms[code] = newRoom({ code, singlePlayer: false });
    rooms[code].players.push(newPlayer({ id: socket.id, name: playerName }));
    players[socket.id] = { name: playerName, roomCode: code };

    socket.join(code);
    socket.emit('room_created', { code });
    console.log(`🏠 Room created: ${code}`);
  });

  // ── 2. JOIN ROOM ──────────────────────────────────────────────────────────
  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (room.singlePlayer) return socket.emit('error', { message: 'Room not found.' });
    if (room.state !== 'waiting') return socket.emit('error', { message: 'Game already started.' });
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full.' });

    room.players.push(newPlayer({ id: socket.id, name: playerName }));
    players[socket.id] = { name: playerName, roomCode: code };
    socket.join(code);

    // Multiplayer fairness: server always picks the secret so neither
    // player can know it in advance.
    room.secretNumber = generateSecretNumber();
    room.secretSetBy = 'system';
    startGame(room);
    console.log(`👥 ${playerName} joined room: ${code} — system secret, starting`);
  });

  // ── 3. SINGLE PLAYER ──────────────────────────────────────────────────────
  socket.on('single_player', ({ playerName }) => {
    const code = generateRoomCode();
    const room = newRoom({ code, singlePlayer: true });
    room.players.push(newPlayer({ id: socket.id, name: playerName }));
    room.secretNumber = generateSecretNumber();
    room.secretSetBy = 'system';
    rooms[code] = room;
    players[socket.id] = { name: playerName, roomCode: code };
    socket.join(code);

    startGame(room);
    console.log(`🎮 Single-player room: ${code}`);
  });

  // ── 4. MAKE GUESS ─────────────────────────────────────────────────────────
  socket.on('make_guess', ({ guess }) => {
    const pInfo = players[socket.id];
    if (!pInfo) return;
    const room = rooms[pInfo.roomCode];
    if (!room || room.state !== 'playing') return socket.emit('error', { message: 'Game is not active.' });
    if (room.currentTurn !== socket.id) return socket.emit('error', { message: 'Not your turn.' });

    if (!/^\d{5}$/.test(guess) || new Set(guess).size !== 5) {
      return socket.emit('error', { message: 'Invalid guess. Enter 5 unique digits.' });
    }

    const player = room.players.find(p => p.id === socket.id);
    player.attempts++;
    player.guesses.push(guess);

    const result = checkGuess(room.secretNumber, guess);
    const won = result.exact === 5;

    const hintRow = {
      playerId: socket.id,
      playerName: player.name,
      guess,
      cells: result.cells,
      exact: result.exact,
      misplaced: result.misplaced,
      attemptNo: player.attempts,
    };
    room.hintRows.push(hintRow);

    if (won) {
      const points = calcPoints(player.attempts - 1, true);
      player.score += points;
      finishGame(room, { id: socket.id, name: player.name }, points, hintRow);
      return;
    }

    if (player.attempts >= room.maxAttempts) {
      const lostPoints = calcPoints(player.attempts - 1, false);
      player.score += lostPoints;

      if (room.singlePlayer) {
        finishGame(room, null, lostPoints, hintRow);
        return;
      }

      const otherPlayer = room.players.find(p => p.id !== socket.id);
      const otherFinished = otherPlayer.attempts >= room.maxAttempts;

      if (otherFinished) {
        finishGame(room, null, lostPoints, hintRow);
      } else {
        io.to(room.code).emit('guess_result', { hintRow, room: getRoomInfo(room) });
        switchTurn(room);
      }
      return;
    }

    io.to(room.code).emit('guess_result', { hintRow, room: getRoomInfo(room) });
    if (!room.singlePlayer) switchTurn(room);
  });

  // ── 5. LEADERBOARD ────────────────────────────────────────────────────────
  socket.on('request_leaderboard', () => {
    socket.emit('leaderboard_data', getLeaderboard());
  });

  // ── 6. DISCONNECT ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    const pInfo = players[socket.id];
    if (!pInfo) return;

    const room = rooms[pInfo.roomCode];
    if (room && room.state !== 'finished') {
      room.state = 'finished';
      if (!room.singlePlayer) {
        io.to(room.code).emit('opponent_disconnected', { name: pInfo.name });
      }
      delete rooms[pInfo.roomCode];
    }
    delete players[socket.id];
  });
});

// ─── Lifecycle helpers ───────────────────────────────────────────────────────
function startGame(room) {
  room.state = 'playing';
  room.currentTurn = room.players[0].id;
  room.systemHints = generateSystemHints(room.secretNumber);
  io.to(room.code).emit('game_started', {
    room: getRoomInfo(room),
    secretSetBy: room.secretSetBy === 'system' ? 'system' : 'player',
  });
}

function switchTurn(room) {
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.currentTurn = room.players[room.turnIndex].id;
  io.to(room.code).emit('turn_changed', {
    currentTurn: room.currentTurn,
    room: getRoomInfo(room),
  });
}

function finishGame(room, winner, pointsEarned, lastHint) {
  room.state = 'finished';
  if (winner && winner.name) {
    recordWin(winner.name);
    io.emit('leaderboard_data', getLeaderboard());
  }
  io.to(room.code).emit('game_over', {
    winner,
    secretNumber: room.secretNumber,
    pointsEarned,
    room: getRoomInfo(room),
    lastHint,
  });
}

// ─── Health endpoint ─────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'Number Challenge Backend running 🎮' }));
app.get('/leaderboard', (_, res) => res.json(getLeaderboard()));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server started: http://localhost:${PORT}`));
