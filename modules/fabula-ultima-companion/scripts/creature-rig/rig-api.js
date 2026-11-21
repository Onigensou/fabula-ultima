// ============================================================================
// creature-rig/rig-api.js — the public trigger API for creature rigs (docs/creature-rig.md, "API contract")
//
// Every client renders its own rig, so a motion must reach EVERY client exactly once:
//   play / rest / release        broadcast on the module socket AND run here (Foundry does not echo to the
//                                sender); each message carries an id and a client acts on an id once.
//   playLocal / restLocal / ...  this client only — for code that already runs everywhere (animation
//                                scripts, the battle entrance, event-row client handlers).
//
// A call on a token with no rig resolves { ok: false, reason: "no-rig" } and never throws, so callers
// never check first. A rig still building (an entrance right after canvas load) is waited for briefly.
// Booted by the host (rig-host.js boot wiring) through initCreatureRigApi().
// ============================================================================

import { rigFor, whenRig, isRiggedToken } from "./rig-host.js";
import { defineMotion, motionNames, hasMotion } from "./rig-motions.js";
import {
  RIG_MSG, refTarget, resolveTokenRef, createSeen, makeMsgId, sanitizeOpts, acceptMessage,
  motionTiming, entranceMotionOf, createOncePer,
} from "./rig-api-core.js";

const SOCKET = "module.fabula-ultima-companion";
const TAG = "[creature-rig:api]";
const WAIT_MS = 3000;            // how long a call waits for a rig that is still building
const ENTRANCE_WAIT_MS = 2500;   // shorter for the entrance: a late roar is worse than none

const NO_RIG = Object.freeze({ ok: false, reason: "no-rig" });
const result = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// ── resolution ───────────────────────────────────────────────────────────────
const env = () => ({ sceneId: globalThis.canvas?.scene?.id ?? null, get: (id) => globalThis.canvas?.tokens?.get?.(id) ?? null });
const resolve = (ref) => { try { return resolveTokenRef(ref, env()); } catch { return null; } };
const suppressed = () => { try { return globalThis.FUCompanion?.api?.vfxSuppressed?.() === true; } catch { return false; } };
const rigged = (token) => { try { return !!token && isRiggedToken(token); } catch { return false; } };

async function liveRig(token, waitMs = WAIT_MS) {
  if (!rigged(token)) return null;
  try {
    const now = rigFor(token);
    if (now) return now;
    return waitMs > 0 ? ((await whenRig(token, waitMs)) ?? null) : null;
  } catch (e) {
    console.warn(TAG, "rig lookup failed", e);
    return null;
  }
}

// ── local (this client only) ─────────────────────────────────────────────────

/**
 * Play a named motion on this client's rig. Returns a handle at once: { done, peak, cancel() }.
 * done resolves { ok, reason, name } (reason "ended" when it ran to the end); peak resolves true at the
 * motion's marked moment (the roar's jaw snap), false if it never gets there.
 * opts: the motion's own options (hold, jaw, head, wings, strength, speed, exclusive) + waitMs.
 */
export function playLocal(tokenRef, motion, opts = {}) {
  let cancelled = false, inner = null, peakResolve;
  const peak = new Promise((r) => { peakResolve = r; });
  const done = (async () => {
    if (!hasMotion(motion)) return result("unknown-motion", { name: motion });
    const token = resolve(tokenRef);
    if (!token || !rigged(token)) return { ...NO_RIG, name: motion };
    // a hidden tab would bank the motion and play it on refocus; drop it like every other VFX
    if (suppressed()) return result("suppressed", { name: motion });
    const rig = await liveRig(token, opts?.waitMs ?? WAIT_MS);
    if (!rig) return { ...NO_RIG, name: motion };
    if (cancelled) return result("cancelled", { name: motion });
    const { waitMs, ...motionOpts } = opts ?? {};
    inner = rig.play(motion, motionOpts);
    inner.peak.then(peakResolve, () => peakResolve(false));
    return await inner.done;
  })().catch((e) => {
    console.warn(TAG, `play "${motion}" failed`, e);
    return result("error", { name: motion, error: String(e?.message ?? e) });
  }).then((r) => { peakResolve(false); return r; });
  return { done, peak, cancel() { cancelled = true; try { inner?.cancel(); } catch {} } };
}

/** Hold this client's rig at its painted rest pose (shows that hide the token call this first). */
export async function restLocal(tokenRef, ms = 250) {
  const rig = await liveRig(resolve(tokenRef));
  if (!rig) return NO_RIG;
  try { rig.rest(ms); return { ok: true }; } catch (e) { console.warn(TAG, "rest failed", e); return result("error"); }
}

/** Let this client's rig move again after a rest. */
export async function releaseLocal(tokenRef, ms = 400) {
  const rig = await liveRig(resolve(tokenRef), 0);   // not built yet = nothing is resting
  if (!rig) return NO_RIG;
  try { rig.release(ms); return { ok: true }; } catch (e) { console.warn(TAG, "release failed", e); return result("error"); }
}

/** Does this token get a rig on this client (even one still building)? */
export function isRigged(tokenRef) { return rigged(resolve(tokenRef)); }

// ── the entrance beat ────────────────────────────────────────────────────────
// The battle entrance runs on every client (director-init.js playEntranceLocal / playJoinOne), so this is
// LOCAL. The token's rig def names the beat (Nidhogg: onEntrance "roar"). Once per token per 8 s: the
// entrance path can reach it twice when a style falls back to a plain fade.
const entranceOnce = createOncePer(8000);
export async function playEntranceMotion(tokenRef) {
  const token = resolve(tokenRef);
  if (!rigged(token)) return NO_RIG;
  if (!entranceOnce(token.id)) return result("already");
  const rig = await liveRig(token, ENTRANCE_WAIT_MS);
  if (!rig) return NO_RIG;
  const beat = entranceMotionOf(rig.def);
  if (!beat) return result("no-entrance-motion");
  return playLocal(token, beat.motion, { ...beat.opts, waitMs: 0 }).done;
}

// ── all clients ──────────────────────────────────────────────────────────────
const seen = createSeen(256);

function runMessage(msg) {
  switch (msg.op) {
    case "play": return playLocal(msg.tokenId, msg.motion, msg.opts ?? {}).done;
    case "rest": return restLocal(msg.tokenId, msg.ms ?? undefined);
    case "release": return releaseLocal(msg.tokenId, msg.ms ?? undefined);
  }
  return Promise.resolve(result("bad-op"));
}

function onSocket(msg) {
  if (msg?.type !== RIG_MSG) return;
  const skip = acceptMessage(msg, { sceneId: env().sceneId, seen });
  if (skip) return;
  runMessage(msg).catch((e) => console.warn(TAG, "socket op failed", e));
}

// Send to everyone else, then run here. The id is marked seen BEFORE anything runs, so a relay or a
// second listener that hands it back to us is ignored; receivers act on each id once.
function broadcast(op, tokenRef, extra) {
  const tgt = refTarget(tokenRef);
  if (!tgt?.tokenId) return Promise.resolve(result("no-token"));
  const msg = {
    type: RIG_MSG, op, id: makeMsgId(globalThis.game?.user?.id),
    sceneId: tgt.sceneId ?? env().sceneId, tokenId: tgt.tokenId, ...extra,
  };
  seen.check(msg.id);
  try { globalThis.game?.socket?.emit?.(SOCKET, msg); } catch (e) { console.warn(TAG, "broadcast failed", e); }
  if (msg.sceneId && env().sceneId && msg.sceneId !== env().sceneId) return Promise.resolve(result("other-scene"));
  return runMessage(msg);
}

/** Play on EVERY client. Resolves with this client's result when the motion ends here. */
export function play(tokenRef, motion, opts = {}) {
  if (!hasMotion(motion)) return Promise.resolve(result("unknown-motion", { name: motion }));
  return broadcast("play", tokenRef, { motion, opts: sanitizeOpts(opts) });
}
export function rest(tokenRef, ms) { return broadcast("rest", tokenRef, { ms: Number.isFinite(ms) ? ms : null }); }
export function release(tokenRef, ms) { return broadcast("release", tokenRef, { ms: Number.isFinite(ms) ? ms : null }); }

// ── animation scripts: oni.rig ───────────────────────────────────────────────
// Built per run by oni-helpers.js (buildOni) with its `track` disposer hook. Everything is LOCAL: the
// script already runs on every client. Choice on dispose(): a motion the run started is LEFT to finish —
// the listener disposes the moment the script returns, so cancelling would cut off any roar the script
// did not await (like oni.vfx, a roar outlives its script). A rest() the run made and did not release IS
// released on dispose, so a script that forgets (or throws mid-show) never leaves the creature frozen.
export function createScriptRig(track) {
  const rested = new Map();   // tokenId -> the pending rest promise
  let armed = false;
  const arm = () => {
    if (armed || typeof track !== "function") return;
    armed = true;
    track(() => {
      for (const [id, p] of rested) Promise.resolve(p).finally(() => releaseLocal(id).catch(() => {}));
      rested.clear();
    });
  };
  const idOf = (t) => refTarget(t)?.tokenId ?? null;
  return {
    play: (token, name, opts) => playLocal(token, name, opts),
    roar: (token, opts) => playLocal(token, "roar", opts),
    rest(token, ms) {
      const p = restLocal(token, ms);
      const id = idOf(token);
      if (id) { arm(); rested.set(id, p); }
      return p;
    },
    release(token, ms) {
      const id = idOf(token);
      if (id) rested.delete(id);
      return releaseLocal(token, ms);
    },
    isRigged: (token) => isRigged(token),
    timing: (name, opts) => motionTiming(name, opts),
  };
}

// ── boot ─────────────────────────────────────────────────────────────────────
let _socketOn = false;
function listen() {
  if (_socketOn || !globalThis.game?.socket?.on) return;
  _socketOn = true;
  globalThis.game.socket.on(SOCKET, onSocket);
}

export function initCreatureRigApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  FUCompanion.api = FUCompanion.api || {};
  FUCompanion.api.creatureRig = {
    play, playLocal, rest, release, restLocal, releaseLocal,
    isRigged,
    motions: () => motionNames(),
    // LOCAL registry: a motion defined at runtime exists only where defineMotion ran — define it on every
    // client (a module file, or inside an animation script) before broadcasting it.
    defineMotion,
    timing: (name, opts) => motionTiming(name, opts),   // { durationMs, peakMs } | null
    entrance: playEntranceMotion,                        // LOCAL: the def's onEntrance beat
    forScript: createScriptRig,                          // oni.rig (oni-helpers.js)
  };
  // the socket is connected before init; only a very early call has to wait for it
  if (globalThis.game?.socket?.on) listen();
  else globalThis.Hooks?.once?.("ready", listen);
}
