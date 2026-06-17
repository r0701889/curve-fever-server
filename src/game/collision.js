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
 * @param {number} x
 * @param {number} y
 * @param {Map<string, Array<{x,y,r}>>} allBodies  playerId → current trail points
 *        (index 0 = first point laid this round, last = most recent point
 *        just behind the current head). Each point may carry an optional
 *        `r` (radius) for Fat/Tiny Trail.
 * @param {string} ownerId           player whose head we're testing
 * @param {number} [headRadius]      override for head collision radius (default PLAYER_RADIUS)
 */
function collidesWithBody(x, y, allBodies, ownerId, headRadius = PLAYER_RADIUS) {
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
