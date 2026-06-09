'use strict';

const { v4: uuidv4 } = require('uuid');
const { Room } = require('./Room');

/**
 * RoomManager
 *
 * Tracks all live rooms and provides lookup utilities.
 *
 * Room destruction policy (fixes the freeze-after-playerDied bug):
 *
 *   Rooms are NEVER destroyed immediately when a player disconnects during
 *   a match. The Room itself decides when it is safe to clean up by calling
 *   onEmpty() — which only happens after:
 *     1. matchEnded has been emitted
 *     2. The backend finish call has been attempted
 *     3. A 30-second grace delay has elapsed (so late-reconnectors get state)
 *
 *   During that window, getRoomForSocket() still works because we keep the
 *   socketId → roomId mapping alive until the room explicitly releases it
 *   via releaseSocket().
 */
class RoomManager {
  constructor(io) {
    this._io           = io;
    this._rooms        = new Map();     // roomId  → Room
    this._socketToRoom = new Map();     // socketId → roomId
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  createRoom(socketId, wallet, rounds, entryFee) {
    if (this._socketToRoom.has(socketId)) {
      return { ok: false, error: 'You are already in a room' };
    }

    const roomId = uuidv4().slice(0, 8).toUpperCase();

    const room = new Room({
      roomId,
      hostId:        socketId,
      hostWallet:    wallet,
      rounds,
      entryFee,
      emitToRoom:    (event, data) => this._io.to(roomId).emit(event, data),
      emitToSocket:  (id, event, data) => this._io.to(id).emit(event, data),
      // Room calls onEmpty when it is truly done (after grace delay)
      onEmpty:       () => this._destroyRoom(roomId),
      // Room calls releaseSocket when a player's slot can be freed
      releaseSocket: (id) => this._socketToRoom.delete(id),
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

  // ─── Remove player (on disconnect) ───────────────────────────────────────────

  /**
   * Called when a socket disconnects.
   *
   * We do NOT delete the socketId → roomId mapping here.
   * That mapping is removed by Room via releaseSocket() at the right moment:
   *   - Lobby: immediately (no match in progress)
   *   - Playing/between_rounds: after matchEnded + grace delay
   *
   * This ensures getRoomForSocket() keeps working for the duration of a match
   * even after a player's socket disconnects.
   */
  removePlayer(socketId) {
    const room = this.getRoomForSocket(socketId);
    if (!room) return;
    room.removePlayer(socketId);
    // Do NOT delete _socketToRoom[socketId] here — Room.releaseSocket() does it
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
