'use strict';

const { GameLoop } = require('../game/GameLoop');
const { MIN_PLAYERS, MAX_PLAYERS } = require('../game/constants');

/**
 * Room
 *
 * Manages the lobby and game lifecycle for one match.
 * IO emissions are handled externally via callbacks to keep this class testable.
 *
 * States: 'lobby' → 'playing' → 'ended'
 */
class Room {
  /**
   * @param {object} opts
   * @param {string}   opts.roomId
   * @param {string}   opts.hostId        socket ID of creator
   * @param {string}   opts.hostWallet    wallet address of creator
   * @param {Function} opts.emitToRoom    (event, data) — broadcasts to entire room
   * @param {Function} opts.emitToSocket  (socketId, event, data) — sends to one socket
   * @param {Function} opts.onEmpty       called when the last player leaves
   */
  constructor({ roomId, hostId, hostWallet, emitToRoom, emitToSocket, onEmpty }) {
    this.roomId         = roomId;
    this.hostId         = hostId;
    this.state          = 'lobby';   // 'lobby' | 'playing' | 'ended'

    this._emitToRoom    = emitToRoom;
    this._emitToSocket  = emitToSocket;
    this._onEmpty       = onEmpty;

    // players: Map<socketId, { socketId, wallet, ready }>
    this._players = new Map();
    this._gameLoop = null;

    // Add the host as the first player
    this._players.set(hostId, {
      socketId: hostId,
      wallet:   hostWallet,
      ready:    false,
    });

    console.log(`[Room ${this.roomId}] Created by ${hostWallet}`);
  }

  // ─── Getters ────────────────────────────────────────────────────────────────

  get playerCount()  { return this._players.size; }
  get isFull()       { return this._players.size >= MAX_PLAYERS; }
  get hasMinPlayers(){ return this._players.size >= MIN_PLAYERS; }

  getLobbyState() {
    return {
      roomId:   this.roomId,
      hostId:   this.hostId,
      state:    this.state,
      players:  [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        ready:    p.ready,
      })),
    };
  }

  // ─── Join ────────────────────────────────────────────────────────────────────

  join(socketId, wallet) {
    if (this.state !== 'lobby') {
      return { ok: false, error: 'Game already in progress' };
    }
    if (this.isFull) {
      return { ok: false, error: 'Room is full' };
    }
    if (this._players.has(socketId)) {
      return { ok: false, error: 'Already in room' };
    }

    this._players.set(socketId, { socketId, wallet, ready: false });
    console.log(`[Room ${this.roomId}] ${wallet} joined (${this._players.size}/${MAX_PLAYERS})`);

    // Broadcast updated lobby to everyone
    this._emitToRoom('lobbyState', this.getLobbyState());

    return { ok: true };
  }

  // ─── Ready ───────────────────────────────────────────────────────────────────

  setReady(socketId, isReady) {
    const player = this._players.get(socketId);
    if (!player) return;

    player.ready = Boolean(isReady);
    this._emitToRoom('lobbyState', this.getLobbyState());
  }

  // ─── Start ───────────────────────────────────────────────────────────────────

  startGame(requesterId) {
    if (requesterId !== this.hostId) {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Only the host can start the game' });
      return;
    }
    if (this.state !== 'lobby') {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Game already started' });
      return;
    }
    if (!this.hasMinPlayers) {
      this._emitToSocket(requesterId, 'errorMessage', { message: `Need at least ${MIN_PLAYERS} players to start` });
      return;
    }

    const notReady = [...this._players.values()].filter(p => p.socketId !== this.hostId && !p.ready);
    if (notReady.length > 0) {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Not all players are ready' });
      return;
    }

    this.state = 'playing';

    const playerIds = [...this._players.keys()];
    const wallets   = new Map([...this._players.entries()].map(([id, p]) => [id, p.wallet]));

    this._gameLoop = new GameLoop({
      playerIds,
      wallets,
      onGameState:  (state)              => this._onGameState(state),
      onPlayerDied: (id, wallet, reason) => this._onPlayerDied(id, wallet, reason),
      onMatchEnded: (winnerWallet, winnerId) => this._onMatchEnded(winnerWallet, winnerId),
    });

    // Tell everyone the game is starting (include initial player info)
    this._emitToRoom('gameStarted', {
      roomId:   this.roomId,
      players:  [...this._players.values()].map((p, idx) => ({
        socketId: p.socketId,
        wallet:   p.wallet,
      })),
    });

    this._gameLoop.start();
    console.log(`[Room ${this.roomId}] Game started with ${playerIds.length} players`);
  }

  // ─── Player Input ────────────────────────────────────────────────────────────

  handleInput(socketId, direction) {
    if (this.state !== 'playing' || !this._gameLoop) return;

    const valid = ['left', 'right', 'neutral'];
    if (!valid.includes(direction)) return;

    this._gameLoop.setInput(socketId, direction);
  }

  // ─── Leave ───────────────────────────────────────────────────────────────────

  removePlayer(socketId) {
    if (!this._players.has(socketId)) return;

    const player = this._players.get(socketId);
    this._players.delete(socketId);
    console.log(`[Room ${this.roomId}] ${player.wallet} left`);

    // If the game is running, kill that player's snake
    if (this._gameLoop && this.state === 'playing') {
      this._gameLoop.setInput(socketId, 'neutral');
      // Mark them dead via a virtual wall collision handled by the loop's public kill API
      // (we rely on the loop to handle the disconnect gracefully on next tick)
    }

    if (this._players.size === 0) {
      this._gameLoop?.stop();
      this._onEmpty();
      return;
    }

    // Migrate host if the host left
    if (socketId === this.hostId) {
      this.hostId = [...this._players.keys()][0];
      console.log(`[Room ${this.roomId}] Host migrated to ${this.hostId}`);
    }

    if (this.state === 'lobby') {
      this._emitToRoom('lobbyState', this.getLobbyState());
    }
  }

  // ─── Game Callbacks ──────────────────────────────────────────────────────────

  _onGameState(state) {
    this._emitToRoom('gameState', state);
  }

  _onPlayerDied(socketId, wallet, reason) {
    this._emitToRoom('playerDied', { socketId, wallet, reason });
  }

  _onMatchEnded(winnerWallet, winnerId) {
    this.state = 'ended';
    this._gameLoop = null;

    this._emitToRoom('matchEnded', {
      roomId:       this.roomId,
      winnerWallet: winnerWallet ?? null,
      winnerId:     winnerId ?? null,
      draw:         winnerWallet === null,
    });

    console.log(`[Room ${this.roomId}] Match ended — winner: ${winnerWallet ?? 'draw'}`);
  }
}

module.exports = { Room };
