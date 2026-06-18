'use strict';

const { PLAYER_RADIUS, ARENA_WIDTH, ARENA_HEIGHT, TRAIL_SELF_SKIP_POINTS } = require('./constants');

/**
 * Returns true if the player head at (x,y) touches an arena wall.
 * Always lethal — Ghost and Shield do NOT protect against walls/shrink boundary.
 *
 * The arena bounds can be passed dynamically (for shrinking arena support).
 * Defaults to the full constants if not provided.
 *
 * @param {number} x
 * @param {number} y
 * @param {{x,y,width,height}} [bounds]
 */
function collidesWithWall(x, y, bounds) {
  const b = bounds ?? { x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT };
  return (
    x - PLAYER_RADIUS < b.x ||
    x + PLAYER_RADIUS > b.x + b.width ||
    y - PLAYER_RADIUS < b.y ||
    y + PLAYER_RADIUS > b.y + b.height
  );
}

/**
 * Returns true if the circle at (x, y) overlaps any player's CURRENT trail
 * — classic Curve Fever rules: the trail is permanent for the round, never
 * trimmed, so this checks against the player's FULL movement history since
 * their last spawn, not a sliding window behind the head.
 *
 * Generic by design: this function has no idea whether the trail it's given
 * is bounded or unbounded — it just walks whatever array of points it's
 * handed. That's why reverting GameLoop from a fixed-length body back to a
 * permanent trail required zero changes here beyond the constant rename
 * below — the caller simply passes a Map of longer-lived arrays now.
 *
 * Optional `grid` (a TrailGrid instance) accelerates this from O(total
 * trail points across all players) down to O(points in the local
 * neighbourhood). When provided, only points the grid reports near (x, y)
 * are distance-checked — same exact math, smaller candidate set. The
 * self-skip rule still applies (a candidate from the owner's own trail at
 * an index past `body.length - TRAIL_SELF_SKIP_POINTS` is excluded), so
 * results are identical to the brute-force path; `grid` only changes how
 * fast the answer is found, never what the answer is. When `grid` is
 * omitted, this falls back to the original full-scan behaviour unchanged —
 * existing callers that don't pass a grid keep working exactly as before.
 *
 * @param {number} x
 * @param {number} y
 * @param {Map<string, Array<{x,y,r}>>} allBodies  playerId → current trail points
 *        (index 0 = first point laid this round, last = most recent point
 *        just behind the current head). Each point may carry an optional
 *        `r` (radius) for Fat/Tiny Trail.
 * @param {string} ownerId           player whose head we're testing
 * @param {number} [headRadius]      override for head collision radius (default PLAYER_RADIUS)
 * @param {import('./TrailGrid').TrailGrid} [grid]  optional spatial index for fast lookup
 */
function collidesWithBody(x, y, allBodies, ownerId, headRadius = PLAYER_RADIUS, grid = null) {
  if (grid) {
    // Widest plausible point radius is FAT_TRAIL's multiplier on PLAYER_RADIUS;
    // headRadius + that bound is the true max interaction distance, so the
    // neighbourhood query just needs to be at least that wide to be exhaustive.
    const maxQueryRadius = headRadius + PLAYER_RADIUS * 2; // generous bound, see TrailGrid docs
    const candidates = grid.queryNearby(x, y, maxQueryRadius);

    for (const candidate of candidates) {
      if (candidate.ownerId === ownerId) {
        const ownerBody = allBodies.get(ownerId);
        const skipLimit = ownerBody ? Math.max(0, ownerBody.length - TRAIL_SELF_SKIP_POINTS) : 0;
        if (candidate.index >= skipLimit) continue; // within self-skip window
      }

      const dx = x - candidate.x;
      const dy = y - candidate.y;
      const distSq = dx * dx + dy * dy;
      const bodyR  = candidate.r ?? PLAYER_RADIUS;
      const minDist = headRadius + bodyR;

      if (distSq < minDist * minDist) {
        return true;
      }
    }

    return false;
  }

  // Fallback: original brute-force scan, unchanged.
  for (const [playerId, body] of allBodies) {
    // Self-collision: skip the points immediately behind the head — these
    // are always within head-radius due to continuous movement and are not
    // a real collision. This window is FIXED and independent of how long
    // the trail has grown so far this round.
    const limit = playerId === ownerId
      ? Math.max(0, body.length - TRAIL_SELF_SKIP_POINTS)
      : body.length;

    for (let i = 0; i < limit; i++) {
      const point = body[i];

      const dx = x - point.x;
      const dy = y - point.y;
      const distSq = dx * dx + dy * dy;

      // Trail point radius comes from the point itself (set when the trail
      // owner had Fat/Tiny Trail active) or defaults to PLAYER_RADIUS.
      const bodyR  = point.r ?? PLAYER_RADIUS;
      const minDist = headRadius + bodyR;

      if (distSq < minDist * minDist) {
        return true;
      }
    }
  }

  return false;
}

module.exports = { collidesWithWall, collidesWithBody };
