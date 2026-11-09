// grapple-hold.js — Grappled moves the held unit into its grappler's space.
//
// Grappled means the held unit shares the grappler's space (grappled.js has the
// rules). This module makes that visible by moving the held TOKEN to a slot
// beside its grappler (grapple-rules.js slotPosition), and back home when the
// hold ends. Approved look: claude.ai/artifact/FmUkx43vnEo8dtev1XjfyU (v4).
//
// It is a REAL token move, like the turn step (turn-start-cue.js): animation
// scripts read the token's live position, so every effect on or from the held
// unit plays at the held spot, and a dash-to-target starts and ends there.
//
//   pull     Grappled lands → after the grab beat, the token slides to a free
//            slot (up to four per grappler). Its home spot is saved on the token
//            (flags.<ns>.grappleHold = { home, slot, by: grapplerTokenUuid }).
//   follow   the grappler's token moves (turn step, step back, a formation
//            re-form, a crash walk-home) → its held units move with it.
//   release  Grappled leaves (Break Free, cleanse, Severed Tendrils, battle end,
//            a defeated grappler or held unit) → the token walks home.
//   heal     at every turn start: a held token not at its slot is put there, a
//            token with a saved home but no Grappled goes home (rewind, reload,
//            save/load, a GM drag).
//
// Rulings (user, 2026-11-10): a defeated grappler releases everyone it holds;
// a held unit that is knocked out is released too (releaseGrappleOnDown, called
// from defeat-reactor.js). A held unit skips its own turn step (turn-start-cue).
//
// Host GM only (the client holding the running director): every other client
// sees the moves through the token documents. The grip itself is drawn by
// grapple-grip-fx.js on every client.

import { log, warn } from "./logger.js";
import { isGrappled, grapplerOf, tokensGrappledBy, breakFree } from "./grappled.js";
import { slotPosition, sideOf, freeSlot, isAt } from "./grapple-rules.js";
import { NAME as CODE_BACKED_NAME } from "../shared/code-backed-content.js";

const NS = "fabula-ultima-companion";
const HOLD_FLAG = "grappleHold";
const STEP_FLAG = "turnStepHome";          // turn-start-cue.js
const GRAPPLED = CODE_BACKED_NAME.GRAPPLED.toLowerCase();
const PULL_DELAY_MS = 700;                 // the grab beat: the grip shoots out and wraps first
const PULL_MS = 560;
const RELEASE_DELAY_MS = 260;              // the grip snaps first
const RELEASE_MS = 620;
const FOLLOW_MS = 380;

let _getDirector = null;
let _installed = false;
const isHost = () => !!game.user?.isGM && !!_getDirector?.();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isGrappledAE = (e) => String(e?.name ?? "").trim().toLowerCase() === GRAPPLED;
const holdOf = (doc) => doc?.getFlag?.(NS, HOLD_FLAG) ?? null;
// Knocked out / defeated (HP 0): never held (ruling 2026-11-10: a KO releases).
const isDown = (actor) => { const hp = Number(actor?.system?.props?.current_hp); return Number.isFinite(hp) && hp <= 0; };

// Where a token really is: its saved position. While Foundry animates a move,
// doc.x / doc.y are the in-between values (measured 2026-11-10), so a follow
// read from them lands one move behind.
const posOf = (doc) => ({ x: Number(doc?._source?.x ?? doc?.x), y: Number(doc?._source?.y ?? doc?.y) });

// Drawn sprite size + where its feet are, in 2D scene px. From the texture
// ("contain" in the token box × texture scale), not the mesh: the idle bounce
// squashes the mesh, which made slots jitter by a few px.
function geometry(doc) {
  const grid = doc.parent?.grid?.size ?? canvas?.dimensions?.size ?? 100;
  const boxW = doc.width * grid, boxH = doc.height * grid;
  const sx = Math.abs(doc.texture?.scaleX ?? 1), sy = Math.abs(doc.texture?.scaleY ?? 1);
  let spriteW = boxW * sx, spriteH = boxH * sy;
  const tex = doc.object?.mesh?.texture;
  const tw = Number(tex?.width), th = Number(tex?.height);
  if (tw > 1 && th > 1) { const k = Math.min(boxW / tw, boxH / th); spriteW = tw * k * sx; spriteH = th * k * sy; }
  const p = posOf(doc);
  const cx = p.x + boxW / 2, cy = p.y + boxH / 2;
  return { grid, boxW, boxH, spriteW, spriteH, cx, feetY: cy + spriteH / 2 };
}

function edgeOf(grapplerDoc) {
  const v = Number(grapplerDoc.actor?.getFlag?.(NS, "grappleEdge"));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

/** Where `heldDoc` stands in `grapplerDoc`'s slot `index`, coming from `home`. */
export function slotFor(heldDoc, grapplerDoc, index, home = null) {
  const g = geometry(grapplerDoc), h = geometry(heldDoc);
  const from = home ? home.x + h.boxW / 2 : h.cx;
  const edge = edgeOf(grapplerDoc);
  return slotPosition({ grappler: g, held: h, side: sideOf(from, g.cx), index, grid: g.grid, ...(edge != null ? { edge } : {}) });
}

// The token of the grappler holding `actor`, on the held token's scene.
function grapplerTokenOf(actor, scene) {
  const by = grapplerOf(actor);
  if (!by) return null;
  let doc = null;
  try { doc = by.tokenUuid ? fromUuidSync(by.tokenUuid) : null; } catch { doc = null; }
  if (doc?.documentName === "Token" && doc.parent === scene) return doc;
  if (by.actorUuid) {
    // A linked actor ("Actor.<id>") can be found by id; a synthetic token actor only by its own uuid.
    const linkedId = /^Actor\.[^.]+$/.test(by.actorUuid) ? by.actorUuid.slice(6) : null;
    const hit = scene?.tokens?.find((t) => t.actor?.uuid === by.actorUuid || (linkedId && t.actorLink && t.actorId === linkedId));
    if (hit) return hit;
  }
  return null;
}

function tokensOf(actor) {
  if (!actor) return [];
  if (actor.isToken && actor.token) return [actor.token];
  try { return actor.getActiveTokens(false, true) ?? []; } catch { return []; }
}

function moveOpts(ms, easing = "easeInOutCosine") {
  return ms > 0 ? { oniBypassGate: true, fuGrapple: true, animation: { duration: ms, easing } }
    : { oniBypassGate: true, fuGrapple: true, animate: false };
}

/** Move a held token into its slot beside `grapplerDoc`. */
export async function pull(heldDoc, grapplerDoc, { ms = PULL_MS, easing = "easeInCircle" } = {}) {
  if (!heldDoc || !grapplerDoc || heldDoc.parent !== grapplerDoc.parent) return false;
  if (isDown(heldDoc.actor)) return false;
  // A bigger body than its grappler is not carried off (a giant stays put; the grip still shows).
  if (heldDoc.width > grapplerDoc.width || heldDoc.height > grapplerDoc.height) return false;
  const scene = heldDoc.parent;
  const hold = holdOf(heldDoc);
  const same = hold?.by === grapplerDoc.uuid;
  const taken = scene.tokens.filter((t) => t.id !== heldDoc.id && holdOf(t)?.by === grapplerDoc.uuid).map((t) => holdOf(t).slot);
  const slot = same && Number.isInteger(hold.slot) ? hold.slot : freeSlot(taken);
  // Home: where it stood before any hold; if it was on its turn-step spot, the spot behind that.
  const step = heldDoc.getFlag?.(NS, STEP_FLAG);
  const home = hold?.home ?? (step && Number.isFinite(Number(step.x)) ? { x: Number(step.x), y: Number(step.y) } : posOf(heldDoc));
  const pos = slotFor(heldDoc, grapplerDoc, slot, home);
  // 12 px: a pose swap changes the texture shape a little; never nudge a held unit for that.
  if (same && isAt(posOf(heldDoc), pos, 12)) return false;
  const change = { x: pos.x, y: pos.y, [`flags.${NS}.${HOLD_FLAG}`]: { home, slot, by: grapplerDoc.uuid } };
  if (step) change[`flags.${NS}.-=${STEP_FLAG}`] = null;
  await heldDoc.update(change, moveOpts(ms, easing));
  return true;
}

/** Walk a token with a saved home back to it and drop the hold flag. */
export async function release(heldDoc, { ms = RELEASE_MS } = {}) {
  const hold = holdOf(heldDoc);
  if (!hold) return false;
  const change = { [`flags.${NS}.-=${HOLD_FLAG}`]: null };
  if (Number.isFinite(Number(hold.home?.x))) change.x = Number(hold.home.x);
  if (Number.isFinite(Number(hold.home?.y))) change.y = Number(hold.home.y);
  await heldDoc.update(change, moveOpts(ms, "easeInOutCosine"));
  return true;
}

/**
 * Put every token on `scene` where its hold says it should be: held units in
 * their slot, freed ones home. Run at turn start (after the turn-step walk
 * home) so a rewind, reload or save/load never leaves a unit stranded.
 */
export async function reconcileGrapples(scene, { ms = 300 } = {}) {
  if (!scene || !game.user?.isGM) return 0;
  let n = 0;
  for (const doc of scene.tokens?.contents ?? []) {
    try {
      const actor = doc.actor;
      const held = actor && isGrappled(actor) && !isDown(actor);
      const g = held ? grapplerTokenOf(actor, scene) : null;
      if (g) { if (await pull(doc, g, { ms, easing: "easeInOutCosine" })) n++; }
      else if (holdOf(doc)) { if (await release(doc, { ms })) n++; }
    } catch (e) { warn(`[grapple-hold] reconcile failed for ${doc?.name}`, e); }
  }
  if (n) log(`[grapple-hold] reconcile: ${n} token(s) put back in place`);
  return n;
}

/** Battle end / stop: every held token goes home (the hold is over). */
export async function releaseAllGrapples(scene, { animate = true } = {}) {
  if (!scene || !game.user?.isGM) return 0;
  let n = 0;
  for (const doc of scene.tokens?.contents ?? []) {
    try { if (holdOf(doc) && await release(doc, { ms: animate ? RELEASE_MS : 0 })) n++; }
    catch (e) { warn(`[grapple-hold] release failed for ${doc?.name}`, e); }
  }
  if (n) log(`[grapple-hold] battle over: ${n} held token(s) sent home`);
  return n;
}

/**
 * A creature just went down (HP 0). Rulings 2026-11-10: a defeated grappler
 * releases everyone it holds, and a knocked-out held unit is released.
 * Removing the Grappled AEs is enough: the delete hook below walks them home.
 */
export async function releaseGrappleOnDown(actor) {
  if (!actor) return 0;
  let n = 0;
  try { if (isGrappled(actor)) n += await breakFree(actor, { reason: "knocked out" }); }
  catch (e) { warn(`[grapple-hold] KO release failed for ${actor.name}`, e); }
  const tokenUuid = tokensOf(actor)[0]?.uuid ?? null;
  for (const td of tokensGrappledBy({ actorUuid: actor.uuid, tokenUuid })) {
    try { if (td.actor) n += await breakFree(td.actor, { reason: `${actor.name} defeated` }); }
    catch (e) { warn(`[grapple-hold] defeated-grappler release failed for ${td?.name}`, e); }
  }
  if (n) log(`[grapple-hold] ${actor.name} went down: ${n} Grappled AE(s) removed`);
  return n;
}

async function onGrappledAdded(effect) {
  const actor = effect?.parent;
  if (!(actor instanceof Actor)) return;
  await sleep(PULL_DELAY_MS);
  for (const doc of tokensOf(actor)) {
    const g = grapplerTokenOf(actor, doc.parent);
    if (g) await pull(doc, g);
  }
}

async function onGrappledGone(effect) {
  const actor = effect?.parent;
  if (!(actor instanceof Actor) || isGrappled(actor)) return;   // another Grappled still holds it
  await sleep(RELEASE_DELAY_MS);
  if (isGrappled(actor)) return;
  for (const doc of tokensOf(actor)) await release(doc);
}

// The grappler moved on its own (not by us): its held units come along, in step.
async function onGrapplerMoved(doc, change, options) {
  if (options?.fuGrapple) return;
  const held = doc.parent?.tokens?.filter((t) => holdOf(t)?.by === doc.uuid) ?? [];
  if (!held.length) return;
  const ms = options?.animate === false ? 0 : Number(options?.animation?.duration ?? FOLLOW_MS);
  const easing = options?.animation?.easing ?? "easeInOutCosine";
  for (const t of held) {
    try { if (t.actor && isGrappled(t.actor)) await pull(t, doc, { ms, easing }); }
    catch (e) { warn(`[grapple-hold] follow failed for ${t?.name}`, e); }
  }
}

/** Install the hooks once (every client; they act only on the host GM). */
export function installGrappleHold({ getActiveDirector } = {}) {
  if (_installed) return;
  _installed = true;
  _getDirector = typeof getActiveDirector === "function" ? getActiveDirector : null;
  const run = (fn, label) => (...args) => {
    try { if (!isHost()) return; fn(...args).catch((e) => warn(`[grapple-hold] ${label} threw`, e)); }
    catch (e) { warn(`[grapple-hold] ${label} hook threw`, e); }
  };
  Hooks.on("createActiveEffect", run(async (effect) => { if (isGrappledAE(effect) && !effect.disabled) await onGrappledAdded(effect); }, "pull"));
  Hooks.on("deleteActiveEffect", run(async (effect) => { if (isGrappledAE(effect)) await onGrappledGone(effect); }, "release"));
  Hooks.on("updateActiveEffect", run(async (effect, change) => {
    if (!isGrappledAE(effect) || !("disabled" in (change ?? {}))) return;
    if (effect.disabled) await onGrappledGone(effect); else await onGrappledAdded(effect);
  }, "toggle"));
  Hooks.on("updateToken", run(async (doc, change, options) => {
    if (("x" in (change ?? {})) || ("y" in (change ?? {}))) await onGrapplerMoved(doc, change, options);
  }, "follow"));
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.grappleHold = { pull, release, slotFor, reconcileGrapples, releaseAllGrapples, releaseGrappleOnDown };
  log("[grapple-hold] installed");
}
