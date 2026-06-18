'use strict';

/**
 * PresenceService
 *
 * Tracks which wallets are currently "online" (have an active socket
 * connection and have called registerUser at least once).
 *
 * This is purely in-memory presence for the social/invite layer — it does
 * NOT track room membership (that's RoomManager's job) or identity lookup
 * (that's UserRegistry's job). A wallet is "online" here from the moment
 * registerUser succeeds until either:
 *   - the socket disconnects, or
 *   - the same wallet re-registers from a different socket (the old
 *     socket's presence entry is replaced, not stacked).
 *
 * A wallet can only ever be mapped to ONE current socketId. If a wallet
 * opens a second tab/socket and registers again, the newest registration
 * wins for presence purposes — this mirrors UserRegistry's same
 * one-socket-per-registration model so the two stores never disagree
 * about "which socket is this wallet right now".
 *
 * All wallet keys are lower-cased for case-insensitive lookup, consistent
 * with UserRegistry.
 */
class PresenceService {
  constructor() {
    // walletLower → socketId
    this._online = new Map();
  }

  /**
   * Mark a wallet online, associated with the given socket.
   * Safe to call repeatedly (idempotent) — e.g. re-registering on the same
   * socket, or a reconnect with a new socket id for the same wallet.
   *
   * @param {string} wallet
   * @param {string} socketId
   */
  async goOnline(wallet, socketId) {
    if (!wallet || !socketId) return;
    const walletLower = wallet.toLowerCase();
    this._online.set(walletLower, socketId);
  }

  /**
   * Mark a wallet offline. Only removes the entry if the CURRENT socketId
   * for that wallet matches what's being removed (or no socketId is given),
   * so a stale disconnect from an old socket can never clobber a fresher
   * registration from a new one for the same wallet.
   *
   * @param {string} wallet
   * @param {string} [socketId]  if provided, only clears when it matches
   *                              the wallet's current socket
   */
  async goOffline(wallet, socketId) {
    if (!wallet) return;
    const walletLower = wallet.toLowerCase();
    if (socketId && this._online.get(walletLower) !== socketId) {
      // A different (newer) socket already took over this wallet's
      // presence — don't remove it out from under that registration.
      return;
    }
    this._online.delete(walletLower);
  }

  /**
   * @param {string} wallet
   * @returns {boolean} true if this wallet currently has an online socket
   */
  isOnline(wallet) {
    if (!wallet) return false;
    return this._online.has(wallet.toLowerCase());
  }

  /**
   * @param {string} wallet
   * @returns {string|null} the current socketId for this wallet, or null
   */
  getSocketId(wallet) {
    if (!wallet) return null;
    return this._online.get(wallet.toLowerCase()) ?? null;
  }

  /** @returns {number} count of distinct online wallets */
  get onlineCountSync() {
    return this._online.size;
  }

  // ─── Async-style wrappers ─────────────────────────────────────────────────
  //
  // RoomManager/UserRegistry/PresenceService are all plain in-memory stores
  // today, but socketHandlers.js awaits every call into them by design —
  // that's the seam where a future swap to a shared/Redis-backed store
  // (multi-instance deployment) would slot in without touching call sites.
  // These thin async wrappers keep that contract real instead of just
  // "await on a sync function happens to work".

  async onlineCount() {
    return this._online.size;
  }
}

module.exports = { PresenceService };
