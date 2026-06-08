// ─── Arena ────────────────────────────────────────────────────────────────────

const ARENA_WIDTH  = 800;
const ARENA_HEIGHT = 600;

// ─── Player Physics ───────────────────────────────────────────────────────────

const PLAYER_SPEED        = 2.5;   // pixels per tick
const TURN_RATE           = 0.055; // radians per tick (~3.15°)
const PLAYER_RADIUS       = 3;     // collision radius (pixels)

// ─── Trail ────────────────────────────────────────────────────────────────────

const TRAIL_GAP_INTERVAL  = 180;   // ticks between gap windows
const TRAIL_GAP_DURATION  = 12;    // ticks the gap stays open

// ─── Game Loop ────────────────────────────────────────────────────────────────

const TICK_RATE           = 30;    // ticks per second
const TICK_INTERVAL_MS    = 1000 / TICK_RATE;

// ─── Room ─────────────────────────────────────────────────────────────────────

const MIN_PLAYERS         = 2;
const MAX_PLAYERS         = 6;

// ─── Spawn ────────────────────────────────────────────────────────────────────

const SPAWN_MARGIN        = 80;    // min distance from arena edge when spawning

// ─── Player Colours ───────────────────────────────────────────────────────────

const PLAYER_COLORS = [
  '#FF4D4D',
  '#4D9EFF',
  '#4DFF91',
  '#FFD84D',
  '#C44DFF',
  '#FF914D',
];

module.exports = {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  PLAYER_SPEED,
  TURN_RATE,
  PLAYER_RADIUS,
  TRAIL_GAP_INTERVAL,
  TRAIL_GAP_DURATION,
  TICK_RATE,
  TICK_INTERVAL_MS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  SPAWN_MARGIN,
  PLAYER_COLORS,
};
