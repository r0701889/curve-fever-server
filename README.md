# curve-fever-server — social invite bridge

Drop these two files into your repo at the exact paths shown — both
replace existing files in place. Nothing else in this repo changed:
not Room.js, RoomManager, GameLoop, collision.js, ArenaManager,
PowerUpManager, joinRoom, acceptInvite, or anything payment-related.

## What's new

`src/services/BackendClient.js` — one new method, `notifySocial(event,
targetWallet, payload)`, following the exact same `post()` helper and
error-swallowing pattern as every other method in this file. Best-effort:
never throws, so a backend hiccup here can't affect the invite itself.

`src/rooms/socketHandlers.js` — inside the existing `sendInvite` handler,
after its existing validation and after the existing `inviteReceived`
emit (byte-identical, unchanged), one new block calls `notifySocial()`
with a `roomInviteReceived` payload built from the lobby's actual data
(`roomId`, `hostWallet`/`hostUsername` resolved from the real room host,
`entryFee`, `playerCount`, `maxPlayers`, `gameType` hardcoded to
`'curve_fever'` for now, `expiresAt` = now + 3 minutes). This reaches the
target even if they have no game socket open at all — the gap the
existing in-game-only emit couldn't cover.

Invite expiry is informational only at this point — `expiresAt` is sent
in the payload for the frontend to act on, but nothing server-side
rejects a join after that time yet, since that would mean touching
`joinRoom`/`acceptInvite`, which was explicitly out of scope this round.
Flagging this as a deliberate gap, not an oversight.

## Tested before packaging

Spawned the real backend as a child process and wired the real
`RoomManager`/`UserRegistry`/`socketHandlers` (not mocks) against it: created
a room, registered a second wallet without joining, sent an invite, and
confirmed both the existing `inviteReceived` game-socket emit (verified
byte-identical payload shape) AND the new `roomInviteReceived` arriving on
a real SSE connection on the real backend, with the correct room/host/fee/
capacity/expiry data. Then re-ran `joinRoom` and `acceptInvite` against the
same live room and confirmed both still work exactly as before. 13
assertions, all passing.
