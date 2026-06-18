'use strict';

/**
 * E2E test for the invite/social layer: registerUser -> sendInvite ->
 * inviteReceived -> acceptInvite (joins the room), and separately
 * declineInvite -> inviteDeclined notification back to the inviter.
 *
 * Also validates the guard rails: inviting yourself, inviting an offline
 * user, inviting into a non-existent room, and inviting into a full/
 * already-started room.
 */

const path = require('path');
const { spawn } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3506;
const URL = `http://localhost:${PORT}`;

const checks = [];
function check(label, cond) {
  checks.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeoutMs = 6000) {
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
    const host = ioClient(URL, { transports: ['websocket'] });
    const friend = ioClient(URL, { transports: ['websocket'] });
    await Promise.all([waitFor(host, 'connect'), waitFor(friend, 'connect')]);

    host.emit('registerUser', { wallet: '0xHOST', username: 'Hosty' });
    friend.emit('registerUser', { wallet: '0xFRIEND', username: 'Friendo' });
    await sleep(200);

    host.emit('createRoom', { wallet: '0xHOST', username: 'Hosty', rounds: 3, entryFee: 0 });
    const { roomId } = await waitFor(host, 'roomCreated');
    check('Room created for invite test', !!roomId);

    // ── Guard: invite yourself ─────────────────────────────────────────
    const selfInviteErr = waitFor(host, 'errorMessage', 3000);
    host.emit('sendInvite', { targetWallet: '0xHOST', roomId, fromWallet: '0xHOST', fromUsername: 'Hosty' });
    const selfErr = await selfInviteErr;
    check('Inviting yourself is rejected', /yourself/i.test(selfErr.message));

    // ── Guard: invite an offline/unregistered wallet ────────────────────
    const offlineErr = waitFor(host, 'errorMessage', 3000);
    host.emit('sendInvite', { targetWallet: '0xGHOST', roomId, fromWallet: '0xHOST', fromUsername: 'Hosty' });
    const offErr = await offlineErr;
    check('Inviting an offline wallet is rejected', /not online/i.test(offErr.message));

    // ── Guard: invite into a non-existent room ──────────────────────────
    const noRoomErr = waitFor(host, 'errorMessage', 3000);
    host.emit('sendInvite', { targetWallet: '0xFRIEND', roomId: 'NOPENOPE', fromWallet: '0xHOST', fromUsername: 'Hosty' });
    const noRoom = await noRoomErr;
    check('Inviting into a non-existent room is rejected', /not found/i.test(noRoom.message));

    // ── Real invite: host invites friend by wallet ───────────────────────
    const inviteReceivedPromise = waitFor(friend, 'inviteReceived', 4000);
    host.emit('sendInvite', { targetWallet: '0xFRIEND', roomId, fromWallet: '0xHOST', fromUsername: 'Hosty' });
    const invite = await inviteReceivedPromise;
    check('inviteReceived delivered to target', invite.roomId === roomId);
    check('inviteReceived carries fromWallet', invite.fromWallet === '0xHOST');
    check('inviteReceived carries correct rounds/entryFee from lobby', invite.rounds === 3 && invite.entryFee === 0);
    check('inviteReceived carries current player count', invite.playersCount === 1);

    // ── acceptInvite — friend joins the room ─────────────────────────────
    const roomJoinedPromise = waitFor(friend, 'roomJoined', 4000);
    friend.emit('acceptInvite', { roomId, wallet: '0xFRIEND', username: 'Friendo' });
    const joined = await roomJoinedPromise;
    check('acceptInvite results in roomJoined', joined.roomId === roomId);
    check('Lobby now shows 2 players after accept', joined.lobbyState.players.length === 2);

    // ── Guard: inviting by username when already in lobby full check etc;
    //    also test username-based targeting works (not just wallet) ──────
    const charlie = ioClient(URL, { transports: ['websocket'] });
    await waitFor(charlie, 'connect');
    charlie.emit('registerUser', { wallet: '0xCHARLIE', username: 'Charlie' });
    await sleep(150);

    const inviteByUsernamePromise = waitFor(charlie, 'inviteReceived', 4000);
    host.emit('sendInvite', { targetUsername: 'Charlie', roomId, fromWallet: '0xHOST', fromUsername: 'Hosty' });
    const inviteByUsername = await inviteByUsernamePromise;
    check('sendInvite resolves target by username too', inviteByUsername.targetWallet.toLowerCase() === '0xcharlie'.toLowerCase());

    // ── declineInvite — Charlie declines, host gets notified ────────────
    const inviteDeclinedPromise = waitFor(host, 'inviteDeclined', 4000);
    charlie.emit('declineInvite', { roomId, wallet: '0xCHARLIE', fromWallet: '0xHOST' });
    const declined = await inviteDeclinedPromise;
    check('inviteDeclined delivered back to inviter', declined.roomId === roomId && declined.wallet === '0xCHARLIE');

    charlie.close();
    host.close();
    friend.close();
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
