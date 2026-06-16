'use strict';

const { VALID_ROUNDS, DEFAULT_ROUNDS, MAX_PLAYERS } = require('../game/constants');
const BackendClient = require('../services/BackendClient');

// Confirmed default for the new cross-app social invite push — see plan
// approval. Only affects the expiresAt field sent to the backend's /social
// layer; does NOT change anything about the existing in-game inviteReceived
// event below, and does NOT (yet) enforce expiry server-side on join —
// that would require touching joinRoom/acceptInvite, explicitly out of
// scope for this change.
const INVITE_EXPIRY_MS = 3 * 60 * 1000;

/**
 * ── Client → Server ───────────────────────────────────────────────────────────
 *
 *   registerUser   { wallet, username? }
 *                  Must be called once after connect before using invite
 *                  features. Also marks this wallet ONLINE in PresenceService.
 *
 *   createRoom     { wallet, username?, rounds?, entryFee? }
 *   joinRoom       { roomId, wallet, username? }
 *   setRounds      { rounds }                        host only, lobby only
 *   setReady       { ready }
 *   startGame      (no payload)                      host only
 *   playerInput    { direction }                     'left'|'right'|'neutral'
 *   playAgain      { roomId, wallet }                after matchEnded
 *   exitMatch      { roomId, wallet }                after matchEnded
 *
 *   sendInvite     { targetWallet?, targetUsername?, roomId,
 *                    fromWallet, fromUsername }
 *                  Exactly one of targetWallet/targetUsername required.
 *
 *   acceptInvite   { roomId, wallet, username? }
 *                  Same as joinRoom — joins the room.
 *
 *   declineInvite  { roomId, wallet, fromWallet }
 *                  Notifies the inviter that the invite was declined.
 *
 * ── Cheat-resistance contract — what the client is NEVER trusted to send ──────
 *
 *   The client has NO event for: position, speed, collision, winner,
 *   powerupCollected, or payout. Every one of those is computed and emitted
 *   exclusively by the server (GameLoop / Room / PowerUpManager / backend).
 *   playerInput only ever carries a direction enum ('left'|'right'|'neutral') —
 *   never a position or velocity. If a future event needs adding, this
 *   contract is the bar it must clear: does it let the client assert a fact
 *   about game state, or only express player INTENT for the server to
 *   validate? Only the latter is acceptable here.
 *
 * ── Server → Client ───────────────────────────────────────────────────────────
 *
 *   roomCreated          { roomId, lobbyState }
 *   roomJoined           { roomId, lobbyState }
 *   lobbyState           { roomId, hostId, state, entryFee, matchId, rounds,
 *                          winsRequired, currentRound, gameStartAt,
 *                          countdownSeconds, scoreboard, players }
 *                          state is one of: 'lobby' | 'starting' | 'playing' |
 *                          'between_rounds' | 'ended'
 *
 *                          players[]: { socketId, wallet, username, ready, color }
 *                          color is assigned the moment a player creates/joins
 *                          the room — present in roomCreated.lobbyState,
 *                          roomJoined.lobbyState, and every lobbyState update.
 *                          It is the SAME color used later in gameStarting,
 *                          gameStarted, gameState, scoreboard, roundEnded and
 *                          matchEnded — never reassigned once given. Colors are
 *                          drawn from a fixed 6-color palette (max 6 players)
 *                          with no duplicates in a room. If a player leaves
 *                          before the game starts, their color is freed for
 *                          others; if they reconnect with the same wallet
 *                          before the game starts and that color is still
 *                          free, they get it back.
 *
 *   gameStarting         { roomId, gameStartAt, countdownSeconds, players, scoreboard }
 *                          Sent when the host starts the game. The server enters
 *                          a 5-second synchronized countdown before gameStarted.
 *                          gameStartAt is a unix-ms timestamp (Date.now() + 5000) —
 *                          use this for a synced client-side countdown display.
 *                          No new players may join while state === 'starting'.
 *                          If the room becomes invalid during the countdown
 *                          (too few players), the start is cancelled: the server
 *                          emits errorMessage and lobbyState (state back to 'lobby').
 *
 *   gameStarted          { roomId, rounds, winsRequired, scoreboard, players }
 *                          Sent exactly gameStartAt (5s after gameStarting).
 *                          The game loop begins only after this event.
 *   roundStarted         { roomId, currentRound, rounds, winsRequired, scoreboard }
 *   gameState            { tick, players, powerUps, arena}
 *                          Sent ~20×/sec (GAMESTATE_SEND_RATE_HZ) — NOT 60×/sec.
 *                          Physics/collision still run at 60Hz internally; only
 *                          this broadcast is rate-limited. Interpolate between
 *                          the last two received snapshots for smooth motion
 *                          rather than snapping directly to each new position.
 *                          NO permanent lethal trails. Each players[] entry
 *                          carries its own current snake body — see below.
 *   playerDied           { socketId, wallet, reason }
 *                          reason: 'wall' | 'trail' | 'shrink'
 *                          'wall'   — hit the arena/shrink boundary (always lethal)
 *                          'trail'  — hit a snake body (own or another player's
 *                                     CURRENT body — never an old/permanent trail)
 *                          'shrink' — caught outside the active arena after
 *                                     the grace period during shrinking
 *   scoreboardUpdate     { scoreboard }
 *   roundEnded           { roomId, roundWinnerWallet, roundWinnerId, draw,
 *                          scoreboard, currentRound, rounds, winsRequired,
 *                          matchOver, nextRoundStartsAt, countdownSeconds }
 *   matchEnded           { roomId, winnerWallet, winnerId, draw,
 *                          scoreboard, totalRounds, rounds }
 *   rematchLobbyCreated  { roomId, lobbyState }
 *   rematchJoined        { roomId, lobbyState }
 *   lobbyFull            { message }
 *   powerUpsUpdate       { powerUps }
 *                          powerUps[]: { id, type, x, y, expiresAt }
 *                          Types: 'ghost' | 'nitro' | 'shield' | 'speed_boost' |
 *                                 'length_boost' | 'fat_trail' | 'tiny_trail'
 *   powerUpCollected     { socketId, playerWallet, playerUsername, type, duration }
 *                          duration is null for shield (counter) and length_boost (instant).
 *   powerUpExpired       { socketId, playerWallet, type }
 *   powerUpUsed          { socketId, playerWallet, type }
 *
 *   NOTE: growth and arena-phase are NOT separate events. They are read
 *   from the per-tick gameState snapshot:
 *     - growth:      gameState.players[].lengthMultiplier / shieldCount / activePowerups
 *     - snake body:   gameState.players[].bodyPoints[] (each [x,y,r]) — LETHAL,
 *                     use for collision. NO permanent trail — this IS the
 *                     entire current body (head-to-tail).
 *     - visual trail: gameState.players[].visualTrail[] (each [x,y,r,alpha]) —
 *                     NON-LETHAL, cosmetic fading trace only. NEVER use this
 *                     for client-side collision/prediction.
 *     - arena:       gameState.arena.{ current, next, phase, warningEndsAt,
 *                     shrinkEndsAt, shrinkProgress }
 *
 *   gameState.players[] full shape:
 *     {
 *       id, wallet, color, x, y, angle, alive,
 *       bodyLengthPx,       // current target head-to-tail length in px
 *       lengthMultiplier,   // growth multiplier (1.0 - 2.5), drives bodyLengthPx
 *                            // and bodyPoints[].r (3rd array element)
 *       bodyPoints,         // [[x,y,r], ...] — LETHAL current snake body,
 *                            // tail-to-head order, decimated for network.
 *       visualTrail,        // [[x,y,r,alpha], ...] — NON-LETHAL fading trace,
 *                            // oldest-to-newest, alpha 1.0→0.0. Render only.
 *       activePowerups,     // [{type, expiresAt}]
 *       shieldCount,        // 0-3
 *     }
 *
 *   inviteReceived       { roomId, fromWallet, fromUsername,
 *                          targetWallet, targetUsername,
 *                          entryFee, rounds, playersCount, maxPlayers }
 *                          → sent to target socket only. UNCHANGED — only
 *                          reaches the target if they already have a game
 *                          socket open. As of this change, sendInvite ALSO
 *                          pushes a roomInviteReceived event (different
 *                          field names, see BackendClient.notifySocial)
 *                          through the backend's separate /social SSE
 *                          channel, so the target gets notified even with
 *                          no game client open at all. Two channels, two
 *                          payload shapes, deliberately not unified here.
 *
 *   inviteDeclined       { roomId, wallet }
 *                          → sent to inviter socket only
 *
 *   errorMessage         { message }
 *
 * ── Scoreboard format ────────────────────────────────────────────────────────
 *
 *   [{ wallet, username, color, wins, alive, rank, activePowerUp }]
 *   activePowerUp: { type, remainingMs } | null
 */

/**
 * @param {import('socket.io').Server} io
 * @param {object} deps                       injected so index.js is the
 *                                              single place stores/services
 *                                              are constructed — and the
 *                                              single place they'd be swapped
 *                                              for Redis-backed equivalents.
 * @param {import('./RoomManager').RoomManager} deps.manager
 * @param {import('./UserRegistry').UserRegistry} deps.registry
 * @param {import('../presence/PresenceService').PresenceService} deps.presenceService
 */
function registerSocketHandlers(io, deps) {
  const { manager, registry, presenceService } = deps;

  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ── registerUser ───────────────────────────────────────────────────────────
    // Payload: { wallet, username? }
    // Must be called once after connecting to enable invite features.
    // Also marks the wallet ONLINE in PresenceService — this is the only
    // social-system touch point in the entire connection handler.
    socket.on('registerUser', async (payload = {}) => {
      const { wallet, username } = payload;

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'registerUser: invalid wallet address' });
      }

      const sanitised = sanitizeUsername(username, wallet);
      await registry.register(socket.id, wallet, sanitised);
      // Remember which wallet this socket registered as, so disconnect can
      // mark it offline without needing another registry round-trip.
      socket.data.registeredWallet = wallet;
      await presenceService.goOnline(wallet, socket.id);
    });

    // ── createRoom ─────────────────────────────────────────────────────────────
    socket.on('createRoom', async (payload = {}) => {
      const { wallet, username, rounds, entryFee } = payload;
      console.log(`[Socket] createRoom — socket: ${socket.id}, wallet: ${JSON.stringify(wallet)}, rounds: ${rounds}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}".` });
      }

      const validatedRounds   = VALID_ROUNDS.includes(rounds) ? rounds : DEFAULT_ROUNDS;
      const validatedFee      = Number.isInteger(entryFee) && entryFee >= 0 ? entryFee : 0;
      const validatedUsername = sanitizeUsername(username, wallet);

      const result = await manager.createRoom(socket.id, wallet, validatedUsername, validatedRounds, validatedFee);
      if (!result.ok) return socket.emit('errorMessage', { message: result.error });

      const { room } = result;
      socket.join(room.roomId);
      socket.emit('roomCreated', { roomId: room.roomId, lobbyState: room.getLobbyState() });
      console.log(`[Socket] ${validatedUsername} (${wallet}) created room ${room.roomId}`);
    });

    // ── joinRoom ───────────────────────────────────────────────────────────────
    socket.on('joinRoom', async (payload = {}) => {
      const { roomId, wallet, username } = payload;
      console.log(`[Socket] joinRoom — socket: ${socket.id}, roomId: ${JSON.stringify(roomId)}, wallet: ${JSON.stringify(wallet)}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: `Invalid wallet address: "${wallet}".` });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const validatedUsername = sanitizeUsername(username, wallet);
      const result = await manager.joinRoom(socket.id, roomId.toUpperCase(), wallet, validatedUsername);
      if (!result.ok) return socket.emit('errorMessage', { message: result.error });

      const { room } = result;
      socket.join(room.roomId);
      socket.emit('roomJoined', { roomId: room.roomId, lobbyState: room.getLobbyState() });
      console.log(`[Socket] ${validatedUsername} (${wallet}) joined room ${room.roomId}`);
    });

    // ── setRounds ──────────────────────────────────────────────────────────────
    socket.on('setRounds', async (payload = {}) => {
      const room = await manager.getRoomForSocket(socket.id);
      if (!room) return socket.emit('errorMessage', { message: 'You are not in a room' });
      room.setRounds(socket.id, payload.rounds);
    });

    // ── setReady ───────────────────────────────────────────────────────────────
    socket.on('setReady', async (payload = {}) => {
      console.log(`[Socket] setReady — socket: ${socket.id}, ready: ${payload.ready}`);
      const room = await manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] setReady failed — ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.setReady(socket.id, payload.ready);
    });

    // ── startGame ──────────────────────────────────────────────────────────────
    socket.on('startGame', async () => {
      console.log(`[Socket] startGame — socket: ${socket.id}`);
      const room = await manager.getRoomForSocket(socket.id);
      if (!room) {
        console.warn(`[Socket] startGame failed — ${socket.id} not in a room`);
        return socket.emit('errorMessage', { message: 'You are not in a room' });
      }
      room.startGame(socket.id);
    });

    // ── playerInput ────────────────────────────────────────────────────────────
    // The ONLY gameplay input the client ever sends. payload.direction is
    // validated against an enum inside Room.handleInput — never trusted as
    // position/velocity/anything else.
    socket.on('playerInput', async (payload = {}) => {
      const room = await manager.getRoomForSocket(socket.id);
      if (!room) return;
      room.handleInput(socket.id, payload.direction);
    });

    // ── playAgain ──────────────────────────────────────────────────────────────
    socket.on('playAgain', async (payload = {}) => {
      const { roomId, wallet } = payload;
      console.log(`[Socket] playAgain — socket: ${socket.id}, roomId: ${roomId}, wallet: ${wallet}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'Invalid wallet address' });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const result = await manager.playAgain(socket.id, wallet);
      if (!result.ok) {
        if (result.error === 'Lobby is full') {
          return socket.emit('lobbyFull', { message: 'Lobby is full' });
        }
        return socket.emit('errorMessage', { message: result.error });
      }
    });

    // ── exitMatch ──────────────────────────────────────────────────────────────
    socket.on('exitMatch', async (payload = {}) => {
      const { roomId } = payload;
      console.log(`[Socket] exitMatch — socket: ${socket.id}, roomId: ${roomId}`);

      const result = await manager.exitMatch(socket.id);
      if (!result.ok) {
        return socket.emit('errorMessage', { message: result.error ?? 'Could not exit room' });
      }

      if (roomId) socket.leave(roomId.toUpperCase());
    });

    // ── sendInvite ─────────────────────────────────────────────────────────────
    // Payload: { targetWallet?, targetUsername?, roomId, fromWallet, fromUsername }
    // Exactly one of targetWallet / targetUsername must be provided.
    socket.on('sendInvite', async (payload = {}) => {
      const { targetWallet, targetUsername, roomId, fromWallet, fromUsername } = payload;

      console.log(
        `[Socket] sendInvite — from: ${fromWallet}, ` +
        `target: ${targetWallet ?? targetUsername}, room: ${roomId}`
      );

      // ── Validate sender identity ─────────────────────────────────────────────
      if (!isValidWallet(fromWallet)) {
        return socket.emit('errorMessage', { message: 'sendInvite: invalid fromWallet' });
      }

      // ── Validate target was specified ────────────────────────────────────────
      if (!targetWallet && !targetUsername) {
        return socket.emit('errorMessage', {
          message: 'sendInvite: provide targetWallet or targetUsername',
        });
      }

      // ── Room must exist ──────────────────────────────────────────────────────
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'sendInvite: invalid roomId' });
      }
      const room = await manager.getRoom(roomId.toUpperCase());
      if (!room) {
        return socket.emit('errorMessage', { message: `Room ${roomId} not found` });
      }

      // ── Room must be in lobby state ──────────────────────────────────────────
      if (room.state !== 'lobby') {
        return socket.emit('errorMessage', { message: 'Match already started' });
      }

      // ── Room must not be full ────────────────────────────────────────────────
      if (room.isFull) {
        return socket.emit('errorMessage', { message: 'Room is full' });
      }

      // ── Sender must be in the room ───────────────────────────────────────────
      const senderRoom = await manager.getRoomForSocket(socket.id);
      if (!senderRoom || senderRoom.roomId !== room.roomId) {
        return socket.emit('errorMessage', { message: 'You are not in this room' });
      }

      // ── Resolve target ───────────────────────────────────────────────────────
      const target = await registry.findTarget(targetWallet, targetUsername);
      if (!target) {
        const identifier = targetWallet ?? targetUsername;
        return socket.emit('errorMessage', { message: `User "${identifier}" is not online` });
      }

      // ── Cannot invite yourself ────────────────────────────────────────────────
      if (target.wallet.toLowerCase() === fromWallet.toLowerCase()) {
        return socket.emit('errorMessage', { message: 'Cannot invite yourself' });
      }

      // ── Emit invite to target ─────────────────────────────────────────────────
      const lobbyState = room.getLobbyState();

      io.to(target.socketId).emit('inviteReceived', {
        roomId,
        fromWallet,
        fromUsername:   fromUsername ?? fromWallet,
        targetWallet:   target.wallet,
        targetUsername: target.username,
        entryFee:       lobbyState.entryFee,
        rounds:         lobbyState.rounds,
        playersCount:   lobbyState.players.length,
        maxPlayers:     MAX_PLAYERS,
      });

      console.log(
        `[Socket] Invite sent: ${fromWallet} → ${target.wallet} for room ${roomId}`
      );

      // ── Social cross-app push (new) ──────────────────────────────────────────
      // Everything above is unchanged. This is purely additive: the emit
      // above only reaches B if they already have a game socket open — this
      // pushes the same invite to the backend's /social SSE layer so B gets
      // notified even if they're just browsing the lobby/dashboard with no
      // game client open at all. Fire-and-forget — notifySocial() never
      // throws, so a backend hiccup here can never affect the invite above.
      const hostPlayer = lobbyState.players.find(p => p.socketId === lobbyState.hostId);

      BackendClient.notifySocial('roomInviteReceived', target.wallet, {
        roomId:       room.roomId,
        gameType:     'curve_fever',
        hostWallet:   hostPlayer?.wallet   ?? fromWallet,
        hostUsername: hostPlayer?.username ?? (fromUsername ?? fromWallet),
        entryFee:     lobbyState.entryFee,
        playerCount:  lobbyState.players.length,
        maxPlayers:   MAX_PLAYERS,
        expiresAt:    Date.now() + INVITE_EXPIRY_MS,
      });
    });

    // ── acceptInvite ───────────────────────────────────────────────────────────
    // Payload: { roomId, wallet, username? }
    // Identical logic to joinRoom — handled the same way server-side.
    socket.on('acceptInvite', async (payload = {}) => {
      const { roomId, wallet, username } = payload;
      console.log(`[Socket] acceptInvite — socket: ${socket.id}, roomId: ${roomId}, wallet: ${wallet}`);

      if (!isValidWallet(wallet)) {
        return socket.emit('errorMessage', { message: 'Invalid wallet address' });
      }
      if (!roomId || typeof roomId !== 'string') {
        return socket.emit('errorMessage', { message: 'Invalid room ID' });
      }

      const validatedUsername = sanitizeUsername(username, wallet);
      const result = await manager.joinRoom(socket.id, roomId.toUpperCase(), wallet, validatedUsername);

      if (!result.ok) {
        // Use lobbyFull for the capacity error, errorMessage for everything else
        if (result.error === 'Room is full') {
          return socket.emit('lobbyFull', { message: 'Lobby is full' });
        }
        return socket.emit('errorMessage', { message: result.error });
      }

      const { room } = result;
      socket.join(room.roomId);
      socket.emit('roomJoined', { roomId: room.roomId, lobbyState: room.getLobbyState() });
      console.log(`[Socket] ${validatedUsername} (${wallet}) accepted invite → room ${room.roomId}`);
    });

    // ── declineInvite ──────────────────────────────────────────────────────────
    // Payload: { roomId, wallet, fromWallet }
    // Notifies the inviter that their invite was declined.
    socket.on('declineInvite', async (payload = {}) => {
      const { roomId, wallet, fromWallet } = payload;
      console.log(`[Socket] declineInvite — ${wallet} declined invite from ${fromWallet} for room ${roomId}`);

      if (!isValidWallet(fromWallet)) {
        return; // silently ignore malformed declines
      }

      // Find the inviter and notify them if still online
      const inviter = await registry.findByWallet(fromWallet);
      if (inviter) {
        io.to(inviter.socketId).emit('inviteDeclined', {
          roomId,
          wallet,   // wallet that declined
        });
      }
      // No error if inviter is offline — decline is best-effort
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
      await registry.remove(socket.id);
      await manager.removePlayer(socket.id);
      if (socket.data.registeredWallet) {
        await presenceService.goOffline(socket.data.registeredWallet);
      }
    });
  });

  // ── Periodic stats ─────────────────────────────────────────────────────────
  setInterval(async () => {
    const rooms   = await manager.activeRoomCount();
    const players = await manager.connectedPlayers();
    const online  = await presenceService.onlineCount();
    if (rooms > 0 || players > 0 || online > 0) {
      console.log(`[Stats] Rooms: ${rooms} | In-room: ${players} | Online: ${online}`);
    }
  }, 30_000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidWallet(wallet) {
  return typeof wallet === 'string' && wallet.trim().length > 0;
}

function sanitizeUsername(username, wallet) {
  if (typeof username === 'string' && username.trim().length > 0) {
    return username.trim().slice(0, 20);
  }
  const w = String(wallet);
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

module.exports = { registerSocketHandlers };
