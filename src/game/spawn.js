const {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  SPAWN_MARGIN,
} = require('./constants');

/**
 * Generates evenly-spread spawn positions for `count` players.
 * Each position is a safe distance from the walls and given a random
 * outward-facing angle so players head toward the centre.
 *
 * @param {number} count  number of players (2–6)
 * @returns {Array<{x:number, y:number, angle:number}>}
 */
function generateSpawns(count) {
  const spawns = [];

  // Distribute players around a virtual circle inside the arena
  const cx = ARENA_WIDTH  / 2;
  const cy = ARENA_HEIGHT / 2;
  const rx = cx - SPAWN_MARGIN;
  const ry = cy - SPAWN_MARGIN;

  for (let i = 0; i < count; i++) {
    const t = (2 * Math.PI * i) / count;

    // Slightly randomise so it doesn't feel scripted
    const jitter = (Math.random() - 0.5) * 0.4;
    const angle  = t + jitter;

    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);

    // Face toward the centre, with a small random offset
    const towardCentre = Math.atan2(cy - y, cx - x);
    const spawnAngle   = towardCentre + (Math.random() - 0.5) * 0.6;

    spawns.push({ x, y, angle: spawnAngle });
  }

  return spawns;
}

module.exports = { generateSpawns };
