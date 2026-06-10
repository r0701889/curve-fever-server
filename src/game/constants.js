// ─── Arena ────────────────────────────────────────────────────────────────────

const ARENA_WIDTH  = 800;
const ARENA_HEIGHT = 600;

// ─── Player Physics ───────────────────────────────────────────────────────────

const TICK_RATE           = 60;
const TICK_INTERVAL_MS    = 1000 / TICK_RATE;

const PLAYER_SPEED_PPS    = 75;
const TURN_RATE_RPS       = 1.65;

const PLAYER_SPEED        = PLAYER_SPEED_PPS / TICK_RATE;   // 1.25 px/tick
const TURN_RATE           = TURN_RATE_RPS    / TICK_RATE;   // 0.0275 rad/tick
const PLAYER_RADIUS       = 3;

// ─── Trail ────────────────────────────────────────────────────────────────────

const GAP_INTERVAL_S      = 6;
const GAP_DURATION_S      = 0.4;

const TRAIL_GAP_INTERVAL  = Math.round(GAP_INTERVAL_S * TICK_RATE);  // 360 ticks
const TRAIL_GAP_DURATION  = Math.round(GAP_DURATION_S * TICK_RATE);  // 24 ticks

// ─── Room ─────────────────────────────────────────────────────────────────────

const MIN_PLAYERS         = 2;
const MAX_PLAYERS         = 6;

// ─── Multi-round ──────────────────────────────────────────────────────────────

const VALID_ROUNDS             = [1, 3, 5, 7, 9];
const DEFAULT_ROUNDS           = 1;
const BETWEEN_ROUNDS_DELAY_MS  = 10000;
const POST_MATCH_GRACE_MS      = 60_000; // keep room alive 60s after matchEnded for rematch

// ─── Spawn ────────────────────────────────────────────────────────────────────

const SPAWN_MARGIN        = 80;

// ─── Player Colours ───────────────────────────────────────────────────────────

const PLAYER_COLORS = [
  '#FF4D4D',
  '#4D9EFF',
  '#4DFF91',
  '#FFD84D',
  '#C44DFF',
  '#FF914D',
];

// ─── Power-ups ────────────────────────────────────────────────────────────────

// Spawn timing (seconds → ms)
const POWERUP_SPAWN_MIN_MS    = 10_000;   // minimum delay between spawns
const POWERUP_SPAWN_MAX_MS    = 20_000;   // maximum delay between spawns
const POWERUP_MAX_ON_MAP      = 2;        // max simultaneous power-ups on map
const POWERUP_EXPIRE_MS       = 15_000;   // uncollected power-up lifetime
const POWERUP_COLLECT_RADIUS  = 14;       // px — head must be within this to collect

// Power-up types
const POWERUP_TYPES = {
  GHOST:      'ghost',
  NITRO:      'nitro',
  SHIELD:     'shield',
  FAT_TRAIL:  'fat_trail',
  TINY_TRAIL: 'tiny_trail',
};

// Duration in ms for each type (Shield has no timer — consumed on use)
const POWERUP_DURATION_MS = {
  [POWERUP_TYPES.GHOST]:      2_000,
  [POWERUP_TYPES.NITRO]:      2_000,
  [POWERUP_TYPES.SHIELD]:     null,    // duration-less — consumed on first trail hit
  [POWERUP_TYPES.FAT_TRAIL]:  6_000,
  [POWERUP_TYPES.TINY_TRAIL]: 6_000,
};

// Spawn weights (must sum to 100)
const POWERUP_WEIGHTS = [
  { type: POWERUP_TYPES.GHOST,      weight: 20 },
  { type: POWERUP_TYPES.NITRO,      weight: 20 },
  { type: POWERUP_TYPES.SHIELD,     weight: 30 },
  { type: POWERUP_TYPES.FAT_TRAIL,  weight: 15 },
  { type: POWERUP_TYPES.TINY_TRAIL, weight: 15 },
];

// Effect multipliers
const NITRO_SPEED_MULTIPLIER      = 1.30;  // +30% speed
const FAT_TRAIL_RADIUS_MULTIPLIER = 1.50;  // +50% collision width
const TINY_TRAIL_RADIUS_MULTIPLIER = 0.50; // -50% collision width

// Safe distance from walls and trails when spawning a power-up
const POWERUP_SPAWN_WALL_MARGIN   = 50;   // px from any wall
const POWERUP_SPAWN_TRAIL_CLEARANCE = 20; // px from any trail point

module.exports = {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  PLAYER_SPEED,
  PLAYER_SPEED_PPS,
  TURN_RATE,
  TURN_RATE_RPS,
  PLAYER_RADIUS,
  TRAIL_GAP_INTERVAL,
  TRAIL_GAP_DURATION,
  TICK_RATE,
  TICK_INTERVAL_MS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  VALID_ROUNDS,
  DEFAULT_ROUNDS,
  BETWEEN_ROUNDS_DELAY_MS,
  POST_MATCH_GRACE_MS,
  SPAWN_MARGIN,
  PLAYER_COLORS,
  // power-ups
  POWERUP_SPAWN_MIN_MS,
  POWERUP_SPAWN_MAX_MS,
  POWERUP_MAX_ON_MAP,
  POWERUP_EXPIRE_MS,
  POWERUP_COLLECT_RADIUS,
  POWERUP_TYPES,
  POWERUP_DURATION_MS,
  POWERUP_WEIGHTS,
  NITRO_SPEED_MULTIPLIER,
  FAT_TRAIL_RADIUS_MULTIPLIER,
  TINY_TRAIL_RADIUS_MULTIPLIER,
  POWERUP_SPAWN_WALL_MARGIN,
  POWERUP_SPAWN_TRAIL_CLEARANCE,
};
