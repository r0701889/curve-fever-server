'use strict';

const { TRAIL_GRID_CELL_SIZE } = require('./constants');

/**
 * TrailGrid
 *
 * A uniform spatial hash over trail points, used ONLY to accelerate the
 * "is (x,y) near any lethal trail point" query that collidesWithBody and
 * GameLoop._findBodyOwner both need every tick.
 *
 * This is purely an index. It does not own, trim, or expire any points —
 * the permanent/gapped trail arrays in GameLoop._trails remain the single
 * source of truth and are never capped. The grid just lets us avoid
 * scanning every point ever laid this round on every collision check.
 *
 * Why this exists: with permanent (never-trimmed) trails, the naive
 * approach — loop over every player's full trail array — is O(total
 * points laid so far this round) per query, and that total only grows for
 * the entire round. A 6-player, 3-minute round at 60Hz can accumulate tens
 * of thousands of live points; checking all of them on every tick for
 * every alive player quickly dominates frame time. Bucketing points into
 * fixed-size cells means a query only has to look at the handful of points
 * that fall in the 3x3 neighbourhood around the query position — a couple
 * of array lookups instead of a full history scan, regardless of how long
 * the round has run.
 *
 * Usage pattern (see collision.js / GameLoop.js):
 *   - One TrailGrid per round (owned by GameLoop, alongside this._trails).
 *   - Call insert(ownerId, point, index) exactly once, right when a point
 *     is appended to a trail (GameLoop._pushTrailPoint already does this).
 *   - Call queryNearby(x, y, radius) to get back only the candidate points
 *     within `radius` of (x, y) — still need a final distance check against
 *     each candidate's own radius, same as before, just over a tiny set.
 *   - clear() at round start (a fresh TrailGrid is also fine — GameLoop
 *     constructs a new one per round either way, matching "trail clears
 *     only on new round" exactly as before).
 */
class TrailGrid {
  constructor(cellSize = TRAIL_GRID_CELL_SIZE) {
    this._cellSize = cellSize;
    // cellKey -> Array<{ ownerId, index, x, y, r }>
    this._cells = new Map();
  }

  _key(cx, cy) {
    return `${cx},${cy}`;
  }

  _cellOf(x, y) {
    return [Math.floor(x / this._cellSize), Math.floor(y / this._cellSize)];
  }

  /**
   * Index a single trail point. Called once per point, at append time —
   * O(1), so it adds no meaningful cost to the existing _pushTrailPoint path.
   *
   * @param {string} ownerId
   * @param {number} index    position of this point within its owner's trail array
   * @param {number} x
   * @param {number} y
   * @param {number} r
   */
   insert(ownerId, index, x, y, r) {
    const [cx, cy] = this._cellOf(x, y);
    const key = this._key(cx, cy);
    let bucket = this._cells.get(key);
    if (!bucket) {
      bucket = [];
      this._cells.set(key, bucket);
    }
    bucket.push({ ownerId, index, x, y, r });
  }

  /**
   * Return every indexed point whose cell falls within the 3x3 neighbourhood
   * of (x, y) — a superset of points that could possibly be within
   * `maxQueryRadius` of (x, y). Callers still do their own precise
   * distance + radius check against each candidate (same math as the old
   * brute-force loop), this just shrinks the candidate set first.
   *
   * `maxQueryRadius` is only used to decide how many neighbouring cells to
   * scan — if collision radii ever grow larger than ~1 cell width (e.g. a
   * much bigger Fat Trail multiplier in the future), widen the cell scan
   * here rather than changing TRAIL_GRID_CELL_SIZE itself.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} maxQueryRadius
   * @returns {Array<{ownerId, index, x, y, r}>}
   */
  queryNearby(x, y, maxQueryRadius) {
    const span = Math.max(1, Math.ceil(maxQueryRadius / this._cellSize));
    const [cx, cy] = this._cellOf(x, y);
    const results = [];

    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = this._cells.get(this._key(cx + dx, cy + dy));
        if (bucket) results.push(...bucket);
      }
    }

    return results;
  }

  clear() {
    this._cells.clear();
  }
}

module.exports = { TrailGrid };
