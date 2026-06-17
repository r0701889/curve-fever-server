// ─── Arena ────────────────────────────────────────────────────────────────────
//
// Starting arena: 1400×1050 (4:3). Bumped up from 1200×900 as part of the
// permanent-trail revert — see the match-length note below for why.
// The arena SHRINKS over time to force encounters.
//
// Phase cycle (per round):
//   safe (30s)  →  warning (5s)  →  shrinking (10s)  →  safe (30s) → ...
//
// All bounds checks (walls, power-up spawn, kill outside) use the ArenaManager's
// `current` rectangle. The "next" rectangle is shown to the client during the
// warning phase so players can see where the border is moving.
//
// ── Match-length note (permanent trails vs the old fixed-length body) ────────
// With a fixed-length snake body, the lethal surface on the map was capped at
// ~6 players × ~180px of body — small and constant for the whole match. With
// permanent trails, lethal surface only grows: at PLAYER_SPEED_PPS=75 px/s and
// up to MAX_PLAYERS=6 players moving continuously, the arena accumulates trail
// at up to ~450 px of new lethal length per second. In the OLD 1200×900 arena
// (1,080,000 px²) that fills a meaningful fraction of the open space well
// before the first scheduled shrink (ARENA_FIRST_SHRINK_AFTER_MS=30s), which
// would make rounds end abruptly via mutual trail-blocking rather than via
// genuine head-to-head plays. Widening to 1400×1050 (1,470,000 px², +36% area)
// keeps the first 30s safe phase meaningfully open while changing nothing
// about the shrink cadence/ratio itself (left exactly as instructed) — the
// shrink cycle still does its job of forcing encounters later in the round.
// This was judged sufficient without adding any new mechanics (no spawn
// delay, no gap/dash mechanic — none of that existed before and the prompt
// said not to add complexity unless necessary).
const ARENA_WIDTH  = 1400;
const ARENA_HEIGHT = 1050;

const ARENA_MIN_WIDTH           = 580;
const ARENA_MIN_HEIGHT          = 440;
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

// ─── Trail (classic Curve Fever — permanent, lethal) ───────────────────────────
//
// REVERTED from the fixed-length snake-body system back to classic Curve
// Fever rules. Each player leaves a trail behind them that PERSISTS for the
// entire round — it is never trimmed by length or age. The only thing that
// clears a trail is a new round starting (GameLoop is re-constructed fresh
// per round by Room._startRound(), which re-seeds every player's trail to
// a single point at their new spawn).
//
// this._trails: Map<socketId, Array<{x,y,r}>>
//   index 0     = first point laid down this round (at spawn)
//   last index  = most recent point (just behind the current head)
//   Grows by one point almost every tick a player is alive and moving.
//   NEVER shrinks during the round — no trimming, no expiry, no fixed
//   "bodyLengthPx" target. This is the entire gameplay reversion: the
//   lethal zone is everywhere the player has ever been this round, not a
//   sliding window behind the head.
//
// Self-collision: the points immediately behind the head are always within
// head-radius of the head itself (continuous movement) and must be skipped,
// or a player would die on their own most recent trail point every tick.
// This window is fixed-size and independent of how long the trail has grown.
const TRAIL_SELF_SKIP_POINTS = 8;

// Network payload: gameState.players[].trailPoints (bodyPoints is kept as an
// identical alias for frontend backward compatibility — see GameLoop
// _buildSnapshot) is decimated for transmission. The server simulates and
// collides against the FULL, untrimmed trail every tick — only the
// broadcast is sampled down to keep payload size reasonable.
//
// Because the trail now grows for the whole round instead of being capped
// at a fixed ~300px window, a flat fixed-stride sample (the old approach)
// would either truncate long trails or balloon payload size. Instead the
// stride is computed per player, per broadcast, from the trail's current
// length so that: short trails are sent in near-full detail, and long
// trails are sent evenly decimated across their FULL length (spawn to head)
// rather than cut off — the client always sees the whole shape, just
// coarser as a round goes on. TRAIL_POINT_MAX_SENT is the hard cap that
// stride is computed against.
const TRAIL_POINT_MAX_SENT = 220; // hard cap on points sent per player per broadcast

// Trail points are sent as compact [x, y, r] arrays instead of {x,y,r}
// objects (~16 bytes vs ~28 bytes per point). At TRAIL_POINT_MAX_SENT=220
// and MAX_PLAYERS=6, worst case is ≈ 220 * 16 * 6 ≈ 21KB per gameState
// broadcast at the 20Hz send rate — acceptable for a 6-player room, and
// numeric arrays compress well over the websocket transport's deflate.

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

// Power-up types — reviewed for classic permanent-trail gameplay.
//
//  GHOST       — pass through trails temporarily (2s)
//  NITRO       — large speed burst (+50%, 2s)
//  SHIELD      — increments shieldCount, consumed on next trail hit (stackable)
//  SPEED_BOOST — moderate speed buff (+15%, 8s)
//  FAT_TRAIL   — widens this player's NEW trail segments temporarily (6s)
//  TINY_TRAIL  — narrows this player's NEW trail segments temporarily (6s)
//
// REMOVED: LENGTH_BOOST. It existed to grow the old fixed-length snake
// body — with permanent trails there's no "body length" left to grow, so
// the power-up no longer has a meaningful effect and has been dropped
// rather than repurposed (Fat Trail already covers "temporary trail-width
// effect", so adding a second one would be redundant). Its spawn weight
// (15) has been redistributed across the remaining types below.
const POWERUP_TYPES = {
  GHOST:        'ghost',
  NITRO:        'nitro',
  SHIELD:       'shield',
  SPEED_BOOST:  'speed_boost',
  FAT_TRAIL:    'fat_trail',
  TINY_TRAIL:   'tiny_trail',
};

// Duration in ms for each type.
//   null      = instant / counter-style (Shield)
const POWERUP_DURATION_MS = {
  [POWERUP_TYPES.GHOST]:        2_000,
  [POWERUP_TYPES.NITRO]:        2_000,
  [POWERUP_TYPES.SPEED_BOOST]:  8_000,
  [POWERUP_TYPES.SHIELD]:       null,    // counter — stored in shieldCount
  [POWERUP_TYPES.FAT_TRAIL]:    6_000,
  [POWERUP_TYPES.TINY_TRAIL]:   6_000,
};

// Spawn weights (must sum to 100). LENGTH_BOOST's old weight (15) is folded
// into SHIELD (+8) and SPEED_BOOST (+7) — the two power-ups that most
// directly help survival in a permanent-trail arena, which is what
// LENGTH_BOOST indirectly did before (a longer body gave more elimination
// surface but also more growth reward).
const POWERUP_WEIGHTS = [
  { type: POWERUP_TYPES.GHOST,        weight: 15 },
  { type: POWERUP_TYPES.NITRO,        weight: 15 },
  { type: POWERUP_TYPES.SHIELD,       weight: 33 },
  { type: POWERUP_TYPES.SPEED_BOOST,  weight: 22 },
  { type: POWERUP_TYPES.FAT_TRAIL,    weight: 8  },
  { type: POWERUP_TYPES.TINY_TRAIL,   weight: 7  },
];

// Effect multipliers
const NITRO_SPEED_MULTIPLIER       = 1.50;  // +50% speed (2s burst)
const SPEED_BOOST_MULTIPLIER       = 1.15;  // +15% speed (8s)
const FAT_TRAIL_RADIUS_MULTIPLIER  = 1.50;
const TINY_TRAIL_RADIUS_MULTIPLIER = 0.50;

// Player-shield stacking
const SHIELD_MAX_STACK             = 3;     // max simultaneous shields a player can hold

// Growth (persistent across rounds within a match, reset on rematch).
// REVERTED: eliminations no longer grow body length (there is no body
// length to grow in classic mode) — they ONLY grant a small permanent
// speed bonus, which is a kept, classic-feeling kill-reward mechanic and
// requires no new code (GameLoop already separates length/speed growth;
// this just stops touching the length half). lengthMultiplier is kept in
// the growth record at a constant 1.0 purely so any frontend code reading
// scoreboard.lengthMultiplier doesn't break — it is never collision- or
// rendering-relevant and never changes.
const GROWTH_SPEED_PER_ELIMINATION = 0.05;  // +0.05 to speedMultiplier per kill
const GROWTH_MAX_SPEED             = 1.25;  // cap — never faster than 1.25×


// Power-up spawn — interval/limit/safety
const POWERUP_SPAWN_PLAYER_CLEARANCE = 150;  // px from any alive player's head
const POWERUP_SPAWN_WALL_MARGIN      = 50;   // px from current arena wall
const POWERUP_SPAWN_TRAIL_CLEARANCE  = 20;   // px from any current trail point

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
  // Trail (classic, permanent, lethal)
  TRAIL_SELF_SKIP_POINTS,
  TRAIL_POINT_MAX_SENT,
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
  SHIELD_MAX_STACK,
  POWERUP_SPAWN_WALL_MARGIN,
  POWERUP_SPAWN_TRAIL_CLEARANCE,
  POWERUP_SPAWN_PLAYER_CLEARANCE,
  // Growth (persistent across rounds within a match, reset on rematch) —
  // speed-only now; see comment above GROWTH_SPEED_PER_ELIMINATION.
  GROWTH_SPEED_PER_ELIMINATION,
  GROWTH_MAX_SPEED,
};

