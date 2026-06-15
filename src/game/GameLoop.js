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
const { ArenaManager }    = require('./ArenaManager');

/**
 * GameLoop
 *
 * Runs ONE round. Multi-round orchestration lives in Room.js.
 *
 * Arena integration:
 *   - Owns an ArenaManager — the arena starts full-size, then enters a
 *     warning → shrinking → safe cycle. See ArenaManager for details.
 *   - Wall collision uses ArenaManager.current bounds, so as the arena
 *     shrinks the lethal walls move inward.
 *   - During 'shrinking' phase, players outside `current` accumulate
 *     grace-period exposure; arena kill is attributed BEFORE movement
 *     each tick (so the player doesn't simultaneously die from arena
 *     and trail in the same tick — arena wins).
 *
 * Power-up integration:
 *   - PowerUpManager is created fresh each round and owned here.
 *   - Spawn bounds are read from ArenaManager.current each spawn attempt.
 *   - Each tick: PowerUpManager.tick() runs before movement so effects
 *     are applied in the same tick they're collected.
 *   - Speed: PLAYER_SPEED × baseGrowthSpeed × powerUpSpeedMultiplier
 *   - Trail radius: stored on each trail point so Fat/Tiny Trail / growth
 *     affects future collisions against that player's trail.
 *   - Ghost: trail collision skipped entirely.
 *   - Shield: trail collision intercepted → consumeShield() → player survives.
 *
 * Growth integration:
 *   - GameLoop is given a reference to an external `growth` Map (owned by
 *     Room — persists across rounds). It READS lengthMultiplier and
 *     speedMultiplier from this map for per-tick physics, and WRITES
 *     elimination credit when a trail-kill happens (B hits A's trail → A
 *     gets growth).
 *   - It also reads/writes shieldCount from the same growth map: pickup
 *     increments, trail-hit-with-shield decrements.
 *
 * Callbacks:
 *   onGameState(snapshot)
 *   onPlayerDied(id, wallet, reason)
 *   onRoundEnded(winnerId, winnerWallet)
 *   onPowerUpsUpdate(powerUps)
 *   onPowerUpCollected(socketId, type, durationMs)
 *   onPowerUpExpired(socketId, type)
 *   onPowerUpUsed(socketId, type)
 *   onPlayerGrowth(socketId, growthData)       — emitted when growth changes
 *   onArenaPhaseChange(newPhase, snapshot)     — for logging/broadcasts
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
    growth,                  // Map<socketId, {lengthMultiplier, speedMultiplier, shieldCount, eliminations}>
    onGameState, onPlayerDied, onRoundEnded,
    onPowerUpsUpdate, onPowerUpCollected, onPowerUpExpired, onPowerUpUsed,
    onPlayerGrowth,
    onArenaPhaseChange,
  }) {
    this._playerIds    = [...playerIds];
    this._wallets      = wallets;
    this._colors       = colors;
    this._growth       = growth;             // shared with Room — persists across rounds
    this._onGameState  = onGameState;
    this._onPlayerDied = onPlayerDied;
    this._onRoundEnded = onRoundEnded;
    this._onPlayerGrowth = onPlayerGrowth ?? (() => {});

    this._tick       = 0;
    this._intervalId = null;
    this._running    = false;

    this._players = new Map();
    this._trails  = new Map();
    this._inputs  = new Map();

    // Arena manager — owns shrink cycle and lethal bounds
    this._arena = new ArenaManager({
      onPhaseChange: onArenaPhaseChange ?? (() => {}),
    });

    // Power-up manager — fresh each round.
    // Receives an `arena` reference so spawn bounds shrink with the arena.
    this._pum = new PowerUpManager({
      onPowerUpsUpdate:   onPowerUpsUpdate,
      onPowerUpCollected: (socketId, type, durationMs) =>
        this._onPowerUpCollectedInternal(socketId, type, durationMs, onPowerUpCollected),
      onPowerUpExpired:   onPowerUpExpired,
      onPowerUpUsed:      onPowerUpUsed,
      arena:              this._arena,
      growth:             this._growth,
    });

    this._initPlayers();
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  _initPlayers() {
    const spawns = generateSpawns(this._playerIds.length, this._arena.getCurrentBounds());
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
    this._arena.start();
    this._pum.start();
    console.log('[GameLoop] Round started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._intervalId);
    this._intervalId = null;
    this._arena.stop();
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

    // 1. Arena tick — advances phase, returns players to kill due to shrink
    const arenaResult = this._arena.tick(this._players);
    for (const id of arenaResult.killedSocketIds) {
      this._killPlayer(id, 'shrink');
    }

    // 2. Power-up manager tick — expire map PUs, expire player PUs, collect
    this._pum.tick(this._players);
    this._pum.triggerSpawnCheck(this._trails);

    const aliveBefore = [];

    for (const [id, player] of this._players) {
      if (!player.alive) continue;
      aliveBefore.push(id);

      // 3. Apply turning
      const input = this._inputs.get(id);
      if (input === 'left')  player.angle -= TURN_RATE;
      if (input === 'right') player.angle += TURN_RATE;

      // 4. Speed = base × growth speed × active power-up speed
      const growthSpeed = this._getGrowthSpeed(id);
      const puSpeed     = this._pum.getSpeedMultiplier(id);
      const speed       = PLAYER_SPEED * growthSpeed * puSpeed;
      const newX = player.x + Math.cos(player.angle) * speed;
      const newY = player.y + Math.sin(player.angle) * speed;

      // 5. Wall collision — uses current (possibly shrunken) arena bounds
      if (collidesWithWall(newX, newY, this._arena.getCurrentBounds())) {
        this._killPlayer(id, 'wall');
        continue;
      }

      // 6. Trail collision — Ghost skips, Shield (stacked counter) absorbs one
      if (!this._pum.hasGhost(id)) {
        if (collidesWithTrails(newX, newY, this._trails, id)) {
          // Check stacked shield counter on the growth map first
          if (this._consumeShield(id)) {
            // Shield absorbed the hit — player survives, no elimination credit
          } else {
            // Trail hit kills — attribute elimination credit to the trail's owner
            const trailOwner = this._findTrailOwner(newX, newY, id);
            this._killPlayer(id, 'trail');
            if (trailOwner && trailOwner !== id) {
              this._creditElimination(trailOwner);
            }
            continue;
          }
        }
      }

      // 7. Commit movement
      player.x = newX;
      player.y = newY;

      // 8. Append trail point — radius reflects both Fat/Tiny Trail AND growth length
      const baseR = PLAYER_RADIUS * this._getGrowthLength(id);
      const trailR = this._pum.getTrailRadius(id, baseR);
      const isGap  = this._isGapTick();
      this._trails.get(id).push({ x: newX, y: newY, gap: isGap, r: trailR });
    }

    // 9. Check round end condition
    const stillAlive = aliveBefore.filter(id => this._players.get(id).alive);
    if (stillAlive.length <= 1) {
      this._endRound(stillAlive[0] ?? null);
      return;
    }

    // 10. Broadcast game state
    this._onGameState(this._buildSnapshot());
  }

  // ─── Growth helpers ──────────────────────────────────────────────────────────

  _getGrowthLength(socketId) {
    const g = this._growth?.get(socketId);
    return g?.lengthMultiplier ?? 1.0;
  }

  _getGrowthSpeed(socketId) {
    const g = this._growth?.get(socketId);
    return g?.speedMultiplier ?? 1.0;
  }

  /**
   * Consume one shield from the player's growth.shieldCount counter.
   * Returns true if a shield was consumed (player survives).
   */
  _consumeShield(socketId) {
    if (!this._growth) return false;
    const g = this._growth.get(socketId);
    if (!g || g.shieldCount <= 0) return false;
    g.shieldCount--;
    this._onPlayerGrowth(socketId, { ...g });
    return true;
  }

  /**
   * Award an elimination to the trail's owner.
   * Reads caps from constants so growth never exceeds limits.
   */
  _creditElimination(socketId) {
    if (!this._growth) return;
    const { GROWTH_PER_ELIMINATION, GROWTH_SPEED_PER_ELIMINATION, GROWTH_MAX_LENGTH, GROWTH_MAX_SPEED } =
      require('./constants');

    const g = this._growth.get(socketId);
    if (!g) return;

    g.lengthMultiplier = Math.min(GROWTH_MAX_LENGTH, g.lengthMultiplier + GROWTH_PER_ELIMINATION);
    g.speedMultiplier  = Math.min(GROWTH_MAX_SPEED,  g.speedMultiplier  + GROWTH_SPEED_PER_ELIMINATION);
    g.eliminations    += 1;

    console.log(`[GameLoop] Elimination credit → ${socketId}: lengthMult=${g.lengthMultiplier.toFixed(2)}, speedMult=${g.speedMultiplier.toFixed(2)}, kills=${g.eliminations}`);
    this._onPlayerGrowth(socketId, { ...g });
  }

  /**
   * Find which player's trail killed the head at (x, y).
   * Returns the owner socketId, or null if no clear attribution.
   *
   * Strategy: nearest non-gap trail point within (PLAYER_RADIUS + maxTrailR)
   * wins. Self-trail SKIP applies (same logic as collidesWithTrails).
   */
  _findTrailOwner(x, y, victimId) {
    const SELF_SKIP = 8;
    let bestOwner = null;
    let bestDistSq = Infinity;

    for (const [ownerId, trail] of this._trails) {
      const limit = ownerId === victimId ? trail.length - SELF_SKIP : trail.length;
      for (let i = 0; i < limit; i++) {
        const pt = trail[i];
        if (pt.gap) continue;
        const dx = x - pt.x;
        const dy = y - pt.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestOwner  = ownerId;
        }
      }
    }
    return bestOwner;
  }

  /**
   * Wraps the PowerUpManager's collected callback to handle SHIELD and
   * LENGTH_BOOST specially: they don't become "active" power-ups, they
   * modify the player's growth record directly.
   */
  _onPowerUpCollectedInternal(socketId, type, durationMs, downstreamCallback) {
    const { POWERUP_TYPES, SHIELD_MAX_STACK, LENGTH_BOOST_DELTA, GROWTH_MAX_LENGTH } =
      require('./constants');

    if (this._growth) {
      const g = this._growth.get(socketId);
      if (g) {
        if (type === POWERUP_TYPES.SHIELD) {
          g.shieldCount = Math.min(SHIELD_MAX_STACK, g.shieldCount + 1);
          this._onPlayerGrowth(socketId, { ...g });
        } else if (type === POWERUP_TYPES.LENGTH_BOOST) {
          g.lengthMultiplier = Math.min(
            GROWTH_MAX_LENGTH,
            g.lengthMultiplier + LENGTH_BOOST_DELTA
          );
          this._onPlayerGrowth(socketId, { ...g });
        }
      }
    }

    // Forward to the downstream callback (Room) for emit
    downstreamCallback(socketId, type, durationMs);
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
      const growth = this._growth?.get(p.id);
      players.push({
        id:                p.id,
        wallet:            p.wallet,
        color:             p.color,
        x:                 +p.x.toFixed(2),
        y:                 +p.y.toFixed(2),
        angle:             +p.angle.toFixed(4),
        alive:             p.alive,
        lengthMultiplier:  growth?.lengthMultiplier ?? 1.0,
        speedMultiplier:   growth?.speedMultiplier  ?? 1.0,
        shieldCount:       growth?.shieldCount      ?? 0,
        activePowerups:    this._pum.getActivePowerUpsArray(p.id),
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
      arena:    this._arena.getSnapshot(),
    };
  }
}

module.exports = { GameLoop };
