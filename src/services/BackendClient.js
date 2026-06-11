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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create (or fetch, if already exists) a match record in the backend.
 *
 * IDEMPOTENT — safe to call multiple times with the same roomId.
 * matchId is set to roomId by convention, so verify-payment can find the
 * match immediately, even before startGame is called.
 *
 * @param {string} roomId       — Socket.io room code, also used as matchId
 * @param {number} entryFeeUsdc
 * @param {number} maxPlayers
 * @param {number} rounds       — BO format (1,3,5,7,9)
 * @param {string} gameType
 * @param {string} [hostWallet] — informational only
 * @returns {Promise<{ matchId, roomId, alreadyExists?: boolean } | null>}
 */
async function createMatch(roomId, entryFeeUsdc = 0, maxPlayers = 6, rounds = 1, gameType = 'curve_fever', hostWallet = null) {
  try {
    const result = await post('/api/matches', {
      matchId:  roomId,
      roomId,
      entryFeeUsdc,
      maxPlayers,
      rounds,
      gameType,
      hostWallet,
    });

    if (result?.alreadyExists) {
      console.log(`[BackendClient] Match ${result.matchId} already existed for room ${roomId}`);
    } else {
      console.log(`[BackendClient] Created match ${result?.matchId} for room ${roomId}`);
    }

    return result;
  } catch (err) {
    console.error(`[BackendClient] createMatch failed: ${err.message}`);
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
async function finishMatch(matchId, winnerWallet, winnerId, draw) {
  if (!matchId) {
    console.warn('[BackendClient] finishMatch called without matchId — skipping');
    return null;
  }

  try {
    const result = await postFinish(`/api/matches/${matchId}/finish`, {
      matchId,
      winnerWallet: draw ? null : winnerWallet,
      winnerId:     draw ? null : winnerId,
      draw:         Boolean(draw),
    });
    console.log(`[BackendClient] Match ${matchId} finished — ${draw ? 'draw' : `winner: ${winnerWallet}`}`);
    return result;
  } catch (err) {
    // Log but don't crash the game server — match result is already broadcast to clients
    console.error(`[BackendClient] finishMatch failed for ${matchId}: ${err.message}`);
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

module.exports = { createMatch, registerPlayers, startMatch, finishMatch, cancelMatch };
