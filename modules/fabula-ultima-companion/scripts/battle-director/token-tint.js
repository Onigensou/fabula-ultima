// AE-driven token body tint — a creature's sprite takes on a colour for as long
// as an Active Effect says so.
//
// Built for King Gorger's Elemental Overflow: the companion belches a Wellspring
// onto the Field and its body glows that element's colour until the Wellspring
// runs out. "Until it runs out" is the LIFETIME OF AN AE (the 1-round Field AE
// the chain applies), so the tint is bound to that AE rather than to the
// one-shot wave cinematic — a replaced Wellspring recolours, an expired one
// clears, and an F5 mid-fight comes back tinted.
//
// Deliberately GENERIC: any AE on any actor can carry it.
//
//   flags.fabula-ultima-companion.tokenTint         "#rrggbb" / css colour — the tint
//   flags.fabula-ultima-companion.tokenTintMode     "multiply" (default) | "recolor"
//   flags.fabula-ultima-companion.tokenTintTarget   "bearer" (default) | "applier"
//   flags.fabula-ultima-companion.tokenTintStrength 0..1 (default 1)
//
// Two MODES, because "tint the body" means two different things:
//   multiply — classic mesh.tint: every pixel is multiplied by the colour, so a
//              white belly turns the colour too and the whole sprite is dyed
//              (a Frozen-blue / Poisoned-green status wash).
//   recolor  — a fragment-shader filter that keys on SATURATION: pixels that
//              already carry colour are re-hued to the tint colour at their own
//              brightness, while white / grey / black pixels (highlights, outlines)
//              are left exactly as drawn. The sprite keeps its shading and its
//              whites and only "changes element" (King Gorger's rainbow scales →
//              ice-blue scales, belly still white). `tokenTintStrength` is the
//              mix amount in both modes.
//
// `applier` tints the token of the actor that APPLIED the AE (read from the
// director's `directorAppliedBy.reactorActorUuid` stamp) instead of its bearer.
// That is the Field case: the Wellspring AE lives on the hidden Field actor,
// but the creature that should glow is the one that produced it.
//
// ARCHITECTURE — same shape as aspect-aura.js:
//   - Fully AE-replication-driven: the AE replicates to every client, each
//     client resolves its own tints off create/update/deleteActiveEffect. Zero
//     socket traffic; F5-safe via the canvasReady rescan.
//   - multiply writes `token.mesh.tint` (composed with the document's own texture
//     tint); recolor pushes ONE shared filter instance onto `token.mesh.filters`.
//     Foundry re-stamps mesh.tint from the document on every refresh
//     (_refreshMesh), so the refreshToken / drawToken hooks re-assert; a
//     per-frame ticker runs ONLY while a tint is fading in/out.
//   - Fade: ~500 ms in, ~700 ms out, so a Wellspring swap reads as a wash rather
//     than a hard cut.
//
// Cinematic clones (oni.cloneToken) copy mesh.tint AND mesh.filters, so a tinted
// body stays tinted through its own animation.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

const FADE_IN_MS = 500;
const FADE_OUT_MS = 700;

// tokenId -> { mode, color:[r,g,b], strength, cur, from, tgt (progress 0..1), t0, dur }
const _tints = new Map();
let _tickerOn = false;
let _hooksOn = false;

/* ── Colour helpers ─────────────────────────────────────────────────────── */

const WHITE = [1, 1, 1];

function parseColor(css) {
  try {
    const c = foundry.utils.Color.from(css);
    if (!Number.isFinite(Number(c))) return null;
    return [c.r, c.g, c.b];
  } catch { return null; }
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mul3(a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; }
function toHexNumber(rgb) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(rgb[0]) << 16) | (q(rgb[1]) << 8) | q(rgb[2]);
}
function same3(a, b) { return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3; }

/* ── Recolor filter ─────────────────────────────────────────────────────── */
//
// Saturation-keyed hue replacement. For each pixel: s = HSV saturation, l =
// luminance. Neutral pixels (s below uSatFloor) pass through; saturated ones
// become the tint colour scaled to the pixel's own luminance (so shading, the
// darker scale edges and the bright highlights survive), mixed by uStrength.
// Premultiplied alpha is unpacked / repacked around the maths.
const RECOLOR_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 uTint;
uniform float uStrength;
uniform float uSatFloor;
void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.001) { gl_FragColor = c; return; }
  vec3 rgb = c.rgb / c.a;
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float sat = mx <= 0.0 ? 0.0 : (mx - mn) / mx;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float lum = dot(rgb, LUMA);
  vec3 target = clamp(uTint * (lum / max(dot(uTint, LUMA), 0.0001)), 0.0, 1.0);
  float m = smoothstep(uSatFloor, uSatFloor + 0.25, sat) * uStrength;
  vec3 o = mix(rgb, target, m);
  gl_FragColor = vec4(o * c.a, c.a);
}`;

// Built lazily: PIXI is a canvas-time global, and this module is imported at
// boot by director-boot before any filter is needed.
let _RecolorFilter = null;
function makeRecolorFilter() {
  if (!_RecolorFilter) {
    _RecolorFilter = class RecolorFilter extends PIXI.Filter {
      constructor() {
        super(undefined, RECOLOR_FRAG, { uTint: [1, 1, 1], uStrength: 0, uSatFloor: 0.18 });
        this.fudTokenTint = true;
      }
    };
  }
  return new _RecolorFilter();
}

/* ── Reading the flag ───────────────────────────────────────────────────── */

function tintFlagOf(effect) {
  const f = effect?.flags?.[FLAG_NS];
  const raw = f?.tokenTint;
  if (!raw || effect?.disabled) return null;
  const rgb = parseColor(raw);
  if (!rgb) return null;
  let strength = Number(f.tokenTintStrength);
  if (!Number.isFinite(strength)) strength = 1;
  strength = Math.max(0, Math.min(1, strength));
  return {
    color: rgb,
    strength,
    mode: String(f.tokenTintMode ?? "multiply").trim().toLowerCase() === "recolor" ? "recolor" : "multiply",
    target: String(f.tokenTintTarget ?? "bearer").trim().toLowerCase() === "applier" ? "applier" : "bearer",
    applierActorUuid: f.directorAppliedBy?.reactorActorUuid ?? null,
  };
}

// Every actor whose AEs could tint SOMEONE: world actors (the Field is one) plus
// unlinked token actors on the current canvas. Event-driven, never per-frame.
function* candidateBearers() {
  const seen = new Set();
  for (const a of game.actors?.contents ?? []) { if (a && !seen.has(a.uuid)) { seen.add(a.uuid); yield a; } }
  for (const t of canvas?.tokens?.placeables ?? []) {
    const a = t?.actor;
    if (a && !seen.has(a.uuid)) { seen.add(a.uuid); yield a; }
  }
}

// Desired tint spec for an actor ({ color, strength, mode } or null): its own
// bearer-mode AEs first, else any applier-mode AE anywhere that names it. First
// match wins (replace_family keeps one anyway).
export function readTokenTint(actor) {
  if (!actor) return null;
  try {
    for (const e of actor.effects ?? []) {
      const spec = tintFlagOf(e);
      if (spec?.target === "bearer") return spec;
    }
  } catch { /* fall through */ }
  for (const bearer of candidateBearers()) {
    let effects = [];
    try { effects = [...(bearer.effects ?? [])]; } catch { continue; }
    for (const e of effects) {
      const spec = tintFlagOf(e);
      if (spec?.target === "applier" && spec.applierActorUuid === actor.uuid) return spec;
    }
  }
  return null;
}

/* ── Apply ──────────────────────────────────────────────────────────────── */

function docTintOf(token) {
  try {
    const c = foundry.utils.Color.from(token.document?.texture?.tint ?? 0xFFFFFF);
    return Number.isFinite(Number(c)) ? [c.r, c.g, c.b] : WHITE;
  } catch { return WHITE; }
}

function setFilter(mesh, on, color, amount) {
  const existing = (mesh.filters ?? []).find((f) => f?.fudTokenTint);
  if (on) {
    const f = existing ?? makeRecolorFilter();
    f.uniforms.uTint = color;
    f.uniforms.uStrength = amount;
    if (!existing) mesh.filters = [...(mesh.filters ?? []), f];
  } else if (existing) {
    const rest = (mesh.filters ?? []).filter((f) => f !== existing);
    mesh.filters = rest.length ? rest : null;
    try { existing.destroy(); } catch {}
  }
}

// Write the record's CURRENT state onto the mesh (progress-scaled).
function applyRec(token, rec) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return;
  const amount = rec ? rec.strength * rec.cur : 0;
  try {
    if (rec?.mode === "recolor") {
      mesh.tint = toHexNumber(docTintOf(token));
      // Attach the filter as soon as the record exists — even at progress 0 —
      // so a cinematic clone taken in the same tick the AE lands (oni.cloneToken
      // copies mesh.filters) carries it and fades in along with the real mesh.
      setFilter(mesh, true, rec.color, amount);
    } else {
      setFilter(mesh, false);
      mesh.tint = toHexNumber(mul3(docTintOf(token), rec ? lerp3(WHITE, rec.color, amount) : WHITE));
    }
  } catch {}
}

function ensureTicker() {
  if (_tickerOn) return;
  try { canvas.app.ticker.add(tintTick); _tickerOn = true; } catch {}
}
function dropTicker() {
  if (!_tickerOn) return;
  try { canvas.app.ticker.remove(tintTick); } catch {}
  _tickerOn = false;
}

function tintTick() {
  if (!_tints.size) { dropTicker(); return; }
  const now = performance.now();
  let animating = false;
  for (const [tokenId, rec] of _tints) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) { _tints.delete(tokenId); continue; }
    const t = rec.dur > 0 ? Math.min(1, (now - rec.t0) / rec.dur) : 1;
    rec.cur = rec.from + (rec.tgt - rec.from) * t;
    applyRec(token, rec);
    if (t < 1) animating = true;
    else if (rec.tgt === 0) {
      // Faded back to neutral — hand the mesh back to Foundry's own tint.
      _tints.delete(tokenId);
      applyRec(token, null);
    }
  }
  if (!animating) dropTicker();
}

// Steer a token toward `spec` (null = back to neutral) with a fade.
function setTokenTint(token, spec) {
  if (!token?.id) return;
  const rec = _tints.get(token.id);
  if (spec) {
    if (rec && rec.mode === spec.mode && same3(rec.color, spec.color) && rec.strength === spec.strength && rec.tgt === 1) return;
    if (rec && rec.mode === spec.mode) {
      // Colour / strength swap in the same mode: cross-fade the progress from
      // wherever it is, re-pointed at the new colour.
      rec.color = spec.color; rec.strength = spec.strength;
      rec.from = rec.cur; rec.tgt = 1; rec.t0 = performance.now(); rec.dur = FADE_IN_MS;
    } else {
      if (rec) applyRec(token, null); // mode change: drop the old representation first
      _tints.set(token.id, { mode: spec.mode, color: spec.color, strength: spec.strength, cur: 0, from: 0, tgt: 1, t0: performance.now(), dur: FADE_IN_MS });
    }
  } else {
    if (!rec || rec.tgt === 0) return; // already neutral / fading out
    rec.from = rec.cur; rec.tgt = 0; rec.t0 = performance.now(); rec.dur = FADE_OUT_MS;
  }
  ensureTicker();
}

/* ── Sync ───────────────────────────────────────────────────────────────── */

export function syncActorTint(actor) {
  if (!actor) return;
  const spec = readTokenTint(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch {}
  for (const token of tokens) setTokenTint(token, spec);
}

async function syncActorByUuid(uuid) {
  if (!uuid) return;
  try {
    const doc = await fromUuid(uuid);
    const actor = doc?.documentName === "Actor" ? doc : doc?.actor ?? null;
    if (actor) syncActorTint(actor);
  } catch (e) { warn("token-tint: sync by uuid threw", e); }
}

function rescanCanvas() {
  // Snap (no fade) on a rescan — this is "restore what should already be there".
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (!token?.actor) continue;
    const spec = readTokenTint(token.actor);
    if (spec) {
      const rec = { mode: spec.mode, color: spec.color, strength: spec.strength, cur: 1, from: 1, tgt: 1, t0: performance.now(), dur: 0 };
      _tints.set(token.id, rec);
      applyRec(token, rec);
    } else if (_tints.has(token.id)) {
      _tints.delete(token.id);
      applyRec(token, null);
    }
  }
  if (_tints.size) log(`token-tint: rescan — ${_tints.size} tinted token(s) on ${canvas?.scene?.name ?? "?"}`);
}

// Exported for manual probing / recovery (FUCompanion console use).
export function rescanTokenTints() { rescanCanvas(); }
export function tintedTokenIds() { return Array.from(_tints.keys()); }

/* ── Boot ───────────────────────────────────────────────────────────────── */

// Idempotent — called on every client from director-boot's ready hook.
export function initTokenTint() {
  if (_hooksOn) return;
  _hooksOn = true;

  // An AE event touches at most two actors: the bearer (bearer mode) and the
  // stamped applier (applier mode). On DELETE the flag is still readable off
  // the deleted document, so the applier can be resolved and cleared.
  const onAeEvent = (effect) => {
    if (!effect?.flags?.[FLAG_NS]?.tokenTint) return;
    const bearer = effect.parent?.documentName === "Actor" ? effect.parent : null;
    if (bearer) syncActorTint(bearer);
    const applier = effect.flags?.[FLAG_NS]?.directorAppliedBy?.reactorActorUuid ?? null;
    if (applier && applier !== bearer?.uuid) syncActorByUuid(applier);
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  // Foundry re-stamps mesh.tint from the document on every refresh / redraw
  // (and a redraw builds a fresh mesh with no filters); re-assert ours. Cheap:
  // a Map lookup per refresh, a write only when tinted.
  const reassert = (token) => {
    const rec = _tints.get(token?.id);
    if (rec) applyRec(token, rec);
  };
  Hooks.on("refreshToken", reassert);
  Hooks.on("drawToken", reassert);
  Hooks.on("destroyToken", (token) => { _tints.delete(token?.id); });

  // Token spawned mid-scene (director PREP spawns, summons) whose actor is
  // already tinted. Defer so the mesh exists before the first write.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor) return;
    setTimeout(() => {
      try { syncActorTint(tokenDoc.actor); }
      catch (e) { warn("token-tint: createToken sync threw", e); }
    }, 100);
  });

  Hooks.on("canvasTearDown", () => { _tints.clear(); dropTicker(); });
  Hooks.on("canvasReady", () => {
    setTimeout(() => {
      try { rescanCanvas(); }
      catch (e) { warn("token-tint: canvasReady rescan threw", e); }
    }, 250);
  });

  if (canvas?.ready) rescanCanvas();
  setTimeout(() => {
    try { rescanCanvas(); }
    catch (e) { warn("token-tint: deferred boot rescan threw", e); }
  }, 3000);

  try {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.tokenTint = { rescan: rescanCanvas, read: readTokenTint, tintedTokenIds };
  } catch {}

  log("token-tint: watcher installed");
}
