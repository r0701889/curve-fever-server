// ─── Arena ────────────────────────────────────────────────────────────────────
//
// Starting arena: 1200×900 (4:3, larger than the previous 800×600).
// The arena SHRINKS over time to force encounters.
//
// Phase cycle (per round):
//   safe (30s)  →  warning (5s)  →  shrinking (10s)  →  safe (30s) → ...
//
// All bounds checks (walls, power-up spawn, kill outside) use the ArenaManager's
// `current` rectangle. The "next" rectangle is shown to the client during the
// warning phase so players can see where the border is moving.

const ARENA_WIDTH  = 1200;
const ARENA_HEIGHT = 900;

const ARENA_MIN_WIDTH           = 500;
const ARENA_MIN_HEIGHT          = 375;
const ARENA_FIRST_SHRINK_AFTER_MS = 30_000;
const ARENA_WARNING_MS          = 5_000;
const ARENA_SHRINK_MS           = 10_000;
const ARENA_SAFE_MS             = 30_000;   // time spent in 'safe' between cycles
const ARENA_SHRINK_RATIO        = 0.85;     // each cycle keeps 85% width AND height
const ARENA_GRACE_MS            = 300;      // grace period before kill outside active border

// ─── Player Physics ───────────────────────────────────────────────────────────

const TICK_RATE           = 60;
const TICK_INTERVAL_MS    = 1000 / TICK_RATE;

const PLAYER_SPEED_PPS    = 75;
const TURN_RATE_RPS       = 1.65;

const PLAYER_SPEED        = PLAYER_SPEED_PPS / TICK_RATE;   // 1.25 px/tick
const TURN_RATE           = TURN_RATE_RPS    / TICK_RATE;   // 0.0275 rad/tick
const PLAYER_RADIUS       = 3;

// ─── Snake Body ───────────────────────────────────────────────────────────────
//
// Permanent trails are GONE. Each player is a fixed-length snake body:
// the head leads, bodyPoints follow, and the tail is continuously trimmed
// so the head-to-tail path distance stays close to bodyLengthPx.
//
// bodyLengthPx is derived from lengthMultiplier (the same growth value that
// drove trail-point radius before): effectiveBodyLengthPx =
//   BASE_BODY_LENGTH_PX * lengthMultiplier
//
// MAX_BODY_LENGTH_MULTIPLIER reuses GROWTH_MAX_LENGTH — body length and trail
// radius share the same growth cap (2.5x).

const BASE_BODY_LENGTH_PX = 120;   // starting head-to-tail length, in px

// Self-collision: the few points immediately behind the head are always
// within head-radius of the head itself (continuous movement) and must be
// skipped, regardless of bodyLengthPx. This is independent of growth.
const BODY_SELF_SKIP_POINTS = 8;

// Network payload: gameState.players[].bodyPoints is decimated for
// transmission — server simulates every tick internally, but only sends
// every Nth point, capped at a maximum count, to keep snapshots small even
// at max growth (2.5x * 120px / ~1.25px-per-tick ≈ 240 simulated points).
const BODY_POINT_SAMPLE_STRIDE = 4;   // send every 4th simulated point
const BODY_POINT_MAX_SENT      = 40;  // hard cap on points sent per player

// bodyPoints are sent as compact arrays [x, y, r] instead of {x,y,r} objects
// (~16 bytes vs ~28 bytes per point — ~43% smaller). At BODY_POINT_MAX_SENT=40
// and 8 players, worst case ≈ 40 * 16 * 8 ≈ 5.1KB for body data alone —
// comfortable for a 60Hz broadcast.

// ─── Room ─────────────────────────────────────────────────────────────────────

const MIN_PLAYERS         = 2;
const MAX_PLAYERS         = 6;

// ─── Multi-round ──────────────────────────────────────────────────────────────

const VALID_ROUNDS             = [1, 3, 5, 7, 9];
const DEFAULT_ROUNDS           = 1;
const BETWEEN_ROUNDS_DELAY_MS  = 10000;
const POST_MATCH_GRACE_MS      = 60_000; // keep room alive 60s after matchEnded for rematch
const PRE_GAME_COUNTDOWN_MS    = 5000;   // synchronized countdown before gameStarted

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
const POWERUP_SPAWN_MIN_MS    = 8_000;    // minimum delay between spawns
const POWERUP_SPAWN_MAX_MS    = 15_000;   // maximum delay between spawns
const POWERUP_MAX_ON_MAP      = 3;        // max simultaneous power-ups on map
const POWERUP_EXPIRE_MS       = 15_000;   // uncollected power-up lifetime
const POWERUP_COLLECT_RADIUS  = 14;       // px — head must be within this to collect

// Power-up types
//
//  GHOST       — pass through trails (2s)
//  NITRO       — large speed burst (+50%, 2s)
//  SHIELD      — increments shieldCount, consumed on next trail hit (stackable)
//  SPEED_BOOST — moderate speed buff (+15%, 8s)
//  LENGTH_BOOST — permanent +0.20 to lengthMultiplier (capped, persists across rounds)
//  FAT_TRAIL   — legacy, kept for backward compatibility
//  TINY_TRAIL  — legacy, kept for backward compatibility
const POWERUP_TYPES = {
  GHOST:        'ghost',
  NITRO:        'nitro',
  SHIELD:       'shield',
  SPEED_BOOST:  'speed_boost',
  LENGTH_BOOST: 'length_boost',
  FAT_TRAIL:    'fat_trail',
  TINY_TRAIL:   'tiny_trail',
};

// Duration in ms for each type.
//   null      = instant / counter-style (Shield, Length Boost)
const POWERUP_DURATION_MS = {
  [POWERUP_TYPES.GHOST]:        2_000,
  [POWERUP_TYPES.NITRO]:        2_000,
  [POWERUP_TYPES.SPEED_BOOST]:  8_000,
  [POWERUP_TYPES.SHIELD]:       null,    // counter — stored in shieldCount
  [POWERUP_TYPES.LENGTH_BOOST]: null,    // applied immediately to lengthMultiplier
  [POWERUP_TYPES.FAT_TRAIL]:    6_000,
  [POWERUP_TYPES.TINY_TRAIL]:   6_000,
};

// Spawn weights (must sum to 100)
const POWERUP_WEIGHTS = [
  { type: POWERUP_TYPES.GHOST,        weight: 15 },
  { type: POWERUP_TYPES.NITRO,        weight: 15 },
  { type: POWERUP_TYPES.SHIELD,       weight: 25 },
  { type: POWERUP_TYPES.SPEED_BOOST,  weight: 15 },
  { type: POWERUP_TYPES.LENGTH_BOOST, weight: 15 },
  { type: POWERUP_TYPES.FAT_TRAIL,    weight: 8  },
  { type: POWERUP_TYPES.TINY_TRAIL,   weight: 7  },
];

// Effect multipliers
const NITRO_SPEED_MULTIPLIER       = 1.50;  // +50% speed (2s burst)
const SPEED_BOOST_MULTIPLIER       = 1.15;  // +15% speed (8s)
const FAT_TRAIL_RADIUS_MULTIPLIER  = 1.50;
const TINY_TRAIL_RADIUS_MULTIPLIER = 0.50;
const LENGTH_BOOST_DELTA           = 0.20;  // +0.20 to lengthMultiplier per pickup

// Player-shield stacking
const SHIELD_MAX_STACK             = 3;     // max simultaneous shields a player can hold

// Growth (persistent across rounds, reset on rematch)
const GROWTH_PER_ELIMINATION       = 0.10;  // +0.10 to lengthMultiplier per kill
const GROWTH_SPEED_PER_ELIMINATION = 0.05;  // +0.05 to speedMultiplier per kill
const GROWTH_MAX_LENGTH            = 2.50;  // cap — never bigger than 2.5×
const GROWTH_MAX_SPEED             = 1.25;  // cap — never faster than 1.25×

// Explicit alias requested for the snake-body system — same cap as
// GROWTH_MAX_LENGTH (one number, two names for clarity at call sites).
const MAX_BODY_LENGTH_MULTIPLIER   = GROWTH_MAX_LENGTH;

// Power-up spawn — interval/limit/safety
const POWERUP_SPAWN_PLAYER_CLEARANCE = 150;  // px from any alive player's head
const POWERUP_SPAWN_WALL_MARGIN      = 50;   // px from current arena wall
const POWERUP_SPAWN_TRAIL_CLEARANCE  = 20;   // px from any current snake-body point

module.exports = {
  // Arena (starting dimensions and shrink cycle)
  ARENA_WIDTH,
  ARENA_HEIGHT,
  ARENA_MIN_WIDTH,
  ARENA_MIN_HEIGHT,
  ARENA_FIRST_SHRINK_AFTER_MS,
  ARENA_WARNING_MS,
  ARENA_SHRINK_MS,
  ARENA_SAFE_MS,
  ARENA_SHRINK_RATIO,
  ARENA_GRACE_MS,
  // Player physics
  PLAYER_SPEED,
  PLAYER_SPEED_PPS,
  TURN_RATE,
  TURN_RATE_RPS,
  PLAYER_RADIUS,
  // Snake body
  BASE_BODY_LENGTH_PX,
  BODY_SELF_SKIP_POINTS,
  BODY_POINT_SAMPLE_STRIDE,
  BODY_POINT_MAX_SENT,
  // Tick
  TICK_RATE,
  TICK_INTERVAL_MS,
  // Room
  MIN_PLAYERS,
  MAX_PLAYERS,
  // Multi-round
  VALID_ROUNDS,
  DEFAULT_ROUNDS,
  BETWEEN_ROUNDS_DELAY_MS,
  POST_MATCH_GRACE_MS,
  PRE_GAME_COUNTDOWN_MS,
  // Spawn
  SPAWN_MARGIN,
  // Colors
  PLAYER_COLORS,
  // Power-ups
  POWERUP_SPAWN_MIN_MS,
  POWERUP_SPAWN_MAX_MS,
  POWERUP_MAX_ON_MAP,
  POWERUP_EXPIRE_MS,
  POWERUP_COLLECT_RADIUS,
  POWERUP_TYPES,
  POWERUP_DURATION_MS,
  POWERUP_WEIGHTS,
  NITRO_SPEED_MULTIPLIER,
  SPEED_BOOST_MULTIPLIER,
  FAT_TRAIL_RADIUS_MULTIPLIER,
  TINY_TRAIL_RADIUS_MULTIPLIER,
  LENGTH_BOOST_DELTA,
  SHIELD_MAX_STACK,
  POWERUP_SPAWN_WALL_MARGIN,
  POWERUP_SPAWN_TRAIL_CLEARANCE,
  POWERUP_SPAWN_PLAYER_CLEARANCE,
  // Growth (persistent across rounds, reset on rematch)
  GROWTH_PER_ELIMINATION,
  GROWTH_SPEED_PER_ELIMINATION,
  GROWTH_MAX_LENGTH,
  GROWTH_MAX_SPEED,
  MAX_BODY_LENGTH_MULTIPLIER,
};
