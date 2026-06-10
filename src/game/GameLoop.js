'use strict';

const {
  PLAYER_SPEED,
  TURN_RATE,
  TRAIL_GAP_INTERVAL,
  TRAIL_GAP_DURATION,
  TICK_INTERVAL_MS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
} = require('./constants');

const { collidesWithWall, collidesWithTrails } = require('./collision');
const { generateSpawns }  = require('./spawn');
const { PowerUpManager }  = require('./PowerUpManager');

/**
 * GameLoop
 *
 * Runs ONE round. Multi-round orchestration lives in Room.js.
 *
 * Power-up integration:
 *   - PowerUpManager is created fresh each round and owned here.
 *   - Each tick: PowerUpManager.tick() runs before movement so effects
 *     are applied in the same tick they're collected.
 *   - Speed: PLAYER_SPEED × getSpeedMultiplier(id)
 *   - Trail radius: stored on each trail point so Fat/Tiny Trail
 *     affects future collisions against that player's trail.
 *   - Ghost: trail collision skipped entirely.
 *   - Shield: trail collision intercepted → consumeShield() → player survives.
 *   - Wall: always lethal, no power-up overrides this.
 *
 * Callbacks (in addition to power-up ones passed through):
 *   onGameState(snapshot)
 *   onPlayerDied(id, wallet, reason)
 *   onRoundEnded(winnerId, winnerWallet)
 */
class GameLoop {
  /**
   * @param {string[]}           opts.playerIds
   * @param {Map<string,string>} opts.wallets      socketId → wallet
   * @param {Map<string,string>} opts.colors       socketId → hex color
   * @param {Function}           opts.onGameState
   * @param {Function}           opts.onPlayerDied
   * @param {Function}           opts.onRoundEnded
   * @param {Function}           opts.onPowerUpsUpdate
   * @param {Function}           opts.onPowerUpCollected
   * @param {Function}           opts.onPowerUpExpired
   * @param {Function}           opts.onPowerUpUsed
   */
  constructor({
    playerIds, wallets, colors,
    onGameState, onPlayerDied, onRoundEnded,
    onPowerUpsUpdate, onPowerUpCollected, onPowerUpExpired, onPowerUpUsed,
  }) {
    this._playerIds    = [...playerIds];
    this._wallets      = wallets;
    this._colors       = colors;
    this._onGameState  = onGameState;
    this._onPlayerDied = onPlayerDied;
    this._onRoundEnded = onRoundEnded;

    this._tick       = 0;
    this._intervalId = null;
    this._running    = false;

    this._players = new Map();
    this._trails  = new Map();
    this._inputs  = new Map();

    // Power-up manager — fresh each round
    this._pum = new PowerUpManager({
      onPowerUpsUpdate:   onPowerUpsUpdate,
      onPowerUpCollected: onPowerUpCollected,
      onPowerUpExpired:   onPowerUpExpired,
      onPowerUpUsed:      onPowerUpUsed,
    });

    this._initPlayers();
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

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
    this._pum.start();
    console.log('[GameLoop] Round started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._intervalId);
    this._intervalId = null;
    this._pum.stop();
    console.log('[GameLoop] Round stopped');
  }

  setInput(playerId, direction) {
    if (this._inputs.has(playerId)) {
      this._inputs.set(playerId, direction);
    }
  }

  /** Expose active power-up info for Room's scoreboard builder */
  getActivePowerUp(socketId) {
    return this._pum.getActivePowerUp(socketId);
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  _step() {
    this._tick++;

    // 1. Power-up manager tick — expire map PUs, expire player PUs, collect
    this._pum.tick(this._players);
    // Share current trails so spawn logic can avoid them
    this._pum.triggerSpawnCheck(this._trails);

    const aliveBefore = [];

    for (const [id, player] of this._players) {
      if (!player.alive) continue;
      aliveBefore.push(id);

      // 2. Apply turning
      const input = this._inputs.get(id);
      if (input === 'left')  player.angle -= TURN_RATE;
      if (input === 'right') player.angle += TURN_RATE;

      // 3. Move forward with optional Nitro speed boost
      const speedMult = this._pum.getSpeedMultiplier(id);
      const speed     = PLAYER_SPEED * speedMult;
      const newX = player.x + Math.cos(player.angle) * speed;
      const newY = player.y + Math.sin(player.angle) * speed;

      // 4. Wall collision — always lethal, no power-up overrides
      if (collidesWithWall(newX, newY)) {
        this._killPlayer(id, 'wall');
        continue;
      }

      // 5. Trail collision — Ghost skips, Shield absorbs once
      if (!this._pum.hasGhost(id)) {
        if (collidesWithTrails(newX, newY, this._trails, id)) {
          // Check shield before killing
          if (this._pum.consumeShield(id)) {
            // Shield absorbed the hit — player survives, continue moving
          } else {
            this._killPlayer(id, 'trail');
            continue;
          }
        }
      }

      // 6. Commit movement
      player.x = newX;
      player.y = newY;

      // 7. Append trail point — radius baked in for Fat/Tiny Trail
      const trailR  = this._pum.getTrailRadius(id, PLAYER_RADIUS);
      const isGap   = this._isGapTick();
      this._trails.get(id).push({ x: newX, y: newY, gap: isGap, r: trailR });
    }

    // 8. Check round end condition
    const stillAlive = aliveBefore.filter(id => this._players.get(id).alive);
    if (stillAlive.length <= 1) {
      this._endRound(stillAlive[0] ?? null);
      return;
    }

    // 9. Broadcast game state
    this._onGameState(this._buildSnapshot());
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _isGapTick() {
    return (this._tick % TRAIL_GAP_INTERVAL) < TRAIL_GAP_DURATION;
  }

  _killPlayer(id, reason) {
    const player = this._players.get(id);
    if (!player || !player.alive) return;
    player.alive = false;
    console.log(`[GameLoop] Player ${id} died (${reason})`);
    this._onPlayerDied(id, player.wallet, reason);
  }

  _endRound(winnerId) {
    this.stop();
    this._pum.reset();
    const winnerWallet = winnerId ? this._players.get(winnerId)?.wallet ?? null : null;
    console.log(`[GameLoop] Round ended — winner: ${winnerWallet ?? 'draw'}`);
    this._onRoundEnded(winnerId, winnerWallet);
  }

  _buildSnapshot() {
    const players = [];
    for (const [, p] of this._players) {
      players.push({
        id:     p.id,
        wallet: p.wallet,
        color:  p.color,
        x:      +p.x.toFixed(2),
        y:      +p.y.toFixed(2),
        angle:  +p.angle.toFixed(4),
        alive:  p.alive,
      });
    }

    const trails = {};
    for (const [id, trail] of this._trails) {
      // Send last 4 points; include r so client can render correct trail width
      trails[id] = trail.slice(-4);
    }

    return {
      tick:     this._tick,
      players,
      trails,
      powerUps: this._pum.getMapPowerUps(),
    };
  }
}

module.exports = { GameLoop };
