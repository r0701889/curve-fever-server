'use strict';

const { RoomManager } = require('./RoomManager');

/**
 * Registers all Socket.io event handlers on the given `io` server instance.
 * All game logic is delegated to RoomManager and Room.
 *
 * @param {import('socket.io').Server} io
 */
function registerSocketHandlers(io) {
  const manager = new RoomManager(io);

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── createRoom ────────────────────────────────────────────────────────────
    // Payload: { wallet: string }
    socket.on('createRoom', (payload = {}) => {
      const { wallet } = payload;
      console.log(`[Socket] createRoom received — socket: ${socket.id}, wallet: ${JSON.stringify(wallet)}`);

      if (!isValidWallet(wallet)) {
        console.warn(`[Socket] createRoom rejected — invalid wallet: ${JSON.stringify(wallet)}`);
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}". Expected a non-empty string.` });
      }

      const result = manager.createRoom(socket.id, wallet);
      if (!result.ok) {
        console.warn(`[Socket] createRoom failed — ${result.error}`);
        return socket.emit('errorMessage', { message: result.error });
      }

      const { room } = result;
      socket.join(room.roomId);

      socket.emit('roomCreated', {
        roomId:     room.roomId,
        lobbyState: room.getLobbyState(),
      });

      console.log(`[Socket] ${wallet} created room ${room.roomId}`);
    });

    // ── joinRoom ──────────────────────────────────────────────────────────────
    // Payload: { roomId: string, wallet: string }
    socket.on('joinRoom', (payload = {}) => {
      const { roomId, wallet } = payload;
      console.log(`[Socket] joinRoom received — socket: ${socket.id}, roomId: ${JSON.stringify(roomId)}, wallet: ${JSON.stringify(wallet)}`);

      if (!isValidWallet(wallet)) {
        console.warn(`[Socket] joinRoom rejected — invalid wallet: ${JSON.stringify(wallet)}`);
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}". Expected a non-empty string.` });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const result = manager.joinRoom(socket.id, roomId.toUpperCase(), wallet);
      if (!result.ok) {
        console.warn(`[Socket] joinRoom failed — ${result.error}`);
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

    // ── setReady ──────────────────────────────────────────────────────────────
    // Payload: { ready: boolean }
    socket.on('setReady', (payload = {}) => {
      const { ready } = payload;
      console.log(`[Socket] setReady — socket: ${socket.id}, ready: ${ready}`);
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] setReady failed — socket ${socket.id} is not in any room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.setReady(socket.id, ready);
    });

    // ── startGame ─────────────────────────────────────────────────────────────
    // No payload required
    socket.on('startGame', () => {
      console.log(`[Socket] startGame — socket: ${socket.id}`);
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] startGame failed — socket ${socket.id} is not in any room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.startGame(socket.id);
    });

    // ── playerInput ───────────────────────────────────────────────────────────
    // Payload: { direction: 'left' | 'right' | 'neutral' }
    socket.on('playerInput', ({ direction } = {}) => {
      const room = manager.getRoomForSocket(socket.id);
      if (!room) return; // silently ignore stale inputs

      room.handleInput(socket.id, direction);
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
      manager.removePlayer(socket.id);
    });
  });

  // ── Periodic stats logging ─────────────────────────────────────────────────
  setInterval(() => {
    if (manager.activeRoomCount > 0 || manager.connectedPlayers > 0) {
      console.log(
        `[Stats] Rooms: ${manager.activeRoomCount} | Players: ${manager.connectedPlayers}`
      );
    }
  }, 30_000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wallet address validation.
 * Accepts any non-empty string — the server doesn't need to verify
 * on-chain format; blockchain logic lives in the frontend.
 * We only reject empty/missing values to catch obvious bugs.
 */
function isValidWallet(wallet) {
  return typeof wallet === 'string' && wallet.trim().length > 0;
}

module.exports = { registerSocketHandlers };
