'use strict';

/**
 * UserRegistry
 *
 * Tracks all connected, registered users for realtime invite routing.
 *
 * A user is "registered" when they emit `registerUser` with their wallet
 * and optional username. Being connected (socket exists) is not enough —
 * they must explicitly register so we know their identity.
 *
 * Lookup is O(1) by both wallet (lowercase) and username (lowercase).
 * A socket may only have one registration. Re-registering the same socket
 * updates the record in place.
 *
 * All lookups are case-insensitive.
 */
class UserRegistry {
  constructor() {
    // socketId → { socketId, wallet, walletLower, username, usernameLower }
    this._bySocket   = new Map();

    // walletLower → socketId
    this._byWallet   = new Map();

    // usernameLower → socketId  (only when username is non-empty)
    this._byUsername = new Map();
  }

  // ─── Register ─────────────────────────────────────────────────────────────────
  //
  // NOTE on async: like RoomManager, UserRegistry is a plain in-memory store
  // today. Every public method is declared `async` because socketHandlers.js
  // awaits every call into it by design — the seam for a future shared/
  // Redis-backed registry (multi-instance deployment) without touching call
  // sites.

  /**
   * Register or update a user entry for the given socket.
   * Safe to call multiple times — updates in place.
   *
   * @param {string} socketId
   * @param {string} wallet
   * @param {string} username  sanitised, may be wallet-derived fallback
   */
  async register(socketId, wallet, username) {
    // Remove any previous registration for this socket
    this._remove(socketId);

    const walletLower   = wallet.toLowerCase();
    const usernameLower = username.toLowerCase();

    const entry = { socketId, wallet, walletLower, username, usernameLower };

    this._bySocket.set(socketId, entry);
    this._byWallet.set(walletLower, socketId);

    // Only index by username if it differs from the wallet
    // (wallet-derived fallbacks are not useful for username lookup)
    if (usernameLower !== walletLower) {
      this._byUsername.set(usernameLower, socketId);
    }

    console.log(`[UserRegistry] Registered: ${username} (${wallet}) — socket: ${socketId}`);
  }

  // ─── Remove ───────────────────────────────────────────────────────────────────

  /**
   * Remove a user when their socket disconnects or they re-register.
   */
  async remove(socketId) {
    this._remove(socketId);
  }

  _remove(socketId) {
    const entry = this._bySocket.get(socketId);
    if (!entry) return;

    this._bySocket.delete(socketId);
    this._byWallet.delete(entry.walletLower);

    if (entry.usernameLower !== entry.walletLower) {
      this._byUsername.delete(entry.usernameLower);
    }
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────────

  /**
   * Find a registered user by wallet address (case-insensitive).
   * @returns {{ socketId, wallet, username } | null}
   */
  async findByWallet(wallet) {
    if (!wallet) return null;
    const socketId = this._byWallet.get(wallet.toLowerCase());
    return socketId ? this._bySocket.get(socketId) ?? null : null;
  }

  /**
   * Find a registered user by username (case-insensitive).
   * @returns {{ socketId, wallet, username } | null}
   */
  async findByUsername(username) {
    if (!username) return null;
    const socketId = this._byUsername.get(username.toLowerCase());
    return socketId ? this._bySocket.get(socketId) ?? null : null;
  }

  /**
   * Find by wallet first, then username if wallet not given.
   * Returns the first match found.
   */
  async findTarget(targetWallet, targetUsername) {
    if (targetWallet) return this.findByWallet(targetWallet);
    if (targetUsername) return this.findByUsername(targetUsername);
    return null;
  }

  /**
   * Get the registered entry for a socket, or null.
   */
  async getBySocket(socketId) {
    return this._bySocket.get(socketId) ?? null;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────────

  get onlineCount() { return this._bySocket.size; }
}

module.exports = { UserRegistry };
