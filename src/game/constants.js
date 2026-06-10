// ─── Arena ────────────────────────────────────────────────────────────────────

const ARENA_WIDTH  = 800;
const ARENA_HEIGHT = 600;

// ─── Player Physics ───────────────────────────────────────────────────────────
//
// All per-tick values are derived from a target real-world rate so that
// changing TICK_RATE never silently breaks gameplay feel:
//
//   PLAYER_SPEED_PPS  = 75  px/s   (pixels per second — the real-world value)
//   TURN_RATE_RPS     = 1.65 rad/s (radians per second — the real-world value)
//
// Per-tick values = real-world rate / TICK_RATE  ← computed automatically

const TICK_RATE           = 60;              // ticks per second
const TICK_INTERVAL_MS    = 1000 / TICK_RATE; // 16.667 ms

const PLAYER_SPEED_PPS    = 75;              // pixels per second (real-world, do not change)
const TURN_RATE_RPS       = 1.65;            // radians per second (real-world, do not change)

const PLAYER_SPEED        = PLAYER_SPEED_PPS / TICK_RATE;   // 1.25 px/tick  at 60 TPS
const TURN_RATE           = TURN_RATE_RPS    / TICK_RATE;   // 0.0275 rad/tick at 60 TPS
const PLAYER_RADIUS       = 3;               // collision radius (pixels) — unchanged

// ─── Trail ────────────────────────────────────────────────────────────────────
//
// Gap timing is defined in seconds and converted to ticks automatically.
//   Gap opens every GAP_INTERVAL_S seconds, stays open for GAP_DURATION_S seconds.

const GAP_INTERVAL_S      = 6;              // seconds between gap windows
const GAP_DURATION_S      = 0.4;            // seconds each gap stays open

const TRAIL_GAP_INTERVAL  = Math.round(GAP_INTERVAL_S * TICK_RATE);  // 360 ticks at 60 TPS
const TRAIL_GAP_DURATION  = Math.round(GAP_DURATION_S * TICK_RATE);  // 24 ticks  at 60 TPS

// ─── Room ─────────────────────────────────────────────────────────────────────

const MIN_PLAYERS         = 2;
const MAX_PLAYERS         = 6;

// ─── Multi-round ──────────────────────────────────────────────────────────────

const VALID_ROUNDS             = [1, 3, 5, 7, 9];
const DEFAULT_ROUNDS           = 1;
const BETWEEN_ROUNDS_DELAY_MS  = 10000; // 10 second countdown between rounds

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
  SPAWN_MARGIN,
  PLAYER_COLORS,
};
