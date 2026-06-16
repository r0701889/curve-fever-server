# curve-fever-server — social invite bridge

Drop these two files into your repo at the exact paths shown — both
replace existing files in place. Nothing else in this repo changed: not
Room.js, RoomManager, GameLoop, collision.js, ArenaManager, PowerUpManager,
joinRoom, acceptInvite, ready flow, or anything payment-related.

## The problem this solves

The existing `sendInvite` handler already emits `inviteReceived` directly
to the target's game socket — but only if the target already has a game
client open. If they're just browsing the lobby/dashboard in Emblem with
no game socket connected, they never see the invite at all. The fix isn't
to change that existing path — it's to add a second, independent push
through the backend's new `/social` SSE channel (see the companion
package, `curve-fever-backend-social-realtime`), which reaches the target
regardless of whether they have a game client open.

## What's new

**`src/services/BackendClient.js`** — one new method:

```
notifySocial(event, targetWallet, payload)
```

Follows the exact same `post()` helper and error-swallowing pattern as
every other method in this file (`startMatch`, `cancelMatch`, etc.).
Best-effort and fire-and-forget — it never throws. A backend hiccup here
can't affect the invite itself, because the existing `inviteReceived`
emit already happened separately, synchronously, before this is even
called.

**`src/rooms/socketHandlers.js`** — inside the existing `sendInvite`
handler, strictly *after* its existing validation and *after* the
existing `inviteReceived` emit (both untouched, byte-identical to
before), one new block calls `notifySocial()` with a `roomInviteReceived`
payload:

- `roomId` — the actual room, from `room.roomId`.
- `hostWallet` / `hostUsername` — resolved from the lobby's actual host
  (`lobbyState.players.find(p => p.socketId === lobbyState.hostId)`), not
  just defaulted to the inviter — `sendInvite` doesn't require the sender
  to be the host, so these can legitimately differ.
- `entryFee`, `playerCount`, `maxPlayers` — read straight from the live
  lobby state, same source the existing `inviteReceived` event already
  uses.
- `gameType` — hardcoded to `'curve_fever'` for now. There's only one game
  today; this is a one-line change whenever that stops being true.
- `expiresAt` — `Date.now() + 3 minutes` (confirmed default), a new local
  constant (`INVITE_EXPIRY_MS`), not added to `game/constants.js` since
  it isn't a physics/gameplay constant.

The header doc comment for `inviteReceived` got a short note added
pointing at this — the event itself, its field names, and everything it
sends are unchanged.

## Field names are deliberately not unified

The existing `inviteReceived` event uses `fromWallet`/`fromUsername`/
`playersCount`/`rounds`, no `gameType`, no `expiresAt`. The new
`roomInviteReceived` event uses `hostWallet`/`hostUsername`/`playerCount`/
`gameType`/`expiresAt`, per your spec. Two channels, two payload shapes,
on purpose — aligning them would mean changing the existing, already-
shipped event, which this round's instructions explicitly excluded.

## What's NOT done yet — flagging on purpose, not silently skipped

**Expiry is informational only.** `expiresAt` is sent in the payload for
the frontend to act on (grey out / remove the invite client-side), but
nothing server-side rejects a join attempt after that time. Enforcing
that would mean touching `joinRoom`/`acceptInvite`, which this round's
instructions explicitly excluded. Say the word if you want it enforced
next — it'd be a small, self-contained addition (an in-memory map of
target wallet → expiry, checked at the top of `joinRoom`/`acceptInvite`).

**No friendship-gating.** Per the approved plan, `sendInvite` still only
checks that the target is online and registered (`UserRegistry`), same as
before — it does not verify the target is actually the sender's friend.
Adding that would mean a synchronous game-server → backend call on every
invite (new latency, new failure mode if the backend is briefly down),
which you asked to leave for a later pass.

## Tested before packaging

Spawned the real backend as a child process and wired the real
`RoomManager`/`UserRegistry`/`socketHandlers` against it — no mocks on
either side. Created a room, registered a second wallet without joining
it, sent an invite, and confirmed both the existing `inviteReceived`
game-socket emit (verified its payload is exactly the original shape,
nothing new leaked in) and the new `roomInviteReceived` landing on a real
SSE connection on the real backend, carrying the correct room id, host
wallet/username, entry fee, player/capacity counts, and an expiry roughly
3 minutes out. Then re-ran `joinRoom` and `acceptInvite` against that same
live room and confirmed both still work exactly as before. 13 assertions,
all passing.
