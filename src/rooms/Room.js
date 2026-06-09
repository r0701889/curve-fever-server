'use strict';

const { GameLoop }     = require('../game/GameLoop');
const { MIN_PLAYERS, MAX_PLAYERS } = require('../game/constants');
const BackendClient    = require('../services/BackendClient');

/**
 * Room
 *
 * Manages the lobby and game lifecycle for one match.
 *
 * Backend integration points:
 *   startGame()       → BackendClient.createMatch + registerPlayers + startMatch
 *   _onMatchEnded()   → BackendClient.finishMatch  (AUTHORITATIVE — never trust frontend)
 *   removePlayer()    → BackendClient.cancelMatch  (if match never started)
 */
class Room {
  /**
   * @param {object} opts
   * @param {string}   opts.roomId
   * @param {string}   opts.hostId
   * @param {string}   opts.hostWallet
   * @param {number}   opts.entryFee       entry fee in integer units (default 0)
   * @param {Function} opts.emitToRoom
   * @param {Function} opts.emitToSocket
   * @param {Function} opts.onEmpty
   */
  constructor({ roomId, hostId, hostWallet, entryFee = 0, emitToRoom, emitToSocket, onEmpty }) {
    this.roomId         = roomId;
    this.hostId         = hostId;
    this.state          = 'lobby';   // 'lobby' | 'playing' | 'ended'
    this.entryFee       = entryFee;

    this._emitToRoom    = emitToRoom;
    this._emitToSocket  = emitToSocket;
    this._onEmpty       = onEmpty;

    // players: Map<socketId, { socketId, wallet, ready }>
    this._players  = new Map();
    this._gameLoop = null;
    this._matchId  = null;   // set after backend creates the match

    this._players.set(hostId, {
      socketId: hostId,
      wallet:   hostWallet,
      ready:    false,
    });

    console.log(`[Room ${this.roomId}] Created by ${hostWallet}`);
  }

  // ─── Getters ────────────────────────────────────────────────────────────────

  get playerCount()   { return this._players.size; }
  get isFull()        { return this._players.size >= MAX_PLAYERS; }
  get hasMinPlayers() { return this._players.size >= MIN_PLAYERS; }

  getLobbyState() {
    return {
      roomId:   this.roomId,
      hostId:   this.hostId,
      state:    this.state,
      entryFee: this.entryFee,
      matchId:  this._matchId,
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
    const walletList = [...wallets.values()];

    // ── Notify clients immediately ────────────────────────────────────────────
    this._emitToRoom('gameStarted', {
      roomId:  this.roomId,
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
      })),
    });

    // ── Register match in backend (async, non-blocking) ───────────────────────
    // We fire-and-forget here so the game starts without waiting for the backend.
    // matchId is stored for use in finishMatch.
    BackendClient.createMatch(this.roomId, this.entryFee)
      .then(match => {
        if (match?.id) {
          this._matchId = match.id;
          console.log(`[Room ${this.roomId}] Backend match ID: ${this._matchId}`);
          // Register all players then mark the match as started
          return BackendClient.registerPlayers(this._matchId, walletList)
            .then(() => BackendClient.startMatch(this._matchId));
        }
      })
      .catch(err => {
        console.error(`[Room ${this.roomId}] Backend registration error: ${err.message}`);
        // Game continues regardless — backend issues should not block gameplay
      });

    // ── Start game loop ───────────────────────────────────────────────────────
    this._gameLoop = new GameLoop({
      playerIds,
      wallets,
      onGameState:  (state)              => this._onGameState(state),
      onPlayerDied: (id, wallet, reason) => this._onPlayerDied(id, wallet, reason),
      onMatchEnded: (winnerWallet, winnerId) => this._onMatchEnded(winnerWallet, winnerId),
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

    if (this._players.size === 0) {
      // If match was created but never finished, cancel it (triggers refunds)
      if (this._matchId && this.state !== 'ended') {
        BackendClient.cancelMatch(this._matchId).catch(() => {});
      }
      this._gameLoop?.stop();
      this._onEmpty();
      return;
    }

    // Migrate host if host left
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

  /**
   * Called by GameLoop when the match ends.
   *
   * Security: this is the ONLY place match results are reported to the backend.
   * The frontend emits matchEnded to display the result UI, but the backend
   * is called HERE — server-to-server — with the SERVER_SECRET Bearer token.
   * The frontend call to /finish would be rejected with 401.
   */
  _onMatchEnded(winnerWallet, winnerId) {
    this.state = 'ended';
    this._gameLoop = null;

    const isDraw = winnerWallet === null;

    // ── 1. Broadcast to all clients (UI only) ─────────────────────────────────
    this._emitToRoom('matchEnded', {
      roomId:       this.roomId,
      winnerWallet: winnerWallet ?? null,
      winnerId:     winnerId     ?? null,
      draw:         isDraw,
    });

    // ── 2. Report to backend — authoritative, server-to-server ───────────────
    // Backend will:
    //   - Validate winner is a paid player
    //   - Mark match as 'finished'
    //   - Pay out prize pool to winner (or refund all on draw)
    if (this._matchId) {
      BackendClient.finishMatch(this._matchId, winnerWallet, winnerId, isDraw)
        .catch(err => {
          console.error(`[Room ${this.roomId}] Backend finishMatch error: ${err.message}`);
        });
    } else {
      console.warn(`[Room ${this.roomId}] matchEnded but no matchId — backend not notified`);
    }

    console.log(`[Room ${this.roomId}] Match ended — ${isDraw ? 'draw' : `winner: ${winnerWallet}`}`);
  }
}

module.exports = { Room };
