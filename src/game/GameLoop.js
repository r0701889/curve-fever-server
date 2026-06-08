'use strict';

const {
  PLAYER_SPEED,
  TURN_RATE,
  PLAYER_RADIUS,
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
 * Owns the authoritative game state for one room.
 * Does NOT know about Socket.io — it receives callbacks for output.
 *
 * @param {object} opts
 * @param {string[]}  opts.playerIds      ordered array of socket IDs
 * @param {Map<string,string>} opts.wallets  socketId → walletAddress
 * @param {Function}  opts.onGameState    called each tick with (gameState)
 * @param {Function}  opts.onPlayerDied   called when a player dies (playerId, walletAddress)
 * @param {Function}  opts.onMatchEnded   called with (winnerWallet, winnerId)
 */
class GameLoop {
  constructor({ playerIds, wallets, onGameState, onPlayerDied, onMatchEnded }) {
    this._playerIds   = [...playerIds];
    this._wallets     = wallets;            // Map<socketId, walletAddress>
    this._onGameState = onGameState;
    this._onPlayerDied = onPlayerDied;
    this._onMatchEnded = onMatchEnded;

    this._tick        = 0;
    this._intervalId  = null;
    this._running     = false;

    // Build per-player state
    const spawns = generateSpawns(this._playerIds.length);

    this._players = new Map();
    this._trails  = new Map();   // socketId → Array<{x, y, gap}>
    this._inputs  = new Map();   // socketId → 'left' | 'right' | 'neutral'

    this._playerIds.forEach((id, idx) => {
      const spawn = spawns[idx];

      this._players.set(id, {
        id,
        wallet:   wallets.get(id) || id,
        color:    PLAYER_COLORS[idx % PLAYER_COLORS.length],
        x:        spawn.x,
        y:        spawn.y,
        angle:    spawn.angle,
        alive:    true,
        score:    0,
      });

      this._trails.set(id, []);
      this._inputs.set(id, 'neutral');
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running    = true;
    this._intervalId = setInterval(() => this._step(), TICK_INTERVAL_MS);
    console.log('[GameLoop] Started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._intervalId);
    this._intervalId = null;
    console.log('[GameLoop] Stopped');
  }

  setInput(playerId, direction) {
    if (this._inputs.has(playerId)) {
      this._inputs.set(playerId, direction);
    }
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  _step() {
    this._tick++;

    const alivePlayers = [];

    for (const [id, player] of this._players) {
      if (!player.alive) continue;
      alivePlayers.push(id);

      // 1. Apply turning input
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

    // 6. Win condition — evaluated after all players are updated
    const stillAlive = alivePlayers.filter(id => this._players.get(id).alive);

    if (stillAlive.length <= 1) {
      const winnerId = stillAlive[0] ?? null;
      this._endMatch(winnerId);
      return;
    }

    // 7. Broadcast game state
    this._onGameState(this._buildStateSnapshot());
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

  // ─── End Match ───────────────────────────────────────────────────────────────

  _endMatch(winnerId) {
    this.stop();

    const winner     = winnerId ? this._players.get(winnerId) : null;
    const winnerWallet = winner ? winner.wallet : null;

    console.log(`[GameLoop] Match ended — winner: ${winnerWallet ?? 'none (draw)'}`);
    this._onMatchEnded(winnerWallet, winnerId);
  }

  // ─── State Snapshot ──────────────────────────────────────────────────────────

  _buildStateSnapshot() {
    const players = [];

    for (const [, player] of this._players) {
      players.push({
        id:     player.id,
        wallet: player.wallet,
        color:  player.color,
        x:      +player.x.toFixed(2),
        y:      +player.y.toFixed(2),
        angle:  +player.angle.toFixed(4),
        alive:  player.alive,
      });
    }

    // Send full trail data on first tick, then only new points to reduce bandwidth
    const trails = {};
    for (const [id, trail] of this._trails) {
      // Send the last few points each tick; client maintains the full trail locally
      const recent = trail.slice(-4);
      trails[id] = recent;
    }

    return {
      tick:    this._tick,
      players,
      trails,
    };
  }

  /**
   * Full trail dump — sent once when the game starts so the client
   * can seed its local trail store.
   */
  getFullTrailSnapshot() {
    const trails = {};
    for (const [id, trail] of this._trails) {
      trails[id] = trail;
    }
    return trails;
  }
}

module.exports = { GameLoop };
