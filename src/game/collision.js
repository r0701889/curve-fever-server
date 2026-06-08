const { PLAYER_RADIUS, ARENA_WIDTH, ARENA_HEIGHT } = require('./constants');

/**
 * Returns true if (x, y) is outside the arena walls.
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
 * Returns true if the circle at (x, y) with PLAYER_RADIUS
 * overlaps any segment in the trails array.
 *
 * Each trail entry is { x, y } — we treat each as a disc of PLAYER_RADIUS.
 * We skip the most-recent N points of the *owner's* trail to avoid
 * self-collision on the head (the "nose" of the snake).
 *
 * @param {number} x
 * @param {number} y
 * @param {Map<string, Array<{x:number,y:number,gap:boolean}>>} allTrails  playerId → trail points
 * @param {string} ownerId  the player whose head we're testing
 */
function collidesWithTrails(x, y, allTrails, ownerId) {
  const SELF_SKIP = 8; // ignore the last N points of own trail

  for (const [playerId, trail] of allTrails) {
    const limit = playerId === ownerId ? trail.length - SELF_SKIP : trail.length;

    for (let i = 0; i < limit; i++) {
      const point = trail[i];
      if (point.gap) continue; // gap points are passable

      const dx = x - point.x;
      const dy = y - point.y;
      const distSq = dx * dx + dy * dy;
      const minDist = PLAYER_RADIUS * 2;

      if (distSq < minDist * minDist) {
        return true;
      }
    }
  }

  return false;
}

module.exports = { collidesWithWall, collidesWithTrails };
