# Curve Fever — Authoritative Game Server

Authoritative multiplayer game server for a classic Curve Fever-style game, built for the **Emblem / GameHub** platform.
Built with **Node.js**, **Express**, and **Socket.io**. Ready for **Railway** deployment.

Curve Fever is one of (currently) two games on GameHub — the other being **Bomberman** (`bomberman-server`, a separate repo/Railway service). Both game servers are independent and gameplay-only; wallets, payments, friends/chat, lobbies, treasury, payouts, and match history all live in the shared **Emblem** backend, which this server talks to via `services/BackendClient.js`.

---

## Architecture

```
src/
├── index.js                  # Express + Socket.io bootstrap
├── game/
│   ├── constants.js          # All tuneable game values
│   ├── GameLoop.js           # Authoritative 60-tick game loop (per round)
│   ├── ArenaManager.js       # Shrinking-arena phase cycle (safe/warning/shrink)
│   ├── PowerUpManager.js     # Power-up spawning, collection, active effects
│   ├── collision.js          # Wall & trail collision detection
│   └── spawn.js              # Safe player spawn positions
├── rooms/
│   ├── Room.js               # Lobby + multi-round match lifecycle per room
│   ├── RoomManager.js        # Creates/tracks all rooms
│   └── socketHandlers.js     # Socket event wiring
└── services/
    └── BackendClient.js      # Calls into the shared Emblem backend (match registration, payouts)
```

The server is **fully authoritative**:
- Client sends only `direction: 'left' | 'right' | 'neutral'`
- Server calculates position, angle, trail, collisions, power-ups, and round/match results
- Server determines the winner and reports it to Emblem for payout — no client input is trusted

---

## Quick Start

```bash
npm install
cp .env.example .env        # edit FRONTEND_URL and the Emblem backend vars below
npm start                   # or: npm run dev
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `FRONTEND_URL` | yes | Your Emblem Build URL, for CORS (e.g. `https://emblem-build.vercel.app`) |
| `PORT` | no | Injected automatically by Railway — do **not** set it manually |
| `BACKEND_URL` | yes | Base URL of the shared Emblem backend (match registration / payouts) |
| `SERVER_SECRET` | yes | Shared secret used to authenticate this game server to Emblem |
| `RAILWAY_INTERNAL_TOKEN` | yes | Token required for the `/finish` (payout) call to be accepted |

Without the three Emblem-related variables set, the server still runs and plays games fine, but match registration/payout calls to Emblem will be skipped or rejected — set them in Railway's **Variables** tab for production use.

---

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Set the environment variables above in the Railway **Variables** tab
4. Railway picks up `railway.toml` and runs `npm start`

Health check endpoint: `GET /` → `Curve server running`

---

## Testing

This repo includes end-to-end test suites that spin up the real server as a
child process, drive it with real `socket.io-client` connections, and assert
on the actual emitted events — no mocks of the game logic itself.

```bash
npm test
```

Runs, in order:
- `test/e2e.js` — lobby → ready → countdown → round → movement → self-trail
  collision → round end (covers the simultaneous-draw path)
- `test/e2e-rematch.js` — a round with a clear winner → `matchEnded` →
  `playAgain` → `rematchLobbyCreated`/`rematchJoined` → rematch-eligibility
  rejection of an outside wallet → `exitMatch`
- `test/powerup.test.js` — `PowerUpManager` spawning, max-on-map enforcement,
  collection, Shield-as-counter semantics, category exclusivity (Nitro vs
  Speed Boost), Ghost, and both map and player-effect expiry
- `test/e2e-invite.js` — `sendInvite`/`acceptInvite`/`declineInvite` and their
  guard rails (self-invite, offline target, missing room, username lookup)
- `test/e2e-multiround.js` — `setRounds` (host-only, validated), and a full
  BO3 match across two rounds with automatic round-to-round transition

Each suite prints a pass/fail line per assertion and exits non-zero if
anything fails. No `BACKEND_URL`/`SERVER_SECRET` is needed to run them — the
Emblem backend calls are designed to no-op (with a warning log) when those
env vars aren't set, which is exactly what the test runs exercise.

---

## Match Flow

```
Lobby
  ↓
Players ready
  ↓
Countdown (gameStarting → gameStarted)
  ↓
Round starts (roundStarted)
  ↓
Players eliminate each other via trail/wall collisions
  ↓
One player survives → roundEnded
  ↓
Repeat until a player reaches winsRequired (Bo1/Bo3/Bo5/Bo7/Bo9)
  ↓
matchEnded → Emblem payout flow (winnerWallet, 95% winner / 5% platform)
```

Round format is configurable per room (`setRounds`) from `VALID_ROUNDS = [1, 3, 5, 7, 9]`; `winsRequired` is `Math.ceil(rounds / 2)`.

---

## Socket.io Events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `createRoom` | `{ wallet, username, rounds, entryFee }` | Create a new lobby room |
| `joinRoom` | `{ roomId, wallet, username }` | Join an existing room |
| `setReady` | `{ ready: boolean }` | Toggle ready state in lobby |
| `setRounds` | `{ rounds }` | Host changes the Bo-N format (lobby only) |
| `startGame` | _(none)_ | Host starts the game (begins the pre-game countdown) |
| `playerInput` | `{ direction: 'left'\|'right'\|'neutral' }` | Steering input (send every frame) |
| `playAgain` | `{ wallet }` | Join/create a rematch lobby after `matchEnded` |
| `exitMatch` | _(none)_ | Leave the room |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `lobbyState` | see below | Full lobby snapshot, broadcast on any roster/format change |
| `gameStarting` | `{ roomId, gameStartAt, countdownSeconds, players[], scoreboard[] }` | Pre-game countdown begins |
| `gameStarted` | `{ roomId, rounds, winsRequired, scoreboard[], players[] }` | Match begins (round 1 about to start) |
| `roundStarted` | `{ roomId, currentRound, rounds, winsRequired, scoreboard[] }` | A new round's `GameLoop` has started |
| `gameState` | see below | 20× per second during gameplay |
| `playerDied` | `{ socketId, wallet, reason }` | A player died this round |
| `powerUpsUpdate` | `{ powerUps[] }` | Power-ups currently on the map changed |
| `powerUpCollected` | `{ socketId, playerWallet, playerUsername, type, duration }` | A player picked up a power-up |
| `powerUpExpired` | `{ socketId, playerWallet, type }` | A timed power-up effect wore off |
| `powerUpUsed` | `{ socketId, playerWallet, type }` | A power-up effect was actively triggered |
| `scoreboardUpdate` | `{ scoreboard[] }` | Scoreboard changed (death, power-up, etc.) |
| `roundEnded` | `{ roomId, roundWinnerWallet, roundWinnerId, draw, scoreboard[], currentRound, rounds, winsRequired, matchOver, nextRoundStartsAt, countdownSeconds }` | A round concluded |
| `matchEnded` | `{ roomId, winnerWallet, winnerId, draw, scoreboard[], totalRounds, rounds }` | Match result (authoritative) — triggers the Emblem payout call |
| `rematchLobbyCreated` | `{ roomId, lobbyState }` | First player started a rematch lobby |
| `rematchJoined` | `{ roomId, lobbyState }` | You joined an existing rematch lobby |
| `errorMessage` | `{ message }` | Error feedback to client |

---

## lobbyState shape

```jsonc
{
  "roomId": "A3F2B1C4",
  "hostId": "<socketId>",
  "state": "lobby",              // "lobby" | "starting" | "playing" | "between_rounds" | "ended"
  "entryFee": 1,
  "matchId": "A3F2B1C4",
  "rounds": 3,
  "winsRequired": 2,
  "currentRound": 0,
  "gameStartAt": null,
  "countdownSeconds": null,
  "scoreboard": [
    { "wallet": "0x...", "username": "...", "color": "#FF4D4D",
      "wins": 0, "alive": true, "activePowerUp": null,
      "lengthMultiplier": 1.0, "speedMultiplier": 1.0,
      "shieldCount": 0, "eliminations": 0, "rank": 1 }
  ],
  "players": [
    { "socketId": "...", "wallet": "0x...", "username": "...", "ready": false, "color": "#FF4D4D" }
  ]
}
```

`lengthMultiplier` is kept at a constant `1.0` for frontend backward compatibility — classic permanent-trail mode has no body-length mechanic to grow, so this field is never collision- or render-relevant. Eliminations grant a small permanent **speed** bonus instead (capped at 1.25×), not a length bonus.

## gameState shape (emitted 20×/sec; physics simulated at 60 ticks/sec)

```jsonc
{
  "tick": 142,
  "players": [
    { "id": "...", "wallet": "0x...", "color": "#FF4D4D",
      "x": 312.40, "y": 201.80, "angle": 1.5708, "alive": true,
      "lengthMultiplier": 1.0,
      "trailPoints": [ [310.2, 199.5, 3], [311.0, 200.1, 3] ],
      "bodyPoints":  [ [310.2, 199.5, 3], [311.0, 200.1, 3] ],
      "activePowerups": [ { "type": "speed_boost", "expiresAt": 1750000000000 } ],
      "shieldCount": 0 }
  ],
  "powerUps": [ { "id": "...", "type": "shield", "x": 400, "y": 300 } ],
  "arena": { "x": 0, "y": 0, "width": 1400, "height": 1050, "phase": "safe" },
  "scoreboard": [ /* same shape as lobbyState.scoreboard */ ]
}
```

The trail is **permanent for the round** — it persists for the entire round and is never trimmed by length or age; it only resets when a new round starts. `trailPoints` and `bodyPoints` carry identical data (`[x, y, r]` triples); `bodyPoints` is kept purely as a backward-compatible alias from the earlier fixed-length-body version of this game, for any frontend code still reading that field name. Because a permanent trail can grow large over a long round, the broadcast trail is **decimated** (capped at `TRAIL_POINT_MAX_SENT` points per player) — the server always collides against the full, untrimmed trail internally; only what's sent over the wire is sampled down, evenly across the trail's full length so the client always sees its whole shape.

---

## Game Constants (src/game/constants.js)

| Constant | Default | Description |
|---|---|---|
| `ARENA_WIDTH` / `ARENA_HEIGHT` | 1400 / 1050 | Starting arena size in px (4:3-ish, widened to keep the early game open now that trails are permanent) |
| `ARENA_MIN_WIDTH` / `ARENA_MIN_HEIGHT` | 580 / 440 | Arena never shrinks smaller than this |
| `ARENA_SHRINK_RATIO` | 0.85 | Each shrink cycle keeps 85% of width and height |
| `ARENA_FIRST_SHRINK_AFTER_MS` | 30000 | Delay before the first shrink cycle begins |
| `ARENA_SAFE_MS` / `ARENA_WARNING_MS` / `ARENA_SHRINK_MS` | 30000 / 5000 / 10000 | Phase durations in the shrink cycle |
| `TICK_RATE` | 60 | Physics ticks per second |
| `PLAYER_SPEED_PPS` | 75 | Player speed in px/sec |
| `TURN_RATE_RPS` | 1.65 | Steering rate in radians/sec |
| `PLAYER_RADIUS` | 3 px | Collision radius |
| `TRAIL_SELF_SKIP_POINTS` | 8 | Most-recent own-trail points excluded from self-collision |
| `TRAIL_POINT_MAX_SENT` | 220 | Hard cap on trail points sent per player per broadcast |
| `MIN_PLAYERS` / `MAX_PLAYERS` | 2 / 6 | Players per room |
| `VALID_ROUNDS` | [1, 3, 5, 7, 9] | Selectable Bo-N match formats |
| `PRE_GAME_COUNTDOWN_MS` | 5000 | Synchronized countdown before `gameStarted` |
| `BETWEEN_ROUNDS_DELAY_MS` | 10000 | Delay between rounds in a multi-round match |
| `POST_MATCH_GRACE_MS` | 60000 | How long a room stays alive after `matchEnded`, for rematch |
| `SHIELD_MAX_STACK` | 3 | Max simultaneous shields a player can hold |
| `GROWTH_SPEED_PER_ELIMINATION` / `GROWTH_MAX_SPEED` | 0.05 / 1.25 | Permanent speed bonus per kill, capped |

---

## Power-ups

| Type | Effect | Duration |
|---|---|---|
| `ghost` | Pass through trails temporarily | 2s |
| `nitro` | Large speed burst (+50%) | 2s |
| `speed_boost` | Moderate speed buff (+15%) | 8s |
| `shield` | Blocks one trail/wall collision; stacks up to `SHIELD_MAX_STACK` | counter, not timed |
| `fat_trail` | Widens this player's new trail segments | 6s |
| `tiny_trail` | Narrows this player's new trail segments | 6s |

All power-ups are server-authoritative — spawn timing/position, collection, and effect application all happen in `PowerUpManager`/`GameLoop`; the client only renders what it's told.

---

## Frontend Integration Tips

```js
import { io } from 'socket.io-client';

const socket = io('https://your-railway-url.railway.app');

// Create room
socket.emit('createRoom', { wallet: '0xYourWallet', username: 'Player1', rounds: 3, entryFee: 1 });
socket.on('lobbyState', (lobbyState) => { /* ... */ });

// Send input — call this in your game loop (requestAnimationFrame)
function gameLoop() {
  const dir = getInput(); // 'left' | 'right' | 'neutral'
  socket.emit('playerInput', { direction: dir });
  requestAnimationFrame(gameLoop);
}

// Render game state
socket.on('gameState', ({ tick, players, powerUps, arena }) => {
  render(players, powerUps, arena);
});

socket.on('roundEnded', ({ roundWinnerWallet, matchOver, draw }) => {
  console.log(draw ? 'Round draw!' : `Round winner: ${roundWinnerWallet}`, { matchOver });
});

socket.on('matchEnded', ({ winnerWallet, draw }) => {
  console.log(draw ? 'Match draw!' : `Match winner: ${winnerWallet}`);
});
```
