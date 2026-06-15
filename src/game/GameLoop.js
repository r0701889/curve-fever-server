'use strict';

const {
  PLAYER_SPEED,
  TURN_RATE,
  TICK_INTERVAL_MS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  BASE_BODY_LENGTH_PX,
  BODY_POINT_SAMPLE_STRIDE,
  BODY_POINT_MAX_SENT,
} = require('./constants');

const { collidesWithWall, collidesWithBody } = require('./collision');
const { generateSpawns }  = require('./spawn');
const { PowerUpManager }  = require('./PowerUpManager');
const { ArenaManager }    = require('./ArenaManager');

/**
 * GameLoop
 *
 * Runs ONE round. Multi-round orchestration lives in Room.js.
 *
 * ── Snake body model (replaces permanent trails) ────────────────────────────────
 *
 *   Each player is a fixed-length snake body. There is NO permanent trail —
 *   the tail is continuously trimmed so the head-to-tail PATH DISTANCE stays
 *   close to that player's `bodyLengthPx`.
 *
 *   this._bodies: Map<socketId, Array<{x,y,r}>>
 *     index 0     = tail (oldest point still part of the body)
 *     last index  = most recent point pushed (just behind the current head)
 *
 *   this._bodyLen: Map<socketId, number>  — running total path-distance of
 *     the body array, maintained incrementally (O(1) amortized per tick):
 *       +new segment length when a point is pushed
 *       -trimmed segment lengths when tail points are removed
 *
 *   Trimming each tick:
 *     1. push new point, bodyLen += segment distance to previous point
 *     2. while bodyLen > targetBodyLengthPx AND body.length > 1:
 *          shift tail point, bodyLen -= distance(tail, newTail)
 *
 *   targetBodyLengthPx = BASE_BODY_LENGTH_PX * lengthMultiplier (from growth
 *   map). Changing lengthMultiplier doesn't truncate/extend instantly — the
 *   body naturally converges to the new target over the next few ticks
 *   (the per-tick segment is ~1.25px, negligible relative to 120px+ bodies).
 *
 * Collision:
 *   - Head vs ANY current body point (self or other) — collidesWithBody.
 *   - Self-collision skips a small FIXED window of points immediately behind
 *     the head (BODY_SELF_SKIP_POINTS) — independent of bodyLengthPx/growth.
 *   - Wall/shrink boundary — always lethal, Ghost/Shield do not protect.
 *   - Ghost: skips body-collision check entirely (self + others). Wall/shrink
 *     still lethal.
 *   - Shield (stacked counter on growth map): intercepts body-collision,
 *     decrements counter, player survives. Does not protect against wall/shrink.
 *
 * Arena integration: unchanged — see ArenaManager. Wall collision uses
 * ArenaManager.current bounds, shrinking moves the lethal boundary inward.
 *
 * Power-up integration: unchanged — PowerUpManager owned here, spawn bounds
 * from ArenaManager.current, Fat/Tiny Trail set per-point `r` on new body
 * points (same as before, just on _bodies instead of _trails).
 *
 * Growth integration:
 *   - lengthMultiplier drives BOTH body-point radius (visual thickness, as
 *     before) AND targetBodyLengthPx (NEW — snake gets longer too).
 *   - Length Boost (+0.20) / elimination (+0.10) to lengthMultiplier, capped
 *     at GROWTH_MAX_LENGTH (== MAX_BODY_LENGTH_MULTIPLIER, 2.5x).
 *   - speedMultiplier unchanged (movement speed only).
 *   - Shield counter unchanged.
 *
 * Callbacks:
 *   onGameState(snapshot)
 *   onPlayerDied(id, wallet, reason)
 *   onRoundEnded(winnerId, winnerWallet)
 *   onPowerUpsUpdate(powerUps)
 *   onPowerUpCollected(socketId, type, durationMs)
 *   onPowerUpExpired(socketId, type)
 *   onPowerUpUsed(socketId, type)
 *   onPlayerGrowth(socketId, growthData)
 *   onArenaPhaseChange(newPhase, snapshot)
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
    this._bodies  = new Map();  // socketId -> [{x,y,r}], index 0 = tail
    this._bodyLen = new Map();  // socketId -> current path-distance of body
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
    this._bodies.clear();
    this._bodyLen.clear();
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
      // Seed the body with a single point at the spawn position so
      // collision/snapshot code always has at least one point to read.
      this._bodies.set(id, [{ x: spawn.x, y: spawn.y, r: PLAYER_RADIUS }]);
      this._bodyLen.set(id, 0);
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
    this._pum.triggerSpawnCheck(this._bodies);

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

      // 5. Wall/shrink-boundary collision — uses current (possibly shrunken)
      //    arena bounds. Always lethal — Ghost and Shield do NOT protect.
      if (collidesWithWall(newX, newY, this._arena.getCurrentBounds())) {
        this._killPlayer(id, 'wall');
        continue;
      }

      // 6. Body collision — Ghost skips entirely (self + others),
      //    Shield (stacked counter) absorbs one hit against any body.
      if (!this._pum.hasGhost(id)) {
        if (collidesWithBody(newX, newY, this._bodies, id)) {
          if (this._consumeShield(id)) {
            // Shield absorbed the hit — player survives, no elimination credit
          } else {
            // Body hit kills — attribute elimination credit to the body's owner
            const bodyOwner = this._findBodyOwner(newX, newY, id);
            this._killPlayer(id, 'trail');
            if (bodyOwner && bodyOwner !== id) {
              this._creditElimination(bodyOwner);
            }
            continue;
          }
        }
      }

      // 7. Commit movement
      player.x = newX;
      player.y = newY;

      // 8. Append body point + trim tail to maintain fixed body length.
      //    Radius reflects both Fat/Tiny Trail AND growth length.
      const baseR  = PLAYER_RADIUS * this._getGrowthLength(id);
      const pointR = this._pum.getTrailRadius(id, baseR);
      this._pushBodyPoint(id, newX, newY, pointR);
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

  // ─── Snake body helpers ─────────────────────────────────────────────────────

  /**
   * Append a new point to the head end of the body, then trim from the tail
   * until the total path-distance is back at-or-below targetBodyLengthPx.
   *
   * Distance-based trimming: head-to-tail PATH DISTANCE stays close to
   * targetBodyLengthPx (not point count). targetBodyLengthPx is derived from
   * the player's current lengthMultiplier, so growth (Length Boost /
   * elimination) naturally lengthens the body over the next few ticks.
   */
  _pushBodyPoint(socketId, x, y, r) {
    const body = this._bodies.get(socketId);
    const prev = body[body.length - 1];

    const segLen = Math.hypot(x - prev.x, y - prev.y);
    body.push({ x, y, r });
    this._bodyLen.set(socketId, this._bodyLen.get(socketId) + segLen);

    const targetLen = BASE_BODY_LENGTH_PX * this._getGrowthLength(socketId);

    let len = this._bodyLen.get(socketId);
    while (len > targetLen && body.length > 1) {
      const tail     = body[0];
      const nextTail = body[1];
      const trimSeg  = Math.hypot(nextTail.x - tail.x, nextTail.y - tail.y);

      // Don't overshoot — if removing this segment would drop us below the
      // target, stop (keeps the body close to, not under, the target length).
      if (len - trimSeg < targetLen) break;

      body.shift();
      len -= trimSeg;
    }
    this._bodyLen.set(socketId, len);
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
   * Award an elimination to the killed body's owner.
   * Reads caps from constants so growth never exceeds limits.
   * +0.10 lengthMultiplier (→ +10% bodyLengthPx) and +0.05 speedMultiplier,
   * both capped at GROWTH_MAX_LENGTH / GROWTH_MAX_SPEED.
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
   * Find which player's CURRENT body killed the head at (x, y).
   * Returns the owner socketId, or null if no clear attribution.
   *
   * Strategy: nearest body point within (headRadius + pointRadius) wins.
   * Self-body SKIP applies (same fixed window as collidesWithBody).
   */
  _findBodyOwner(x, y, victimId) {
    const { BODY_SELF_SKIP_POINTS } = require('./constants');
    let bestOwner = null;
    let bestDistSq = Infinity;

    for (const [ownerId, body] of this._bodies) {
      const limit = ownerId === victimId
        ? Math.max(0, body.length - BODY_SELF_SKIP_POINTS)
        : body.length;

      for (let i = 0; i < limit; i++) {
        const pt = body[i];
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
          // +0.20 lengthMultiplier → +20% bodyLengthPx (and +20% body radius,
          // same multiplier drives both). Capped at GROWTH_MAX_LENGTH (2.5x).
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

  /**
   * Decimate a player's current body for network transmission.
   * Server simulates every tick internally (collision needs full precision);
   * clients only need enough points to draw the snake smoothly.
   *
   * Always includes the tail (index 0) and the most recent point (the point
   * just behind the head) so the rendered body's endpoints are accurate,
   * then samples every BODY_POINT_SAMPLE_STRIDE-th point in between, capped
   * at BODY_POINT_MAX_SENT total points.
   *
   * Each point is sent as a compact [x, y, r] array (not {x,y,r}) — roughly
   * 43% smaller per point. Order: tail-to-head (index 0 = tail).
   */
  _sampleBodyPoints(body) {
    const toArr = p => [+p.x.toFixed(1), +p.y.toFixed(1), +(p.r ?? PLAYER_RADIUS).toFixed(1)];

    if (body.length <= 2) {
      return body.map(toArr);
    }

    const sampled = [body[0]]; // tail
    for (let i = BODY_POINT_SAMPLE_STRIDE; i < body.length - 1; i += BODY_POINT_SAMPLE_STRIDE) {
      sampled.push(body[i]);
    }
    sampled.push(body[body.length - 1]); // most recent (near head)

    // Enforce hard cap — if still too many, re-sample evenly across `sampled`
    let result = sampled;
    if (result.length > BODY_POINT_MAX_SENT) {
      const stride = result.length / BODY_POINT_MAX_SENT;
      const capped = [];
      // Fill BODY_POINT_MAX_SENT - 1 slots by even sampling, then append the
      // final point explicitly — guarantees exactly BODY_POINT_MAX_SENT total
      // while always preserving the most recent (near-head) point.
      for (let i = 0; i < BODY_POINT_MAX_SENT - 1; i++) {
        capped.push(result[Math.floor(i * stride)]);
      }
      capped.push(result[result.length - 1]);
      result = capped;
    }

    return result.map(toArr);
  }

  _buildSnapshot() {
    const players = [];
    for (const [, p] of this._players) {
      const growth = this._growth?.get(p.id);
      const lengthMultiplier = growth?.lengthMultiplier ?? 1.0;
      players.push({
        id:                p.id,
        wallet:            p.wallet,
        color:             p.color,
        x:                 +p.x.toFixed(2),
        y:                 +p.y.toFixed(2),
        angle:             +p.angle.toFixed(4),
        alive:             p.alive,
        bodyLengthPx:      +(BASE_BODY_LENGTH_PX * lengthMultiplier).toFixed(1),
        lengthMultiplier,
        bodyPoints:        this._sampleBodyPoints(this._bodies.get(p.id) ?? []),
        activePowerups:    this._pum.getActivePowerUpsArray(p.id),
        shieldCount:       growth?.shieldCount ?? 0,
      });
    }

    return {
      tick:     this._tick,
      players,
      powerUps: this._pum.getMapPowerUps(),
      arena:    this._arena.getSnapshot(),
    };
  }
}

module.exports = { GameLoop };
