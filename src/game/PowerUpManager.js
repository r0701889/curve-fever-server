'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  POWERUP_SPAWN_MIN_MS,
  POWERUP_SPAWN_MAX_MS,
  POWERUP_MAX_ON_MAP,
  POWERUP_EXPIRE_MS,
  POWERUP_COLLECT_RADIUS,
  POWERUP_TYPES,
  POWERUP_DURATION_MS,
  POWERUP_WEIGHTS,
  POWERUP_SPAWN_WALL_MARGIN,
  POWERUP_SPAWN_TRAIL_CLEARANCE,
} = require('./constants');

// Total weight for weighted random selection
const TOTAL_WEIGHT = POWERUP_WEIGHTS.reduce((s, e) => s + e.weight, 0);

/**
 * PowerUpManager
 *
 * Completely server-authoritative. Owns:
 *   - Map power-up spawn / expire lifecycle
 *   - Per-player active power-up state
 *   - Collection detection (called each tick by GameLoop)
 *   - Effect queries (GameLoop asks "what speed multiplier does player X have?")
 *
 * Does NOT know about Socket.io — uses callbacks for output.
 *
 * Callbacks:
 *   onPowerUpsUpdate(powerUps)          — map changed (spawn/collect/expire)
 *   onPowerUpCollected(socketId, entry) — player picked up a power-up
 *   onPowerUpExpired(socketId, type)    — active power-up timer ran out
 *   onPowerUpUsed(socketId, type)       — shield consumed on trail hit
 */
class PowerUpManager {
  constructor({ onPowerUpsUpdate, onPowerUpCollected, onPowerUpExpired, onPowerUpUsed }) {
    this._onPowerUpsUpdate  = onPowerUpsUpdate;
    this._onPowerUpCollected = onPowerUpCollected;
    this._onPowerUpExpired  = onPowerUpExpired;
    this._onPowerUpUsed     = onPowerUpUsed;

    // Power-ups currently on the map: id → { id, type, x, y, spawnedAt, expiresAt }
    this._mapPowerUps = new Map();

    // Active power-ups per player: socketId → { type, activatedAt, expiresAt|null }
    this._playerPowerUps = new Map();

    // Next spawn timer
    this._spawnTimer = null;
    this._running    = false;
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

  /** Clear everything — called at round start/end */
  reset() {
    this.stop();
    this._mapPowerUps.clear();
    this._playerPowerUps.clear();
  }

  // ─── Tick — called every GameLoop tick ───────────────────────────────────────

  /**
   * Main tick:
   *   1. Expire map power-ups whose lifetime has elapsed
   *   2. Expire active player power-ups whose duration has elapsed
   *   3. Check collection for each alive player
   *
   * @param {Map<string,{x,y,alive}>} players  socketId → player state from GameLoop
   */
  tick(players) {
    if (!this._running) return;

    const now = Date.now();
    let mapChanged = false;

    // ── 1. Expire map power-ups ────────────────────────────────────────────────
    for (const [id, pu] of this._mapPowerUps) {
      if (now >= pu.expiresAt) {
        this._mapPowerUps.delete(id);
        mapChanged = true;
        console.log(`[PowerUp] Map power-up ${pu.type} expired`);
      }
    }

    // ── 2. Expire active player power-ups ─────────────────────────────────────
    for (const [socketId, active] of this._playerPowerUps) {
      if (active.expiresAt !== null && now >= active.expiresAt) {
        const { type } = active;
        this._playerPowerUps.delete(socketId);
        console.log(`[PowerUp] ${socketId} power-up ${type} expired`);
        this._onPowerUpExpired(socketId, type);
      }
    }

    // ── 3. Collection detection ────────────────────────────────────────────────
    if (this._mapPowerUps.size > 0) {
      for (const [socketId, player] of players) {
        if (!player.alive) continue;

        for (const [puId, pu] of this._mapPowerUps) {
          const dx = player.x - pu.x;
          const dy = player.y - pu.y;
          if (dx * dx + dy * dy < POWERUP_COLLECT_RADIUS * POWERUP_COLLECT_RADIUS) {
            this._collect(socketId, puId, pu);
            mapChanged = true;
            break; // one collection per player per tick
          }
        }
      }
    }

    if (mapChanged) {
      this._emitMapUpdate();
    }
  }

  // ─── Collection ───────────────────────────────────────────────────────────────

  _collect(socketId, puId, pu) {
    this._mapPowerUps.delete(puId);

    const duration = POWERUP_DURATION_MS[pu.type];
    const now      = Date.now();

    const entry = {
      type:        pu.type,
      activatedAt: now,
      expiresAt:   duration !== null ? now + duration : null,
    };

    // Replacing an existing power-up — just overwrite
    this._playerPowerUps.set(socketId, entry);

    console.log(`[PowerUp] ${socketId} collected ${pu.type} (duration: ${duration ?? 'until used'}ms)`);
    this._onPowerUpCollected(socketId, pu.type, duration);
  }

  // ─── Shield consumption ───────────────────────────────────────────────────────

  /**
   * Called by GameLoop when a trail collision is detected for a player.
   * Returns true if the shield absorbed the hit (player survives).
   * Removes the shield and emits powerUpUsed.
   */
  consumeShield(socketId) {
    const active = this._playerPowerUps.get(socketId);
    if (!active || active.type !== POWERUP_TYPES.SHIELD) return false;

    this._playerPowerUps.delete(socketId);
    console.log(`[PowerUp] ${socketId} shield consumed`);
    this._onPowerUpUsed(socketId, POWERUP_TYPES.SHIELD);
    this._onPowerUpExpired(socketId, POWERUP_TYPES.SHIELD);
    return true;
  }

  // ─── Effect queries (called by GameLoop per tick) ─────────────────────────────

  /** Returns the speed multiplier for a player (1.0 if no effect) */
  getSpeedMultiplier(socketId) {
    const active = this._playerPowerUps.get(socketId);
    if (!active) return 1.0;
    if (active.type === POWERUP_TYPES.NITRO) return 1.30;
    return 1.0;
  }

  /** Returns the trail point radius for a player (PLAYER_RADIUS if no effect) */
  getTrailRadius(socketId, baseRadius) {
    const active = this._playerPowerUps.get(socketId);
    if (!active) return baseRadius;
    if (active.type === POWERUP_TYPES.FAT_TRAIL)  return baseRadius * 1.50;
    if (active.type === POWERUP_TYPES.TINY_TRAIL) return baseRadius * 0.50;
    return baseRadius;
  }

  /** Returns true if the player has Ghost active (ignores trail collisions) */
  hasGhost(socketId) {
    const active = this._playerPowerUps.get(socketId);
    return active?.type === POWERUP_TYPES.GHOST;
  }

  /** Returns true if the player has Shield active */
  hasShield(socketId) {
    const active = this._playerPowerUps.get(socketId);
    return active?.type === POWERUP_TYPES.SHIELD;
  }

  /** Returns the active power-up type for a player, or null */
  getActivePowerUp(socketId) {
    const active = this._playerPowerUps.get(socketId);
    if (!active) return null;
    const remaining = active.expiresAt !== null
      ? Math.max(0, active.expiresAt - Date.now())
      : null;
    return { type: active.type, remainingMs: remaining };
  }

  /** Returns the current map power-ups as an array for gameState */
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

  _trySpawn(trails = null) {
    if (!this._running) return;

    if (this._mapPowerUps.size >= POWERUP_MAX_ON_MAP) {
      // Already at max — try again shortly
      console.log(`[PowerUp] Spawn delayed — max ${POWERUP_MAX_ON_MAP} on map`);
      this._spawnTimer = setTimeout(() => this._trySpawn(trails), 2_000);
      return;
    }

    const pos = this._findSafePosition(trails);
    if (!pos) {
      // Couldn't find a safe spot — retry soon
      this._spawnTimer = setTimeout(() => this._trySpawn(trails), 2_000);
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

  /**
   * The spawn method is also exposed so GameLoop can pass current trails
   * for a more accurate safe-position check.
   */
  triggerSpawnCheck(trails) {
    this._currentTrails = trails;
  }

  _findSafePosition(trails) {
    const margin = POWERUP_SPAWN_WALL_MARGIN;
    const clearance = POWERUP_SPAWN_TRAIL_CLEARANCE;

    for (let attempt = 0; attempt < 30; attempt++) {
      const x = margin + Math.random() * (ARENA_WIDTH  - margin * 2);
      const y = margin + Math.random() * (ARENA_HEIGHT - margin * 2);

      if (!trails) return { x, y };  // no trail data yet, accept position

      // Check distance from all trail points
      let safe = true;
      outer:
      for (const [, trail] of trails) {
        for (const pt of trail) {
          if (pt.gap) continue;
          const dx = x - pt.x;
          const dy = y - pt.y;
          if (dx * dx + dy * dy < clearance * clearance) {
            safe = false;
            break outer;
          }
        }
      }
      if (safe) return { x, y };
    }
    return null; // couldn't find a safe spot in 30 attempts
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

module.exports = { PowerUpManager };
