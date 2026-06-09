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

const BACKEND_URL   = process.env.BACKEND_URL;
const SERVER_SECRET = process.env.SERVER_SECRET;

// ─── Startup validation ───────────────────────────────────────────────────────

if (!BACKEND_URL) {
  console.warn('[BackendClient] WARNING: BACKEND_URL is not set — backend calls will be skipped');
}
if (!SERVER_SECRET) {
  console.warn('[BackendClient] WARNING: SERVER_SECRET is not set — backend calls will fail auth');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Makes an authenticated POST to the backend.
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a match in the backend when a game starts.
 * @param {string} roomId
 * @param {number} entryFee
 */
async function createMatch(roomId, entryFee = 0) {
  try {
    const result = await post('/api/matches', { roomId, entryFee });
    console.log(`[BackendClient] Created match ${result?.id} for room ${roomId}`);
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
    const result = await post(`/api/matches/${matchId}/finish`, {
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
