'use strict';

const {
  ARENA_WIDTH, ARENA_HEIGHT,
  ARENA_MIN_WIDTH, ARENA_MIN_HEIGHT,
  ARENA_FIRST_SHRINK_AFTER_MS,
  ARENA_WARNING_MS, ARENA_SHRINK_MS, ARENA_SAFE_MS,
  ARENA_SHRINK_RATIO, ARENA_GRACE_MS,
} = require('./constants');

/**
 * ArenaManager
 *
 * Server-authoritative shrinking arena. Owns the current bounds, the next
 * bounds (during 'warning'), and runs a state machine through the cycle:
 *
 *   safe (first wait → ARENA_FIRST_SHRINK_AFTER_MS, then ARENA_SAFE_MS)
 *     ↓
 *   warning  (ARENA_WARNING_MS — show next border, no kills)
 *     ↓
 *   shrinking (ARENA_SHRINK_MS — interpolate bounds; kill players outside `current`)
 *     ↓
 *   safe again
 *
 * The cycle stops once the arena has reached the minimum size (no further
 * shrinks scheduled — stays in 'safe' indefinitely with the minimum bounds).
 *
 * Frontend-facing state: every tick the GameLoop snapshot includes:
 *   {
 *     current:        { x, y, width, height },
 *     next:           { x, y, width, height } | null,
 *     phase:          'safe' | 'warning' | 'shrinking',
 *     warningEndsAt:  unix ms | null,
 *     shrinkEndsAt:   unix ms | null,
 *     shrinkProgress: 0.0..1.0   (only meaningful during 'shrinking')
 *   }
 *
 * Bound rectangles are { x, y, width, height } in arena coordinates.
 * (x, y) is the top-left corner of the rectangle.
 *
 * Kill check:
 *   - During 'shrinking', a player whose head goes outside `current` starts
 *     accumulating exposure. If they remain outside for > ARENA_GRACE_MS,
 *     they die with reason 'shrink'.
 *   - During 'safe' and 'warning', no kills attributed to the arena
 *     (the warning border is purely visual).
 *
 * The "shrink kill check" runs in tick(); the GameLoop is responsible for
 * calling kill() on players returned via the result.
 */
class ArenaManager {
  /**
   * @param {object} opts
   * @param {Function} [opts.onPhaseChange]  (newPhase, snapshot) — for logging
   */
  constructor({ onPhaseChange } = {}) {
    this._onPhaseChange = onPhaseChange ?? (() => {});

    // Full arena to start with
    this.current = { x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT };
    this.next    = null;

    this.phase            = 'safe';
    this.phaseStartedAt   = null;       // set in start()
    this.warningEndsAt    = null;
    this.shrinkEndsAt     = null;
    this.shrinkLevel      = 0;

    // Per-player "outside arena since" timestamp (for grace period)
    // socketId → unix ms when they first went outside, or null
    this._outsideSince = new Map();

    this._running = false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start() {
    this._running = true;
    this.phase = 'safe';
    this.phaseStartedAt = Date.now();
    // First shrink uses a longer initial safe period (ARENA_FIRST_SHRINK_AFTER_MS)
    // — players need time to get oriented in the larger arena.
  }

  stop() {
    this._running = false;
  }

  /** Reset everything — called when starting a new round */
  reset() {
    this.current = { x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT };
    this.next    = null;
    this.phase           = 'safe';
    this.phaseStartedAt  = null;
    this.warningEndsAt   = null;
    this.shrinkEndsAt    = null;
    this.shrinkLevel     = 0;
    this._outsideSince.clear();
    this._running = false;
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  /**
   * Advance the state machine and check for arena-kill conditions.
   *
   * @param {Map<string,{x,y,alive}>} players  socketId → player state
   * @returns {{killedSocketIds: string[], phaseChanged: boolean}}
   */
  tick(players) {
    if (!this._running) {
      return { killedSocketIds: [], phaseChanged: false };
    }

    const now = Date.now();
    let phaseChanged = false;
    const killed = [];

    // ── State machine ──────────────────────────────────────────────────────
    if (this.phase === 'safe') {
      const safeDuration = this.shrinkLevel === 0
        ? ARENA_FIRST_SHRINK_AFTER_MS
        : ARENA_SAFE_MS;

      // Don't schedule another shrink if we've already hit the minimum
      const atMinimum =
        this.current.width  <= ARENA_MIN_WIDTH &&
        this.current.height <= ARENA_MIN_HEIGHT;

      if (!atMinimum && now >= this.phaseStartedAt + safeDuration) {
        this.next            = this._computeNextBounds();
        this.phase           = 'warning';
        this.phaseStartedAt  = now;
        this.warningEndsAt   = now + ARENA_WARNING_MS;
        phaseChanged = true;
        this._onPhaseChange('warning', this.getSnapshot());
      }
    } else if (this.phase === 'warning') {
      if (now >= this.warningEndsAt) {
        this.phase          = 'shrinking';
        this.phaseStartedAt = now;
        this.shrinkEndsAt   = now + ARENA_SHRINK_MS;
        this.warningEndsAt  = null;
        phaseChanged = true;
        this._onPhaseChange('shrinking', this.getSnapshot());
      }
    } else if (this.phase === 'shrinking') {
      // Interpolate `current` toward `next` based on elapsed time
      const elapsed = now - (this.shrinkEndsAt - ARENA_SHRINK_MS);
      const t = Math.min(1, Math.max(0, elapsed / ARENA_SHRINK_MS));
      this.current = lerpRect(this._shrinkFrom, this.next, t);

      if (now >= this.shrinkEndsAt) {
        // Snap to exactly `next` and return to safe
        this.current        = { ...this.next };
        this.next           = null;
        this.phase          = 'safe';
        this.phaseStartedAt = now;
        this.shrinkEndsAt   = null;
        this.shrinkLevel++;
        this._outsideSince.clear(); // grace timers reset between cycles
        phaseChanged = true;
        this._onPhaseChange('safe', this.getSnapshot());
      }

      // Kill check — only during 'shrinking'
      for (const [socketId, player] of players) {
        if (!player.alive) {
          this._outsideSince.delete(socketId);
          continue;
        }
        const outside = !this.containsPoint(player.x, player.y);
        if (outside) {
          const since = this._outsideSince.get(socketId) ?? now;
          this._outsideSince.set(socketId, since);
          if (now - since > ARENA_GRACE_MS) {
            killed.push(socketId);
            this._outsideSince.delete(socketId);
          }
        } else {
          this._outsideSince.delete(socketId);
        }
      }
    }

    return { killedSocketIds: killed, phaseChanged };
  }

  // ─── Geometry ────────────────────────────────────────────────────────────────

  /**
   * Returns true if (x, y) is inside the current active arena.
   * Used by collision.js (wall kill check uses `current`).
   */
  containsPoint(x, y) {
    return x >= this.current.x &&
           x <= this.current.x + this.current.width &&
           y >= this.current.y &&
           y <= this.current.y + this.current.height;
  }

  /** Bounds for spawning power-ups and players — always `current` */
  getCurrentBounds() {
    return this.current;
  }

  // ─── Snapshot for gameState ──────────────────────────────────────────────────

  getSnapshot() {
    const now = Date.now();

    let shrinkProgress = 0;
    if (this.phase === 'shrinking' && this.shrinkEndsAt) {
      const elapsed = now - (this.shrinkEndsAt - ARENA_SHRINK_MS);
      shrinkProgress = Math.min(1, Math.max(0, elapsed / ARENA_SHRINK_MS));
    }

    return {
      current:        roundRect(this.current),
      next:           this.next ? roundRect(this.next) : null,
      phase:          this.phase,
      warningEndsAt:  this.warningEndsAt,
      shrinkEndsAt:   this.shrinkEndsAt,
      shrinkProgress: +shrinkProgress.toFixed(3),
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  /**
   * Compute the next (smaller) arena rectangle, centred on the same point
   * as the current one. Clamped so we never go below the minimum dimensions.
   */
  _computeNextBounds() {
    const w = Math.max(ARENA_MIN_WIDTH,  this.current.width  * ARENA_SHRINK_RATIO);
    const h = Math.max(ARENA_MIN_HEIGHT, this.current.height * ARENA_SHRINK_RATIO);

    const cx = this.current.x + this.current.width  / 2;
    const cy = this.current.y + this.current.height / 2;

    const next = {
      x:      cx - w / 2,
      y:      cy - h / 2,
      width:  w,
      height: h,
    };

    // Remember the "from" rectangle for smooth interpolation during shrinking
    this._shrinkFrom = { ...this.current };

    return next;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function lerpRect(a, b, t) {
  return {
    x:      a.x      + (b.x      - a.x)      * t,
    y:      a.y      + (b.y      - a.y)      * t,
    width:  a.width  + (b.width  - a.width)  * t,
    height: a.height + (b.height - a.height) * t,
  };
}

function roundRect(r) {
  return {
    x:      +r.x.toFixed(2),
    y:      +r.y.toFixed(2),
    width:  +r.width.toFixed(2),
    height: +r.height.toFixed(2),
  };
}

module.exports = { ArenaManager };
