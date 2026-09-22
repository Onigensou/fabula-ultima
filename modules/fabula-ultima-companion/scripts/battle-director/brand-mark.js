// Brand Mark — persistent badge floating over a creature that is carrying a
// mark, so the table can see who is marked without opening the effects tray.
//
// Built for Fafnir's Searing Brand (a Draconic Curse that detonates when the
// marked creature takes damage, and which that creature may hand to an ally at
// the start of its turn). A mark that MOVES is exactly the case a tray icon
// serves badly — the whole point is knowing, at a glance, who is holding it
// right now.
//
// Deliberately GENERIC, not Searing-Brand-specific. A mark is any AE that
// either carries a `markIcon` flag naming a style, or whose name matches a
// registered style's `matchName`. Because the badge keys off the AE itself,
// passing the mark passes the badge for free — there is no transfer code here
// and there should never need to be.
//
// ARCHITECTURE — cloned from aspect-aura.js, which is itself cloned from
// domination-crest.js. Those solved all of these problems already:
//   - Per-token position:fixed DOM anchored to token.mesh.getBounds(), the
//     RENDERED sprite rect, re-measured every frame so pan / zoom / token scale
//     / anchor / mirroring all track for free. Nominal grid bounds are wrong on
//     any monster with a non-1.0 token scale, which is most of them.
//   - Fully AE-replication-driven: the mark AE replicates to every client, so
//     each client renders its own badge off create/update/deleteActiveEffect.
//     Zero socket traffic for state; F5-safe via the canvasReady rescan.
//   - z-index under 100 so Foundry app windows still cover it.
//
// The one piece of socket traffic is the cinematic hide, mirroring the crest's
// and the aura's: the FSM's ANIMATION state tells every client to fade badges
// out so they never sit on top of an action cinematic.

import { log, warn } from "./logger.js";

const FLAG_NS  = "fabula-ultima-companion";
const STYLE_ID = "fud-brand-mark-style";

// Under the dominance crest (60) and the aspect aura (55) is wrong here — a
// mark is per-target and time-critical, and it sits ABOVE the sprite rather
// than around it, so it does not compete with the aura for the same pixels.
// Between the two, and still under Foundry app windows (>= 100).
const MARK_Z_INDEX = 58;

const ACTION_MARK_VIS = "FU_BRAND_MARK_VIS";

// The AE flag an effect can set to name its badge style explicitly:
//   flags["fabula-ultima-companion"].markIcon = "searing_brand"
const MARK_FLAG = "markIcon";

/* ── Styles ──────────────────────────────────────────────────────────────
 *
 * One entry per mark. `icon` is a texture URL; null renders the built-in CSS
 * chevron in `color` instead, which is what a mark uses until its art lands.
 *
 * `matchName` lets an already-authored AE light up with no data change — the
 * badge finds it by name. New marks should prefer the explicit `markIcon` flag.
 */
export const MARK_STYLES = {
  searing_brand: {
    // The authored sigil. `color` / `glow` still matter: the glow tints the
    // drop-shadow under the art, and `color` is what the built-in chevron
    // falls back to if this URL ever stops resolving.
    icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/VFX/vfx_SearingBrand.png",
    color: "#ff3b30",
    glow: "rgba(255,120,40,0.60)",
    label: "Searing Brand",
    matchName: /^\s*searing\s+brand\s*$/i,
  },
};

const _marks = new Map(); // tokenId -> { el, art, styleKey, missingFrames }
let _tickerOn = false;
let _hooksOn = false;
let _socket = null;
let _hiddenByAnimation = false;

/* ── Cinematic hide ─────────────────────────────────────────────────────── */

// Local apply — runs on every client (socket handler + GM local call).
export function setMarksHiddenLocal(hidden) {
  _hiddenByAnimation = !!hidden;
  for (const rec of _marks.values()) {
    try { rec.el.classList.toggle("is-anim-hidden", _hiddenByAnimation); } catch {}
  }
}

// GM-side emit — fade badges on ALL clients while an action animation plays.
// Called from the FSM ANIMATION state alongside the crest's and the aura's.
export function emitMarksHidden(hidden) {
  try { setMarksHiddenLocal(hidden); }
  catch (e) { warn("emitMarksHidden: local apply threw", e); }
  try { _socket?.executeForOthers?.(ACTION_MARK_VIS, !!hidden); }
  catch (e) { warn("emitMarksHidden: broadcast failed", e); }
}

/* ── Styles ─────────────────────────────────────────────────────────────── */

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.fud-brand-mark {
  position: fixed; pointer-events: none;
  transform: translate(-50%, -50%);
  z-index: ${MARK_Z_INDEX};
  transition: opacity .45s ease;
  display: grid; place-items: center;
}
/* Same cinematic etiquette as the dominance crest and the aspect aura: fade
   out while an action animation plays so the badge never sits on top of a
   cinematic. !important beats the per-frame inline opacity the tracker writes;
   position tracking keeps running so it fades back in exactly in place. */
.fud-brand-mark.is-anim-hidden { opacity: 0 !important; }

/* The badge breathes so a mark reads as live rather than as a static sticker.
   Slow on purpose — this sits on screen for whole rounds, and anything quick
   becomes noise. */
.fud-brand-mark .mark-art {
  width: 100%; height: 100%;
  /* The badge box is square but an authored sigil need not be. object-fit
     contain fits the art inside it at its own aspect instead of stretching
     it; no effect on the drawn-chevron fallback, which is built square.
     NOTE: no backticks in this stylesheet — it is a template literal and one
     would close it early. */
  object-fit: contain;
  filter: drop-shadow(0 0 8px var(--mark-glow)) drop-shadow(0 0 18px var(--mark-glow));
  animation: fud-mark-breathe 2.6s ease-in-out infinite;
}
@keyframes fud-mark-breathe {
  0%, 100% { opacity: .82; transform: translateY(0) scale(1); }
  50%      { opacity: 1;   transform: translateY(-8%) scale(1.06); }
}

/* Built-in placeholder: a downward chevron pointing at the marked creature.
   Drawn in CSS so a mark with no art still reads correctly at any token
   scale. Two stacked bars rotated into a V. */
.fud-brand-mark .chev {
  position: absolute; left: 50%; top: 50%;
  width: 52%; height: 14%;
  background: var(--mark-color);
  border-radius: 2px;
}
.fud-brand-mark .chev.a { transform: translate(-72%, -50%) rotate(48deg); }
.fud-brand-mark .chev.b { transform: translate(-28%, -50%) rotate(-48deg); }

/* Scale-in on appear — the mark lands on its target rather than blinking on.
   Also replayed when the mark is PASSED, since the new bearer builds a fresh
   badge, which is the read we want: something arrived on this creature. */
.fud-brand-mark.is-arriving .mark-art {
  animation: fud-mark-arrive .62s cubic-bezier(.16,1,.3,1) 1,
             fud-mark-breathe 2.6s ease-in-out .62s infinite;
}
@keyframes fud-mark-arrive {
  0%   { opacity: 0; transform: translateY(-140%) scale(2.6); filter: brightness(2.6) drop-shadow(0 0 20px var(--mark-glow)); }
  60%  { opacity: 1; transform: translateY(6%) scale(.92); }
  100% { opacity: .82; transform: translateY(0) scale(1); }
}
`;
  document.head.appendChild(el);
}

/* ── Mark state ─────────────────────────────────────────────────────────── */

// Resolve one AE to a style key, or null if it is not a mark.
export function markStyleOfEffect(effect) {
  if (!effect || effect.disabled) return null;
  try {
    const flagged = String(effect.flags?.[FLAG_NS]?.[MARK_FLAG] ?? "").trim();
    if (flagged) return MARK_STYLES[flagged] ? flagged : null;
    const name = String(effect.name ?? "");
    for (const [key, spec] of Object.entries(MARK_STYLES)) {
      if (spec.matchName?.test(name)) return key;
    }
  } catch { /* fall through */ }
  return null;
}

// The style key this actor is currently marked with, or null. First match wins;
// a creature holding two different marks shows the first registered one, which
// is a deliberate simplification — no mark in the world stacks today, and a
// second badge would just occlude the sprite.
export function readMark(actor) {
  let effects = [];
  try { effects = [...(actor?.effects ?? [])]; } catch { return null; }
  for (const e of effects) {
    const key = markStyleOfEffect(e);
    if (key) return key;
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

function buildMark(token, styleKey) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-brand-mark";

  if (_hiddenByAnimation) el.classList.add("is-anim-hidden");
  document.body.appendChild(el);

  const rec = { el, art: null, styleKey: null, missingFrames: 0 };
  _marks.set(token.id, rec);
  paintMark(rec, styleKey);
  if (!_tickerOn) { PIXI.Ticker.shared.add(markTick); _tickerOn = true; }
  return rec;
}

function paintMark(rec, styleKey) {
  if (rec.styleKey === styleKey) return;
  rec.styleKey = styleKey;

  const spec = MARK_STYLES[styleKey];
  if (!spec) { rec.el.style.display = "none"; return; }
  rec.el.style.display = "";
  rec.el.style.setProperty("--mark-color", spec.color);
  rec.el.style.setProperty("--mark-glow", spec.glow);
  rec.el.title = spec.label ?? "";

  // Rebuild the art node so a style change (or a re-application) replays the
  // arrival beat rather than silently swapping the graphic.
  try { rec.art?.remove(); } catch {}
  const art = document.createElement(spec.icon ? "img" : "div");
  art.className = "mark-art";
  if (spec.icon) {
    art.src = spec.icon;
    // A missing asset must not leave an empty badge — fall back to the chevron.
    art.addEventListener("error", () => {
      try {
        const div = document.createElement("div");
        div.className = "mark-art";
        div.appendChild(chevron("a"));
        div.appendChild(chevron("b"));
        art.replaceWith(div);
        rec.art = div;
      } catch {}
    }, { once: true });
  } else {
    art.appendChild(chevron("a"));
    art.appendChild(chevron("b"));
  }
  rec.el.appendChild(art);
  rec.art = art;

  rec.el.classList.remove("is-arriving");
  void rec.el.offsetWidth; // restart the one-shot arrival
  rec.el.classList.add("is-arriving");
}

function chevron(which) {
  const d = document.createElement("div");
  d.className = `chev ${which}`;
  return d;
}

function dropMark(tokenId) {
  const rec = _marks.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch {}
  _marks.delete(tokenId);
  if (!_marks.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(markTick); } catch {}
    _tickerOn = false;
  }
}

function markTick() {
  if (!_marks.size) return;
  for (const [tokenId, rec] of _marks) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) dropMark(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const b = spriteClientBounds(token);
    // Badge size tracks the sprite so a 2.7x boss and a 1.0x mook both read,
    // clamped so a very large or very small token stays sane.
    const size = Math.min(96, Math.max(30, Math.max(b.width, b.height) * 0.28));
    rec.el.style.width  = `${size}px`;
    rec.el.style.height = `${size}px`;
    // Overhead: centred on the sprite, floating just above its top edge.
    rec.el.style.left = `${b.left + b.width / 2}px`;
    rec.el.style.top  = `${b.top - size * 0.62}px`;
    // Follow the token's own visibility (fog, Escape fade, hidden toggle).
    rec.el.style.opacity = token.visible === false ? "0" : String(token.alpha ?? 1);
  }
}

/* ── Sync ───────────────────────────────────────────────────────────────── */

// Badge presence = the actor currently HOLDS a mark. No empty state: an
// unmarked creature shows nothing.
function syncActorMark(actor) {
  if (!actor) return;
  const styleKey = readMark(actor);
  let tokens = [];
  // getActiveTokens() with NO argument. The first parameter is `linked`, which
  // filters to tokens with actorLink set — not "all tokens", which is what this
  // wants. Passing true works by accident when the effect lands on a token's
  // SYNTHETIC actor (how the director applies them, and why this reads as fine
  // in play) but returns NOTHING for the world actor of an unlinked NPC, which
  // is most monsters. Probed live: world actor of an unlinked token →
  // getActiveTokens(true) = 0, getActiveTokens() = 1.
  try { tokens = actor.getActiveTokens?.() ?? []; } catch {}
  for (const token of tokens) {
    if (!styleKey) { dropMark(token.id); continue; }
    const rec = _marks.get(token.id) ?? buildMark(token, styleKey);
    paintMark(rec, styleKey);
  }
}

function rescanCanvas() {
  for (const rec of _marks.values()) { try { rec.el.remove(); } catch {} }
  _marks.clear();
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (!token?.actor) continue;
    syncActorMark(token.actor);
  }
  log(`brand-mark: rescan — ${_marks.size} mark(s) on ${canvas?.scene?.name ?? "?"}`);
}

// Exported for manual probing / recovery (FUCompanion console use).
export function rescanBrandMarks() { rescanCanvas(); }

/* ── Boot ───────────────────────────────────────────────────────────────── */

// Idempotent — called on every client from director-boot's ready hook.
export function initBrandMark() {
  if (_hooksOn) return;
  _hooksOn = true;

  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(FLAG_NS);
      _socket.register(ACTION_MARK_VIS, setMarksHiddenLocal);
    }
  } catch (e) {
    warn("brand-mark: socket init failed — cinematic hide stays GM-local", e);
  }

  // A mark landing, being disabled, or being removed all resync the bearer.
  // `markStyleOfEffect` is cheap, so an unconditional resync on any AE event
  // on an Actor is simpler than trying to predict which effects matter — and
  // it catches the disable/enable toggle, which changes nothing about the AE's
  // name or flags.
  const onAeEvent = (effect) => {
    try {
      if (effect?.parent?.documentName !== "Actor") return;
      syncActorMark(effect.parent);
    } catch (e) { warn("brand-mark: AE event sync threw", e); }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  // Token spawned mid-scene (director PREP spawns, summons) already carrying a
  // mark. The 100ms defer lets the canvas finish drawing the new placeable
  // before the first bounds measure.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor) return;
    setTimeout(() => {
      try { syncActorMark(tokenDoc.actor); }
      catch (e) { warn("brand-mark: createToken sync threw", e); }
    }, 100);
  });

  Hooks.on("canvasReady", () => {
    setTimeout(() => {
      try { rescanCanvas(); }
      catch (e) { warn("brand-mark: canvasReady rescan threw", e); }
    }, 250);
  });

  // Boot-order belt and braces, same as the crest and the aura: whichever way
  // this client ordered ready vs the initial canvasReady, a delayed sweep
  // guarantees badges appear shortly after load.
  if (canvas?.ready) rescanCanvas();
  setTimeout(() => {
    try { rescanCanvas(); }
    catch (e) { warn("brand-mark: deferred boot rescan threw", e); }
  }, 3000);

  log("brand-mark: watcher installed");
}
