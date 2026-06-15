'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  POWERUP_SPAWN_MIN_MS,
  POWERUP_SPAWN_MAX_MS,
  POWERUP_MAX_ON_MAP,
  POWERUP_EXPIRE_MS,
  POWERUP_COLLECT_RADIUS,
  POWERUP_TYPES,
  POWERUP_DURATION_MS,
  POWERUP_WEIGHTS,
  NITRO_SPEED_MULTIPLIER,
  SPEED_BOOST_MULTIPLIER,
  FAT_TRAIL_RADIUS_MULTIPLIER,
  TINY_TRAIL_RADIUS_MULTIPLIER,
  POWERUP_SPAWN_WALL_MARGIN,
  POWERUP_SPAWN_TRAIL_CLEARANCE,
  POWERUP_SPAWN_PLAYER_CLEARANCE,
} = require('./constants');

const TOTAL_WEIGHT = POWERUP_WEIGHTS.reduce((s, e) => s + e.weight, 0);

/**
 * PowerUpManager
 *
 * Server-authoritative. Owns:
 *   - Map power-up spawn / expire lifecycle (within ArenaManager.current bounds)
 *   - Per-player ACTIVE power-ups (a player can have multiple at once)
 *   - Collection detection (called each tick by GameLoop)
 *   - Effect queries (GameLoop asks "what speed multiplier does player X have?")
 *
 * Multi-concurrent semantics:
 *   - Speed modifiers (NITRO, SPEED_BOOST) are mutually exclusive — latest wins.
 *   - Trail-radius modifiers (FAT_TRAIL, TINY_TRAIL) are mutually exclusive — latest wins.
 *   - GHOST stacks alongside any of the above (you can be Ghost + Nitro).
 *   - SHIELD and LENGTH_BOOST do NOT live here — they modify growth directly.
 *     PowerUpManager just emits the "collected" event for them.
 *
 * Does NOT know about Socket.io — uses callbacks for output.
 *
 * Callbacks:
 *   onPowerUpsUpdate(powerUps)             — map changed (spawn/collect/expire)
 *   onPowerUpCollected(socketId, type, ms) — player picked up a power-up
 *   onPowerUpExpired(socketId, type)       — active power-up timer ran out
 *   onPowerUpUsed(socketId, type)          — shield consumed on body hit
 *
 * Dependencies:
 *   arena   — ArenaManager (for spawn bounds)
 *   growth  — Map<socketId, growthData> (for player-clearance check during spawn)
 */
class PowerUpManager {
  constructor({ onPowerUpsUpdate, onPowerUpCollected, onPowerUpExpired, onPowerUpUsed, arena, growth }) {
    this._onPowerUpsUpdate   = onPowerUpsUpdate;
    this._onPowerUpCollected = onPowerUpCollected;
    this._onPowerUpExpired   = onPowerUpExpired;
    this._onPowerUpUsed      = onPowerUpUsed;
    this._arena              = arena ?? null;
    this._growth             = growth ?? null;

    // Power-ups currently on the map: id → { id, type, x, y, spawnedAt, expiresAt }
    this._mapPowerUps = new Map();

    // Active power-ups per player: socketId → Map<type, { type, activatedAt, expiresAt }>
    // Using a per-player Map keyed by type lets us cleanly enforce "latest wins
    // within a category" while permitting cross-category stacking.
    this._playerActive = new Map();

    this._spawnTimer    = null;
    this._running       = false;
    this._currentBodies = null;  // socketId -> current snake body points
    this._currentPlayers = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start() {
    this._running = true;
    this._scheduleNextSpawn();
  }

  stop() {
    this._running = false;
    if (this._spawnTimer) {
      clearTimeout(this._spawnTimer);
      this._spawnTimer = null;
    }
  }

  reset() {
    this.stop();
    this._mapPowerUps.clear();
    this._playerActive.clear();
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  tick(players) {
    if (!this._running) return;
    this._currentPlayers = players;

    const now = Date.now();
    let mapChanged = false;

    // 1. Expire map power-ups
    for (const [id, pu] of this._mapPowerUps) {
      if (now >= pu.expiresAt) {
        this._mapPowerUps.delete(id);
        mapChanged = true;
        console.log(`[PowerUp] Map power-up ${pu.type} expired`);
      }
    }

    // 2. Expire active player power-ups (per-type)
    for (const [socketId, typesMap] of this._playerActive) {
      for (const [type, active] of typesMap) {
        if (active.expiresAt !== null && now >= active.expiresAt) {
          typesMap.delete(type);
          console.log(`[PowerUp] ${socketId} power-up ${type} expired`);
          this._onPowerUpExpired(socketId, type);
        }
      }
      if (typesMap.size === 0) this._playerActive.delete(socketId);
    }

    // 3. Collection detection
    if (this._mapPowerUps.size > 0) {
      for (const [socketId, player] of players) {
        if (!player.alive) continue;
        for (const [puId, pu] of this._mapPowerUps) {
          const dx = player.x - pu.x;
          const dy = player.y - pu.y;
          if (dx * dx + dy * dy < POWERUP_COLLECT_RADIUS * POWERUP_COLLECT_RADIUS) {
            this._collect(socketId, puId, pu);
            mapChanged = true;
            break;
          }
        }
      }
    }

    if (mapChanged) this._emitMapUpdate();
  }

  // ─── Collection ──────────────────────────────────────────────────────────────

  _collect(socketId, puId, pu) {
    this._mapPowerUps.delete(puId);

    const duration = POWERUP_DURATION_MS[pu.type];

    // SHIELD and LENGTH_BOOST don't become "active" power-ups —
    // they modify growth state. GameLoop's collected-wrapper handles that.
    // Just emit the event so the UI can show the pickup notification.
    if (pu.type === POWERUP_TYPES.SHIELD || pu.type === POWERUP_TYPES.LENGTH_BOOST) {
      console.log(`[PowerUp] ${socketId} collected ${pu.type} (counter/growth — no active timer)`);
      this._onPowerUpCollected(socketId, pu.type, duration);
      return;
    }

    // Multi-active model: keep a per-type record per player.
    // Replacing same-type (a 2nd nitro pickup) extends the timer.
    // Cross-category power-ups (ghost + nitro) coexist.
    const entry = {
      type:        pu.type,
      activatedAt: Date.now(),
      expiresAt:   duration !== null ? Date.now() + duration : null,
    };

    // Enforce category exclusivity: same speed-category replaces, same trail-category replaces
    this._enforceCategoryExclusivity(socketId, pu.type);

    let typesMap = this._playerActive.get(socketId);
    if (!typesMap) {
      typesMap = new Map();
      this._playerActive.set(socketId, typesMap);
    }
    typesMap.set(pu.type, entry);

    console.log(`[PowerUp] ${socketId} collected ${pu.type} (duration: ${duration ?? 'until used'}ms)`);
    this._onPowerUpCollected(socketId, pu.type, duration);
  }

  /**
   * If picking up `newType` conflicts with an existing active type in the same
   * category, remove the old one and emit expired (so the UI can clear the icon).
   */
  _enforceCategoryExclusivity(socketId, newType) {
    const cat = categoryOf(newType);
    if (!cat) return;

    const typesMap = this._playerActive.get(socketId);
    if (!typesMap) return;

    for (const [existingType] of typesMap) {
      if (existingType !== newType && categoryOf(existingType) === cat) {
        typesMap.delete(existingType);
        this._onPowerUpExpired(socketId, existingType);
      }
    }
  }

  // ─── Shield consumption ───────────────────────────────────────────────────────
  // Legacy method — kept for backward compatibility. Real shield consumption
  // happens in GameLoop._consumeShield() against growth.shieldCount.
  // This method is no longer called from GameLoop but is exported for tests.

  consumeShield(socketId) {
    if (!this._growth) return false;
    const g = this._growth.get(socketId);
    if (!g || g.shieldCount <= 0) return false;
    g.shieldCount--;
    this._onPowerUpUsed(socketId, POWERUP_TYPES.SHIELD);
    return true;
  }

  // ─── Effect queries (per tick) ───────────────────────────────────────────────

  /**
   * Returns the speed multiplier from active power-ups (1.0 if none).
   * NITRO takes priority over SPEED_BOOST if somehow both are active
   * (shouldn't happen due to category exclusivity, but defensive).
   */
  getSpeedMultiplier(socketId) {
    const typesMap = this._playerActive.get(socketId);
    if (!typesMap) return 1.0;
    if (typesMap.has(POWERUP_TYPES.NITRO))       return NITRO_SPEED_MULTIPLIER;
    if (typesMap.has(POWERUP_TYPES.SPEED_BOOST)) return SPEED_BOOST_MULTIPLIER;
    return 1.0;
  }

  /** Returns the snake body-point radius for a player (baseRadius if no effect) */
  getTrailRadius(socketId, baseRadius) {
    const typesMap = this._playerActive.get(socketId);
    if (!typesMap) return baseRadius;
    if (typesMap.has(POWERUP_TYPES.FAT_TRAIL))  return baseRadius * FAT_TRAIL_RADIUS_MULTIPLIER;
    if (typesMap.has(POWERUP_TYPES.TINY_TRAIL)) return baseRadius * TINY_TRAIL_RADIUS_MULTIPLIER;
    return baseRadius;
  }

  hasGhost(socketId) {
    return this._playerActive.get(socketId)?.has(POWERUP_TYPES.GHOST) ?? false;
  }

  hasShield(socketId) {
    if (!this._growth) return false;
    const g = this._growth.get(socketId);
    return (g?.shieldCount ?? 0) > 0;
  }

  /**
   * Legacy single-active accessor — returns the "most interesting" active
   * power-up for the scoreboard. Prefer getActivePowerUpsArray for full state.
   */
  getActivePowerUp(socketId) {
    const typesMap = this._playerActive.get(socketId);
    if (!typesMap || typesMap.size === 0) return null;
    // Return the most recently activated one
    let latest = null;
    for (const entry of typesMap.values()) {
      if (!latest || entry.activatedAt > latest.activatedAt) latest = entry;
    }
    if (!latest) return null;
    const remaining = latest.expiresAt !== null
      ? Math.max(0, latest.expiresAt - Date.now())
      : null;
    return { type: latest.type, remainingMs: remaining };
  }

  /**
   * Returns ALL active power-ups for a player.
   * Used in gameState.players[].activePowerups for the new UI.
   *
   * @returns {Array<{type, expiresAt}>}
   */
  getActivePowerUpsArray(socketId) {
    const typesMap = this._playerActive.get(socketId);
    if (!typesMap || typesMap.size === 0) return [];
    return [...typesMap.values()].map(e => ({
      type:      e.type,
      expiresAt: e.expiresAt,
    }));
  }

  getMapPowerUps() {
    return [...this._mapPowerUps.values()].map(pu => ({
      id:        pu.id,
      type:      pu.type,
      x:         pu.x,
      y:         pu.y,
      expiresAt: pu.expiresAt,
    }));
  }

  // ─── Spawn ────────────────────────────────────────────────────────────────────

  _scheduleNextSpawn() {
    if (!this._running) return;
    const delay = POWERUP_SPAWN_MIN_MS +
      Math.random() * (POWERUP_SPAWN_MAX_MS - POWERUP_SPAWN_MIN_MS);
    this._spawnTimer = setTimeout(() => this._trySpawn(), delay);
  }

  _trySpawn() {
    if (!this._running) return;

    if (this._mapPowerUps.size >= POWERUP_MAX_ON_MAP) {
      console.log(`[PowerUp] Spawn delayed — max ${POWERUP_MAX_ON_MAP} on map`);
      this._spawnTimer = setTimeout(() => this._trySpawn(), 2_000);
      return;
    }

    const pos = this._findSafePosition();
    if (!pos) {
      this._spawnTimer = setTimeout(() => this._trySpawn(), 2_000);
      return;
    }

    const type = this._weightedRandom();
    const now  = Date.now();
    const pu   = {
      id:        uuidv4().slice(0, 8),
      type,
      x:         pos.x,
      y:         pos.y,
      spawnedAt: now,
      expiresAt: now + POWERUP_EXPIRE_MS,
    };

    this._mapPowerUps.set(pu.id, pu);
    console.log(`[PowerUp] Spawned ${type} at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`);
    this._emitMapUpdate();
    this._scheduleNextSpawn();
  }

  triggerSpawnCheck(bodies) {
    this._currentBodies = bodies;
  }

  /**
   * Find a safe spawn position inside the CURRENT arena bounds (shrinks!).
   * Avoids walls, current snake bodies, and other alive players' heads.
   */
  _findSafePosition() {
    // Spawn bounds come from the current arena (shrinks!)
    const bounds = this._arena
      ? this._arena.getCurrentBounds()
      : { x: 0, y: 0, width: 1200, height: 900 };  // fallback

    const margin    = POWERUP_SPAWN_WALL_MARGIN;
    const clearance = POWERUP_SPAWN_TRAIL_CLEARANCE;
    const playerClr = POWERUP_SPAWN_PLAYER_CLEARANCE;

    const minX = bounds.x + margin;
    const maxX = bounds.x + bounds.width  - margin;
    const minY = bounds.y + margin;
    const maxY = bounds.y + bounds.height - margin;

    if (minX >= maxX || minY >= maxY) return null;

    for (let attempt = 0; attempt < 30; attempt++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);

      // Player clearance — don't spawn on top of someone
      if (this._currentPlayers) {
        let tooClose = false;
        for (const [, p] of this._currentPlayers) {
          if (!p.alive) continue;
          const dx = x - p.x;
          const dy = y - p.y;
          if (dx * dx + dy * dy < playerClr * playerClr) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
      }

      // Body clearance — don't spawn on top of any current snake body
      if (this._currentBodies) {
        let safe = true;
        outer:
        for (const [, body] of this._currentBodies) {
          for (const pt of body) {
            const dx = x - pt.x;
            const dy = y - pt.y;
            if (dx * dx + dy * dy < clearance * clearance) {
              safe = false;
              break outer;
            }
          }
        }
        if (!safe) continue;
      }

      return { x, y };
    }
    return null;
  }

  _weightedRandom() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const entry of POWERUP_WEIGHTS) {
      r -= entry.weight;
      if (r <= 0) return entry.type;
    }
    return POWERUP_WEIGHTS[POWERUP_WEIGHTS.length - 1].type;
  }

  _emitMapUpdate() {
    this._onPowerUpsUpdate(this.getMapPowerUps());
  }
}

// ─── Category helpers ────────────────────────────────────────────────────────────

/**
 * Two active power-ups are MUTUALLY EXCLUSIVE if they share a category.
 * Otherwise they can stack.
 *
 * Categories:
 *   'speed'  — NITRO, SPEED_BOOST     (only one active at a time)
 *   'trail'  — FAT_TRAIL, TINY_TRAIL  (only one active at a time)
 *   null     — independent (GHOST stands alone — never conflicts)
 */
function categoryOf(type) {
  if (type === POWERUP_TYPES.NITRO || type === POWERUP_TYPES.SPEED_BOOST) return 'speed';
  if (type === POWERUP_TYPES.FAT_TRAIL || type === POWERUP_TYPES.TINY_TRAIL) return 'trail';
  return null;
}

module.exports = { PowerUpManager };
