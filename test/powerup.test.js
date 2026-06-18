'use strict';

/**
 * Unit test for PowerUpManager — exercised directly (no socket/server
 * involved) so we can bypass the real 8-15s spawn-interval timer and test
 * spawn/collect/effect logic deterministically and fast.
 */

const { PowerUpManager } = require('../src/game/PowerUpManager');
const { ArenaManager } = require('../src/game/ArenaManager');
const {
  POWERUP_TYPES,
  SHIELD_MAX_STACK,
  NITRO_SPEED_MULTIPLIER,
  SPEED_BOOST_MULTIPLIER,
  FAT_TRAIL_RADIUS_MULTIPLIER,
  TINY_TRAIL_RADIUS_MULTIPLIER,
  PLAYER_RADIUS,
} = require('../src/game/constants');

const checks = [];
function check(label, cond) {
  checks.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
}

function makeArena() {
  const arena = new ArenaManager({});
  arena.start();
  return arena;
}

function makePlayers(entries) {
  // entries: [[id, x, y, alive]]
  const map = new Map();
  for (const [id, x, y, alive = true] of entries) {
    map.set(id, { id, x, y, alive });
  }
  return map;
}

async function main() {
  // ── 1. Spawning ──────────────────────────────────────────────────────
  {
    const events = { collected: [], expired: [], used: [], mapUpdates: [] };
    const arena = makeArena();
    const pum = new PowerUpManager({
      onPowerUpsUpdate:   (pus) => events.mapUpdates.push(pus),
      onPowerUpCollected: (id, type, dur) => events.collected.push({ id, type, dur }),
      onPowerUpExpired:   (id, type) => events.expired.push({ id, type }),
      onPowerUpUsed:      (id, type) => events.used.push({ id, type }),
      arena,
      growth: new Map(),
    });

    pum.start();
    const players = makePlayers([['p1', 700, 525]]); // center of default 1400x1050 arena
    pum._currentPlayers = players;

    // Force an immediate spawn attempt, bypassing the random 8-15s timer.
    pum._trySpawn();

    const mapPUs = pum.getMapPowerUps();
    check('A power-up spawned on demand', mapPUs.length === 1);
    check('Spawned power-up has a valid type', Object.values(POWERUP_TYPES).includes(mapPUs[0]?.type));
    check('Spawned power-up is within arena bounds', mapPUs[0]
      && mapPUs[0].x >= 0 && mapPUs[0].x <= 1400 && mapPUs[0].y >= 0 && mapPUs[0].y <= 1050);
    check('onPowerUpsUpdate fired on spawn', events.mapUpdates.length >= 1);

    pum.stop();
  }

  // ── 2. Max-on-map enforcement ────────────────────────────────────────
  {
    const arena = makeArena();
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {},
      onPowerUpCollected: () => {},
      onPowerUpExpired: () => {},
      onPowerUpUsed: () => {},
      arena,
      growth: new Map(),
    });
    pum.start();
    pum._currentPlayers = makePlayers([['p1', -9999, -9999]]); // out of the way
    for (let i = 0; i < 5; i++) pum._trySpawn();
    check('Map power-ups never exceed POWERUP_MAX_ON_MAP', pum.getMapPowerUps().length <= 3);
    pum.stop();
  }

  // ── 3. Collection via tick() proximity check ─────────────────────────
  {
    const events = { collected: [] };
    const arena = makeArena();
    const growth = new Map([['p1', { lengthMultiplier: 1.0, speedMultiplier: 1.0, shieldCount: 0, eliminations: 0 }]]);
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {},
      onPowerUpCollected: (id, type, dur) => events.collected.push({ id, type, dur }),
      onPowerUpExpired: () => {},
      onPowerUpUsed: () => {},
      arena,
      growth,
    });
    pum.start();

    // Manually inject a known power-up type at a known position so the test
    // doesn't depend on the weighted-random roll.
    pum._mapPowerUps.set('test-nitro', {
      id: 'test-nitro', type: POWERUP_TYPES.NITRO, x: 500, y: 500,
      spawnedAt: Date.now(), expiresAt: Date.now() + 15_000,
    });

    const players = makePlayers([['p1', 500, 500]]); // standing right on top of it
    pum.tick(players);

    check('Power-up collected when player head is within collect radius', events.collected.length === 1);
    check('Collected power-up type is nitro', events.collected[0]?.type === POWERUP_TYPES.NITRO);
    check('Power-up removed from map after collection', pum.getMapPowerUps().length === 0);
    check('Speed multiplier reflects Nitro while active', pum.getSpeedMultiplier('p1') === NITRO_SPEED_MULTIPLIER);

    pum.stop();
  }

  // ── 4. Shield is a growth counter, not a timed effect ─────────────────
  {
    const events = { collected: [] };
    const arena = makeArena();
    const growth = new Map([['p1', { lengthMultiplier: 1.0, speedMultiplier: 1.0, shieldCount: 0, eliminations: 0 }]]);
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {},
      onPowerUpCollected: (id, type, dur) => events.collected.push({ id, type, dur }),
      onPowerUpExpired: () => {},
      onPowerUpUsed: () => {},
      arena,
      growth,
    });
    pum.start();
    pum._mapPowerUps.set('test-shield', {
      id: 'test-shield', type: POWERUP_TYPES.SHIELD, x: 300, y: 300,
      spawnedAt: Date.now(), expiresAt: Date.now() + 15_000,
    });
    const players = makePlayers([['p1', 300, 300]]);
    pum.tick(players);

    check('Shield collection reported with null duration', events.collected[0]?.dur === null);
    check('Shield does NOT appear in active timed power-ups list', pum.getActivePowerUpsArray('p1').length === 0);
    // GameLoop is the one that actually increments growth.shieldCount on
    // SHIELD collection (see GameLoop._onPowerUpCollectedInternal) — PUM
    // itself only reports the collection event; verify that division of
    // responsibility hasn't silently changed.
    check('PowerUpManager itself does not mutate shieldCount (GameLoop does)', growth.get('p1').shieldCount === 0);

    pum.stop();
  }

  // ── 5. Stacking cap is enforced by GameLoop, not PUM — sanity check the
  //    constant GameLoop relies on is still exported correctly ──────────
  check('SHIELD_MAX_STACK constant is 3', SHIELD_MAX_STACK === 3);

  // ── 6. Category exclusivity: Nitro replaces Speed Boost (same "speed"
  //    category) but Fat Trail (different category) can coexist ─────────
  {
    const events = { expired: [] };
    const arena = makeArena();
    const growth = new Map([['p1', { lengthMultiplier: 1.0, speedMultiplier: 1.0, shieldCount: 0, eliminations: 0 }]]);
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {},
      onPowerUpCollected: () => {},
      onPowerUpExpired: (id, type) => events.expired.push({ id, type }),
      onPowerUpUsed: () => {},
      arena,
      growth,
    });
    pum.start();

    pum._mapPowerUps.set('pu-speed', { id: 'pu-speed', type: POWERUP_TYPES.SPEED_BOOST, x: 100, y: 100, spawnedAt: Date.now(), expiresAt: Date.now() + 15000 });
    pum.tick(makePlayers([['p1', 100, 100]]));
    check('Speed Boost collected first', pum.getActivePowerUpsArray('p1').some(p => p.type === POWERUP_TYPES.SPEED_BOOST));

    pum._mapPowerUps.set('pu-nitro', { id: 'pu-nitro', type: POWERUP_TYPES.NITRO, x: 200, y: 200, spawnedAt: Date.now(), expiresAt: Date.now() + 15000 });
    pum.tick(makePlayers([['p1', 200, 200]]));
    const activeAfterNitro = pum.getActivePowerUpsArray('p1').map(p => p.type);
    check('Nitro replaces Speed Boost (same speed category, exclusive)',
      activeAfterNitro.includes(POWERUP_TYPES.NITRO) && !activeAfterNitro.includes(POWERUP_TYPES.SPEED_BOOST));
    check('Speed Boost expiry was emitted when displaced by Nitro',
      events.expired.some(e => e.type === POWERUP_TYPES.SPEED_BOOST));

    pum._mapPowerUps.set('pu-fat', { id: 'pu-fat', type: POWERUP_TYPES.FAT_TRAIL, x: 300, y: 300, spawnedAt: Date.now(), expiresAt: Date.now() + 15000 });
    pum.tick(makePlayers([['p1', 300, 300]]));
    const activeAfterFat = pum.getActivePowerUpsArray('p1').map(p => p.type);
    check('Fat Trail coexists with Nitro (different categories)',
      activeAfterFat.includes(POWERUP_TYPES.NITRO) && activeAfterFat.includes(POWERUP_TYPES.FAT_TRAIL));
    check('getTrailRadius reflects Fat Trail multiplier',
      pum.getTrailRadius('p1', PLAYER_RADIUS) === PLAYER_RADIUS * FAT_TRAIL_RADIUS_MULTIPLIER);

    pum.stop();
  }

  // ── 7. Ghost flag ──────────────────────────────────────────────────────
  {
    const arena = makeArena();
    const growth = new Map([['p1', { lengthMultiplier: 1.0, speedMultiplier: 1.0, shieldCount: 0, eliminations: 0 }]]);
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {}, onPowerUpCollected: () => {}, onPowerUpExpired: () => {}, onPowerUpUsed: () => {},
      arena, growth,
    });
    pum.start();
    check('hasGhost false before collecting', pum.hasGhost('p1') === false);
    pum._mapPowerUps.set('pu-ghost', { id: 'pu-ghost', type: POWERUP_TYPES.GHOST, x: 50, y: 50, spawnedAt: Date.now(), expiresAt: Date.now() + 15000 });
    pum.tick(makePlayers([['p1', 50, 50]]));
    check('hasGhost true after collecting Ghost', pum.hasGhost('p1') === true);
    pum.stop();
  }

  // ── 8. Power-up expiry (uncollected, on the map) ───────────────────────
  {
    const events = { mapUpdates: [] };
    const arena = makeArena();
    const pum = new PowerUpManager({
      onPowerUpsUpdate: (pus) => events.mapUpdates.push(pus),
      onPowerUpCollected: () => {}, onPowerUpExpired: () => {}, onPowerUpUsed: () => {},
      arena, growth: new Map(),
    });
    pum.start();
    pum._mapPowerUps.set('pu-expired', {
      id: 'pu-expired', type: POWERUP_TYPES.GHOST, x: 1, y: 1,
      spawnedAt: Date.now() - 20000, expiresAt: Date.now() - 1, // already expired
    });
    pum.tick(makePlayers([['p1', 9999, 9999]])); // far away, won't collect
    check('Expired uncollected power-up removed from map', pum.getMapPowerUps().length === 0);
    pum.stop();
  }

  // ── 9. Timed effect expiry ───────────────────────────────────────────
  {
    const events = { expired: [] };
    const arena = makeArena();
    const growth = new Map([['p1', { lengthMultiplier: 1.0, speedMultiplier: 1.0, shieldCount: 0, eliminations: 0 }]]);
    const pum = new PowerUpManager({
      onPowerUpsUpdate: () => {}, onPowerUpCollected: () => {},
      onPowerUpExpired: (id, type) => events.expired.push({ id, type }),
      onPowerUpUsed: () => {},
      arena, growth,
    });
    pum.start();
    pum._mapPowerUps.set('pu-nitro2', { id: 'pu-nitro2', type: POWERUP_TYPES.NITRO, x: 10, y: 10, spawnedAt: Date.now(), expiresAt: Date.now() + 15000 });
    pum.tick(makePlayers([['p1', 10, 10]]));
    check('Nitro active immediately after collection', pum.getSpeedMultiplier('p1') === NITRO_SPEED_MULTIPLIER);

    // Manually force the active entry's expiresAt into the past and tick again.
    const active = pum._playerActive.get('p1');
    for (const entry of active.values()) entry.expiresAt = Date.now() - 1;
    pum.tick(makePlayers([['p1', 10, 10]]));

    check('Nitro effect expired after its duration', pum.getSpeedMultiplier('p1') === 1.0);
    check('onPowerUpExpired fired for Nitro', events.expired.some(e => e.type === POWERUP_TYPES.NITRO));
    pum.stop();
  }

  const failed = checks.filter(c => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(' -', f.label);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
}

main().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
