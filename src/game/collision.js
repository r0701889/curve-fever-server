'use strict';

const { PLAYER_RADIUS, ARENA_WIDTH, ARENA_HEIGHT } = require('./constants');

/**
 * Returns true if the player head at (x,y) touches an arena wall.
 * Always lethal — Ghost and Shield do NOT protect against walls.
 */
function collidesWithWall(x, y) {
  return (
    x - PLAYER_RADIUS < 0 ||
    x + PLAYER_RADIUS > ARENA_WIDTH ||
    y - PLAYER_RADIUS < 0 ||
    y + PLAYER_RADIUS > ARENA_HEIGHT
  );
}

/**
 * Returns true if the circle at (x, y) overlaps any trail point.
 *
 * @param {number} x
 * @param {number} y
 * @param {Map<string, Array<{x,y,gap,r}>>} allTrails  playerId → trail points
 *        Each point may carry an optional `r` (stored radius) for Fat/Tiny Trail.
 * @param {string} ownerId           player whose head we're testing
 * @param {number} [headRadius]      override for head collision radius (default PLAYER_RADIUS)
 */
function collidesWithTrails(x, y, allTrails, ownerId, headRadius = PLAYER_RADIUS) {
  const SELF_SKIP = 8;

  for (const [playerId, trail] of allTrails) {
    const limit = playerId === ownerId ? trail.length - SELF_SKIP : trail.length;

    for (let i = 0; i < limit; i++) {
      const point = trail[i];
      if (point.gap) continue;

      const dx = x - point.x;
      const dy = y - point.y;
      const distSq = dx * dx + dy * dy;

      // Trail point radius comes from the point itself (set when trail owner had
      // Fat/Tiny Trail active) or defaults to PLAYER_RADIUS.
      const trailR = point.r ?? PLAYER_RADIUS;
      const minDist = headRadius + trailR;

      if (distSq < minDist * minDist) {
        return true;
      }
    }
  }

  return false;
}

module.exports = { collidesWithWall, collidesWithTrails };
