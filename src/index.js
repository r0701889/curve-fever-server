const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const { registerSocketHandlers } = require('./rooms/socketHandlers');
const { RoomManager } = require('./rooms/RoomManager');
const { UserRegistry } = require('./rooms/UserRegistry');
const { PresenceService } = require('./presence/PresenceService');

// ─── App Bootstrap ────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://emblem-build.vercel.app';

// ─── CORS ─────────────────────────────────────────────────────────────────────

const corsOptions = {
  origin: [
    FRONTEND_URL,
    // Allow all localhost variants in development
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  ],
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.send('Curve server running');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Socket.io Setup ──────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
});

// ─── Shared stores ────────────────────────────────────────────────────────────
//
// Constructed here (the single place) so they're easy to swap for
// Redis-backed equivalents later without touching socketHandlers.js or any
// other call site — see the "NOTE on async" comments in RoomManager and
// UserRegistry for why every public method on these is async even though
// the current implementation is plain in-memory.

const manager         = new RoomManager(io);
const registry         = new UserRegistry();
const presenceService = new PresenceService();

registerSocketHandlers(io, { manager, registry, presenceService });

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] Curve Fever server listening on port ${PORT}`);
  console.log(`[Server] CORS enabled for: ${FRONTEND_URL}`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
