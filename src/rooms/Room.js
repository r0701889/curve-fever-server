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

/**
 * Room
 *
 * Manages the full lifecycle of a multi-round match.
 *
 * Round flow (all server-authoritative):
 *
 *   lobby
 *     └─ host calls startGame()
 *           ├─ emits gameStarted
 *           └─ _startRound() ──────────────────────────────────────────┐
 *                 └─ GameLoop runs one round                            │
 *                       └─ onRoundEnded(winnerId, winnerWallet)         │
 *                             ├─ _scores[wallet]++                     │
 *                             ├─ emits roundEnded                      │
 *                             ├─ if someone reached winsRequired:      │
 *                             │     _endMatch() → backend + matchEnded │
 *                             └─ else: setTimeout → _startRound() ─────┘
 *
 * Win requirement: Math.ceil(rounds / 2)
 *   BO1 → 1 win   BO3 → 2 wins   BO5 → 3 wins
 *   BO7 → 4 wins  BO9 → 5 wins
 *
 * The server NEVER trusts the frontend for:
 *   - scores        - round winner       - match winner      - payout
 */
class Room {
  /**
   * @param {object}   opts
   * @param {string}   opts.roomId
   * @param {string}   opts.hostId
   * @param {string}   opts.hostWallet
   * @param {number}   opts.entryFee     integer units, default 0
   * @param {number}   opts.rounds       1 | 3 | 5 | 7 | 9, default 1
   * @param {Function} opts.emitToRoom   (event, data) → broadcast to room
   * @param {Function} opts.emitToSocket (socketId, event, data) → one socket
   * @param {Function} opts.onEmpty      called when last player leaves
   */
  constructor({ roomId, hostId, hostWallet, entryFee = 0, rounds = DEFAULT_ROUNDS,
                emitToRoom, emitToSocket, onEmpty }) {
    this.roomId   = roomId;
    this.hostId   = hostId;
    this.state    = 'lobby';      // 'lobby' | 'playing' | 'between_rounds' | 'ended'
    this.entryFee = entryFee;

    // ── Round / match config ────────────────────────────────────────────────
    this.rounds       = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
    this.winsRequired = Math.ceil(this.rounds / 2);
    this.currentRound = 0;        // increments to 1 when first round starts

    // ── Per-player win scores  wallet → wins ────────────────────────────────
    this._scores = new Map();     // wallet → number of round wins

    // ── Player color assignment (stable across rounds) ──────────────────────
    this._colors = new Map();     // socketId → hex color

    // ── IO ──────────────────────────────────────────────────────────────────
    this._emitToRoom    = emitToRoom;
    this._emitToSocket  = emitToSocket;
    this._onEmpty       = onEmpty;

    // ── Players / game state ────────────────────────────────────────────────
    this._players      = new Map();   // socketId → { socketId, wallet, ready }
    this._gameLoop     = null;
    this._matchId      = null;
    this._countdownTimer = null;      // setTimeout handle for between-rounds

    // Add host as first player
    this._addPlayer(hostId, hostWallet);

    console.log(`[Room ${this.roomId}] Created — BO${this.rounds} (need ${this.winsRequired} wins)`);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  _addPlayer(socketId, wallet) {
    this._players.set(socketId, { socketId, wallet, ready: false });
    // Assign a stable color index based on join order
    if (!this._colors.has(socketId)) {
      const idx = this._colors.size;
      this._colors.set(socketId, PLAYER_COLORS[idx % PLAYER_COLORS.length]);
    }
    // Initialise score entry for this wallet
    if (!this._scores.has(wallet)) {
      this._scores.set(wallet, 0);
    }
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get playerCount()   { return this._players.size; }
  get isFull()        { return this._players.size >= MAX_PLAYERS; }
  get hasMinPlayers() { return this._players.size >= MIN_PLAYERS; }

  /** Serialised scores: [{ wallet, wins }] sorted by wins desc */
  _getScores() {
    return [...this._scores.entries()]
      .map(([wallet, wins]) => ({ wallet, wins }))
      .sort((a, b) => b.wins - a.wins);
  }

  getLobbyState() {
    return {
      roomId:       this.roomId,
      hostId:       this.hostId,
      state:        this.state,
      entryFee:     this.entryFee,
      matchId:      this._matchId,
      // Round info — always present so frontend can display format in lobby
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

  // ─── Lobby: join / ready / rounds config ─────────────────────────────────────

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

  /**
   * Host sets the round format (BO1/3/5/7/9) while in the lobby.
   * Only the host may do this; silently ignored otherwise.
   */
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

    // Broadcast match start with full config so frontend knows the format
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

    // Register match in backend (fire-and-forget — game must not wait)
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

    // Start round 1
    this._startRound();
  }

  // ─── Round management ─────────────────────────────────────────────────────────

  /**
   * Starts a new GameLoop for the next round.
   * Resets positions, trails and tick counter — scores are preserved.
   */
  _startRound() {
    this.currentRound++;
    this.state = 'playing';

    const playerIds = [...this._players.keys()];
    const wallets   = new Map([...this._players.entries()].map(([id, p]) => [id, p.wallet]));

    console.log(`[Room ${this.roomId}] Starting round ${this.currentRound}/${this.rounds}`);

    // Emit roundStarted so UI can show "Round X" splash
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
      colors:       this._colors,          // stable colors across rounds
      onGameState:  snap  => this._onGameState(snap),
      onPlayerDied: (id, wallet, reason) => this._onPlayerDied(id, wallet, reason),
      onRoundEnded: (winnerId, winnerWallet) => this._onRoundEnded(winnerId, winnerWallet),
    });

    this._gameLoop.start();
  }

  /**
   * Called by GameLoop when one round finishes.
   * Increments winner score, checks match-win condition,
   * either ends the match or schedules the next round.
   */
  _onRoundEnded(winnerId, winnerWallet) {
    this._gameLoop = null;
    this.state = 'between_rounds';

    const isDraw = winnerWallet === null;

    // ── Increment score ───────────────────────────────────────────────────────
    if (!isDraw && winnerWallet) {
      const prev = this._scores.get(winnerWallet) ?? 0;
      this._scores.set(winnerWallet, prev + 1);
    }

    const scores       = this._getScores();
    const topScore     = scores[0]?.wins ?? 0;
    const matchWinner  = !isDraw && topScore >= this.winsRequired ? winnerWallet : null;
    const matchWinnerId = matchWinner ? winnerId : null;
    const matchOver    = matchWinner !== null;

    console.log(
      `[Room ${this.roomId}] Round ${this.currentRound} ended — ` +
      `winner: ${winnerWallet ?? 'draw'} | scores: ${JSON.stringify(scores)}`
    );

    // ── Emit roundEnded (always, even on draw) ────────────────────────────────
    // nextRoundStartsAt lets the frontend run a real countdown timer.
    // scoreboard gives full player info for the between-rounds standings screen.
    const nextRoundStartsAt = matchOver ? null : Date.now() + BETWEEN_ROUNDS_DELAY_MS;

    const scoreboard = [...this._players.values()].map(p => ({
      socketId: p.socketId,
      wallet:   p.wallet,
      color:    this._colors.get(p.socketId) ?? '#FFFFFF',
      wins:     this._scores.get(p.wallet) ?? 0,
      isRoundWinner: p.wallet === winnerWallet,
    })).sort((a, b) => b.wins - a.wins);

    this._emitToRoom('roundEnded', {
      roomId:            this.roomId,
      roundWinnerWallet: winnerWallet ?? null,
      roundWinnerId:     winnerId     ?? null,
      draw:              isDraw,
      scores,
      scoreboard,           // full player info for standings UI
      currentRound:      this.currentRound,
      rounds:            this.rounds,
      winsRequired:      this.winsRequired,
      matchOver,
      nextRoundStartsAt,    // unix ms timestamp — null when matchOver
      countdownSeconds:  matchOver ? null : BETWEEN_ROUNDS_DELAY_MS / 1000,
    });

    if (matchOver) {
      // ── Match winner reached winsRequired — end the match ─────────────────
      this._endMatch(matchWinner, matchWinnerId);
    } else {
      // ── Schedule next round after countdown ───────────────────────────────
      console.log(`[Room ${this.roomId}] Next round in ${BETWEEN_ROUNDS_DELAY_MS}ms`);
      this._countdownTimer = setTimeout(() => {
        this._countdownTimer = null;
        // Safety: room might have emptied during countdown
        if (this._players.size >= MIN_PLAYERS && this.state === 'between_rounds') {
          this._startRound();
        } else {
          console.warn(`[Room ${this.roomId}] Countdown elapsed but room no longer viable — cancelling`);
          if (this._matchId) BackendClient.cancelMatch(this._matchId).catch(() => {});
        }
      }, BETWEEN_ROUNDS_DELAY_MS);
    }
  }

  /**
   * End the entire match. Only called when a player reaches winsRequired.
   * Emits matchEnded and calls the backend to trigger payout.
   * NEVER called after individual rounds.
   */
  _endMatch(winnerWallet, winnerId) {
    this.state = 'ended';
    const isDraw = winnerWallet === null;

    console.log(
      `[Room ${this.roomId}] MATCH ENDED after ${this.currentRound} rounds — ` +
      `winner: ${winnerWallet ?? 'draw'}`
    );

    // ── 1. Broadcast final result to all clients ──────────────────────────────
    this._emitToRoom('matchEnded', {
      roomId:       this.roomId,
      winnerWallet: winnerWallet ?? null,
      winnerId:     winnerId     ?? null,
      draw:         isDraw,
      scores:       this._getScores(),
      totalRounds:  this.currentRound,
      rounds:       this.rounds,
    });

    // ── 2. Authoritative server-to-server backend call ────────────────────────
    // Backend validates winner is a paid player before paying out.
    // Frontend has NO way to trigger this (requires SERVER_SECRET).
    if (this._matchId) {
      BackendClient.finishMatch(this._matchId, winnerWallet, winnerId, isDraw)
        .catch(err => {
          console.error(`[Room ${this.roomId}] Backend finishMatch error: ${err.message}`);
        });
    } else {
      console.warn(`[Room ${this.roomId}] matchEnded but no matchId — backend not notified`);
    }
  }

  // ─── Input ───────────────────────────────────────────────────────────────────

  handleInput(socketId, direction) {
    if (this.state !== 'playing' || !this._gameLoop) return;
    const valid = ['left', 'right', 'neutral'];
    if (!valid.includes(direction)) return;
    this._gameLoop.setInput(socketId, direction);
  }

  // ─── Leave / disconnect ───────────────────────────────────────────────────────

  removePlayer(socketId) {
    if (!this._players.has(socketId)) return;

    const player = this._players.get(socketId);
    this._players.delete(socketId);
    console.log(`[Room ${this.roomId}] ${player.wallet} left`);

    if (this._players.size === 0) {
      this._cleanup();
      this._onEmpty();
      return;
    }

    // Migrate host
    if (socketId === this.hostId) {
      this.hostId = [...this._players.keys()][0];
      console.log(`[Room ${this.roomId}] Host migrated to ${this.hostId}`);
    }

    if (this.state === 'lobby') {
      this._emitToRoom('lobbyState', this.getLobbyState());
    }
  }

  _cleanup() {
    // Stop active game loop
    this._gameLoop?.stop();
    this._gameLoop = null;

    // Clear any pending between-rounds countdown
    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }

    // Cancel match in backend if it was never finished
    if (this._matchId && this.state !== 'ended') {
      BackendClient.cancelMatch(this._matchId).catch(() => {});
    }
  }

  // ─── Game state passthrough ───────────────────────────────────────────────────

  _onGameState(snapshot) {
    this._emitToRoom('gameState', snapshot);
  }

  _onPlayerDied(socketId, wallet, reason) {
    this._emitToRoom('playerDied', { socketId, wallet, reason });
  }
}

module.exports = { Room };
