'use strict';

const { v4: uuidv4 } = require('uuid');
const { Room } = require('./Room');

/**
 * RoomManager
 *
 * Singleton that tracks all live rooms and provides lookup utilities.
 * Passed the Socket.io `io` instance so rooms can emit without coupling.
 */
class RoomManager {
  constructor(io) {
    this._io    = io;
    this._rooms = new Map();           // roomId  → Room
    this._socketToRoom = new Map();    // socketId → roomId
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  createRoom(socketId, wallet) {
    if (this._socketToRoom.has(socketId)) {
      return { ok: false, error: 'You are already in a room' };
    }

    const roomId = uuidv4().slice(0, 8).toUpperCase();

    const room = new Room({
      roomId,
      hostId:       socketId,
      hostWallet:   wallet,
      emitToRoom:   (event, data) => this._io.to(roomId).emit(event, data),
      emitToSocket: (id, event, data) => this._io.to(id).emit(event, data),
      onEmpty:      () => this._destroyRoom(roomId),
    });

    this._rooms.set(roomId, room);
    this._socketToRoom.set(socketId, roomId);

    return { ok: true, room };
  }

  // ─── Join ────────────────────────────────────────────────────────────────────

  joinRoom(socketId, roomId, wallet) {
    if (this._socketToRoom.has(socketId)) {
      return { ok: false, error: 'You are already in a room' };
    }

    const room = this._rooms.get(roomId);
    if (!room) {
      return { ok: false, error: `Room ${roomId} not found` };
    }

    const result = room.join(socketId, wallet);
    if (!result.ok) return result;

    this._socketToRoom.set(socketId, roomId);
    return { ok: true, room };
  }

  // ─── Lookup ──────────────────────────────────────────────────────────────────

  getRoomForSocket(socketId) {
    const roomId = this._socketToRoom.get(socketId);
    return roomId ? this._rooms.get(roomId) ?? null : null;
  }

  getRoom(roomId) {
    return this._rooms.get(roomId) ?? null;
  }

  // ─── Remove player ───────────────────────────────────────────────────────────

  removePlayer(socketId) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return;

    room.removePlayer(socketId);
    this._socketToRoom.delete(socketId);
  }

  // ─── Destroy room ────────────────────────────────────────────────────────────

  _destroyRoom(roomId) {
    this._rooms.delete(roomId);
    console.log(`[RoomManager] Room ${roomId} destroyed`);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  get activeRoomCount()  { return this._rooms.size; }
  get connectedPlayers() { return this._socketToRoom.size; }
}

module.exports = { RoomManager };
