'use strict';

const { GameLoop }  = require('../game/GameLoop');
const BackendClient = require('../services/BackendClient');
const {
  MIN_PLAYERS,
  MAX_PLAYERS,
  VALID_ROUNDS,
  DEFAULT_ROUNDS,
  BETWEEN_ROUNDS_DELAY_MS,
  POST_MATCH_GRACE_MS,
  PRE_GAME_COUNTDOWN_MS,
  PLAYER_COLORS,
} = require('../game/constants');

/**
 * Room
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────
 *
 *  lobby → starting → playing → between_rounds → ... → ended → (rematch lobby) → ...
 *
 *  'starting' is a 5-second synchronized pre-game countdown:
 *    - host calls startGame() → validated → state becomes 'starting'
 *    - gameStarting is broadcast with gameStartAt (Date.now() + 5000)
 *    - no one may join during 'starting'
 *    - after exactly PRE_GAME_COUNTDOWN_MS, gameStarted is broadcast and the
 *      game loop begins (_startRound)
 *    - if the room becomes invalid during the countdown (too few players),
 *      the start is cancelled and the room returns to 'lobby'
 *
 *  After matchEnded the room enters 'ended' state and stays alive for
 *  POST_MATCH_GRACE_MS (60 s).  During that window players may:
 *    - playAgain  → room resets to a fresh 'lobby' (same format, new matchId)
 *    - exitMatch  → player leaves; if last player, room is cleaned up
 *
 *  If nobody calls playAgain within 60 s the grace timer fires and the room
 *  is destroyed normally.
 *
 * ── Rematch security ─────────────────────────────────────────────────────────
 *  - Only wallets that were in the ended match (_eligibleWallets) may join
 *    the rematch lobby directly via playAgain.
 *  - The rematch gets a brand-new matchId from the backend.
 *  - All ready/payment state is reset — players must pay again.
 *  - Scoreboard wins reset to 0.
 *
 * ── Scoreboard ───────────────────────────────────────────────────────────────
 *  { wallet, username, color, wins, alive, rank, activePowerUp }
 *  Authoritative — frontend must never calculate wins or ranks.
 */
class Room {
  /**
   * @param {string}   opts.roomId
   * @param {string}   opts.hostId
   * @param {string}   opts.hostWallet
   * @param {string}   opts.hostUsername
   * @param {number}   [opts.entryFee=0]
   * @param {number}   [opts.rounds=1]
   * @param {Function} opts.emitToRoom
   * @param {Function} opts.emitToSocket
   * @param {Function} opts.onEmpty
   * @param {Function} opts.releaseSocket
   */
  constructor({ roomId, hostId, hostWallet, hostUsername, entryFee = 0,
                rounds = DEFAULT_ROUNDS, emitToRoom, emitToSocket, onEmpty, releaseSocket }) {
    this.roomId   = roomId;
    this.hostId   = hostId;
    this.state    = 'lobby';
    this.entryFee = entryFee;

    this.rounds       = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
    this.winsRequired = Math.ceil(this.rounds / 2);
    this.currentRound = 0;

    this._emitToRoom    = emitToRoom;
    this._emitToSocket  = emitToSocket;
    this._onEmpty       = onEmpty;
    this._releaseSocket = releaseSocket;

    // socketId → { socketId, wallet, ready }
    this._players   = new Map();

    // Scoreboard state — all Maps keyed by socketId
    this._usernames = new Map();
    this._colors    = new Map();   // socketId → color (assigned at join, stable for the session)
    this._wins      = new Map();
    this._alive     = new Map();

    // wallet → color — lets a reconnecting wallet (new socketId) recover its
    // previous color before the game starts. Best-effort: if that color has
    // since been taken by another player, the reconnecting wallet gets the
    // next available color instead.
    this._walletColors = new Map();

    // socketId → { lengthMultiplier, speedMultiplier, shieldCount, eliminations }
    // PERSISTS ACROSS ROUNDS in the same match. Reset on rematch.
    //   - lengthMultiplier: 1.0 → 2.5 (cap). +0.20 per Length Boost pickup,
    //                       +0.10 per elimination.
    //   - speedMultiplier:  1.0 → 1.25 (cap). +0.05 per elimination.
    //                       (Length Boost does NOT affect speed.)
    //   - shieldCount:      0 → 3 (cap). +1 per Shield pickup. -1 on trail hit.
    //   - eliminations:     counter for scoreboard/debug.
    // Initialised lazily in _ensureGrowth(socketId).
    this._growth = new Map();

    this._gameLoop       = null;
    this._matchId        = null;
    this._countdownTimer = null;
    this._graceTimer     = null;
    this._preGameTimer   = null;

    // Set when state becomes 'starting' — unix ms timestamp of game start.
    // Cleared (null) when not in the 'starting' state.
    this.gameStartAt = null;

    // Set of wallet addresses eligible to join rematch — populated at matchEnded
    this._eligibleWallets = new Set();

    this._addPlayer(hostId, hostWallet, hostUsername);

    // ── Register match with backend immediately ──────────────────────────────
    // matchId = roomId by convention. This is set SYNCHRONOUSLY so that
    // verify-payment can be called by players in the lobby — before startGame.
    // The actual backend POST is fire-and-forget (idempotent — safe to retry
    // and safe if it arrives after a verify-payment call due to network timing,
    // since the backend's INSERT OR IGNORE means the row will exist by the
    // time verify-payment's SELECT runs in practice, and if a race does occur
    // the backend returns 404 which the frontend can retry).
    this._matchId = roomId;

    BackendClient.createMatch(this.roomId, this.entryFee, MAX_PLAYERS, this.rounds, 'curve_fever', hostWallet)
      .catch(err => {
        console.error(`[Room ${this.roomId}] Backend match registration error: ${err.message}`);
      });

    console.log(`[Room ${this.roomId}] Created — BO${this.rounds} (need ${this.winsRequired} wins) — matchId: ${this._matchId}`);
  }

  // ─── Player registration ──────────────────────────────────────────────────────

  _addPlayer(socketId, wallet, username) {
    this._players.set(socketId, { socketId, wallet, ready: false });

    this._assignColor(socketId, wallet);
    this._ensureGrowth(socketId);

    if (!this._usernames.has(socketId)) {
      this._usernames.set(socketId, username || wallet);
    }
    if (!this._wins.has(socketId)) this._wins.set(socketId, 0);
    if (!this._alive.has(socketId)) this._alive.set(socketId, true);
  }

  /**
   * Initialise the growth record for a player if it doesn't exist yet.
   * Idempotent — safe to call on every join (existing growth is preserved).
   */
  _ensureGrowth(socketId) {
    if (!this._growth.has(socketId)) {
      this._growth.set(socketId, {
        lengthMultiplier: 1.0,
        speedMultiplier:  1.0,
        shieldCount:      0,
        eliminations:     0,
      });
    }
  }

  /**
   * Assign a stable color to a player when they join.
   *
   * Color rules:
   *   - Each socketId keeps its color for the lifetime of that connection —
   *     never reassigned later (not at game start, not mid-match).
   *   - No two players in the same room ever hold the same color at once
   *     (palette has exactly MAX_PLAYERS=6 colors).
   *   - If this socketId already has a color (e.g. _addPlayer called again
   *     idempotently), do nothing.
   *   - If this wallet previously held a color (reconnect with a new socketId
   *     before the game started) AND that color is currently free, reuse it.
   *   - Otherwise, assign the first color in PLAYER_COLORS not currently held
   *     by any connected socketId.
   */
  _assignColor(socketId, wallet) {
    // Already has a color — never reassign (covers idempotent _addPlayer calls
    // and "do not reassign at game start")
    if (this._colors.has(socketId)) return this._colors.get(socketId);

    const inUse = new Set(this._colors.values());

    // Try to preserve this wallet's previous color if it's free
    const previousColor = this._walletColors.get(wallet);
    if (previousColor && !inUse.has(previousColor)) {
      this._colors.set(socketId, previousColor);
      this._walletColors.set(wallet, previousColor);
      return previousColor;
    }

    // Otherwise pick the first unused color in the palette
    const color = PLAYER_COLORS.find(c => !inUse.has(c)) ?? PLAYER_COLORS[0];
    this._colors.set(socketId, color);
    this._walletColors.set(wallet, color);
    return color;
  }

  /**
   * Free a socket's color so it becomes available to other players.
   * Only call this for players leaving BEFORE the game starts (lobby/starting).
   * Never call during an active match — colors must not change mid-match.
   *
   * _walletColors is intentionally left untouched so the same wallet can
   * recover this color via _assignColor if they reconnect before the color
   * is claimed by someone else.
   */
  _releaseColor(socketId) {
    this._colors.delete(socketId);
  }

  // ─── Scoreboard ───────────────────────────────────────────────────────────────

  _buildScoreboard() {
    const entries = [...this._players.keys()].map(socketId => {
      const player = this._players.get(socketId);
      const growth = this._growth.get(socketId);
      return {
        socketId,
        wallet:           player.wallet,
        username:         this._usernames.get(socketId) ?? player.wallet,
        color:            this._colors.get(socketId)    ?? '#FFFFFF',
        wins:             this._wins.get(socketId)      ?? 0,
        alive:            this._alive.get(socketId)     ?? true,
        activePowerUp:    this._gameLoop?.getActivePowerUp(socketId) ?? null,
        // Growth fields — persist across rounds in this match
        lengthMultiplier: growth?.lengthMultiplier ?? 1.0,
        speedMultiplier:  growth?.speedMultiplier  ?? 1.0,
        shieldCount:      growth?.shieldCount      ?? 0,
        eliminations:     growth?.eliminations     ?? 0,
      };
    });

    entries.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return (b.alive ? 1 : 0) - (a.alive ? 1 : 0);
    });

    let rank = 1;
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) {
        const prev = entries[i - 1];
        const curr = entries[i];
        if (curr.wins !== prev.wins || curr.alive !== prev.alive) rank = i + 1;
      }
      entries[i].rank = rank;
    }

    return entries.map(({ socketId: _sid, ...rest }) => rest);
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get playerCount()   { return this._players.size; }
  get isFull()        { return this._players.size >= MAX_PLAYERS; }
  get hasMinPlayers() { return this._players.size >= MIN_PLAYERS; }

  getLobbyState() {
    return {
      roomId:           this.roomId,
      hostId:           this.hostId,
      state:            this.state,
      entryFee:         this.entryFee,
      matchId:          this._matchId,
      rounds:           this.rounds,
      winsRequired:     this.winsRequired,
      currentRound:     this.currentRound,
      // Pre-game countdown — only set while state === 'starting'
      gameStartAt:      this.gameStartAt,
      countdownSeconds: this.gameStartAt
        ? Math.max(0, Math.ceil((this.gameStartAt - Date.now()) / 1000))
        : null,
      scoreboard:   this._buildScoreboard(),
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        username: this._usernames.get(p.socketId),
        ready:    p.ready,
        color:    this._colors.get(p.socketId) ?? '#FFFFFF',
      })),
    };
  }

  // ─── Lobby actions ────────────────────────────────────────────────────────────

  join(socketId, wallet, username) {
    // 'starting' = pre-game countdown in progress — no new players allowed
    if (this.state === 'starting')   return { ok: false, error: 'Game is starting — cannot join now' };
    if (this.state !== 'lobby')      return { ok: false, error: 'Game already in progress' };
    if (this.isFull)                 return { ok: false, error: 'Room is full' };
    if (this._players.has(socketId)) return { ok: false, error: 'Already in room' };

    this._addPlayer(socketId, wallet, username);
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

  /**
   * Host requests the game to start.
   *
   * Does NOT start the game immediately. Validates everything, then enters
   * a 5-second synchronized 'starting' countdown. The actual game start
   * (_actuallyStartGame) happens server-side after PRE_GAME_COUNTDOWN_MS,
   * regardless of what the frontend does — the server is the sole authority
   * on when the game begins.
   */
  startGame(requesterId) {
    if (requesterId !== this.hostId) {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Only the host can start the game' });
      return;
    }
    // 'starting' state: a countdown is already in progress — ignore duplicate calls
    if (this.state === 'starting') {
      this._emitToSocket(requesterId, 'errorMessage', { message: 'Game is already starting' });
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

    // ── All validation passed — enter the 'starting' countdown ────────────────
    this.state       = 'starting';
    this.gameStartAt = Date.now() + PRE_GAME_COUNTDOWN_MS;

    console.log(
      `[Room ${this.roomId}] ── gameStarting — countdown ${PRE_GAME_COUNTDOWN_MS / 1000}s, ` +
      `gameStartAt: ${this.gameStartAt}`
    );

    this._emitToRoom('gameStarting', {
      roomId:           this.roomId,
      gameStartAt:      this.gameStartAt,
      countdownSeconds: PRE_GAME_COUNTDOWN_MS / 1000,
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        username: this._usernames.get(p.socketId),
        color:    this._colors.get(p.socketId),
      })),
      scoreboard: this._buildScoreboard(),
    });

    this._preGameTimer = setTimeout(() => {
      this._preGameTimer = null;
      this._actuallyStartGame();
    }, PRE_GAME_COUNTDOWN_MS);
  }

  /**
   * Called exactly PRE_GAME_COUNTDOWN_MS after gameStarting was broadcast.
   *
   * Re-validates the room is still viable (players may have disconnected
   * during the countdown). If not viable, cancels the start and returns the
   * room to 'lobby'. Otherwise proceeds with the existing gameStarted flow
   * and begins the game loop.
   */
  _actuallyStartGame() {
    // ── Safety re-check: room may have become invalid during the countdown ────
    if (this.state !== 'starting') {
      // Room was already moved out of 'starting' by some other path
      // (e.g. removePlayer cancelled the countdown) — nothing to do.
      return;
    }

    if (!this.hasMinPlayers) {
      console.warn(`[Room ${this.roomId}] Countdown finished but room no longer has enough players — cancelling start`);
      this.state       = 'lobby';
      this.gameStartAt = null;
      this._emitToRoom('errorMessage', { message: 'Not enough players — game start cancelled' });
      this._emitToRoom('lobbyState', this.getLobbyState());
      return;
    }

    // Host may have disconnected during the countdown — host migration already
    // handles this in removePlayer, so this.hostId is guaranteed valid here.

    this.state       = 'playing';
    this.gameStartAt = null;

    // Reset scoreboard wins for new match
    for (const socketId of this._players.keys()) {
      this._wins.set(socketId, 0);
      this._alive.set(socketId, true);
    }

    this._emitToRoom('gameStarted', {
      roomId:       this.roomId,
      rounds:       this.rounds,
      winsRequired: this.winsRequired,
      scoreboard:   this._buildScoreboard(),
      players: [...this._players.values()].map(p => ({
        socketId: p.socketId,
        wallet:   p.wallet,
        username: this._usernames.get(p.socketId),
        color:    this._colors.get(p.socketId),
      })),
    });

    // Match record was already created when the room was created (constructor).
    // _matchId === this.roomId by convention — already set.
    // Register players (idempotent — INSERT OR IGNORE) and mark match as started.
    const walletList = [...this._players.values()].map(p => p.wallet);
    BackendClient.registerPlayers(this._matchId, walletList)
      .then(() => BackendClient.startMatch(this._matchId))
      .catch(err => {
        console.error(`[Room ${this.roomId}] Backend start registration error: ${err.message}`);
      });

    this._startRound();
  }

  // ─── Round management ─────────────────────────────────────────────────────────

  _startRound() {
    this.currentRound++;
    this.state = 'playing';

    for (const socketId of this._players.keys()) {
      this._alive.set(socketId, true);
    }

    const playerIds = [...this._players.keys()];
    const wallets   = new Map([...this._players.entries()].map(([id, p]) => [id, p.wallet]));

    console.log(`[Room ${this.roomId}] ── roundStarted ${this.currentRound}/${this.rounds}`);

    this._emitToRoom('roundStarted', {
      roomId:       this.roomId,
      currentRound: this.currentRound,
      rounds:       this.rounds,
      winsRequired: this.winsRequired,
      scoreboard:   this._buildScoreboard(),
    });

    this._gameLoop = new GameLoop({
      playerIds,
      wallets,
      colors:             this._colors,
      growth:             this._growth,
      onGameState:        snap                     => this._onGameState(snap),
      onPlayerDied:       (id, wallet, reason)     => this._onPlayerDied(id, wallet, reason),
      onRoundEnded:       (winnerId, winnerWallet) => this._onRoundEnded(winnerId, winnerWallet),
      onPowerUpsUpdate:   (powerUps)               => this._onPowerUpsUpdate(powerUps),
      onPowerUpCollected: (socketId, type, dur)    => this._onPowerUpCollected(socketId, type, dur),
      onPowerUpExpired:   (socketId, type)         => this._onPowerUpExpired(socketId, type),
      onPowerUpUsed:      (socketId, type)         => this._onPowerUpUsed(socketId, type),
      onPlayerGrowth:     (socketId, growthData)   => this._onPlayerGrowth(socketId, growthData),
      onArenaPhaseChange: (phase, snap)            => this._onArenaPhaseChange(phase, snap),
    });

    this._gameLoop.start();
  }

  // ─── Growth & arena callbacks ────────────────────────────────────────────────

  // NOTE: growth and arena-phase changes are intentionally NOT emitted as
  // their own socket events. Emblem reads everything it needs from the
  // per-tick gameState snapshot:
  //   - growth        -> players[].lengthMultiplier / shieldCount / activePowerups
  //   - trail width   -> trails[].r
  //   - arena phase   -> arena.phase / arena.warningEndsAt / arena.shrinkProgress
  // Keeping these out of the event stream keeps the protocol simple. A
  // dedicated playerGrowth event can be re-added later for special kill/growth
  // UI animations. The callbacks below are kept (no socket emit) so GameLoop's
  // interface is unchanged and the shared _growth map is still updated.

  _onPlayerGrowth(_socketId, _growthData) {
    // Intentionally no socket emit — growth is surfaced via gameState only.
  }

  _onArenaPhaseChange(newPhase, _arenaSnapshot) {
    // Server-side log only — no socket emit. Phase is in gameState.arena.phase.
    console.log(`[Room ${this.roomId}] Arena phase -> ${newPhase}`);
  }

  // ─── Game callbacks ───────────────────────────────────────────────────────────

  _onGameState(snapshot) {
    this._emitToRoom('gameState', {
      ...snapshot,
      scoreboard: this._buildScoreboard(),
    });
  }

  _onPlayerDied(socketId, wallet, reason) {
    this._alive.set(socketId, false);
    console.log(`[Room ${this.roomId}] playerDied — wallet: ${wallet}, reason: ${reason}`);
    this._emitToRoom('playerDied', { socketId, wallet, reason });
    this._emitToRoom('scoreboardUpdate', { scoreboard: this._buildScoreboard() });
  }

  _onRoundEnded(winnerId, winnerWallet) {
    this._gameLoop = null;
    this.state = 'between_rounds';

    const isDraw = winnerWallet === null;

    if (!isDraw && winnerId) {
      this._wins.set(winnerId, (this._wins.get(winnerId) ?? 0) + 1);
    }

    const topWins           = Math.max(...[...this._wins.values()]);
    const matchOver         = !isDraw && topWins >= this.winsRequired;
    const matchWinnerWallet = matchOver ? winnerWallet : null;
    const matchWinnerId     = matchOver ? winnerId     : null;
    const scoreboard        = this._buildScoreboard();
    const nextRoundStartsAt = matchOver ? null : Date.now() + BETWEEN_ROUNDS_DELAY_MS;

    console.log(
      `[Room ${this.roomId}] ── roundEnded ${this.currentRound} — ` +
      `winner: ${winnerWallet ?? 'draw'} | matchOver: ${matchOver} | ` +
      `scores: ${JSON.stringify(scoreboard.map(e => `${e.username}:${e.wins}`))}`
    );

    this._emitToRoom('roundEnded', {
      roomId:            this.roomId,
      roundWinnerWallet: winnerWallet ?? null,
      roundWinnerId:     winnerId     ?? null,
      draw:              isDraw,
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
      console.log(`[Room ${this.roomId}] Next round in ${BETWEEN_ROUNDS_DELAY_MS / 1000}s`);
      this._countdownTimer = setTimeout(() => {
        this._countdownTimer = null;
        if (this._players.size >= MIN_PLAYERS && this.state === 'between_rounds') {
          this._startRound();
        } else {
          console.warn(`[Room ${this.roomId}] Countdown done but not enough players — cancelling`);
          if (this._matchId) BackendClient.cancelMatch(this._matchId).catch(() => {});
          this._scheduleRoomCleanup();
        }
      }, BETWEEN_ROUNDS_DELAY_MS);
    }
  }

  _endMatch(winnerWallet, winnerId) {
    this.state = 'ended';
    const isDraw = winnerWallet === null;

    // Record everyone who played this match as eligible for rematch
    this._eligibleWallets = new Set(
      [...this._players.values()].map(p => p.wallet)
    );

    console.log(
      `[Room ${this.roomId}] ── matchEnded after ${this.currentRound} rounds — ` +
      `winner: ${winnerWallet ?? 'draw'}`
    );

    this._emitToRoom('matchEnded', {
      roomId:       this.roomId,
      winnerWallet: winnerWallet ?? null,
      winnerId:     winnerId     ?? null,
      draw:         isDraw,
      scoreboard:   this._buildScoreboard(),
      totalRounds:  this.currentRound,
      rounds:       this.rounds,
    });

    if (this._matchId) {
      // Pass extra context so the backend can self-heal the match record if it
      // was never created at room-creation time (defensive — normally a no-op
      // since createMatch already ran in the constructor).
      const walletList = [...this._players.values()].map(p => p.wallet);
      BackendClient.finishMatch(this._matchId, winnerWallet, winnerId, isDraw, {
        roomId:       this.roomId,
        players:      walletList,
        entryFeeUsdc: this.entryFee,
        maxPlayers:   MAX_PLAYERS,
        totalRounds:  this.rounds,
      }).catch(err => {
        console.error(`[Room ${this.roomId}] [match_finish_backend_failed] ${err.message}`);
      });
    } else {
      console.warn(`[Room ${this.roomId}] matchEnded but no matchId — backend not notified`);
    }

    this._scheduleRoomCleanup();
  }

  // ─── Rematch ──────────────────────────────────────────────────────────────────

  /**
   * A player chooses to play again after matchEnded.
   *
   * On the FIRST call:  cancel the grace timer, reset room to a fresh lobby,
   *                     emit rematchLobbyCreated to the whole room.
   * On subsequent calls: player is added to the existing rematch lobby,
   *                      emit rematchJoined to the joining socket.
   *
   * Only wallets that were in the ended match may join.
   *
   * @param {string} socketId
   * @param {string} wallet
   * @returns {{ ok: boolean, error?: string }}
   */
  playAgain(socketId, wallet) {
    // Security: only players from the ended match
    if (!this._eligibleWallets.has(wallet)) {
      return { ok: false, error: 'You were not part of this match' };
    }

    if (this.state === 'ended') {
      // First player to click — reset room to fresh lobby
      this._cancelGraceTimer();
      this._resetForRematch(socketId, wallet);

      console.log(`[Room ${this.roomId}] Rematch lobby created by ${wallet}`);

      this._emitToRoom('rematchLobbyCreated', {
        roomId:     this.roomId,
        lobbyState: this.getLobbyState(),
      });

      return { ok: true, isFirst: true };
    }

    if (this.state === 'lobby') {
      // Rematch lobby already exists — join it
      if (this.isFull) {
        return { ok: false, error: 'Lobby is full' };
      }
      if (this._players.has(socketId)) {
        return { ok: false, error: 'Already in rematch lobby' };
      }

      const username = this._usernames.get(socketId) ?? wallet;
      this._addPlayer(socketId, wallet, username);

      console.log(`[Room ${this.roomId}] ${wallet} joined rematch lobby`);

      this._emitToSocket(socketId, 'rematchJoined', {
        roomId:     this.roomId,
        lobbyState: this.getLobbyState(),
      });

      // Tell everyone else the lobby updated
      this._emitToRoom('lobbyState', this.getLobbyState());

      return { ok: true, isFirst: false };
    }

    return { ok: false, error: 'Cannot join rematch at this time' };
  }

  /**
   * Reset room state for a rematch.
   * - Clears all player slots except the requesting player
   * - Resets scoreboard wins to 0
   * - Resets ready states
   * - Clears matchId (new one comes from backend when next game starts)
   * - Sets host to the requesting player (or first remaining if host left)
   * - Keeps same format (rounds, entryFee)
   *
   * Colors: _colors is cleared so the rematch lobby re-assigns colors via
   * _assignColor. Because _walletColors is kept intact, any player whose
   * socket is still connected (the common case — playAgain reuses the same
   * socket) will recover their previous color automatically the moment
   * _addPlayer runs for them again (here for the first player, and in
   * playAgain's 'lobby' branch for subsequent players). _usernames is kept
   * intact too (stable across rematches).
   */
  _resetForRematch(socketId, wallet) {
    const username = this._usernames.get(socketId) ?? wallet;

    this._players.clear();
    this._wins.clear();
    this._alive.clear();
    this._colors.clear();
    this._growth.clear();   // Growth resets on rematch — NOT between rounds within a match

    this.state        = 'lobby';
    this.currentRound = 0;
    this.hostId       = socketId;
    this.gameStartAt  = null;
    this._cancelPreGameTimer();

    // _matchId stays === this.roomId (matchId/roomId are the same value by
    // convention and never change for the lifetime of this Room object).
    //
    // NOTE: the backend match record for this matchId now has status='finished'
    // from the previous match. verify-payment on the rematch will currently
    // fail with WRONG_STATUS until the backend supports re-opening a finished
    // match for a new round of payments. This is a known follow-up — out of
    // scope for the room-creation registration fix.

    // Re-add the first player
    this._addPlayer(socketId, wallet, username);
  }

  /**
   * A player explicitly exits after a match ends.
   * Works during state 'ended' OR 'lobby' (rematch lobby).
   *
   * @param {string} socketId
   * @returns {{ ok: boolean }}
   */
  exitMatch(socketId) {
    if (!this._players.has(socketId)) {
      return { ok: false, error: 'Not in this room' };
    }

    const player = this._players.get(socketId);
    this._players.delete(socketId);
    this._releaseSocket(socketId);

    // exitMatch only runs in 'ended' or 'lobby' (rematch) states — never
    // during an active match — so it's always safe to free the color.
    this._releaseColor(socketId);

    console.log(`[Room ${this.roomId}] ${player.wallet} exited`);

    if (this._players.size === 0) {
      // Last player left — clean up immediately (no need to wait for grace timer)
      this._cancelGraceTimer();
      this._stopEverything();
      this._onEmpty();
      return { ok: true };
    }

    // Migrate host if needed
    if (socketId === this.hostId) {
      this.hostId = [...this._players.keys()][0];
      console.log(`[Room ${this.roomId}] Host migrated to ${this.hostId}`);
    }

    // Broadcast updated lobby to remaining players
    this._emitToRoom('lobbyState', this.getLobbyState());
    return { ok: true };
  }

  // ─── Input ───────────────────────────────────────────────────────────────────

  handleInput(socketId, direction) {
    if (this.state !== 'playing' || !this._gameLoop) return;
    const valid = ['left', 'right', 'neutral'];
    if (!valid.includes(direction)) return;
    this._gameLoop.setInput(socketId, direction);
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────────

  removePlayer(socketId) {
    if (!this._players.has(socketId)) return;

    const player = this._players.get(socketId);
    this._players.delete(socketId);
    console.log(`[Room ${this.roomId}] ${player.wallet} disconnected`);

    this._releaseSocket(socketId);

    if (this.state === 'lobby') {
      // Free this socket's color — it becomes available to other players.
      // _walletColors keeps the mapping so this wallet can recover the same
      // color if it reconnects before the game starts.
      this._releaseColor(socketId);

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

    // ── 'starting': pre-game countdown in progress ──────────────────────────
    if (this.state === 'starting') {
      // Free this socket's color — same reasoning as the 'lobby' branch above.
      this._releaseColor(socketId);

      if (this._players.size === 0) {
        // Everyone left — cancel countdown and clean up
        this._cancelPreGameTimer();
        this.gameStartAt = null;
        this._onEmpty();
        return;
      }

      // Migrate host if needed
      if (socketId === this.hostId) {
        this.hostId = [...this._players.keys()][0];
        console.log(`[Room ${this.roomId}] Host migrated to ${this.hostId}`);
      }

      if (this._players.size < MIN_PLAYERS) {
        // Not enough players to proceed — cancel the countdown, return to lobby
        console.warn(`[Room ${this.roomId}] Player left during countdown — not enough players, cancelling start`);
        this._cancelPreGameTimer();
        this.state       = 'lobby';
        this.gameStartAt = null;
        this._emitToRoom('errorMessage', { message: 'Not enough players — game start cancelled' });
        this._emitToRoom('lobbyState', this.getLobbyState());
        return;
      }

      // Still enough players — countdown continues unaffected.
      // Broadcast updated player list/scoreboard so clients can update the UI.
      this._emitToRoom('lobbyState', this.getLobbyState());
      return;
    }

    if (this.state === 'between_rounds' && this._players.size < MIN_PLAYERS) {
      console.warn(`[Room ${this.roomId}] Not enough players during countdown — ending match early`);
      if (this._countdownTimer) {
        clearTimeout(this._countdownTimer);
        this._countdownTimer = null;
      }
      if (this._matchId) BackendClient.cancelMatch(this._matchId).catch(() => {});
      this._scheduleRoomCleanup();
    }

    // During 'ended': player disconnected while viewing results.
    // The grace timer is still running; if last player disconnects, clean up.
    if (this.state === 'ended' && this._players.size === 0) {
      this._cancelGraceTimer();
      this._stopEverything();
      this._onEmpty();
    }
  }

  // ─── Power-up callbacks ───────────────────────────────────────────────────────

  _onPowerUpsUpdate(powerUps) {
    this._emitToRoom('powerUpsUpdate', { powerUps });
  }

  _onPowerUpCollected(socketId, type, durationMs) {
    const player = this._players.get(socketId);
    if (!player) return;
    console.log(`[Room ${this.roomId}] ${player.wallet} collected ${type}`);
    this._emitToRoom('powerUpCollected', {
      socketId,
      playerWallet:   player.wallet,
      playerUsername: this._usernames.get(socketId) ?? player.wallet,
      type,
      duration:       durationMs,
    });
    this._emitToRoom('scoreboardUpdate', { scoreboard: this._buildScoreboard() });
  }

  _onPowerUpExpired(socketId, type) {
    const player = this._players.get(socketId);
    if (!player) return;
    this._emitToRoom('powerUpExpired', { socketId, playerWallet: player.wallet, type });
    this._emitToRoom('scoreboardUpdate', { scoreboard: this._buildScoreboard() });
  }

  _onPowerUpUsed(socketId, type) {
    const player = this._players.get(socketId);
    if (!player) return;
    console.log(`[Room ${this.roomId}] ${player.wallet} used ${type}`);
    this._emitToRoom('powerUpUsed', { socketId, playerWallet: player.wallet, type });
  }

  // ─── Internal cleanup ────────────────────────────────────────────────────────

  _scheduleRoomCleanup() {
    console.log(`[Room ${this.roomId}] Cleanup scheduled in ${POST_MATCH_GRACE_MS / 1000}s`);
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this._stopEverything();
      console.log(`[Room ${this.roomId}] ── room cleanup — releasing all sockets`);
      for (const socketId of this._players.keys()) {
        this._releaseSocket(socketId);
      }
      this._onEmpty();
    }, POST_MATCH_GRACE_MS);
  }

  _cancelGraceTimer() {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
  }

  _stopEverything() {
    this._gameLoop?.stop();
    this._gameLoop = null;
    if (this._countdownTimer) {
      clearTimeout(this._countdownTimer);
      this._countdownTimer = null;
    }
    this._cancelPreGameTimer();
  }

  _cancelPreGameTimer() {
    if (this._preGameTimer) {
      clearTimeout(this._preGameTimer);
      this._preGameTimer = null;
    }
  }
}

module.exports = { Room };
