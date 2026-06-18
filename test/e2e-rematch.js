'use strict';

/**
 * Second e2e pass — specifically forces an ASYMMETRIC death (only Player 1
 * steers into their own trail; Player 2 goes mostly straight) so the round
 * has a clear winner, letting us validate the matchEnded -> playAgain ->
 * rematchLobbyCreated -> joinRoom(rematch) -> exitMatch chain that the
 * first e2e run's simultaneous-draw didn't exercise.
 */

const path = require('path');
const { spawn } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3502;
const URL = `http://localhost:${PORT}`;

const checks = [];
function check(label, cond) {
  checks.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeoutMs = 10000) {
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
  const serverProc = spawn(process.execPath, ['src/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), FRONTEND_URL: 'http://localhost:9999' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  serverProc.stdout.on('data', d => { serverOutput += d.toString(); });
  serverProc.stderr.on('data', d => { serverOutput += d.toString(); });

  await sleep(1200);

  try {
    const p1 = ioClient(URL, { transports: ['websocket'] });
    const p2 = ioClient(URL, { transports: ['websocket'] });
    await Promise.all([waitFor(p1, 'connect'), waitFor(p2, 'connect')]);

    p1.emit('registerUser', { wallet: '0xALICE', username: 'Alice' });
    p2.emit('registerUser', { wallet: '0xBOB', username: 'Bob' });
    await sleep(150);

    p1.emit('createRoom', { wallet: '0xALICE', username: 'Alice', rounds: 1, entryFee: 0 });
    const { roomId } = await waitFor(p1, 'roomCreated');

    p2.emit('joinRoom', { roomId, wallet: '0xBOB', username: 'Bob' });
    await waitFor(p2, 'roomJoined');

    const lobbyAfterReady = waitFor(p1, 'lobbyState');
    p2.emit('setReady', { ready: true });
    await lobbyAfterReady;

    const gStartingBoth = Promise.all([waitFor(p1, 'gameStarting'), waitFor(p2, 'gameStarting')]);
    p1.emit('startGame');
    await gStartingBoth;

    await Promise.all([waitFor(p1, 'gameStarted', 8000), waitFor(p2, 'gameStarted', 8000)]);
    await waitFor(p1, 'roundStarted', 8000);

    // Only Player 1 turns hard left (will hit own trail quickly).
    // Player 2 stays neutral (goes straight until it hits a wall eventually,
    // but should take much longer) — this should produce a clean single
    // winner rather than a simultaneous draw.
    const p1Interval = setInterval(() => p1.emit('playerInput', { direction: 'left' }), 16);
    p2.emit('playerInput', { direction: 'neutral' });

    // Register the matchEnded listener BEFORE awaiting roundEnded — for a
    // BO1 match with a real winner, Room emits roundEnded and then
    // synchronously calls _endMatch() (which emits matchEnded) in the same
    // tick, so a listener attached only after roundEnded resolves can miss it.
    const matchEndedPromise = waitFor(p1, 'matchEnded', 5000);
    const roundEnded = await waitFor(p1, 'roundEnded', 15000);
    clearInterval(p1Interval);

    check('roundEnded received', true);
    check('roundEnded is NOT a draw (asymmetric death produced a winner)', roundEnded.draw === false);
    check('roundEnded.matchOver is true for BO1 with a real winner', roundEnded.matchOver === true);
    check('Winner is Bob (Alice circled into her own trail)', roundEnded.roundWinnerWallet === '0xBOB');

    const matchEnded = await matchEndedPromise;
    check('matchEnded received', true);
    check('matchEnded.winnerWallet matches round winner', matchEnded.winnerWallet === '0xBOB');
    check('matchEnded.draw is false', matchEnded.draw === false);
    check('matchEnded.scoreboard sorted — Bob ranked above Alice', (() => {
      const bob = matchEnded.scoreboard.find(s => s.wallet === '0xBOB');
      const alice = matchEnded.scoreboard.find(s => s.wallet === '0xALICE');
      return bob.wins === 1 && alice.wins === 0 && bob.rank === 1;
    })());

    // ── Rematch flow: Bob initiates, Alice joins the new lobby ────────────
    const rematchCreatedBob = waitFor(p2, 'rematchLobbyCreated', 5000);
    p2.emit('playAgain', { roomId, wallet: '0xBOB' });
    const rematchCreated = await rematchCreatedBob;
    check('rematchLobbyCreated fired for the initiator', rematchCreated.roomId === roomId);
    check('rematch lobby has exactly 1 player (Bob) so far', rematchCreated.lobbyState.players.length === 1);
    check('rematch wins reset to 0', rematchCreated.lobbyState.scoreboard.every(s => s.wins === 0));

    const rematchJoinedAlice = waitFor(p1, 'rematchJoined', 5000);
    p1.emit('playAgain', { roomId, wallet: '0xALICE' });
    const aliceJoin = await rematchJoinedAlice;
    check('rematchJoined fired for the second player', aliceJoin.roomId === roomId);
    check('rematch lobby now has 2 players', aliceJoin.lobbyState.players.length === 2);

    // ── Security check: a wallet that was never in the original match
    //    must be rejected from the rematch. Mallory's socket was never
    //    associated with this room at all (no createRoom/joinRoom call),
    //    so RoomManager's own "are you in a room" guard rejects her before
    //    Room.playAgain's eligibleWallets check even runs — still a correct
    //    rejection, just via a different errorMessage than the in-room
    //    "you weren't part of this match" case. Either way, the contract
    //    under test is: an outsider can never get into the rematch lobby.
    const p3 = ioClient(URL, { transports: ['websocket'] });
    await waitFor(p3, 'connect');
    p3.emit('registerUser', { wallet: '0xMALLORY', username: 'Mallory' });
    await sleep(100);
    const errPromise = waitFor(p3, 'errorMessage', 3000);
    p3.emit('playAgain', { roomId, wallet: '0xMALLORY' });
    const err = await errPromise;
    check(
      'Ineligible wallet rejected from rematch lobby',
      /not part of this match/i.test(err.message) || /not in a room/i.test(err.message)
    );
    p3.close();

    // ── exitMatch cleanup ───────────────────────────────────────────────
    p1.emit('exitMatch', { roomId });
    p2.emit('exitMatch', { roomId });
    await sleep(300);

    p1.close();
    p2.close();
  } finally {
    serverProc.kill('SIGTERM');
    await sleep(300);
    if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
  }

  console.log('\n--- Server log tail ---');
  console.log(serverOutput.split('\n').slice(-25).join('\n'));

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
