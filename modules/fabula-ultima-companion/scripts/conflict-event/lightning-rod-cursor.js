// ============================================================================
// Lightning Rod cursor — the floating marker over the Storm's current holder.
//
// A downward purple arrow bobbing above the Rod holder's RENDERED sprite. The
// Rod is a singleton battlefield status whose whole strategy layer is "who is
// carrying it right now"; before this existed that fact was legible only as an
// effect icon in a row of other effect icons, which is exactly the confusion
// this file removes.
//
// ── Why there is no socket here ─────────────────────────────────────────────
//
// The Rod IS an Active Effect, and Foundry replicates Active Effects to every
// client on its own. So each client derives its own cursor from
// createActiveEffect / updateActiveEffect / deleteActiveEffect plus a
// canvasReady rescan — no broadcast to desync, no GM to be the source of
// truth, and an F5 mid-battle re-derives the correct cursor from the world
// rather than from a message it missed. Same contract as the Dominance Crest
// ([[domination-crest]]), which this file is deliberately modelled on.
//
// It is also self-scoping: the AE only exists while a Lightning Storm conflict
// is running, so this costs nothing in every other fight and needs no teardown
// call from the event's onConflictEnd.
//
// POSITIONING: anchored off `token.mesh.getBounds()` — the actual rendered
// sprite rectangle — NOT the nominal grid bounds, because token scale,
// off-center anchors, Contain fit and mirroring all move the visible art away
// from the grid square. Re-measured every frame, so pan/zoom/scale track free.
//
// Z-ORDER: z-index 60 — above the canvas (#board z0) and token HUD (#hud z1),
// below Foundry app windows (z >= 100), so an open sheet covers it. Same value
// the crest probed live.
//
// Not a manifest entry on its own account: imported by director-boot.js and
// initialised from its ready hook — loads on a normal hard-reload, no relaunch.
// ============================================================================

const FLAG_NS = "fabula-ultima-companion";
const TAG = "[FU][LightningRodCursor]";
const STYLE_ID = "fud-rod-cursor-style";

const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/** The AE's name, as authored on the shared Debuff item. Mirrors lightning-storm.js. */
const ROD_AE_NAME = "Lightning Rod";

// Above canvas/#hud, below Foundry app windows (z >= 100). See header note.
const CURSOR_Z_INDEX = 60;

/**
 * Placeholder art switch.
 *
 * `null` draws the built-in CSS arrow (a purple triangle). Set this to an image
 * URL and the cursor renders that instead, at CURSOR_ART_HEIGHT px — nothing
 * else in this file needs to change when the real art lands.
 */
const ROD_CURSOR_SRC = null;
const CURSOR_ART_HEIGHT = 44;

/** Gap in screen px between the sprite's top edge and the arrow's tip. */
const CURSOR_GAP = 6;

const _cursors = new Map(); // tokenId -> { el, missingFrames }
let _tickerOn = false;
let _hooksOn = false;

// Cinematic hide — the strike sequence dims the battlefield and spotlights the
// holder, and a lit DOM arrow floating over a darkened field reads backwards.
// Defaults visible on every fresh module load, so an F5 mid-strike can never
// strand a hidden cursor. Mirrors the crest's is-anim-hidden etiquette.
let _hiddenByAnimation = false;

export function setRodCursorHiddenLocal(hidden) {
  _hiddenByAnimation = !!hidden;
  for (const rec of _cursors.values()) {
    try { rec.el.classList.toggle("is-anim-hidden", _hiddenByAnimation); } catch { /* element gone */ }
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.fud-rod-cursor {
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: ${CURSOR_Z_INDEX};
  pointer-events: none;
  transition: opacity .3s ease;
  /* The bob rides the CSS "translate" PROPERTY, leaving "transform" free to
     hold the centering above. Composing them this way means the per-frame
     tracker can keep writing left/top without fighting the animation.
     (No backticks in here — this whole block is a template literal.) */
  animation: fud-rod-bob 1.8s ease-in-out infinite;
  filter: drop-shadow(0 0 6px rgba(168,85,247,.85)) drop-shadow(0 2px 3px rgba(0,0,0,.55));
}
.fud-rod-cursor.is-anim-hidden { opacity: 0 !important; }
@keyframes fud-rod-bob {
  0%, 100% { translate: 0 0; }
  50%      { translate: 0 -8px; }
}
/* Placeholder graphic: a pure-CSS downward triangle. Replaced wholesale when
   ROD_CURSOR_SRC is set. */
.fud-rod-cursor .arrow {
  width: 0; height: 0;
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: 18px solid #A855F7;
}
/* The global stylesheet borders every <img>; never on ours. */
.fud-rod-cursor img {
  display: block; height: ${CURSOR_ART_HEIGHT}px; width: auto;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
  background: transparent;
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// The token's RENDERED sprite rectangle in client (screen) coordinates.
// mesh.getBounds() is renderer-space (post worldTransform), so offsetting by
// the canvas element's own client rect maps it to the page. Falls back to the
// nominal grid bounds when the mesh isn't available. Mirrors the crest helper.
function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  try {
    const b = token.mesh?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) {
      return { left: rect.left + b.x, top: rect.top + b.y, width: b.width, height: b.height };
    }
  } catch { /* fall through to nominal bounds */ }
  const wt = canvas.stage.worldTransform;
  const tl = new PIXI.Point(); wt.apply({ x: token.x, y: token.y }, tl);
  const br = new PIXI.Point(); wt.apply({ x: token.x + (token.w ?? 100), y: token.y + (token.h ?? 100) }, br);
  return { left: rect.left + tl.x, top: rect.top + tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

/** Does this actor currently hold the Rod? Mirrors lightning-storm.js's rodOn. */
function holdsRod(actor) {
  try {
    return !!actor?.effects?.find?.((e) => e?.name === ROD_AE_NAME && !e.disabled);
  } catch { return false; }
}

export function isRodAe(effect) {
  return String(effect?.name ?? "").trim() === ROD_AE_NAME;
}

function buildCursor(token) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-rod-cursor";
  if (ROD_CURSOR_SRC) {
    const img = document.createElement("img");
    img.src = ROD_CURSOR_SRC;
    el.appendChild(img);
  } else {
    const arrow = document.createElement("div");
    arrow.className = "arrow";
    el.appendChild(arrow);
  }
  if (_hiddenByAnimation) el.classList.add("is-anim-hidden");
  document.body.appendChild(el);
  const rec = { el, missingFrames: 0 };
  _cursors.set(token.id, rec);
  if (!_tickerOn) { PIXI.Ticker.shared.add(cursorTick); _tickerOn = true; }
  return rec;
}

function dropCursor(tokenId) {
  const rec = _cursors.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch { /* already gone */ }
  _cursors.delete(tokenId);
  if (!_cursors.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(cursorTick); } catch { /* never added */ }
    _tickerOn = false;
  }
}

function cursorTick() {
  if (!_cursors.size) return;
  for (const [tokenId, rec] of _cursors) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) dropCursor(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    rec.el.style.left = `${b.left + b.width / 2}px`;
    rec.el.style.top = `${b.top - CURSOR_GAP}px`;
    // Follow the token's visibility (fog, hidden toggle, Escape fade) — a
    // holder the viewer cannot see must not be given away by a purple arrow.
    rec.el.style.opacity = token.visible === false ? "0" : String(token.alpha ?? 1);
  }
}

/** Re-derive the cursor across every canvas token of `actor`. */
function syncActorCursor(actor) {
  if (!actor) return;
  const has = holdsRod(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch { /* no canvas */ }
  for (const token of tokens) {
    if (!has) { dropCursor(token.id); continue; }
    if (!_cursors.has(token.id)) buildCursor(token);
  }
}

function rescanCanvas() {
  for (const rec of _cursors.values()) { try { rec.el.remove(); } catch { /* already gone */ } }
  _cursors.clear();
  if (_tickerOn) {
    try { PIXI.Ticker.shared.remove(cursorTick); } catch { /* never added */ }
    _tickerOn = false;
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor) syncActorCursor(token.actor);
  }
  log(`rescan — ${_cursors.size} cursor(s) on ${canvas?.scene?.name ?? "?"}`);
}

/** Exported for manual probing / recovery (FUCompanion console use). */
export function rescanLightningRodCursors() { rescanCanvas(); }

/** Idempotent — called on every client from director-boot's ready hook. */
export function initLightningRodCursor() {
  if (_hooksOn) return;
  _hooksOn = true;

  const onAeEvent = (effect) => {
    if (isRodAe(effect) && effect.parent?.documentName === "Actor") {
      try { syncActorCursor(effect.parent); }
      catch (e) { warn("AE sync threw", e); }
    }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  // A token spawned mid-fight (director PREP spawns, summons) that already
  // carries the Rod. The 100ms defer lets the canvas finish drawing the new
  // placeable before the first bounds measure.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor || !holdsRod(tokenDoc.actor)) return;
    setTimeout(() => { try { syncActorCursor(tokenDoc.actor); } catch (e) { warn("createToken sync threw", e); } }, 100);
  });
  Hooks.on("deleteToken", (tokenDoc) => {
    try { dropCursor(tokenDoc?.id); } catch { /* nothing mounted */ }
  });

  Hooks.on("canvasReady", () => {
    // Defer one tick past the canvasReady storm so token placeables (and any
    // reload-recovery scene switching) settle before the first bounds pass.
    setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("canvasReady rescan threw", e); } }, 250);
  });

  // Boot-order belt and braces: whichever way this client ordered ready vs the
  // initial canvasReady (plain load, reload-recovery scene hop, F5 mid-battle),
  // a delayed sweep guarantees a live Rod shows up shortly after load.
  if (canvas?.ready) rescanCanvas();
  setTimeout(() => { try { rescanCanvas(); } catch (e) { warn("deferred boot rescan threw", e); } }, 3000);

  log("watcher installed");
}
