'use strict';

const { GameLoop }  = require('../game/GameLoop');
const BackendClient = require('../services/BackendClient');
const {
  MIN_PLAYERS,
  MAX_PLAYERS,
  VALID_ROUNDS,
  DEFAULT_ROUNDS,
  BETWEEN_ROUNDS_DELAY_MS,
  PLAYER_COLORS,
} = require('../game/constants');

// How long to keep the room alive after matchEnded so late-reconnectors
// can still receive the final state. After this the room is destroyed.
const POST_MATCH_GRACE_MS = 30_000;

/**
 * Room
 *
 * Manages the full lifecycle of a multi-round match.
 *
 * ── Room lifecycle / destruction policy ──────────────────────────────────────
 *
 *  The room is NEVER destroyed while:
 *    - state is 'playing'
 *    - state is 'between_rounds' (countdown timer running)
 *    - state is 'ended' but grace delay hasn't elapsed
 *
 *  Destruction sequence after matchEnded:
 *    1. _endMatch() emits matchEnded
 *    2. _endMatch() calls backend finish
 *    3. setTimeout(POST_MATCH_GRACE_MS) fires
 *    4. _releaseAllSockets() removes all socket→room mappings
 *    5. onEmpty() → RoomManager._destroyRoom()
 *
 *  Player disconnect during a match:
 *    - removePlayer() notes the player left but does NOT call onEmpty()
 *      while the match is active — GameLoop is still running for others.
 *    - releaseSocket(socketId) is called immediately so the socket slot
 *      can be reused, but the room itself stays alive.
 *
 * ── Win requirement ───────────────────────────────────────────────────────────
 *   BO1 → 1   BO3 → 2   BO5 → 3   BO7 → 4   BO9 → 5
 */
class Room {
  /**
   * @param {object}   opts
   * @param {string}   opts.roomId
   * @param {string}   opts.hostId
   * @param {string}   opts.hostWallet
   * @param {number}   [opts.entryFee=0]
   * @param {number}   [opts.rounds=1]     1|3|5|7|9
   * @param {Function} opts.emitToRoom     (event, data)
   * @param {Function} opts.emitToSocket   (socketId, event, data)
   * @param {Function} opts.onEmpty        called when room can be destroyed
   * @param {Function} opts.releaseSocket  (socketId) removes socket→room mapping
   */
  constructor({ roomId, hostId, hostWallet, entryFee = 0, rounds = DEFAULT_ROUNDS,
                emitToRoom, emitToSocket, onEmpty, releaseSocket }) {
    this.roomId   = roomId;
    this.hostId   = hostId;
    this.state    = 'lobby';
    this.entryFee = entryFee;

    // ── Round config ────────────────────────────────────────────────────────
    this.rounds       = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
    this.winsRequired = Math.ceil(this.rounds / 2);
    this.currentRound = 0;

    // ── Scores: wallet → wins ───────────────────────────────────────────────
    this._scores = new Map();

    // ── Stable colors across rounds: socketId → hex ─────────────────────────
    this._colors = new Map();

    // ── IO ──────────────────────────────────────────────────────────────────
    this._emitToRoom    = emitToRoom;
    this._emitToSocket  = emitToSocket;
    this._onEmpty       = onEmpty;
    this._releaseSocket = releaseSocket;

    // ── State ───────────────────────────────────────────────────────────────
    this._players        = new Map();   // socketId → { socketId, wallet, ready }
    this._gameLoop       = null;
    this._matchId        = null;
    this._countdownTimer = null;        // between-rounds setTimeout
    this._graceTimer     = null;        // post-match grace setTimeout

    this._addPlayer(hostId, hostWallet);

    console.log(`[Room ${this.roomId}] Created — BO${this.rounds} (need ${this.winsRequired} wins)`);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  _addPlayer(socketId, wallet) {
    this._players.set(socketId, { socketId, wallet, ready: false });
    if (!this._colors.has(socketId)) {
      this._colors.set(socketId, PLAYER_COLORS[this._colors.size % PLAYER_COLORS.length]);
    }
    if (!this._scores.has(wallet)) {
      this._scores.set(wallet, 0);
    }
  }

  _getScores() {
    return [...this._scores.entries()]
      .map(([wallet, wins]) => ({ wallet, wins }))
      .sort((a, b) => b.wins - a.wins);
  }

  _isMatchActive() {
    return this.state === 'playing' || this.state === 'between_rounds';
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get playerCount()   { return this._players.size; }
  get isFull()        { return this._players.size >= MAX_PLAYERS; }
  get hasMinPlayers() { return this._players.size >= MIN_PLAYERS; }

  getLobbyState() {
    return {
      roomId:       this.roomId,
      hostId:       this.hostId,
      state:        this.state,
      entryFee:     this.entryFee,
      matchId:      this._matchId,
      rounds:       this.rounds,
      winsRequired: this.winsRequired,
      currentRound: this.currentRound,
      scores:       this._getScores(),
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        ready:    p.ready,
        color:    this._colors.get(p.socketId) ?? '#FFFFFF',
      })),
    };
  }

  // ─── Lobby actions ────────────────────────────────────────────────────────────

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
    this._addPlayer(socketId, wallet);
    console.log(`[Room ${this.roomId}] ${wallet} joined (${this._players.size}/${MAX_PLAYERS})`);
    this._emitToRoom('lobbyState', this.getLobbyState());
    return { ok: true };
  }

  setReady(socketId, isReady) {
    const player = this._players.get(socketId);
    if (!player) return;
    player.ready = Boolean(isReady);
    this._emitToRoom('lobbyState', this.getLobbyState());
  }

  setRounds(socketId, rounds) {
    if (socketId !== this.hostId) {
      this._emitToSocket(socketId, 'errorMessage', { message: 'Only the host can change the round format' });
      return;
    }
    if (this.state !== 'lobby') {
      this._emitToSocket(socketId, 'errorMessage', { message: 'Cannot change format after game starts' });
      return;
    }
    if (!VALID_ROUNDS.includes(rounds)) {
      this._emitToSocket(socketId, 'errorMessage', {
        message: `Invalid rounds value. Must be one of: ${VALID_ROUNDS.join(', ')}`,
      });
      return;
    }
    this.rounds       = rounds;
    this.winsRequired = Math.ceil(rounds / 2);
    console.log(`[Room ${this.roomId}] Host set format: BO${rounds} (need ${this.winsRequired} wins)`);
    this._emitToRoom('lobbyState', this.getLobbyState());
  }

  // ─── Start match ─────────────────────────────────────────────────────────────

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
      this._emitToSocket(requesterId, 'errorMessage', {
        message: `Need at least ${MIN_PLAYERS} players to start`,
      });
      return;
    }
    const notReady = [...this._players.values()]
      .filter(p => p.socketId !== this.hostId && !p.ready);
    if (notReady.length > 0) {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Not all players are ready' });
      return;
    }

    this.state = 'playing';

    this._emitToRoom('gameStarted', {
      roomId:       this.roomId,
      rounds:       this.rounds,
      winsRequired: this.winsRequired,
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        color:    this._colors.get(p.socketId),
      })),
    });

    // Register match in backend — fire and forget, never block gameplay
    const walletList = [...this._players.values()].map(p => p.wallet);
    BackendClient.createMatch(this.roomId, this.entryFee)
      .then(match => {
        if (match?.id) {
          this._matchId = match.id;
          console.log(`[Room ${this.roomId}] Backend match ID: ${this._matchId}`);
          return BackendClient.registerPlayers(this._matchId, walletList)
            .then(() => BackendClient.startMatch(this._matchId));
        }
      })
      .catch(err => {
        console.error(`[Room ${this.roomId}] Backend registration error: ${err.message}`);
      });

    this._startRound();
  }

  // ─── Round management ─────────────────────────────────────────────────────────

  _startRound() {
    this.currentRound++;
    this.state = 'playing';

    const playerIds = [...this._players.keys()];
    const wallets   = new Map([...this._players.entries()].map(([id, p]) => [id, p.wallet]));

    console.log(`[Room ${this.roomId}] ── roundStarted ${this.currentRound}/${this.rounds} ──`);

    this._emitToRoom('roundStarted', {
      roomId:       this.roomId,
      currentRound: this.currentRound,
      rounds:       this.rounds,
      winsRequired: this.winsRequired,
      scores:       this._getScores(),
    });

    this._gameLoop = new GameLoop({
      playerIds,
      wallets,
      colors:       this._colors,
      onGameState:  snap                      => this._onGameState(snap),
      onPlayerDied: (id, wallet, reason)      => this._onPlayerDied(id, wallet, reason),
      onRoundEnded: (winnerId, winnerWallet)  => this._onRoundEnded(winnerId, winnerWallet),
    });

    this._gameLoop.start();
  }

  /**
   * Called by GameLoop when ≤1 player remains alive in a round.
   * Never deletes the room — only _scheduleRoomCleanup() does that.
   */
  _onRoundEnded(winnerId, winnerWallet) {
    this._gameLoop = null;
    this.state = 'between_rounds';

    const isDraw = winnerWallet === null;

    // ── Increment winner score ────────────────────────────────────────────────
    if (!isDraw && winnerWallet) {
      this._scores.set(winnerWallet, (this._scores.get(winnerWallet) ?? 0) + 1);
    }

    const scores    = this._getScores();
    const topScore  = scores[0]?.wins ?? 0;
    const matchOver = !isDraw && topScore >= this.winsRequired;
    const matchWinnerWallet = matchOver ? winnerWallet : null;
    const matchWinnerId     = matchOver ? winnerId     : null;

    console.log(
      `[Room ${this.roomId}] ── roundEnded ${this.currentRound} — ` +
      `winner: ${winnerWallet ?? 'draw'} | scores: ${JSON.stringify(scores)} | matchOver: ${matchOver}`
    );

    // ── Build scoreboard for UI ───────────────────────────────────────────────
    const nextRoundStartsAt = matchOver ? null : Date.now() + BETWEEN_ROUNDS_DELAY_MS;

    const scoreboard = [...this._players.values()].map(p => ({
      socketId:      p.socketId,
      wallet:        p.wallet,
      color:         this._colors.get(p.socketId) ?? '#FFFFFF',
      wins:          this._scores.get(p.wallet) ?? 0,
      isRoundWinner: p.wallet === winnerWallet,
    })).sort((a, b) => b.wins - a.wins);

    // ── Emit roundEnded to all clients ────────────────────────────────────────
    this._emitToRoom('roundEnded', {
      roomId:            this.roomId,
      roundWinnerWallet: winnerWallet ?? null,
      roundWinnerId:     winnerId     ?? null,
      draw:              isDraw,
      scores,
      scoreboard,
      currentRound:      this.currentRound,
      rounds:            this.rounds,
      winsRequired:      this.winsRequired,
      matchOver,
      nextRoundStartsAt,
      countdownSeconds:  matchOver ? null : BETWEEN_ROUNDS_DELAY_MS / 1000,
    });

    if (matchOver) {
      this._endMatch(matchWinnerWallet, matchWinnerId);
    } else {
      // ── Schedule next round ───────────────────────────────────────────────
      console.log(`[Room ${this.roomId}] Next round starts in ${BETWEEN_ROUNDS_DELAY_MS / 1000}s`);
      this._countdownTimer = setTimeout(() => {
        this._countdownTimer = null;
        if (this._players.size >= MIN_PLAYERS && this.state === 'between_rounds') {
          this._startRound();
        } else {
          console.warn(`[Room ${this.roomId}] Countdown done but not enough players — cancelling match`);
          if (this._matchId) BackendClient.cancelMatch(this._matchId).catch(() => {});
          this._scheduleRoomCleanup();
        }
      }, BETWEEN_ROUNDS_DELAY_MS);
    }
  }

  /**
   * End the entire match.
   * Only called when a player reaches winsRequired.
   * NEVER called after individual rounds.
   */
  _endMatch(winnerWallet, winnerId) {
    this.state = 'ended';
    const isDraw = winnerWallet === null;

    console.log(
      `[Room ${this.roomId}] ── matchEnded after ${this.currentRound} rounds — ` +
      `winner: ${winnerWallet ?? 'draw'}`
    );

    // ── 1. Broadcast to all clients ───────────────────────────────────────────
    this._emitToRoom('matchEnded', {
      roomId:       this.roomId,
      winnerWallet: winnerWallet ?? null,
      winnerId:     winnerId     ?? null,
      draw:         isDraw,
      scores:       this._getScores(),
      totalRounds:  this.currentRound,
      rounds:       this.rounds,
    });

    // ── 2. Server-to-server backend call (authoritative payout) ───────────────
    if (this._matchId) {
      BackendClient.finishMatch(this._matchId, winnerWallet, winnerId, isDraw)
        .catch(err => {
          console.error(`[Room ${this.roomId}] Backend finishMatch error: ${err.message}`);
        });
    } else {
      console.warn(`[Room ${this.roomId}] matchEnded but no matchId — backend not notified`);
    }

    // ── 3. Schedule room cleanup after grace period ───────────────────────────
    this._scheduleRoomCleanup();
  }

  /**
   * Destroys the room after POST_MATCH_GRACE_MS.
   * Releases all socket mappings first so they can be reused.
   * Then calls onEmpty() so RoomManager removes the room from its map.
   */
  _scheduleRoomCleanup() {
    console.log(`[Room ${this.roomId}] Cleanup scheduled in ${POST_MATCH_GRACE_MS / 1000}s`);
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this._stopEverything();
      console.log(`[Room ${this.roomId}] ── room cleanup — releasing all sockets`);
      // Release all socket→room mappings
      for (const socketId of this._players.keys()) {
        this._releaseSocket(socketId);
      }
      this._onEmpty();
    }, POST_MATCH_GRACE_MS);
  }

  // ─── Input ───────────────────────────────────────────────────────────────────

  handleInput(socketId, direction) {
    if (this.state !== 'playing' || !this._gameLoop) return;
    const valid = ['left', 'right', 'neutral'];
    if (!valid.includes(direction)) return;
    this._gameLoop.setInput(socketId, direction);
  }

  // ─── Player disconnect ────────────────────────────────────────────────────────

  removePlayer(socketId) {
    if (!this._players.has(socketId)) return;

    const player = this._players.get(socketId);
    this._players.delete(socketId);
    console.log(`[Room ${this.roomId}] ${player.wallet} disconnected`);

    // Always release the socket slot immediately so it can reconnect elsewhere
    this._releaseSocket(socketId);

    // ── Lobby: normal empty-room cleanup ─────────────────────────────────────
    if (this.state === 'lobby') {
      if (this._players.size === 0) {
        this._onEmpty();
        return;
      }
      if (socketId === this.hostId) {
        this.hostId = [...this._players.keys()][0];
        console.log(`[Room ${this.roomId}] Host migrated to ${this.hostId}`);
      }
      this._emitToRoom('lobbyState', this.getLobbyState());
      return;
    }

    // ── Match active: do NOT destroy the room ─────────────────────────────────
    // The GameLoop keeps running for the remaining players.
    // If only 1 player remains during a round, GameLoop's win-condition
    // fires naturally on the next tick and _onRoundEnded handles it.
    // We only force-end if the room is between rounds and now under-staffed.
    if (this.state === 'between_rounds' && this._players.size < MIN_PLAYERS) {
      console.warn(`[Room ${this.roomId}] Not enough players during countdown — ending match early`);
      if (this._countdownTimer) {
        clearTimeout(this._countdownTimer);
        this._countdownTimer = null;
      }
      if (this._matchId) BackendClient.cancelMatch(this._matchId).catch(() => {});
      this._scheduleRoomCleanup();
    }

    // ── Ended: nothing to do — grace timer is already running ─────────────────
  }

  // ─── Internal cleanup ────────────────────────────────────────────────────────

  _stopEverything() {
    this._gameLoop?.stop();
    this._gameLoop = null;

    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }
    // Note: _graceTimer is NOT cleared here — it called us
  }

  // ─── Game state passthrough ───────────────────────────────────────────────────

  _onGameState(snapshot) {
    this._emitToRoom('gameState', snapshot);
  }

  _onPlayerDied(socketId, wallet, reason) {
    console.log(`[Room ${this.roomId}] playerDied — wallet: ${wallet}, reason: ${reason}`);
    this._emitToRoom('playerDied', { socketId, wallet, reason });
  }
}

module.exports = { Room };
