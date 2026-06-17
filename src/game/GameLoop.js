'use strict';

const {
  PLAYER_SPEED,
  TURN_RATE,
  TICK_INTERVAL_MS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  TRAIL_SELF_SKIP_POINTS,
  TRAIL_POINT_MAX_SENT,
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
 * ── Trail model (classic Curve Fever — REVERTED from fixed-length snake body) ──
 *
 *   Each player leaves a PERMANENT, LETHAL trail behind them as they move.
 *   There is no body-length cap and no trimming — the trail is every point
 *   the player has visited since the start of the current round. The only
 *   thing that clears a trail is a brand-new round starting: Room._startRound()
 *   constructs a fresh GameLoop per round, and _initPlayers() (below) seeds
 *   every player's trail back down to a single point at their new spawn.
 *
 *   this._trails: Map<socketId, Array<{x,y,r}>>
 *     index 0     = first point laid down this round (at spawn)
 *     last index  = most recent point pushed (just behind the current head)
 *     Grows by ~1 point per tick per alive, moving player. NEVER trimmed.
 *
 *   Collision uses the FULL _trails map — every point ever laid this round,
 *   for every player, is live and lethal. This is the entire gameplay
 *   reversion: previously only a sliding window behind the head was lethal
 *   (Slither/Snake-style); now the whole path is (classic Curve Fever).
 *
 * ── Network payload ──────────────────────────────────────────────────────────
 *
 *   The server simulates and collides against the full untrimmed trail every
 *   tick, but only a decimated sample is broadcast — see _sampleTrailPoints.
 *   Sent as gameState.players[].trailPoints, with players[].bodyPoints kept
 *   as an identical alias so existing Emblem frontend code that already
 *   reads bodyPoints keeps working unmodified. Both fields carry the exact
 *   same sampled array — pick whichever name is clearer going forward.
 *
 * ── Collision ────────────────────────────────────────────────────────────────
 *   - Head vs ANY current trail point (self or other), across the player's
 *     ENTIRE trail this round — collidesWithBody, now given the full
 *     unbounded _trails map instead of a fixed-length body map.
 *   - Self-collision skips a small FIXED window of points immediately
 *     behind the head (TRAIL_SELF_SKIP_POINTS) — these are always within
 *     head-radius due to continuous movement and are not real collisions.
 *     This window does NOT grow with the trail.
 *   - Wall / shrink boundary — always lethal; Ghost/Shield do not protect.
 *   - Ghost: skips trail-collision entirely (self + others). Wall/shrink
 *     still lethal.
 *   - Shield (stacked counter on the growth map): intercepts trail-collision,
 *     decrements counter, player survives. Does not protect against wall/shrink.
 *
 * ── Growth (reverted) ────────────────────────────────────────────────────────
 *   There is no body-length/lengthMultiplier mechanic anymore — eliminations
 *   only grant a small permanent speedMultiplier bonus (kept, classic-feeling
 *   kill reward). lengthMultiplier is still present on the shared growth
 *   record (Room._ensureGrowth seeds it at 1.0) purely so any frontend code
 *   reading scoreboard.lengthMultiplier doesn't break; it never changes and
 *   is never read for collision or trail-radius purposes here.
 *
 * ── Callbacks ────────────────────────────────────────────────────────────────
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
    this._trails  = new Map();  // socketId -> [{x,y,r}], permanent for the round
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
      // Seed the trail with a single point at the spawn position. This is
      // also what makes "new round clears trails" work: GameLoop is
      // reconstructed fresh per round by Room._startRound(), so every
      // round starts every player's trail back down to this one point.
      this._trails.set(id, [{ x: spawn.x, y: spawn.y, r: PLAYER_RADIUS }]);
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

      // 5. Wall/shrink-boundary collision — uses current (possibly shrunken)
      //    arena bounds. Always lethal — Ghost and Shield do NOT protect.
      if (collidesWithWall(newX, newY, this._arena.getCurrentBounds())) {
        this._killPlayer(id, 'wall');
        continue;
      }

      // 6. Trail collision — Ghost skips entirely (self + others),
      //    Shield (stacked counter) absorbs one hit against any trail.
      //    Checked against the FULL, permanent trail map — classic rules.
      if (!this._pum.hasGhost(id)) {
        if (collidesWithBody(newX, newY, this._trails, id)) {
          if (this._consumeShield(id)) {
            // Shield absorbed the hit — player survives, no elimination credit
          } else {
            // Trail hit kills — attribute elimination credit to the trail's owner
            const trailOwner = this._findBodyOwner(newX, newY, id);
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

      // 8. Append trail point. Never trimmed — this is the permanent,
      //    lethal trail. Radius reflects Fat/Tiny Trail if active.
      const pointR = this._pum.getTrailRadius(id, PLAYER_RADIUS);
      this._pushTrailPoint(id, newX, newY, pointR);
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

  // ─── Trail helpers ───────────────────────────────────────────────────────────

  /**
   * Append a new point to the trail. Classic Curve Fever — no trimming, no
   * length cap, no expiry. The trail simply grows for the entire round.
   */
  _pushTrailPoint(socketId, x, y, r) {
    const trail = this._trails.get(socketId);
    trail.push({ x, y, r });
  }

  // ─── Growth helpers ──────────────────────────────────────────────────────────

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
   * Award an elimination to the trail owner whose trail killed someone.
   * Classic-mode growth is speed-only — there is no body length left to
   * grow, so only speedMultiplier is incremented (capped at GROWTH_MAX_SPEED).
   */
  _creditElimination(socketId) {
    if (!this._growth) return;
    const { GROWTH_SPEED_PER_ELIMINATION, GROWTH_MAX_SPEED } = require('./constants');

    const g = this._growth.get(socketId);
    if (!g) return;

    g.speedMultiplier = Math.min(GROWTH_MAX_SPEED, g.speedMultiplier + GROWTH_SPEED_PER_ELIMINATION);
    g.eliminations   += 1;

    console.log(`[GameLoop] Elimination credit → ${socketId}: speedMult=${g.speedMultiplier.toFixed(2)}, kills=${g.eliminations}`);
    this._onPlayerGrowth(socketId, { ...g });
  }

  /**
   * Find which player's trail killed the head at (x, y).
   * Returns the owner socketId, or null if no clear attribution.
   *
   * Strategy: nearest trail point within (headRadius + pointRadius) wins.
   * Self-trail SKIP applies (same fixed window as collidesWithBody) — this
   * is checked against the player's ENTIRE trail this round, not a window.
   */
  _findBodyOwner(x, y, victimId) {
    let bestOwner = null;
    let bestDistSq = Infinity;

    for (const [ownerId, trail] of this._trails) {
      const limit = ownerId === victimId
        ? Math.max(0, trail.length - TRAIL_SELF_SKIP_POINTS)
        : trail.length;

      for (let i = 0; i < limit; i++) {
        const pt = trail[i];
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
   * Wraps the PowerUpManager's collected callback to handle SHIELD specially:
   * it doesn't become an "active" timed power-up, it modifies the player's
   * growth record (shieldCount) directly. (LENGTH_BOOST no longer exists —
   * removed along with the fixed-length body system it grew.)
   */
  _onPowerUpCollectedInternal(socketId, type, durationMs, downstreamCallback) {
    const { POWERUP_TYPES, SHIELD_MAX_STACK } = require('./constants');

    if (this._growth) {
      const g = this._growth.get(socketId);
      if (g && type === POWERUP_TYPES.SHIELD) {
        g.shieldCount = Math.min(SHIELD_MAX_STACK, g.shieldCount + 1);
        this._onPlayerGrowth(socketId, { ...g });
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
   * Decimate a player's current (full, permanent) trail for network
   * transmission. The server simulates and collides against every point
   * ever laid this round; clients only need enough points to draw the
   * trail smoothly.
   *
   * Unlike the old fixed-length-body sampler (which used a flat fixed
   * stride because the body was capped at a small, constant length), the
   * trail here grows for the entire round — a flat stride would either
   * truncate long trails or balloon payload size. Instead the stride is
   * computed fresh from the trail's CURRENT length so a short trail is
   * sent in near-full detail and a long trail is sent evenly decimated
   * across its FULL length (spawn to head) — the client always sees the
   * whole shape, just coarser as the round goes on.
   *
   * Always includes the first point (spawn) and the most recent point
   * (just behind the head) so the rendered trail's endpoints are accurate.
   *
   * Each point is sent as a compact [x, y, r] array (not {x,y,r}) — roughly
   * 43% smaller per point. Order: oldest-to-newest (index 0 = first point
   * laid this round).
   */
  _sampleTrailPoints(trail) {
    const toArr = p => [+p.x.toFixed(1), +p.y.toFixed(1), +(p.r ?? PLAYER_RADIUS).toFixed(1)];

    if (trail.length <= TRAIL_POINT_MAX_SENT) {
      return trail.map(toArr);
    }

    // Long trail — compute a stride from current length so the WHOLE trail
    // (not just a recent window) is represented, just more coarsely.
    const stride = trail.length / TRAIL_POINT_MAX_SENT;
    const sampled = [];
    for (let i = 0; i < TRAIL_POINT_MAX_SENT - 1; i++) {
      sampled.push(trail[Math.floor(i * stride)]);
    }
    sampled.push(trail[trail.length - 1]); // always keep the most recent (near-head) point

    return sampled.map(toArr);
  }

  _buildSnapshot() {
    const players = [];
    for (const [, p] of this._players) {
      const growth = this._growth?.get(p.id);
      const lengthMultiplier = growth?.lengthMultiplier ?? 1.0;
      const sampledTrail = this._sampleTrailPoints(this._trails.get(p.id) ?? []);
      players.push({
        id:                p.id,
        wallet:            p.wallet,
        color:             p.color,
        x:                 +p.x.toFixed(2),
        y:                 +p.y.toFixed(2),
        angle:             +p.angle.toFixed(4),
        alive:             p.alive,
        // Classic mode has no body-length mechanic. lengthMultiplier is kept
        // at a constant 1.0 purely for frontend backward compatibility —
        // never collision/render relevant, never changes.
        lengthMultiplier,
        // Permanent, lethal trail for this round — use for collision and
        // rendering. trailPoints is the new, clearer name; bodyPoints is
        // kept as an identical alias so existing frontend code that reads
        // bodyPoints (from the snake-body era) keeps working unmodified.
        trailPoints:       sampledTrail,
        bodyPoints:        sampledTrail,
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
