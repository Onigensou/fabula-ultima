// Elemental Aspect Aura — persistent particle halo showing which element a
// creature is currently attuned to.
//
// Built for the Asura (Valley of the Dragon), whose Elemental Aspect passive
// swaps its Aspect every time it takes elemental damage, and whose Elemental
// Slash changes rider on that Aspect. Without a visual the players have no way
// to read which element is loaded — the information only existed in the effects
// tray. The aura is that tell: fire embers rise, bolt sparks jitter, ice motes
// drift down, air motes swirl sideways.
//
// Deliberately GENERIC, not Asura-specific: it keys off any AE named
// "<Element> Aspect", so any future monster that adopts the same AE naming gets
// the aura for free with no code change.
//
// ARCHITECTURE — copied wholesale from domination-crest.js, which solved all of
// these problems already:
//   - Per-token position:fixed DOM anchored to token.mesh.getBounds(), the
//     RENDERED sprite rect, re-measured every frame so pan / zoom / token scale
//     / anchor / mirroring all track for free. Nominal grid bounds are wrong on
//     any monster with a non-1.0 token scale, which is most of them.
//   - Fully AE-replication-driven: the Aspect AE replicates to every client, so
//     each client renders its own aura off create/update/deleteActiveEffect.
//     Zero socket traffic for state; F5-safe via the canvasReady rescan.
//   - z-index under 100 so Foundry app windows still cover it.
//
// The one piece of socket traffic is the cinematic hide, which mirrors the
// crest's: the FSM's ANIMATION state tells every client to fade auras out so
// they never sit on top of an action cinematic.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";
const STYLE_ID = "fud-aspect-aura-style";

// Under the dominance crest (60) — when a boss has both, the crest is the
// readable one and should win. Still under Foundry app windows (>= 100).
const AURA_Z_INDEX = 55;

const ACTION_AURA_VIS = "FU_ASPECT_AURA_VIS";

// How many motes per aura. Enough to read as a continuous effect, few enough
// that four on-screen auras cost nothing (these are CSS-animated divs, not
// PIXI — the compositor does the work, not the ticker).
const MOTE_COUNT = 14;

// Per-element look. `dy` is the drift direction in px over the mote's life
// (negative = rises), `sway` the horizontal wander amplitude, `dur` the base
// mote lifetime in ms. Slow and smooth on purpose — these sit on screen for
// whole rounds, so anything fast reads as noise rather than atmosphere.
const ASPECTS = {
  fire: { color: "#ff8a3d", glow: "rgba(255,110,30,.30)", dy: -46, sway: 7,  dur: 2600, size: 6 },
  bolt: { color: "#ffe75a", glow: "rgba(255,225,60,.28)", dy: -30, sway: 14, dur: 1500, size: 5 },
  ice:  { color: "#8fe2ff", glow: "rgba(120,210,255,.28)", dy: 40,  sway: 9,  dur: 3400, size: 6 },
  air:  { color: "#c6ffe4", glow: "rgba(180,255,220,.24)", dy: -14, sway: 26, dur: 3000, size: 5 },
};

const _auras = new Map(); // tokenId -> { el, motes, glow, aspect, missingFrames }
let _tickerOn = false;
let _hooksOn = false;
let _socket = null;
let _hiddenByAnimation = false;

/* ── Cinematic hide ─────────────────────────────────────────────────────── */

// Local apply — runs on every client (socket handler + GM local call).
export function setAurasHiddenLocal(hidden) {
  _hiddenByAnimation = !!hidden;
  for (const rec of _auras.values()) {
    try { rec.el.classList.toggle("is-anim-hidden", _hiddenByAnimation); } catch {}
  }
}

// GM-side emit — fade auras on ALL clients while an action animation plays.
// Called from the FSM ANIMATION state alongside the crest's equivalent.
export function emitAurasHidden(hidden) {
  try { setAurasHiddenLocal(hidden); }
  catch (e) { warn("emitAurasHidden: local apply threw", e); }
  try { _socket?.executeForOthers?.(ACTION_AURA_VIS, !!hidden); }
  catch (e) { warn("emitAurasHidden: broadcast failed", e); }
}

/* ── Styles ─────────────────────────────────────────────────────────────── */

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.fud-aspect-aura {
  position: fixed; pointer-events: none;
  transform: translate(-50%, -50%);
  z-index: ${AURA_Z_INDEX};
  transition: opacity .45s ease;
}
/* Same cinematic etiquette as the dominance crest: fade out while an action
   animation plays so the aura never sits on top of a cinematic. !important
   beats the per-frame inline opacity the tracker writes; position tracking
   keeps running so it fades back in exactly in place. */
.fud-aspect-aura.is-anim-hidden { opacity: 0 !important; }

/* Soft elemental wash centred on the sprite, so the aura still reads at a
   glance when the individual motes are between cycles. */
.fud-aspect-aura .aura-glow {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, var(--aura-glow) 0%, transparent 70%);
  animation: fud-aura-breathe 4.2s ease-in-out infinite;
}
@keyframes fud-aura-breathe {
  0%, 100% { opacity: .55; }
  50%      { opacity: 1; }
}

.fud-aspect-aura .mote {
  position: absolute; left: 50%; top: 50%;
  border-radius: 50%;
  background: var(--aura-color);
  box-shadow: 0 0 6px 2px var(--aura-color);
  opacity: 0;
  animation-name: fud-aura-mote;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
/* Rise/fall + sway + fade, all driven off per-mote custom properties so one
   keyframe set covers every element. */
@keyframes fud-aura-mote {
  0%   { transform: translate(calc(var(--mx) * 1px), 0) scale(.5); opacity: 0; }
  18%  { opacity: .95; }
  70%  { opacity: .7; }
  100% {
    transform: translate(calc((var(--mx) + var(--sway)) * 1px), calc(var(--dy) * 1px)) scale(1.05);
    opacity: 0;
  }
}

/* Aspect swap — one quick bloom so the change is noticed at the table. */
.fud-aspect-aura.is-swapping .aura-glow {
  animation: fud-aura-swap .9s cubic-bezier(.16,1,.3,1) 1,
             fud-aura-breathe 4.2s ease-in-out .9s infinite;
}
@keyframes fud-aura-swap {
  0%   { opacity: 1; transform: translate(-50%, -50%) scale(1.9); filter: brightness(2.4); }
  100% { opacity: .55; transform: translate(-50%, -50%) scale(1); filter: brightness(1); }
}
`;
  document.head.appendChild(el);
}

/* ── Aspect state ───────────────────────────────────────────────────────── */

// Aspect AEs are named "<Element> Aspect" (Fire Aspect, Bolt Aspect, …) and are
// applied with ae_duplicate_mode "replace", so at most one is ever present.
// Returns the lowercase element key, or null.
export function readAspect(actor) {
  let effects = [];
  try { effects = [...(actor?.effects ?? [])]; } catch { return null; }
  for (const e of effects) {
    if (e?.disabled) continue;
    const m = /^\s*(fire|bolt|ice|air)\s+aspect\s*$/i.exec(String(e?.name ?? ""));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/* ── Positioning ────────────────────────────────────────────────────────── */

// mesh.getBounds() is renderer-space (post worldTransform), so offsetting by
// the canvas element's client rect maps it to the page. Accounts for scale /
// anchor / fit-mode / mirroring. Falls back to nominal grid bounds.
function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  try {
    const b = token.mesh?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) {
      return { left: rect.left + b.x, top: rect.top + b.y, width: b.width, height: b.height };
    }
  } catch { /* fall through */ }
  const wt = canvas.stage.worldTransform;
  const tl = new PIXI.Point(); wt.apply({ x: token.x, y: token.y }, tl);
  const br = new PIXI.Point(); wt.apply({ x: token.x + (token.w ?? 100), y: token.y + (token.h ?? 100) }, br);
  return { left: rect.left + tl.x, top: rect.top + tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

/* ── Build / paint / drop ───────────────────────────────────────────────── */

function buildAura(token, aspect) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-aspect-aura";

  const glow = document.createElement("div");
  glow.className = "aura-glow";
  el.appendChild(glow);

  const motes = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    const m = document.createElement("div");
    m.className = "mote";
    el.appendChild(m);
    motes.push(m);
  }

  if (_hiddenByAnimation) el.classList.add("is-anim-hidden");
  document.body.appendChild(el);

  const rec = { el, glow, motes, aspect: null, missingFrames: 0 };
  _auras.set(token.id, rec);
  paintAura(rec, aspect);
  if (!_tickerOn) { PIXI.Ticker.shared.add(auraTick); _tickerOn = true; }
  return rec;
}

function paintAura(rec, aspect) {
  if (rec.aspect === aspect) return;
  const swapped = rec.aspect !== null && aspect !== null;
  rec.aspect = aspect;

  const spec = ASPECTS[aspect];
  if (!spec) { rec.el.style.display = "none"; return; }
  rec.el.style.display = "";
  rec.el.style.setProperty("--aura-color", spec.color);
  rec.el.style.setProperty("--aura-glow", spec.glow);

  // Randomise every mote's lane, delay and lifetime on each repaint so a swap
  // visibly re-seeds rather than just re-tinting the same frozen pattern.
  rec.motes.forEach((m) => {
    const dur = spec.dur * (0.75 + Math.random() * 0.5);
    m.style.width = m.style.height = `${spec.size * (0.7 + Math.random() * 0.8)}px`;
    m.style.setProperty("--mx", String(Math.round((Math.random() * 2 - 1) * 34)));
    m.style.setProperty("--dy", String(Math.round(spec.dy * (0.7 + Math.random() * 0.6))));
    m.style.setProperty("--sway", String(Math.round((Math.random() * 2 - 1) * spec.sway)));
    m.style.animationDuration = `${Math.round(dur)}ms`;
    m.style.animationDelay = `${Math.round(Math.random() * dur)}ms`;
  });

  if (swapped) {
    rec.el.classList.remove("is-swapping");
    void rec.el.offsetWidth; // restart the one-shot bloom
    rec.el.classList.add("is-swapping");
  }
}

function dropAura(tokenId) {
  const rec = _auras.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch {}
  _auras.delete(tokenId);
  if (!_auras.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(auraTick); } catch {}
    _tickerOn = false;
  }
}

function auraTick() {
  if (!_auras.size) return;
  for (const [tokenId, rec] of _auras) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) dropAura(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    rec.el.style.left = `${b.left + b.width / 2}px`;
    rec.el.style.top = `${b.top + b.height / 2}px`;
    rec.el.style.width = `${b.width}px`;
    rec.el.style.height = `${b.height}px`;
    // Scale the glow with the sprite so a 2.7x token doesn't get a pinprick.
    const d = Math.max(b.width, b.height) * 1.15;
    rec.glow.style.width = `${d}px`;
    rec.glow.style.height = `${d}px`;
    // Follow the token's own visibility (fog, Escape fade, hidden toggle).
    rec.el.style.opacity = token.visible === false ? "0" : String(token.alpha ?? 1);
  }
}

/* ── Sync ───────────────────────────────────────────────────────────────── */

// Aura presence = the actor currently HOLDS an Aspect. Unlike the dominance
// crest there is no always-visible empty state: no Aspect means no aura.
function syncActorAura(actor) {
  if (!actor) return;
  const aspect = readAspect(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch {}
  for (const token of tokens) {
    if (!aspect) { dropAura(token.id); continue; }
    const rec = _auras.get(token.id) ?? buildAura(token, aspect);
    paintAura(rec, aspect);
  }
}

function rescanCanvas() {
  for (const rec of _auras.values()) { try { rec.el.remove(); } catch {} }
  _auras.clear();
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (!token?.actor) continue;
    syncActorAura(token.actor);
  }
  log(`aspect-aura: rescan — ${_auras.size} aura(s) on ${canvas?.scene?.name ?? "?"}`);
}

// Exported for manual probing / recovery (FUCompanion console use).
export function rescanAspectAuras() { rescanCanvas(); }

function isAspectAe(effect) {
  return /^\s*(fire|bolt|ice|air)\s+aspect\s*$/i.test(String(effect?.name ?? ""));
}

/* ── Boot ───────────────────────────────────────────────────────────────── */

// Idempotent — called on every client from director-boot's ready hook.
export function initAspectAura() {
  if (_hooksOn) return;
  _hooksOn = true;

  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(FLAG_NS);
      _socket.register(ACTION_AURA_VIS, setAurasHiddenLocal);
    }
  } catch (e) {
    warn("aspect-aura: socket init failed — cinematic hide stays GM-local", e);
  }

  const onAeEvent = (effect) => {
    if (isAspectAe(effect) && effect.parent?.documentName === "Actor") {
      syncActorAura(effect.parent);
    }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  // Token spawned mid-scene (director PREP spawns, summons) already holding an
  // Aspect. The 100ms defer lets the canvas finish drawing the new placeable
  // before the first bounds measure.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor) return;
    setTimeout(() => {
      try { syncActorAura(tokenDoc.actor); }
      catch (e) { warn("aspect-aura: createToken sync threw", e); }
    }, 100);
  });

  Hooks.on("canvasReady", () => {
    setTimeout(() => {
      try { rescanCanvas(); }
      catch (e) { warn("aspect-aura: canvasReady rescan threw", e); }
    }, 250);
  });

  // Boot-order belt and braces, same as the crest: whichever way this client
  // ordered ready vs the initial canvasReady, a delayed sweep guarantees auras
  // appear shortly after load.
  if (canvas?.ready) rescanCanvas();
  setTimeout(() => {
    try { rescanCanvas(); }
    catch (e) { warn("aspect-aura: deferred boot rescan threw", e); }
  }, 3000);

  log("aspect-aura: watcher installed");
}
