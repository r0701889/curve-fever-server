'use strict';

const { RoomManager } = require('./RoomManager');
const { VALID_ROUNDS, DEFAULT_ROUNDS } = require('../game/constants');

/**
 * Registers all Socket.io event handlers.
 *
 * Client → Server events:
 *   createRoom    { wallet, rounds? }
 *   joinRoom      { roomId, wallet }
 *   setRounds     { rounds }           host only, lobby only
 *   setReady      { ready }
 *   startGame     (no payload)
 *   playerInput   { direction }
 *
 * Server → Client events:
 *   roomCreated   { roomId, lobbyState }
 *   roomJoined    { roomId, lobbyState }
 *   lobbyState    { roomId, hostId, state, entryFee, matchId, rounds,
 *                   winsRequired, currentRound, scores, players }
 *   gameStarted   { roomId, rounds, winsRequired, players }
 *   roundStarted  { roomId, currentRound, rounds, winsRequired, scores }
 *   gameState     { tick, players, trails }              — 30×/sec
 *   playerDied    { socketId, wallet, reason }
 *   roundEnded    { roomId, roundWinnerWallet, roundWinnerId, draw,
 *                   scores, currentRound, rounds, winsRequired, matchOver }
 *   matchEnded    { roomId, winnerWallet, winnerId, draw,
 *                   scores, totalRounds, rounds }
 *   errorMessage  { message }
 */
function registerSocketHandlers(io) {
  const manager = new RoomManager(io);

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── createRoom ─────────────────────────────────────────────────────────────
    // Payload: { wallet: string, rounds?: 1|3|5|7|9, entryFee?: number }
    socket.on('createRoom', (payload = {}) => {
      const { wallet, rounds, entryFee } = payload;
      console.log(`[Socket] createRoom — socket: ${socket.id}, wallet: ${JSON.stringify(wallet)}, rounds: ${rounds}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', {
          message: `Invalid wallet address: "${wallet}". Expected a non-empty string.`,
        });
      }

      // Validate rounds — fall back to default if not provided or invalid
      const validatedRounds = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
      const validatedFee    = Number.isInteger(entryFee) && entryFee >= 0 ? entryFee : 0;

      const result = manager.createRoom(socket.id, wallet, validatedRounds, validatedFee);
      if (!result.ok) {
        return socket.emit('errorMessage', { message: result.error });
      }

      const { room } = result;
      socket.join(room.roomId);

      socket.emit('roomCreated', {
        roomId:     room.roomId,
        lobbyState: room.getLobbyState(),
      });

      console.log(`[Socket] ${wallet} created room ${room.roomId} — BO${validatedRounds}`);
    });

    // ── joinRoom ───────────────────────────────────────────────────────────────
    // Payload: { roomId: string, wallet: string }
    socket.on('joinRoom', (payload = {}) => {
      const { roomId, wallet } = payload;
      console.log(`[Socket] joinRoom — socket: ${socket.id}, roomId: ${JSON.stringify(roomId)}, wallet: ${JSON.stringify(wallet)}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', {
          message: `Invalid wallet address: "${wallet}". Expected a non-empty string.`,
        });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const result = manager.joinRoom(socket.id, roomId.toUpperCase(), wallet);
      if (!result.ok) {
        return socket.emit('errorMessage', { message: result.error });
      }

      const { room } = result;
      socket.join(room.roomId);

      socket.emit('roomJoined', {
        roomId:     room.roomId,
        lobbyState: room.getLobbyState(),
      });

      console.log(`[Socket] ${wallet} joined room ${room.roomId}`);
    });

    // ── setRounds ──────────────────────────────────────────────────────────────
    // Host changes the BO format while in the lobby.
    // Payload: { rounds: 1|3|5|7|9 }
    socket.on('setRounds', (payload = {}) => {
      const { rounds } = payload;
      console.log(`[Socket] setRounds — socket: ${socket.id}, rounds: ${rounds}`);

      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }

      room.setRounds(socket.id, rounds);
    });

    // ── setReady ───────────────────────────────────────────────────────────────
    // Payload: { ready: boolean }
    socket.on('setReady', (payload = {}) => {
      const { ready } = payload;
      console.log(`[Socket] setReady — socket: ${socket.id}, ready: ${ready}`);

      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] setReady failed — socket ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }

      room.setReady(socket.id, ready);
    });

    // ── startGame ──────────────────────────────────────────────────────────────
    // No payload — host only
    socket.on('startGame', () => {
      console.log(`[Socket] startGame — socket: ${socket.id}`);

      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] startGame failed — socket ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }

      room.startGame(socket.id);
    });

    // ── playerInput ────────────────────────────────────────────────────────────
    // Payload: { direction: 'left' | 'right' | 'neutral' }
    socket.on('playerInput', (payload = {}) => {
      const { direction } = payload;
      const room = manager.getRoomForSocket(socket.id);
      if (!room) return;   // silently ignore stale inputs
      room.handleInput(socket.id, direction);
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

module.exports = { registerSocketHandlers };
