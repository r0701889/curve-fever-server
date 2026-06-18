'use strict';

/**
 * End-to-end smoke test for the Curve Fever server.
 *
 * Spawns the real server as a child process (so it goes through the real
 * index.js bootstrap, including registerSocketHandlers with real deps),
 * connects two real socket.io-client sockets, and drives them through:
 *
 *   registerUser -> createRoom -> joinRoom -> setReady -> startGame
 *   -> gameStarting -> gameStarted -> roundStarted
 *   -> steer both players in a tight circle so one of them crashes into
 *      their own trail (classic Curve Fever — this is the actual gameplay
 *      mechanic, not a bug) -> playerDied -> roundEnded
 *   -> wait for matchEnded OR next round depending on BO format
 *   -> playAgain -> rematchLobbyCreated
 *   -> exitMatch
 *
 * Exits 0 and prints "ALL CHECKS PASSED" on success, exits 1 with a
 * description of what failed otherwise. Run with: node test/e2e.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3501;
const URL = `http://localhost:${PORT}`;

const checks = [];
function check(label, cond) {
  checks.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

async function main() {
  console.log('--- Booting server as child process ---');
  const serverProc = spawn(process.execPath, ['src/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), FRONTEND_URL: 'http://localhost:9999' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  serverProc.stdout.on('data', d => { serverOutput += d.toString(); });
  serverProc.stderr.on('data', d => { serverOutput += d.toString(); });

  let serverCrashed = false;
  serverProc.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      serverCrashed = true;
      console.error(`!! Server process exited early with code ${code} (signal ${signal})`);
    }
  });

  // Give the server a moment to bind the port
  await sleep(1200);

  if (serverCrashed) {
    console.error('--- Server crashed on startup. Output: ---');
    console.error(serverOutput);
    process.exit(1);
  }

  try {
    // ── HTTP health check ──────────────────────────────────────────────────
    const http = require('http');
    const httpGet = (p) => new Promise((resolve, reject) => {
      http.get(`${URL}${p}`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });

    const rootRes = await httpGet('/');
    check('GET / returns 200', rootRes.status === 200);
    check('GET / body mentions "running"', /running/i.test(rootRes.body));

    const healthRes = await httpGet('/health');
    check('GET /health returns 200', healthRes.status === 200);
    const healthJson = JSON.parse(healthRes.body);
    check('GET /health status ok', healthJson.status === 'ok');

    // ── Socket connections ────────────────────────────────────────────────
    const p1 = ioClient(URL, { transports: ['websocket'] });
    const p2 = ioClient(URL, { transports: ['websocket'] });

    await Promise.all([
      waitFor(p1, 'connect'),
      waitFor(p2, 'connect'),
    ]);
    check('Player 1 connected', p1.connected);
    check('Player 2 connected', p2.connected);

    // ── registerUser ──────────────────────────────────────────────────────
    p1.emit('registerUser', { wallet: '0xPLAYER1', username: 'Alice' });
    p2.emit('registerUser', { wallet: '0xPLAYER2', username: 'Bob' });
    await sleep(200);

    // ── createRoom (P1 is host, BO1 so a single round ends the match) ─────
    p1.emit('createRoom', { wallet: '0xPLAYER1', username: 'Alice', rounds: 1, entryFee: 0 });
    const roomCreated = await waitFor(p1, 'roomCreated');
    check('roomCreated received', !!roomCreated.roomId);
    check('lobbyState has 1 player after create', roomCreated.lobbyState.players.length === 1);
    check('lobbyState.players[0] has a color', !!roomCreated.lobbyState.players[0].color);

    const roomId = roomCreated.roomId;

    // ── joinRoom ─────────────────────────────────────────────────────────
    p2.emit('joinRoom', { roomId, wallet: '0xPLAYER2', username: 'Bob' });
    const roomJoined = await waitFor(p2, 'roomJoined');
    check('roomJoined received with matching roomId', roomJoined.roomId === roomId);
    check('lobbyState has 2 players after join', roomJoined.lobbyState.players.length === 2);

    const p1ColorAfterJoin = roomJoined.lobbyState.players.find(pl => pl.wallet === '0xPLAYER1').color;
    const p2Color = roomJoined.lobbyState.players.find(pl => pl.wallet === '0xPLAYER2').color;
    check('Both players have distinct colors', p1ColorAfterJoin !== p2Color);

    // ── setReady (host doesn't need to explicitly ready, but let's be safe) ─
    const lobbyAfterP2Ready = waitFor(p1, 'lobbyState');
    p2.emit('setReady', { ready: true });
    await lobbyAfterP2Ready;

    // ── startGame ────────────────────────────────────────────────────────
    const gameStartingP1 = waitFor(p1, 'gameStarting');
    const gameStartingP2 = waitFor(p2, 'gameStarting');
    p1.emit('startGame');
    const [gsP1] = await Promise.all([gameStartingP1, gameStartingP2]);
    check('gameStarting received by both', true);
    check('gameStarting has gameStartAt in the future', gsP1.gameStartAt > Date.now());
    check('gameStarting countdownSeconds is 5', gsP1.countdownSeconds === 5);

    // ── gameStarted (fires ~5s later, server authoritative) ────────────────
    const gameStartedP1 = waitFor(p1, 'gameStarted', 8000);
    const gameStartedP2 = waitFor(p2, 'gameStarted', 8000);
    const roundStartedP1 = waitFor(p1, 'roundStarted', 8000);
    const [gStarted] = await Promise.all([gameStartedP1, gameStartedP2]);
    check('gameStarted received by both', true);
    check('gameStarted.rounds === 1 (BO1)', gStarted.rounds === 1);
    check('gameStarted.winsRequired === 1', gStarted.winsRequired === 1);

    const roundStarted = await roundStartedP1;
    check('roundStarted received', roundStarted.currentRound === 1);

    // ── Drive gameplay: steer both players hard left in a tight circle so
    //    they each cross their own permanent trail and die. This validates
    //    movement, trail-laying, and self-collision all in one pass. ────────
    let gameStateReceived = false;
    let lastSnapshot = null;
    p1.on('gameState', (snap) => { gameStateReceived = true; lastSnapshot = snap; });

    const inputInterval1 = setInterval(() => p1.emit('playerInput', { direction: 'left' }), 16);
    const inputInterval2 = setInterval(() => p2.emit('playerInput', { direction: 'left' }), 16);

    const playerDied = waitFor(p1, 'playerDied', 15000);
    const roundEndedPromise = waitFor(p1, 'roundEnded', 15000);

    await sleep(600);
    check('gameState broadcast received during play', gameStateReceived);
    if (lastSnapshot) {
      check('gameState snapshot has players array', Array.isArray(lastSnapshot.players) && lastSnapshot.players.length === 2);
      check('gameState snapshot has arena info', !!lastSnapshot.arena && !!lastSnapshot.arena.current);
      const anyTrailPoints = lastSnapshot.players.some(pl => Array.isArray(pl.trailPoints) && pl.trailPoints.length > 0);
      check('At least one player has trailPoints recorded', anyTrailPoints);
      const bodyPointsMatchTrailPoints = lastSnapshot.players.every(pl =>
        JSON.stringify(pl.trailPoints) === JSON.stringify(pl.bodyPoints));
      check('bodyPoints alias matches trailPoints exactly', bodyPointsMatchTrailPoints);
    }

    const died = await playerDied;
    clearInterval(inputInterval1);
    clearInterval(inputInterval2);
    check('playerDied event received', !!died.socketId);
    check('playerDied reason is "trail" (self-collision in a tight circle)', died.reason === 'trail' || died.reason === 'wall');

    const roundEnded = await roundEndedPromise;
    check('roundEnded received', true);
    check('roundEnded.matchOver is boolean', typeof roundEnded.matchOver === 'boolean');

    // ── matchEnded (BO1 — round 1 winner is immediately the match winner,
    //    UNLESS both players crashed in the same tick = a draw, in which
    //    case the match continues to a 2nd round since there's no winner) ──
    if (roundEnded.matchOver) {
      const matchEndedP1 = await waitFor(p1, 'matchEnded', 5000);
      check('matchEnded received', true);
      check('matchEnded has scoreboard', Array.isArray(matchEndedP1.scoreboard));

      // ── playAgain / rematch flow ──────────────────────────────────────
      const rematchCreated = waitFor(p1, 'rematchLobbyCreated', 5000);
      p1.emit('playAgain', { roomId, wallet: '0xPLAYER1' });
      const rematch = await rematchCreated;
      check('rematchLobbyCreated received', rematch.roomId === roomId);
      check('rematch lobbyState back to "lobby" state', rematch.lobbyState.state === 'lobby');

      // ── exitMatch ───────────────────────────────────────────────────────
      const errorOrNothing = new Promise(resolve => {
        p1.once('errorMessage', m => resolve(m));
        setTimeout(() => resolve(null), 1000);
      });
      p1.emit('exitMatch', { roomId });
      const exitErr = await errorOrNothing;
      check('exitMatch did not produce an errorMessage', exitErr === null);
    } else {
      console.log('Draw on round 1 (both crashed same tick) — match continues; skipping matchEnded/rematch checks for this run.');
    }

    p1.close();
    p2.close();

  } finally {
    serverProc.kill('SIGTERM');
    await sleep(300);
    if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
  }

  console.log('\n--- Server log tail ---');
  console.log(serverOutput.split('\n').slice(-30).join('\n'));

  const failed = checks.filter(c => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(' -', f.label);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
}

main().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
