'use strict';

/**
 * BackendClient
 *
 * The Railway game server uses this to call the secure backend API.
 * All calls include Authorization: Bearer SERVER_SECRET.
 *
 * The frontend must NEVER have access to SERVER_SECRET.
 * These calls happen server-to-server only.
 */

const BACKEND_URL            = process.env.BACKEND_URL;
const SERVER_SECRET          = process.env.SERVER_SECRET;
const RAILWAY_INTERNAL_TOKEN = process.env.RAILWAY_INTERNAL_TOKEN;

// ─── Startup validation ───────────────────────────────────────────────────────

if (!BACKEND_URL) {
  console.warn('[BackendClient] WARNING: BACKEND_URL is not set — backend calls will be skipped');
}
if (!SERVER_SECRET) {
  console.warn('[BackendClient] WARNING: SERVER_SECRET is not set — backend calls will fail auth');
}
if (!RAILWAY_INTERNAL_TOKEN) {
  console.warn('[BackendClient] WARNING: RAILWAY_INTERNAL_TOKEN is not set — /finish calls will be rejected');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Makes an authenticated POST to the backend.
 * Uses Authorization: Bearer SERVER_SECRET for all general endpoints.
 * Throws on non-2xx responses.
 */
async function post(path, body) {
  if (!BACKEND_URL) {
    console.warn(`[BackendClient] Skipping POST ${path} — BACKEND_URL not configured`);
    return null;
  }

  const url = `${BACKEND_URL.replace(/\/$/, '')}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SERVER_SECRET}`,
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    console.error(`[BackendClient] Network error POST ${path}: ${networkErr.message}`);
    throw networkErr;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[BackendClient] POST ${path} failed: ${response.status} ${text}`);
    const err = new Error(`Backend returned ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Makes a POST to /finish with the dedicated x-railway-token header.
 * This header is checked by requireRailwayToken middleware on the backend.
 * Separate from post() so the token is ONLY sent to the /finish endpoint.
 */
async function postFinish(path, body) {
  if (!BACKEND_URL) {
    console.warn(`[BackendClient] Skipping POST ${path} — BACKEND_URL not configured`);
    return null;
  }

  if (!RAILWAY_INTERNAL_TOKEN) {
    console.error('[BackendClient] RAILWAY_INTERNAL_TOKEN not set — cannot call /finish');
    return null;
  }

  const url = `${BACKEND_URL.replace(/\/$/, '')}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-railway-token': RAILWAY_INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    console.error(`[BackendClient] Network error POST ${path}: ${networkErr.message}`);
    throw networkErr;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[BackendClient] POST ${path} failed: ${response.status} ${text}`);
    const err = new Error(`Backend returned ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Retry an async operation up to `attempts` times with linear backoff.
 * Used for createMatch — the most important call to get right, since a
 * failure here means Emblem will eventually get a 404 from GET /matches/:id
 * with no obvious cause (the match plays out fine on the game server, but
 * its result is never queryable).
 */
async function _withRetries(fn, { attempts = 3, delayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create (or fetch, if already exists) a match record in the backend.
 *
 * IDEMPOTENT — safe to call multiple times with the same matchId.
 *
 * For the first match: matchId === roomId (by convention).
 * For rematches: matchId is "${roomId}_r1", "_r2" etc. (new unique ID each time),
 * while roomId stays the same. This allows Emblem to look up the latest match
 * via GET /matches/:roomId (falls back to room_id in the backend) while the
 * verify-payment flow uses the new matchId against a fresh 'pending' record.
 *
 * @param {string} matchId       — primary key for this match (roomId or roomId_rN)
 * @param {string} roomId        — stable Socket.io room code
 * @param {number} entryFeeUsdc
 * @param {number} maxPlayers
 * @param {number} rounds        — BO format (1,3,5,7,9)
 * @param {string} gameType
 * @param {string} [hostWallet]  — informational only
 * @returns {Promise<{ matchId, roomId, alreadyExists?: boolean } | null>}
 */
async function createMatch(matchId, roomId, entryFeeUsdc = 0, maxPlayers = 6, rounds = 1, gameType = 'curve_fever', hostWallet = null) {
  const body = {
    matchId,
    roomId,
    entryFeeUsdc,
    maxPlayers,
    rounds,
    gameType,
    hostWallet,
    players: [], // see POST /api/matches docs — accepted, players registered separately
  };

  try {
    // Retried — this is the persistence point Emblem's GET /matches/:id depends on.
    const result = await _withRetries(() => post('/api/matches', body), { attempts: 3, delayMs: 500 });

    if (result?.alreadyExists) {
      console.log(`[BackendClient] [match_registered] matchId=${result.matchId} roomId=${roomId} alreadyExists=true`);
    } else {
      console.log(`[BackendClient] [match_registered] matchId=${result?.matchId} roomId=${roomId}`);
    }

    return result;
  } catch (err) {
    console.error(`[BackendClient] [match_register_failed] matchId=${matchId} roomId=${roomId} error=${err.message}`);
    return null;
  }
}

/**
 * Register all players in the match (before they pay).
 * @param {string} matchId
 * @param {string[]} wallets
 */
async function registerPlayers(matchId, wallets) {
  const results = await Promise.allSettled(
    wallets.map(wallet => post(`/api/matches/${matchId}/register`, { wallet }))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[BackendClient] registerPlayer failed for ${wallets[i]}: ${r.reason?.message}`);
    }
  });
}

/**
 * Mark match as started in the backend.
 * @param {string} matchId
 */
async function startMatch(matchId) {
  try {
    await post(`/api/matches/${matchId}/start`, {});
    console.log(`[BackendClient] Match ${matchId} marked as started`);
  } catch (err) {
    console.error(`[BackendClient] startMatch failed: ${err.message}`);
  }
}

/**
 * Report match result to the backend.
 * This is the AUTHORITATIVE call — backend will distribute the prize pool.
 *
 * @param {string} matchId
 * @param {string|null} winnerWallet
 * @param {string|null} winnerId
 * @param {boolean} draw
 */
/**
 * Report match result to the backend.
 * This is the AUTHORITATIVE call — it persists the result so Emblem's
 * GET /matches/:id (with SERVER_SECRET) returns it after the room is destroyed.
 *
 * Extra context fields (roomId, players, entryFeeUsdc, maxPlayers, totalRounds)
 * are sent so the backend can self-heal the match record if it was never
 * created at room-creation time (defensive — should be a no-op normally).
 *
 * @param {string} matchId
 * @param {string|null} winnerWallet
 * @param {string|null} winnerId
 * @param {boolean} draw
 * @param {object} [context]
 * @param {string}   [context.roomId]
 * @param {string[]} [context.players]      - wallet addresses in this match
 * @param {number}   [context.entryFeeUsdc]
 * @param {number}   [context.maxPlayers]
 * @param {number}   [context.totalRounds]
 */
async function finishMatch(matchId, winnerWallet, winnerId, draw, context = {}) {
  if (!matchId) {
    console.warn('[BackendClient] finishMatch called without matchId — skipping');
    return null;
  }

  const body = {
    matchId,
    winnerWallet: draw ? null : winnerWallet,
    winnerId:     draw ? null : winnerId,
    draw:         Boolean(draw),
    roomId:        context.roomId,
    players:       context.players,
    entryFeeUsdc:  context.entryFeeUsdc,
    maxPlayers:    context.maxPlayers,
    totalRounds:   context.totalRounds,
  };

  console.log(
    `[BackendClient] [match_finish_sent_to_backend] matchId=${matchId} ` +
    `${draw ? 'draw=true' : `winnerWallet=${winnerWallet}`}`
  );

  try {
    const result = await postFinish(`/api/matches/${matchId}/finish`, body);
    console.log(
      `[BackendClient] [match_finish_backend_success] matchId=${matchId} ` +
      `payoutStatus=${result?.payoutStatus} prizePoolUsdc=${result?.prizePoolUsdc}` +
      (result?.selfHealed ? ' selfHealed=true' : '')
    );
    return result;
  } catch (err) {
    // Log but don't crash the game server — match result is already broadcast to clients.
    // This is the critical failure mode: the match finished on the game server,
    // but Emblem's GET /matches/:id will 404 or return a stale status until
    // this is investigated (check BACKEND_URL / RAILWAY_INTERNAL_TOKEN).
    console.error(`[BackendClient] [match_finish_backend_failed] matchId=${matchId} error=${err.message}`);
    return null;
  }
}

/**
 * Cancel a match in the backend (triggers refunds).
 * @param {string} matchId
 */
async function cancelMatch(matchId) {
  if (!matchId) return null;
  try {
    const result = await post(`/api/matches/${matchId}/cancel`, {});
    console.log(`[BackendClient] Match ${matchId} cancelled`);
    return result;
  } catch (err) {
    console.error(`[BackendClient] cancelMatch failed for ${matchId}: ${err.message}`);
    return null;
  }
}

/**
 * Notify the backend's social realtime layer (SSE) that something should
 * be pushed instantly to a specific wallet. Currently used only for room
 * invites — lobby state (the thing being announced) only exists here in
 * the game server, not in the backend's DB, so the game server has to be
 * the one to initiate this push.
 *
 * Best-effort / fire-and-forget: this NEVER throws. A failure here can't
 * break the invite itself — the existing in-game socket emit (inviteReceived)
 * already happened separately, synchronously, and is unaffected either way.
 * Worst case, the target wallet just doesn't get the cross-app push and
 * falls back to whatever they'd see next time they poll/refresh.
 *
 * @param {string} event         one of the backend's allowed internal event
 *                                names (currently roomInvite*) — see
 *                                ALLOWED_INTERNAL_EVENTS in the backend's
 *                                routes/social.js
 * @param {string} targetWallet
 * @param {object} payload
 */
async function notifySocial(event, targetWallet, payload) {
  try {
    await post('/api/social/notify', { event, targetWallet, payload });
  } catch (err) {
    console.error(`[BackendClient] notifySocial(${event}) failed for ${targetWallet}: ${err.message}`);
  }
}

module.exports = { createMatch, registerPlayers, startMatch, finishMatch, cancelMatch, notifySocial };
