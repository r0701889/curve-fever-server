'use strict';

/**
 * E2E test for a multi-round match (BO3): verifies setRounds, and that
 * after round 1 ends without the match being over, the room automatically
 * starts round 2 after BETWEEN_ROUNDS_DELAY_MS — exercising the
 * 'between_rounds' state and the _startRound() re-entry path that none of
 * the other e2e tests (all BO1) ever reach.
 */

const path = require('path');
const { spawn } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3507;
const URL = `http://localhost:${PORT}`;

const checks = [];
function check(label, cond) {
  checks.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeoutMs = 16000) {
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

    // ── Guard: non-host cannot change rounds ────────────────────────────
    const nonHostErr = waitFor(p2, 'errorMessage', 3000);
    p2.emit('setRounds', { rounds: 5 });
    const err1 = await nonHostErr;
    check('Non-host setRounds is rejected', /only the host/i.test(err1.message));

    // ── Guard: invalid rounds value rejected ────────────────────────────
    const invalidErr = waitFor(p1, 'errorMessage', 3000);
    p1.emit('setRounds', { rounds: 4 }); // not in VALID_ROUNDS [1,3,5,7,9]
    const err2 = await invalidErr;
    check('Invalid rounds value rejected', /invalid rounds/i.test(err2.message));

    // ── Host sets BO3 ────────────────────────────────────────────────────
    const lobbyAfterRounds = waitFor(p1, 'lobbyState', 3000);
    p1.emit('setRounds', { rounds: 3 });
    const lobbyRounds = await lobbyAfterRounds;
    check('Host setRounds(3) updates lobby', lobbyRounds.rounds === 3 && lobbyRounds.winsRequired === 2);

    const lobbyAfterReady = waitFor(p1, 'lobbyState');
    p2.emit('setReady', { ready: true });
    await lobbyAfterReady;

    const gStartingBoth = Promise.all([waitFor(p1, 'gameStarting'), waitFor(p2, 'gameStarting')]);
    p1.emit('startGame');
    await gStartingBoth;

    // gameStarted and the first roundStarted are emitted synchronously,
    // back-to-back, in the same tick (_actuallyStartGame calls _startRound()
    // directly) — register both listeners before awaiting either, or a
    // roundStarted listener attached only after gameStarted resolves can
    // miss the event entirely.
    const roundStarted1Promise = waitFor(p1, 'roundStarted', 8000);
    const gStarted = await waitFor(p1, 'gameStarted', 8000);
    check('gameStarted reflects BO3 (rounds=3, winsRequired=2)', gStarted.rounds === 3 && gStarted.winsRequired === 2);

    await roundStarted1Promise;

    const p1Interval1 = setInterval(() => p1.emit('playerInput', { direction: 'left' }), 16);
    const roundEnded1 = await waitFor(p1, 'roundEnded', 15000);
    clearInterval(p1Interval1);

    check('Round 1 ended with a winner (not a draw)', roundEnded1.draw === false);
    check('Round 1: matchOver is FALSE (BO3 needs 2 wins, this is the 1st)', roundEnded1.matchOver === false);
    check('Round 1: nextRoundStartsAt is set', typeof roundEnded1.nextRoundStartsAt === 'number');
    check('Round 1 winner has 1 win on the roundEnded scoreboard', (() => {
      const winnerEntry = roundEnded1.scoreboard.find(s => s.wallet === roundEnded1.roundWinnerWallet);
      return winnerEntry && winnerEntry.wins === 1;
    })());

    const roundStarted2 = await waitFor(p1, 'roundStarted', 16000);
    check('Round 2 (roundStarted) fires automatically after round 1', roundStarted2.currentRound === 2);
    check('Round 2 roundStarted still reports rounds=3/winsRequired=2', roundStarted2.rounds === 3 && roundStarted2.winsRequired === 2);

    const p1Interval2 = setInterval(() => p1.emit('playerInput', { direction: 'left' }), 16);
    const matchEndedPromise = waitFor(p1, 'matchEnded', 5000);
    const roundEnded2 = await waitFor(p1, 'roundEnded', 15000);
    clearInterval(p1Interval2);

    check('Round 2 also ended with a winner', roundEnded2.draw === false);

    if (roundEnded2.matchOver) {
      const matchEnded = await matchEndedPromise;
      check('Match ended after round 2 (Bob reached winsRequired=2)', matchEnded.winnerWallet === '0xBOB');
      const bobEntry = matchEnded.scoreboard.find(s => s.wallet === '0xBOB');
      check('Final scoreboard shows Bob with 2 wins', bobEntry?.wins === 2);
    } else {
      console.log('Round 2 ended in a draw (no winner credited) — match continues; skipping matchEnded check.');
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
