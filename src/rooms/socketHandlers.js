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
    socket.on('createRoom', ({ wallet } = {}) => {
      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'Invalid wallet address' });
      }

      const result = manager.createRoom(socket.id, wallet);
      if (!result.ok) {
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
    socket.on('joinRoom', ({ roomId, wallet } = {}) => {
      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'Invalid wallet address' });
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

    // ── setReady ──────────────────────────────────────────────────────────────
    // Payload: { ready: boolean }
    socket.on('setReady', ({ ready } = {}) => {
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.setReady(socket.id, ready);
    });

    // ── startGame ─────────────────────────────────────────────────────────────
    // No payload required
    socket.on('startGame', () => {
      const room = manager.getRoomForSocket(socket.id);
      if (!room) {
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
 * Loose wallet address validation.
 * Accepts EVM (0x…) addresses and Solana base58 addresses.
 */
function isValidWallet(wallet) {
  if (typeof wallet !== 'string' || wallet.trim().length === 0) return false;

  // EVM address: 0x followed by 40 hex chars
  if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) return true;

  // Solana address: 32–44 base58 chars
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return true;

  return false;
}

module.exports = { registerSocketHandlers };
