// End-to-end smoke test for the Number Challenge backend.
// Runs a single-player game, exhausts attempts, asserts payload shape.

const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const TIMEOUT_MS = 8000;

function assert(cond, msg) {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  console.log('✓ ' + msg);
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      TIMEOUT_MS
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

(async () => {
  const socket = io(URL, { transports: ['websocket'] });
  await once(socket, 'connect');
  console.log('Connected as', socket.id);

  // 1. Single-player start
  socket.emit('single_player', { playerName: 'SmokeBot' });
  const start = await once(socket, 'game_started');

  assert(start.room.state === 'playing', 'state is playing on start');
  assert(start.room.singlePlayer === true, 'room flagged singlePlayer');
  assert(start.secretSetBy === 'system', 'secret set by system');
  assert(Array.isArray(start.room.systemHints), 'systemHints is an array');
  assert(start.room.systemHints.length === 3, 'systemHints has 3 rows');
  assert(
    start.room.systemHints.every(
      (row) => Array.isArray(row) && row.length === 5
    ),
    'every systemHint row has 5 cells'
  );
  assert(
    start.room.systemHints.every((row) =>
      row.every((c) => ['exact', 'misplaced', 'absent'].includes(c.status))
    ),
    'every cell has a valid status'
  );
  assert(start.room.players.length === 1, 'single player roster has 1 entry');
  assert(
    start.room.players[0].maxAttempts === 3,
    'maxAttempts hardcoded to 3'
  );

  // 2. First guess — verify hintRow.cells shape
  socket.emit('make_guess', { guess: '12345' });
  const r1 = await once(socket, 'guess_result');
  const h1 = r1.hintRow;
  assert(h1.guess === '12345', 'guess echoed');
  assert(h1.attemptNo === 1, 'attemptNo=1');
  assert(Array.isArray(h1.cells) && h1.cells.length === 5, 'cells length 5');
  assert(
    h1.cells.every(
      (c) => /^\d$/.test(c.digit) &&
        ['exact', 'misplaced', 'absent'].includes(c.status)
    ),
    'cells well-formed (digit + status)'
  );
  const computedExact = h1.cells.filter((c) => c.status === 'exact').length;
  const computedMisplaced = h1.cells.filter(
    (c) => c.status === 'misplaced'
  ).length;
  assert(
    computedExact === h1.exact && computedMisplaced === h1.misplaced,
    `cells totals match: exact=${h1.exact} misplaced=${h1.misplaced}`
  );
  assert(
    r1.room.hintRows.length === 1,
    'room.hintRows has 1 entry after first guess'
  );

  // 3. Second guess — still continuing
  socket.emit('make_guess', { guess: '67890' });
  const r2 = await once(socket, 'guess_result');
  assert(r2.hintRow.attemptNo === 2, 'attemptNo=2');
  assert(r2.room.hintRows.length === 2, 'room.hintRows has 2 entries');

  // 4. Third guess — should trigger game_over (out of attempts)
  socket.emit('make_guess', { guess: '13579' });
  const end = await once(socket, 'game_over');
  assert(end.room.state === 'finished', 'state is finished');
  assert(end.winner === null, 'no winner (out of attempts)');
  assert(/^\d{5}$/.test(end.secretNumber), 'secretNumber revealed (5 digits)');
  assert(
    new Set(end.secretNumber).size === 5,
    'secretNumber has 5 unique digits'
  );
  assert(end.room.hintRows.length === 3, 'room.hintRows has 3 entries at end');

  console.log('\nAll assertions passed.');
  socket.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
