'use strict';

const { RoomManager } = require('./RoomManager');
const { VALID_ROUNDS, DEFAULT_ROUNDS } = require('../game/constants');

/**
 * ── Client → Server ───────────────────────────────────────────────────────────
 *
 *   createRoom   { wallet, username?, rounds?, entryFee? }
 *   joinRoom     { roomId, wallet, username? }
 *   setRounds    { rounds }                        host only, lobby only
 *   setReady     { ready }
 *   startGame    (no payload)                      host only
 *   playerInput  { direction }                     'left'|'right'|'neutral'
 *   playAgain    { roomId, wallet }                after matchEnded
 *   exitMatch    { roomId, wallet }                after matchEnded
 *
 * ── Server → Client ───────────────────────────────────────────────────────────
 *
 *   roomCreated          { roomId, lobbyState }
 *   roomJoined           { roomId, lobbyState }
 *   lobbyState           { roomId, hostId, state, entryFee, matchId, rounds,
 *                          winsRequired, currentRound, scoreboard, players }
 *   gameStarted          { roomId, rounds, winsRequired, scoreboard, players }
 *   roundStarted         { roomId, currentRound, rounds, winsRequired, scoreboard }
 *   gameState            { tick, players, trails, scoreboard, powerUps }  — 60×/sec
 *   playerDied           { socketId, wallet, reason }
 *   scoreboardUpdate     { scoreboard }
 *   roundEnded           { roomId, roundWinnerWallet, roundWinnerId, draw,
 *                          scoreboard, currentRound, rounds, winsRequired,
 *                          matchOver, nextRoundStartsAt, countdownSeconds }
 *   matchEnded           { roomId, winnerWallet, winnerId, draw,
 *                          scoreboard, totalRounds, rounds }
 *   rematchLobbyCreated  { roomId, lobbyState }    — broadcast to room when first
 *                                                     player clicks playAgain
 *   rematchJoined        { roomId, lobbyState }    — sent to joining player only
 *   lobbyFull            { message }               — sent when rematch lobby full
 *   powerUpsUpdate       { powerUps }
 *   powerUpCollected     { socketId, playerWallet, playerUsername, type, duration }
 *   powerUpExpired       { socketId, playerWallet, type }
 *   powerUpUsed          { socketId, playerWallet, type }
 *   errorMessage         { message }
 *
 * ── Scoreboard format ────────────────────────────────────────────────────────
 *
 *   [{ wallet, username, color, wins, alive, rank, activePowerUp }]
 *   activePowerUp: { type, remainingMs } | null
 */
function registerSocketHandlers(io) {
  const manager = new RoomManager(io);

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── createRoom ─────────────────────────────────────────────────────────────
    socket.on('createRoom', (payload = {}) => {
      const { wallet, username, rounds, entryFee } = payload;
      console.log(`[Socket] createRoom — socket: ${socket.id}, wallet: ${JSON.stringify(wallet)}, rounds: ${rounds}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}".` });
      }

      const validatedRounds   = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
      const validatedFee      = Number.isInteger(entryFee) && entryFee >= 0 ? entryFee : 0;
      const validatedUsername = sanitizeUsername(username, wallet);

      const result = manager.createRoom(socket.id, wallet, validatedUsername, validatedRounds, validatedFee);
      if (!result.ok) return socket.emit('errorMessage', { message: result.error });

      const { room } = result;
      socket.join(room.roomId);
      socket.emit('roomCreated', { roomId: room.roomId, lobbyState: room.getLobbyState() });
      console.log(`[Socket] ${validatedUsername} (${wallet}) created room ${room.roomId}`);
    });

    // ── joinRoom ───────────────────────────────────────────────────────────────
    socket.on('joinRoom', (payload = {}) => {
      const { roomId, wallet, username } = payload;
      console.log(`[Socket] joinRoom — socket: ${socket.id}, roomId: ${JSON.stringify(roomId)}, wallet: ${JSON.stringify(wallet)}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}".` });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const validatedUsername = sanitizeUsername(username, wallet);
      const result = manager.joinRoom(socket.id, roomId.toUpperCase(), wallet, validatedUsername);
      if (!result.ok) return socket.emit('errorMessage', { message: result.error });

      const { room } = result;
      socket.join(room.roomId);
      socket.emit('roomJoined', { roomId: room.roomId, lobbyState: room.getLobbyState() });
      console.log(`[Socket] ${validatedUsername} (${wallet}) joined room ${room.roomId}`);
    });

    // ── setRounds ──────────────────────────────────────────────────────────────
    socket.on('setRounds', (payload = {}) => {
      const room = manager.getRoomForSocket(socket.id);
      if (!room) return socket.emit('errorMessage', { message: 'You are not in a room' });
      room.setRounds(socket.id, payload.rounds);
    });

    // ── setReady ───────────────────────────────────────────────────────────────
    socket.on('setReady', (payload = {}) => {
      console.log(`[Socket] setReady — socket: ${socket.id}, ready: ${payload.ready}`);
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] setReady failed — ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.setReady(socket.id, payload.ready);
    });

    // ── startGame ──────────────────────────────────────────────────────────────
    socket.on('startGame', () => {
      console.log(`[Socket] startGame — socket: ${socket.id}`);
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] startGame failed — ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.startGame(socket.id);
    });

    // ── playerInput ────────────────────────────────────────────────────────────
    socket.on('playerInput', (payload = {}) => {
      const room = manager.getRoomForSocket(socket.id);
      if (!room) return;
      room.handleInput(socket.id, payload.direction);
    });

    // ── playAgain ──────────────────────────────────────────────────────────────
    // Payload: { roomId: string, wallet: string }
    // Player wants to rematch after matchEnded.
    socket.on('playAgain', (payload = {}) => {
      const { roomId, wallet } = payload;
      console.log(`[Socket] playAgain — socket: ${socket.id}, roomId: ${roomId}, wallet: ${wallet}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'Invalid wallet address' });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const result = manager.playAgain(socket.id, wallet);

      if (!result.ok) {
        if (result.error === 'Lobby is full') {
          // Use dedicated lobbyFull event as specified
          return socket.emit('lobbyFull', { message: 'Lobby is full' });
        }
        return socket.emit('errorMessage', { message: result.error });
      }
    });

    // ── exitMatch ──────────────────────────────────────────────────────────────
    // Payload: { roomId: string, wallet: string }
    // Player explicitly leaves the ended/rematch room.
    socket.on('exitMatch', (payload = {}) => {
      const { roomId, wallet } = payload;
      console.log(`[Socket] exitMatch — socket: ${socket.id}, roomId: ${roomId}, wallet: ${wallet}`);

      const result = manager.exitMatch(socket.id);
      if (!result.ok) {
        return socket.emit('errorMessage', { message: result.error ?? 'Could not exit room' });
      }

      // Leave the Socket.io room channel
      if (roomId) socket.leave(roomId.toUpperCase());
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
      manager.removePlayer(socket.id);
    });
  });

  // ── Periodic stats ─────────────────────────────────────────────────────────
  setInterval(() => {
    if (manager.activeRoomCount > 0 || manager.connectedPlayers > 0) {
      console.log(`[Stats] Rooms: ${manager.activeRoomCount} | Players: ${manager.connectedPlayers}`);
    }
  }, 30_000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidWallet(wallet) {
  return typeof wallet === 'string' && wallet.trim().length > 0;
}

function sanitizeUsername(username, wallet) {
  if (typeof username === 'string' && username.trim().length > 0) {
    return username.trim().slice(0, 20);
  }
  const w = String(wallet);
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

module.exports = { registerSocketHandlers };
