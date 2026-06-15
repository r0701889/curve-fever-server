'use strict';

const { PLAYER_RADIUS, ARENA_WIDTH, ARENA_HEIGHT, BODY_SELF_SKIP_POINTS } = require('./constants');

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
 * Returns true if the circle at (x, y) overlaps any player's CURRENT
 * snake body (fixed-length, continuously trimmed — no permanent trail).
 *
 * @param {number} x
 * @param {number} y
 * @param {Map<string, Array<{x,y,r}>>} allBodies  playerId → current body points
 *        (index 0 = tail/oldest, last = most recent point behind the head)
 *        Each point may carry an optional `r` (radius) for Fat/Tiny/growth.
 * @param {string} ownerId           player whose head we're testing
 * @param {number} [headRadius]      override for head collision radius (default PLAYER_RADIUS)
 */
function collidesWithBody(x, y, allBodies, ownerId, headRadius = PLAYER_RADIUS) {
  for (const [playerId, body] of allBodies) {
    // Self-collision: skip the points immediately behind the head — these
    // are always within head-radius due to continuous movement and are not
    // a real collision. This window is FIXED (not affected by growth/length).
    const limit = playerId === ownerId
      ? Math.max(0, body.length - BODY_SELF_SKIP_POINTS)
      : body.length;

    for (let i = 0; i < limit; i++) {
      const point = body[i];

      const dx = x - point.x;
      const dy = y - point.y;
      const distSq = dx * dx + dy * dy;

      // Body point radius comes from the point itself (set when the body
      // owner had Fat/Tiny Trail or growth active) or defaults to PLAYER_RADIUS.
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
