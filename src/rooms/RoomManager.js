'use strict';

const { v4: uuidv4 } = require('uuid');
const { Room } = require('./Room');

/**
 * RoomManager
 *
 * Tracks all live rooms and provides lookup utilities.
 *
 * Room destruction policy:
 *   Rooms are NEVER destroyed immediately when a player disconnects during a
 *   match. The Room itself decides when it is safe to clean up via onEmpty().
 *   After matchEnded the room stays alive for POST_MATCH_GRACE_MS (60 s) so
 *   players can choose playAgain or exitMatch. Only after that timer fires
 *   (or all players exit) is the room destroyed.
 */
class RoomManager {
  constructor(io) {
    this._io           = io;
    this._rooms        = new Map();
    this._socketToRoom = new Map();
  }

  // ─── Create ──────────────────────────────────────────────────────────────────
  //
  // NOTE on async: RoomManager is a plain in-memory store today, but every
  // public method here is declared `async` (even though nothing inside
  // currently awaits) because socketHandlers.js awaits every call into it
  // by design — that's the seam where a future swap to a shared/Redis-backed
  // store (for multi-instance deployment) would slot in without touching
  // any call site. Keeping the signatures async now means that swap is a
  // pure internal change later.

  async createRoom(socketId, wallet, username, rounds, entryFee) {
    if (this._socketToRoom.has(socketId)) {
      return { ok: false, error: 'You are already in a room' };
    }

    const roomId = uuidv4().slice(0, 8).toUpperCase();

    const room = new Room({
      roomId,
      hostId:        socketId,
      hostWallet:    wallet,
      hostUsername:  username,
      rounds,
      entryFee,
      emitToRoom:    (event, data) => this._io.to(roomId).emit(event, data),
      emitToSocket:  (id, event, data) => this._io.to(id).emit(event, data),
      onEmpty:       () => this._destroyRoom(roomId),
      releaseSocket: (id) => this._socketToRoom.delete(id),
    });

    this._rooms.set(roomId, room);
    this._socketToRoom.set(socketId, roomId);

    return { ok: true, room };
  }

  // ─── Join ────────────────────────────────────────────────────────────────────

  async joinRoom(socketId, roomId, wallet, username) {
    if (this._socketToRoom.has(socketId)) {
      return { ok: false, error: 'You are already in a room' };
    }

    const room = this._rooms.get(roomId);
    if (!room) {
      return { ok: false, error: `Room ${roomId} not found` };
    }

    const result = room.join(socketId, wallet, username);
    if (!result.ok) return result;

    this._socketToRoom.set(socketId, roomId);
    return { ok: true, room };
  }

  // ─── Rematch actions ─────────────────────────────────────────────────────────

  /**
   * Player chooses to play again after matchEnded.
   * Room must be in 'ended' or 'lobby' (rematch lobby) state.
   */
  async playAgain(socketId, wallet) {
    const room = await this.getRoomForSocket(socketId);
    if (!room) {
      return { ok: false, error: 'You are not in a room' };
    }

    const result = room.playAgain(socketId, wallet);
    return result.ok ? { ok: true, room } : result;
  }

  /**
   * Player explicitly exits after matchEnded.
   * Removes them from the room and releases their socket slot.
   */
  async exitMatch(socketId) {
    const room = await this.getRoomForSocket(socketId);
    if (!room) {
      return { ok: false, error: 'You are not in a room' };
    }

    return room.exitMatch(socketId);
    // Note: releaseSocket is called inside Room.exitMatch()
  }

  // ─── Lookup ──────────────────────────────────────────────────────────────────

  async getRoomForSocket(socketId) {
    const roomId = this._socketToRoom.get(socketId);
    return roomId ? this._rooms.get(roomId) ?? null : null;
  }

  async getRoom(roomId) {
    return this._rooms.get(roomId) ?? null;
  }

  // ─── Remove player (on disconnect) ───────────────────────────────────────────

  async removePlayer(socketId) {
    const room = await this.getRoomForSocket(socketId);
    if (!room) return;
    room.removePlayer(socketId);
    // Do NOT delete _socketToRoom here — Room.releaseSocket() does it
  }

  // ─── Destroy room ────────────────────────────────────────────────────────────

  _destroyRoom(roomId) {
    this._rooms.delete(roomId);
    console.log(`[RoomManager] Room ${roomId} destroyed`);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async activeRoomCount()  { return this._rooms.size; }
  async connectedPlayers() { return this._socketToRoom.size; }
}

module.exports = { RoomManager };
