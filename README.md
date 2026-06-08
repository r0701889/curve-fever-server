# Curve Fever — Authoritative Game Server

Authoritative multiplayer game server for a Curve Fever-style game.  
Built with **Node.js**, **Express**, and **Socket.io**. Ready for **Railway** deployment.

---

## Architecture

```
src/
├── index.js                  # Express + Socket.io bootstrap
├── game/
│   ├── constants.js          # All tuneable game values
│   ├── GameLoop.js           # Authoritative 30-tick game loop
│   ├── collision.js          # Wall & trail collision detection
│   └── spawn.js              # Safe player spawn positions
└── rooms/
    ├── Room.js               # Lobby + game lifecycle per room
    ├── RoomManager.js        # Creates/tracks all rooms
    └── socketHandlers.js     # Socket event wiring
```

The server is **fully authoritative**:
- Client sends only `direction: 'left' | 'right' | 'neutral'`
- Server calculates position, angle, trail, and all collisions
- Server determines the winner — no client input is trusted

---

## Quick Start

```bash
npm install
cp .env.example .env        # edit FRONTEND_URL
npm start                   # or: npm run dev
```

---

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Set environment variables in the Railway **Variables** tab:
   - `FRONTEND_URL` → your Emblem Build URL (e.g. `https://emblem-build.vercel.app`)
   - `PORT` is injected automatically by Railway — do **not** set it
4. Railway picks up `railway.toml` and runs `npm start`

Health check endpoint: `GET /` → `Curve server running`

---

## Socket.io Events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `createRoom` | `{ wallet }` | Create a new lobby room |
| `joinRoom` | `{ roomId, wallet }` | Join an existing room |
| `setReady` | `{ ready: boolean }` | Toggle ready state in lobby |
| `startGame` | _(none)_ | Host starts the game |
| `playerInput` | `{ direction: 'left'\|'right'\|'neutral' }` | Steering input (send every frame) |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `roomCreated` | `{ roomId, lobbyState }` | Confirms room creation to host |
| `roomJoined` | `{ roomId, lobbyState }` | Confirms join to the joining player |
| `lobbyState` | `{ roomId, hostId, state, players[] }` | Broadcast lobby update to all |
| `gameStarted` | `{ roomId, players[] }` | Game is beginning |
| `gameState` | `{ tick, players[], trails{} }` | 30× per second during gameplay |
| `playerDied` | `{ socketId, wallet, reason }` | A player has died |
| `matchEnded` | `{ roomId, winnerWallet, winnerId, draw }` | Match result (authoritative) |
| `errorMessage` | `{ message }` | Error feedback to client |

---

## lobbyState shape

```jsonc
{
  "roomId": "A3F2B1C4",
  "hostId": "<socketId>",
  "state": "lobby",          // "lobby" | "playing" | "ended"
  "players": [
    { "socketId": "...", "wallet": "0x...", "ready": false }
  ]
}
```

## gameState shape (emitted 30×/sec)

```jsonc
{
  "tick": 142,
  "players": [
    { "id": "...", "wallet": "0x...", "color": "#FF4D4D",
      "x": 312.40, "y": 201.80, "angle": 1.5708, "alive": true }
  ],
  "trails": {
    "<socketId>": [
      { "x": 310.2, "y": 199.5, "gap": false },
      ...
    ]
  }
}
```

The `trails` object contains the **last 4 points** added that tick.  
The client should maintain a full local trail map, appending new points each tick.  
`gap: true` points are passable (no collision).

---

## Game Constants (src/game/constants.js)

| Constant | Default | Description |
|---|---|---|
| `ARENA_WIDTH` | 800 | Arena width in px |
| `ARENA_HEIGHT` | 600 | Arena height in px |
| `PLAYER_SPEED` | 2.5 | px per tick |
| `TURN_RATE` | 0.055 rad | Steering per tick (~3.15°) |
| `PLAYER_RADIUS` | 3 px | Collision radius |
| `TRAIL_GAP_INTERVAL` | 180 ticks | Ticks between gap windows |
| `TRAIL_GAP_DURATION` | 12 ticks | Duration of each gap |
| `TICK_RATE` | 30 | Ticks per second |
| `MIN_PLAYERS` | 2 | Min to start |
| `MAX_PLAYERS` | 6 | Max per room |

---

## Frontend Integration Tips

```js
import { io } from 'socket.io-client';

const socket = io('https://your-railway-url.railway.app');

// Create room
socket.emit('createRoom', { wallet: '0xYourWallet' });
socket.on('roomCreated', ({ roomId, lobbyState }) => { /* ... */ });

// Send input — call this in your game loop (requestAnimationFrame)
function gameLoop() {
  const dir = getInput(); // 'left' | 'right' | 'neutral'
  socket.emit('playerInput', { direction: dir });
  requestAnimationFrame(gameLoop);
}

// Render game state
socket.on('gameState', ({ tick, players, trails }) => {
  // trails contains only the newest points — append to local trail store
  for (const [id, newPoints] of Object.entries(trails)) {
    localTrails[id] = (localTrails[id] ?? []).concat(newPoints);
  }
  render(players, localTrails);
});

socket.on('matchEnded', ({ winnerWallet, draw }) => {
  console.log(draw ? 'Draw!' : `Winner: ${winnerWallet}`);
});
```
