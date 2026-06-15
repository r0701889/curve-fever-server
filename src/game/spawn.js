const {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  SPAWN_MARGIN,
} = require('./constants');

/**
 * Generates evenly-spread spawn positions for `count` players inside the
 * given arena rectangle.
 *
 * @param {number} count  number of players (2–6)
 * @param {{x,y,width,height}} [arenaBounds]  defaults to full arena
 * @returns {Array<{x:number, y:number, angle:number}>}
 */
function generateSpawns(count, arenaBounds) {
  const bounds = arenaBounds ?? {
    x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT,
  };

  const cx = bounds.x + bounds.width  / 2;
  const cy = bounds.y + bounds.height / 2;
  const rx = bounds.width  / 2 - SPAWN_MARGIN;
  const ry = bounds.height / 2 - SPAWN_MARGIN;

  const spawns = [];
  for (let i = 0; i < count; i++) {
    const t = (2 * Math.PI * i) / count;
    const jitter = (Math.random() - 0.5) * 0.4;
    const angle  = t + jitter;

    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);

    const towardCentre = Math.atan2(cy - y, cx - x);
    const spawnAngle   = towardCentre + (Math.random() - 0.5) * 0.6;

    spawns.push({ x, y, angle: spawnAngle });
  }

  return spawns;
}

module.exports = { generateSpawns };
