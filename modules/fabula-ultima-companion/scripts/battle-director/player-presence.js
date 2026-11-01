// Who can actually answer right now — GM-side view of every other client.
//
//   offline  no socket (user.active is false)
//   loading  socket up, but the client hasn't said its handlers are attached.
//            A connected client can spend minutes here (Blumairwen's 987 s boot,
//            2026-10-31), and anything sent to it meanwhile is simply lost, so
//            user.active alone can't answer "is anyone there?".
//   ready    told us it is listening (PLAYER_HELLO, or an answer to our probe)
//   silent   was ready, but its client stopped answering the probe
//
// The probe is a heartbeat because the socket can't be trusted to report a drop:
// a client that had navigated away still read as active over 70 s later (measured
// 2026-11-01), and a real internet drop sends no goodbye at all. Clients answer it
// by themselves. It measures the machine, never the person.
//
// The rule built on this: the game never waits on a player who isn't there.
// `isGone` turns true once a client has been unreachable for GRACE_MS.
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
const SILENT_AFTER_MS = 12_000;

const _ready = new Set();
const _seen = new Set();
const _awaySince = new Map();   // userId → ms it stopped being ready
const _lastHeard = new Map();   // userId → ms of its last answer, while ready
let _lastTick = 0;
let _installed = false;

function markAway(userId) {
  _ready.delete(userId);
  _lastHeard.delete(userId);
  if (!_awaySince.has(userId)) _awaySince.set(userId, Date.now());
}

function markReady(userId) {
  if (!userId) return;
  const wasAway = _awaySince.has(userId);
  _ready.add(userId);
  _lastHeard.set(userId, Date.now());
  _seen.add(userId);
  _awaySince.delete(userId);
  if (wasAway) log(`[presence] ${game.users?.get(userId)?.name ?? userId} is ready`);
}

// 🩸 If THIS client stalled (a busy GM app, a throttled hidden window), the answers
// are sitting unread, so its clock says nothing about the players. It gives them a
// fresh window instead of blaming them.
function iStalled() {
  return !!_lastTick && Date.now() - _lastTick > PROBE_EVERY_MS * 1.6;
}

function probeAll() {
  if (iStalled()) {
    const now = Date.now();
    for (const id of _lastHeard.keys()) _lastHeard.set(id, now);
    for (const id of _awaySince.keys()) _awaySince.set(id, now);
  }
  _lastTick = Date.now();
  const ids = (game.users?.contents ?? [])
    .filter((u) => u.active && u.id !== game.user?.id)
    .map((u) => u.id);
  for (const id of ids) {
    _seen.add(id);
    if (!_ready.has(id) && !_awaySince.has(id)) _awaySince.set(id, Date.now());
  }
  if (ids.length) getIntentChannel().probePeers(ids);
}

export function installPlayerPresence() {
  if (_installed || !game.user?.isGM) return;
  _installed = true;
  getIntentChannel().onPeerReady(({ userId }) => {
    markReady(userId);
    if (_waits.size && game.users?.get(userId)?.isGM) publishWaits();
  });
  getIntentChannel().onGmEvent((p, sender) => {
    if (p.kind === "waits") _remoteWaits = (p.waits ?? []);
    else if (p.kind === "run" && _waits.has(p.waitId)) runWaitAction(p.waitId, p.actionId);
    else if (p.kind === "ask" && _waits.size) publishWaits();
  });
  getIntentChannel().emitToGms({ kind: "ask" });
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
  probeAll();
  setInterval(probeAll, PROBE_EVERY_MS);
}

/** "self" | "offline" | "loading" | "silent" | "ready" */
export function presenceOf(userId) {
  if (userId === game.user?.id) return "self";
  const u = game.users?.get(userId);
  if (!u?.active) return "offline";
  if (!_ready.has(userId)) return "loading";
  return !iStalled() && Date.now() - (_lastHeard.get(userId) ?? 0) >= SILENT_AFTER_MS ? "silent" : "ready";
}

export function isReady(userId) {
  const s = presenceOf(userId);
  return s === "ready" || s === "self";
}

/** This client was here this session and has been away for the whole grace period. */
export function isGone(userId) {
  if (!userId || !_seen.has(userId) || isReady(userId) || iStalled()) return false;
  const since = _awaySince.get(userId) ?? _lastHeard.get(userId);
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
  const state = { loading: "is still loading", silent: "isn't responding" }[presenceOf(userId)] ?? "is offline";
  log(`[presence] ${name} ${state} — ${what} is waiting on the GM`);
  ui.notifications?.warn(`${name} ${state}: ${what} is waiting on you. Answer it from the GM desk, or use Turn to pass.`);
}

// ── What the battle is waiting on ───────────────────────────────────────────
// Each place that waits on a player registers here, so the GM desk can say what is
// holding the game and offer the way out. Lives on the host; other GMs get a copy,
// because the GM at the screen isn't always the one hosting.
//   action: { id, label, run? } — run happens on the host. No run means the desk
//   handles it where it was clicked: kind "unlock" (answer for them), "turn" (pass).
const _waits = new Map();
let _remoteWaits = [];

function publishWaits() {
  getIntentChannel().emitToGms({ kind: "waits", waits: localWaits() });
}
function localWaits() {
  return [..._waits.values()].map(({ id, userId, label, actions }) => ({
    id, userId, label, actions: actions.map(({ id, label, kind }) => ({ id, label, kind: kind ?? null })),
  }));
}

/** Returns the stop function. No owner or a sim run: nothing to track. */
export function trackWait({ userId, label, actions = [] }) {
  if (!userId || SimMode.active || !game.user?.isGM) return () => {};
  const id = foundry.utils.randomID();
  _waits.set(id, { id, userId, label, actions });
  publishWaits();
  return () => { if (_waits.delete(id)) publishWaits(); };
}

export function listWaits() {
  return _waits.size ? localWaits() : _remoteWaits;
}

export function runWaitAction(waitId, actionId) {
  const w = _waits.get(waitId);
  if (!w) { getIntentChannel().emitToGms({ kind: "run", waitId, actionId }); return; }
  try { w.actions.find((a) => a.id === actionId)?.run?.(); }
  catch (e) { console.error(e); }
}

/** How long this client has been unreachable, or 0. GM desk only: never shown to players. */
export function awayForMs(userId) {
  if (isReady(userId)) return 0;
  const since = _awaySince.get(userId) ?? _lastHeard.get(userId);
  return since != null ? Date.now() - since : 0;
}

export function presenceList() {
  return (game.users?.contents ?? [])
    .filter((u) => u.id !== game.user?.id && (u.active || _seen.has(u.id)))
    .map((u) => ({ id: u.id, name: u.name, state: presenceOf(u.id), gone: isGone(u.id) }));
}
