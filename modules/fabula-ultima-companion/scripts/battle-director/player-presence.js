// Who can actually answer right now — GM-side view of every other client.
//
//   offline  no socket (user.active is false)
//   loading  socket up, but the client hasn't said its handlers are attached.
//            A connected client can spend minutes here (Blumairwen's 987 s boot,
//            2026-10-31), and anything sent to it meanwhile is simply lost, so
//            user.active alone can't answer "is anyone there?".
//   ready    told us it is listening (PLAYER_HELLO, or an answer to our probe)
//
// The rule built on this: the game never waits on a player who isn't there.
// `isGone` turns true once a client has been offline or loading for GRACE_MS.
//
// 🩸 A connected, ready player is NEVER timed, however long they think. Nothing
// here measures how long a menu has been open, and no player sees any of this.
//
// A player who never joined this session is not "gone" either: the GM is running
// that character, so the decision stays with the GM. `_seen` is memory on this
// client, so a GM who reloads forgets who dropped before the reload and those
// players fall under the same rule until they come back.

import { log } from "./logger.js";
import { SimMode } from "./sim/sim-mode.js";
import { getIntentChannel } from "./intent-channel.js";

export const GRACE_MS = 20_000;
const PROBE_EVERY_MS = 5_000;

const _ready = new Set();
const _seen = new Set();
const _awaySince = new Map();   // userId → ms it stopped being ready
let _installed = false;

function markAway(userId) {
  _ready.delete(userId);
  if (!_awaySince.has(userId)) _awaySince.set(userId, Date.now());
}

function markReady(userId) {
  if (!userId) return;
  const wasAway = _awaySince.has(userId);
  _ready.add(userId);
  _seen.add(userId);
  _awaySince.delete(userId);
  if (wasAway) log(`[presence] ${game.users?.get(userId)?.name ?? userId} is ready`);
}

function probeUnready() {
  const ids = (game.users?.contents ?? [])
    .filter((u) => u.active && u.id !== game.user?.id && !_ready.has(u.id))
    .map((u) => u.id);
  for (const id of ids) { _seen.add(id); if (!_awaySince.has(id)) _awaySince.set(id, Date.now()); }
  if (ids.length) getIntentChannel().probePeers(ids);
}

export function installPlayerPresence() {
  if (_installed || !game.user?.isGM) return;
  _installed = true;
  getIntentChannel().onPeerReady(({ userId }) => markReady(userId));
  Hooks.on("userConnected", (user, connected) => {
    if (!user?.id || user.id === game.user?.id) return;
    _seen.add(user.id);
    // A client that reconnected without reloading answers the probe at once; one
    // that reloaded can't until its handlers exist. Either way, it isn't ready
    // until it says so, so a hello that raced ahead of this hook can't stick.
    markAway(user.id);
    log(`[presence] ${user.name} ${connected ? "connected, loading" : "offline"}`);
    if (connected) getIntentChannel().probePeers([user.id]);
  });
  probeUnready();
  setInterval(probeUnready, PROBE_EVERY_MS);
}

/** "self" | "offline" | "loading" | "ready" */
export function presenceOf(userId) {
  if (userId === game.user?.id) return "self";
  const u = game.users?.get(userId);
  if (!u?.active) return "offline";
  return _ready.has(userId) ? "ready" : "loading";
}

export function isReady(userId) {
  const s = presenceOf(userId);
  return s === "ready" || s === "self";
}

/** This client was here this session and has been away for the whole grace period. */
export function isGone(userId) {
  if (!userId || !_seen.has(userId) || isReady(userId)) return false;
  const since = _awaySince.get(userId);
  return since != null && Date.now() - since >= GRACE_MS;
}

/** Calls onGone once each time `userId` goes missing. Returns the stop function. */
export function watchGone(userId, onGone) {
  if (!userId || SimMode.active) return () => {};
  let fired = false;
  const tid = setInterval(() => {
    const gone = isGone(userId);
    if (gone && !fired) { fired = true; try { onGone(); } catch (e) { console.error(e); } }
    if (!gone) fired = false;
  }, 1000);
  return () => clearInterval(tid);
}

/** A required choice is waiting on someone who isn't there: tell the GM, don't decide it. */
export function noteGmWaiting(userId, what) {
  const name = game.users?.get(userId)?.name ?? "A player";
  const state = presenceOf(userId) === "loading" ? "is still loading" : "is offline";
  log(`[presence] ${name} ${state} — ${what} is waiting on the GM`);
  ui.notifications?.warn(`${name} ${state}: ${what} is waiting on you. Answer it from the GM desk, or use Turn to pass.`);
}

export function presenceList() {
  return (game.users?.contents ?? [])
    .filter((u) => u.id !== game.user?.id && (u.active || _seen.has(u.id)))
    .map((u) => ({ id: u.id, name: u.name, state: presenceOf(u.id), gone: isGone(u.id) }));
}
