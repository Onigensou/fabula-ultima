// ============================================================================
// creature-rig/rig-api-core.js — the pure parts of the trigger API (no Foundry, no THREE)
//
// Kept apart from rig-api.js so node can test them without loading rig-host.js:
//   tokenRef resolution, the broadcast target a ref names, message dedupe, socket-safe options,
//   a motion's timing (for an event row that waits), the entrance beat a rig def asks for.
// ============================================================================

import { RigAnimator } from "./rig-motions.js";

export const RIG_MSG = "fu.creatureRig";
export const RIG_OPS = ["play", "rest", "release"];

const isTokenDoc = (o) => o && typeof o === "object" && o.documentName === "Token";
const isPlaceable = (o) => o && typeof o === "object" && isTokenDoc(o.document);

/** { sceneId, tokenId } named by a Foundry uuid ("Scene.<s>.Token.<t>"), or null. */
export function parseTokenUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  const ti = parts.lastIndexOf("Token");
  if (ti < 0 || !parts[ti + 1]) return null;
  const si = parts.lastIndexOf("Scene", ti);
  return { sceneId: si >= 0 ? (parts[si + 1] ?? null) : null, tokenId: parts[ti + 1] };
}

/**
 * Where a tokenRef points: { sceneId, tokenId } (sceneId null = whatever scene the reader is on).
 * Accepts a Token placeable, a TokenDocument, a token id or a token uuid. Never throws.
 */
export function refTarget(ref) {
  try {
    if (!ref) return null;
    if (typeof ref === "string") {
      if (ref.includes(".")) return parseTokenUuid(ref);
      return { sceneId: null, tokenId: ref };
    }
    if (isPlaceable(ref)) return { sceneId: ref.document.parent?.id ?? null, tokenId: ref.document.id ?? ref.id ?? null };
    if (isTokenDoc(ref)) return { sceneId: ref.parent?.id ?? null, tokenId: ref.id ?? null };
  } catch { /* fall through */ }
  return null;
}

/**
 * The live Token placeable a ref names on the CURRENT scene, or null.
 * env = { sceneId, get(id) -> placeable|null } (canvas.scene.id / canvas.tokens.get on a client).
 * A ref on another scene is null: token ids only mean something on their own scene.
 */
export function resolveTokenRef(ref, env) {
  const tgt = refTarget(ref);
  if (!tgt?.tokenId || !env) return null;
  if (tgt.sceneId && env.sceneId && tgt.sceneId !== env.sceneId) return null;
  let live = null;
  try { live = env.get?.(tgt.tokenId) ?? null; } catch { live = null; }
  if (live) return live;
  // a placeable handed in directly but not (yet) in the layer's index: trust it while it is alive
  if (isPlaceable(ref) && !ref.destroyed) return ref;
  if (isTokenDoc(ref) && ref.object && !ref.object.destroyed) return ref.object;
  return null;
}

/** A bounded "seen" set. check(id) records it and says whether it is NEW (true) or a repeat (false). */
export function createSeen(cap = 256) {
  const ids = new Map();
  return {
    has: (id) => ids.has(id),
    check(id) {
      if (id == null || id === "") return true;   // un-ided messages cannot be deduped; let them through
      if (ids.has(id)) return false;
      ids.set(id, true);
      while (ids.size > cap) ids.delete(ids.keys().next().value);
      return true;
    },
    get size() { return ids.size; },
  };
}

let _seq = 0;
/** A message id unique across clients: sender user, time, a counter, a random tail. */
export function makeMsgId(userId = "?") {
  _seq = (_seq + 1) % 1e6;
  return `${userId}:${Date.now().toString(36)}:${_seq.toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Options that survive a socket hop: finite numbers, strings, booleans (functions and objects dropped). */
export function sanitizeOpts(opts) {
  const out = {};
  if (!opts || typeof opts !== "object") return out;
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === "number" ? Number.isFinite(v) : (typeof v === "string" || typeof v === "boolean")) out[k] = v;
  }
  return out;
}

/** Should this client act on a socket message? Returns null to act, or the reason it is skipped. */
export function acceptMessage(msg, { sceneId, seen }) {
  if (!msg || msg.type !== RIG_MSG) return "not-mine";
  if (!RIG_OPS.includes(msg.op)) return "bad-op";
  if (msg.sceneId && sceneId && msg.sceneId !== sceneId) return "other-scene";
  if (seen && !seen.check(msg.id)) return "duplicate";
  return null;
}

/**
 * A motion's length and peak in ms for these options (speed included), or null for an unknown name.
 * Probes a throwaway animator, so it always agrees with what play() will really do.
 */
export function motionTiming(name, opts = {}) {
  const a = new RigAnimator();
  const h = a.play(name, opts, 0);
  const m = a.active[0];
  const out = m ? { durationMs: Math.round(m.dur * 1000), peakMs: Math.round(m.peak * 1000) } : null;
  h.cancel();
  return out;
}

/** The entrance beat a rig def asks for: onEntrance "roar" or { motion: "roar", ...opts }. */
export function entranceMotionOf(def) {
  const e = def?.onEntrance;
  if (!e) return null;
  if (typeof e === "string") return { motion: e, opts: {} };
  if (typeof e === "object" && typeof e.motion === "string") {
    const { motion, ...opts } = e;
    return { motion, opts };
  }
  return null;
}

/** Once per token per window: the entrance path may reach the beat twice (a style that falls back to a fade). */
export function createOncePer(windowMs = 8000) {
  const last = new Map();
  return (key, now = Date.now()) => {
    const t = last.get(key);
    if (t != null && now - t < windowMs) return false;
    last.set(key, now);
    if (last.size > 128) for (const [k, v] of last) if (now - v >= windowMs) last.delete(k);
    return true;
  };
}
