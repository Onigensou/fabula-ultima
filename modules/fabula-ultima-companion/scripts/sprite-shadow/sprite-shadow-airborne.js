// ============================================================================
// FabulaUltimaCompanion — Sprite Shadow (airborne: Flying ↔ hover ↔ shadow lift)
// File: scripts/sprite-shadow/sprite-shadow-airborne.js
// Foundry VTT v12
//
// Two jobs, both keyed on the engine's own airborne predicate
// (`targetIsFlying` in battle-director/snapshot.js: the Flying status / an AE
// named "Flying", suppressed while a `flying_grounded` AE — Grounded — is on):
//
// 1. FLYING → FLOATING ANIMATION. Today the idle-animation "Float" is a
//    per-actor cosmetic flag and is NOT tied to Flying (Pyrefly, Mana Ray,
//    Banestrix fly with no animation at all). While a token is airborne this
//    module keeps a TokenMagic `transform` filter on it, `fudFlyLift`: a
//    constant upward `translationY` bias (the body hovers ABOVE its ground
//    position instead of bobbing through it) plus, when the actor has no Float
//    of its own, the same gentle bob the idle Float uses. Actors that already
//    float keep their animation untouched (`liftForFloaters: false`) — nothing
//    that exists changes. Filters persist into token flags and replicate, so
//    exactly ONE writer (the active GM, the idle-animation rule) adds/removes;
//    every client renders from the synced flag.
//
// 2. SHADOW LIFT. A TokenMagic transform shifts UVs inside the filter frame
//    (mesh bounds + 2 × padding); `token.mesh` itself never moves, so the
//    rendered shadow stays planted on the ground by construction. This module
//    registers a lift provider that reads the LIVE uniform every frame:
//        lift = translationY × (mesh.height + 2 × padding)
//    summed over the Float and fly filters, so the shadow shrinks/fades with
//    the bob — the coupling that sells height. Zero when the body dips below
//    its ground line.
//
//   FUCompanion.api.spriteShadow.airborne = { FLY, isAirborne, reconcile, reconcileAll }
// ============================================================================

import { registerLiftProvider } from "./sprite-shadow-renderer.js";

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[FUC][SpriteShadow][airborne]";
const warn = (...a) => console.warn(TAG, ...a);

const FLY_FILTER_ID = "fudFlyLift";
const FLOAT_FILTER_ID = "oniIdleFloat";   // idle-animation-logic.js

/** Tunables (live). Translations are fractions of the TokenMagic filter frame. */
export const FLY = {
  bias: 0.08,             // hover height while airborne
  bob: 0.05,              // bob amplitude (matches the idle Float) …
  bobMs: 3000,            // … and period; only added when the actor has no Float of its own
  liftForFloaters: false, // leave actors that already Float exactly as they are
  sign: 1,                // +1: positive translationY draws the body HIGHER (verified live)
  minPadding: 50,
};

// ── Airborne predicate (engine truth, loaded lazily) ─────────────────────────
let _targetIsFlying = null;
function fallbackIsFlying(actor) {
  const effs = actor?.appliedEffects ?? actor?.effects?.contents ?? [];
  for (const ae of effs) if (!ae.disabled && (ae.changes ?? []).some((c) => c?.key === "flying_grounded")) return false;
  return effs.some((e) => !e.disabled && String(e.name ?? "").trim().toLowerCase() === "flying");
}
async function loadPredicate() {
  try {
    const m = await import("../battle-director/snapshot.js");
    if (typeof m.targetIsFlying === "function") _targetIsFlying = m.targetIsFlying;
  } catch (e) {
    warn("snapshot.js targetIsFlying unavailable — using the name-based fallback", e);
  }
  if (!_targetIsFlying) _targetIsFlying = fallbackIsFlying;
}
export function isAirborne(token) {
  const actor = token?.actor;
  if (!actor) return false;
  try { return !!(_targetIsFlying ?? fallbackIsFlying)(actor); } catch (_) { return false; }
}

// ── TokenMagic plumbing ──────────────────────────────────────────────────────
const TM = () => globalThis.TokenMagic;
function isAuthority() {
  const activeGM = game.users?.find((u) => u.isGM && u.active);
  return !!activeGM && game.user === activeGM;
}
function hasFilter(token, id) {
  try { return TM()?.hasFilterId?.(token, id) === true; } catch (_) { return false; }
}
function paddingFor(token) {
  // Frame = h + 2p; the shift t·(h + 2p) must fit inside p → p ≥ t·h / (1 − 2t).
  const t = Math.abs(FLY.bias) + FLY.bob, h = token?.mesh?.height ?? 0;
  return Math.max(FLY.minPadding, Math.ceil((t * h) / Math.max(0.2, 1 - 2 * t)) + 16);
}
function flyParams(token) {
  const ownFloat = hasFilter(token, FLOAT_FILTER_ID);
  const p = { filterType: "transform", filterId: FLY_FILTER_ID, padding: paddingFor(token), translationY: FLY.sign * FLY.bias };
  if (!ownFloat) {
    p.animated = { translationY: { animType: "cosOscillation", val1: FLY.sign * (FLY.bias - FLY.bob), val2: FLY.sign * (FLY.bias + FLY.bob), loopDuration: FLY.bobMs } };
  }
  return p;
}

const _locks = new Set();
export async function reconcile(token) {
  if (!token?.document || token.destroyed || !canvas?.ready) return;
  const fly = isAirborne(token);
  const has = hasFilter(token, FLY_FILTER_ID);
  if (!TM() || !isAuthority() || _locks.has(token.id)) return;
  const want = fly && (FLY.liftForFloaters || !hasFilter(token, FLOAT_FILTER_ID));
  if (want === has) return;
  _locks.add(token.id);
  try {
    if (want) await TM().addUpdateFilters(token, [flyParams(token)]);
    else await TM().deleteFilters(token, FLY_FILTER_ID);
  } catch (e) {
    warn("filter update failed", token.name, e);
  } finally {
    _locks.delete(token.id);
  }
}
export function reconcileAll() {
  if (!canvas?.ready) return;
  for (const t of canvas.tokens?.placeables ?? []) reconcile(t);
}
function reconcileActor(actor) {
  if (!actor || !canvas?.ready) return;
  const base = actor.isToken ? (actor.token?.baseActor ?? actor) : actor;
  for (const t of canvas.tokens.placeables) {
    const a = t.actor;
    if (!a) continue;
    if (a === actor || a === base || (a.isToken ? a.token?.baseActor : a) === base) reconcile(t);
  }
}
const _pending = new Set();
function scheduleActor(actor) {
  if (!actor || _pending.has(actor)) return;
  _pending.add(actor);
  setTimeout(() => { _pending.delete(actor); try { reconcileActor(actor); } catch (e) { warn("reconcileActor threw", e); } }, 50);
}
function actorOfDoc(doc) {
  let d = doc;
  for (let i = 0; i < 3 && d; i++) { if (d.documentName === "Actor") return d; d = d.parent; }
  return null;
}

// ── Lift provider: what the filters are drawing THIS frame ───────────────────
function liftOf(token) {
  const mesh = token?.mesh;
  const filters = mesh?.filters;
  if (!filters?.length) return 0;
  let t = 0, pad = 0, any = false;
  for (const f of filters) {
    if (f?.filterId !== FLY_FILTER_ID && f?.filterId !== FLOAT_FILTER_ID) continue;
    t += Number(f.translationY) || 0;
    pad = Math.max(pad, Number(f.padding) || 0);
    any = true;
  }
  if (!any) return 0;
  const lift = FLY.sign * t * (mesh.height + 2 * pad);
  return lift > 0 ? lift : 0;
}

// ── Wiring ───────────────────────────────────────────────────────────────────
Hooks.once("ready", async () => {
  await loadPredicate();
  registerLiftProvider(liftOf);
  for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(h, (eff) => scheduleActor(actorOfDoc(eff?.parent)));
  }
  for (const h of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(h, (item) => scheduleActor(actorOfDoc(item?.parent)));
  }
  Hooks.on("updateActor", (actor) => scheduleActor(actor));
  Hooks.on("drawToken", (token) => setTimeout(() => reconcile(token), 250));
  Hooks.on("canvasReady", () => setTimeout(reconcileAll, 800));
  if (canvas?.ready) setTimeout(reconcileAll, 800);

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  const api = (globalThis.FUCompanion.api.spriteShadow ||= {});
  api.airborne = { FLY, isAirborne, reconcile, reconcileAll, liftOf, FLY_FILTER_ID };
});
