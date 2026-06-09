'use strict';

const {
  PLAYER_SPEED,
  TURN_RATE,
  TRAIL_GAP_INTERVAL,
  TRAIL_GAP_DURATION,
  TICK_INTERVAL_MS,
  PLAYER_COLORS,
} = require('./constants');

const { collidesWithWall, collidesWithTrails } = require('./collision');
const { generateSpawns } = require('./spawn');

/**
 * GameLoop
 *
 * Runs ONE round of the game.
 * Multi-round orchestration lives in Room.js — this class knows nothing about
 * rounds, scores, or match winners. It only knows about a single round.
 *
 * Callbacks:
 *   onGameState(snapshot)            — called every tick while running
 *   onPlayerDied(id, wallet, reason) — called when a player dies
 *   onRoundEnded(winnerId, wallets)  — called with the round winner (null = draw)
 */
class GameLoop {
  /**
   * @param {object} opts
   * @param {string[]}              opts.playerIds   ordered socket ID list
   * @param {Map<string,string>}    opts.wallets     socketId → walletAddress
   * @param {Map<string,string>}    opts.colors      socketId → hex color (preserved across rounds)
   * @param {Function}              opts.onGameState
   * @param {Function}              opts.onPlayerDied
   * @param {Function}              opts.onRoundEnded
   */
  constructor({ playerIds, wallets, colors, onGameState, onPlayerDied, onRoundEnded }) {
    this._playerIds    = [...playerIds];
    this._wallets      = wallets;
    this._colors       = colors;          // keeps colors stable across rounds
    this._onGameState  = onGameState;
    this._onPlayerDied = onPlayerDied;
    this._onRoundEnded = onRoundEnded;

    this._tick       = 0;
    this._intervalId = null;
    this._running    = false;

    this._players = new Map();
    this._trails  = new Map();   // socketId → Array<{x, y, gap}>
    this._inputs  = new Map();   // socketId → 'left' | 'right' | 'neutral'

    this._initPlayers();
  }

  // ─── Init / Reset ────────────────────────────────────────────────────────────

  _initPlayers() {
    const spawns = generateSpawns(this._playerIds.length);

    this._players.clear();
    this._trails.clear();
    this._inputs.clear();

    this._playerIds.forEach((id, idx) => {
      const spawn = spawns[idx];

      this._players.set(id, {
        id,
        wallet: this._wallets.get(id) || id,
        // Color from preserved map, falling back to index-based default
        color:  this._colors?.get(id) ?? PLAYER_COLORS[idx % PLAYER_COLORS.length],
        x:      spawn.x,
        y:      spawn.y,
        angle:  spawn.angle,
        alive:  true,
      });

      this._trails.set(id, []);
      this._inputs.set(id, 'neutral');
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running    = true;
    this._intervalId = setInterval(() => this._step(), TICK_INTERVAL_MS);
    console.log('[GameLoop] Round started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._intervalId);
    this._intervalId = null;
    console.log('[GameLoop] Round stopped');
  }

  setInput(playerId, direction) {
    if (this._inputs.has(playerId)) {
      this._inputs.set(playerId, direction);
    }
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  _step() {
    this._tick++;

    const aliveBefore = [];

    for (const [id, player] of this._players) {
      if (!player.alive) continue;
      aliveBefore.push(id);

      // 1. Apply turning
      const input = this._inputs.get(id);
      if (input === 'left')  player.angle -= TURN_RATE;
      if (input === 'right') player.angle += TURN_RATE;

      // 2. Move forward
      const newX = player.x + Math.cos(player.angle) * PLAYER_SPEED;
      const newY = player.y + Math.sin(player.angle) * PLAYER_SPEED;

      // 3. Collision detection
      const hitWall  = collidesWithWall(newX, newY);
      const hitTrail = collidesWithTrails(newX, newY, this._trails, id);

      if (hitWall || hitTrail) {
        this._killPlayer(id, hitWall ? 'wall' : 'trail');
        continue;
      }

      // 4. Commit movement
      player.x = newX;
      player.y = newY;

      // 5. Append trail point
      const isGap = this._isGapTick();
      this._trails.get(id).push({ x: newX, y: newY, gap: isGap });
    }

    // 6. Check round end condition
    const stillAlive = aliveBefore.filter(id => this._players.get(id).alive);

    if (stillAlive.length <= 1) {
      this._endRound(stillAlive[0] ?? null);
      return;
    }

    // 7. Broadcast game state
    this._onGameState(this._buildSnapshot());
  }

  // ─── Trail Gap Logic ─────────────────────────────────────────────────────────

  _isGapTick() {
    return (this._tick % TRAIL_GAP_INTERVAL) < TRAIL_GAP_DURATION;
  }

  // ─── Kill Player ─────────────────────────────────────────────────────────────

  _killPlayer(id, reason) {
    const player = this._players.get(id);
    if (!player || !player.alive) return;

    player.alive = false;
    console.log(`[GameLoop] Player ${id} died (${reason})`);
    this._onPlayerDied(id, player.wallet, reason);
  }

  // ─── End Round ───────────────────────────────────────────────────────────────

  _endRound(winnerId) {
    this.stop();
    const winnerWallet = winnerId ? this._players.get(winnerId)?.wallet ?? null : null;
    console.log(`[GameLoop] Round ended — winner: ${winnerWallet ?? 'draw'}`);
    this._onRoundEnded(winnerId, winnerWallet);
  }

  // ─── State Snapshot ──────────────────────────────────────────────────────────

  _buildSnapshot() {
    const players = [];
    for (const [, p] of this._players) {
      players.push({
        id:    p.id,
        wallet: p.wallet,
        color:  p.color,
        x:     +p.x.toFixed(2),
        y:     +p.y.toFixed(2),
        angle: +p.angle.toFixed(4),
        alive:  p.alive,
      });
    }

    const trails = {};
    for (const [id, trail] of this._trails) {
      trails[id] = trail.slice(-4);   // client appends; we only send recent points
    }

    return { tick: this._tick, players, trails };
  }
}

module.exports = { GameLoop };
