// Director-native transient NPC HP bar — DOM screen-space subsystem.
//
// When a STUDIED hostile NPC's HP changes (damage or heal), a bare unlabeled
// bar fades in under the token, plays a JRPG "damage ghost" sequence, lingers,
// and fades out — giving players an APPROXIMATE read on the monster's
// condition without exposing numbers. Player characters never get one (they
// have the resource HUD); unstudied monsters never get one (studying is what
// unlocks it).
//
// DAMAGE GHOST (loss): the green fill slides DOWN to the new value fast,
// revealing a RED segment covering [new → old] — the visual size of the hit.
// After a short hold the red segment drains down to the green edge, much
// slower than the green slide: green slide = the hit landing, red drain = the
// health bleeding off. Heals keep the classic slide: green sweeps UP to the
// new value with a soft glow.
//
// CRISIS COLOR: no notch/marker — the FILL ITSELF is the signal. Green above
// 50%, yellow at 50% and below (FU Crisis), red at 25% and below. On a hit
// that crosses a threshold the color change rides the red drain (same duration,
// gradual green→yellow), not the initial snap.
//
// Same architecture as the damage-number / hurt-reaction siblings: the GM
// computes a tiny SEMANTIC payload and broadcasts it via socketlib; every
// client renders from its OWN camera transform (snapshot positioning at spawn,
// no per-frame tracking). The payload carries HP FRACTIONS only (quantized to
// 2% steps), never raw HP values, so clients can't reverse the monster's max
// HP from `damage ÷ Δfraction`.
//
// GATES (evaluated GM-side in emitNpcHpBar, so player journal permissions on
// the encyclopedia never matter):
//   1. token disposition is HOSTILE (-1) — excludes PCs and friendly allies
//   2. the monster has been successfully Studied — encyclopedia page flag
//      `bestResult >= TIER_IDENTITY (7)`, the same persistent gate the action
//      card uses to mask DEF/affinity (action-profile makeStudiedGate). The
//      lowest SUCCESSFUL study result is Identity, so this is "any success".
//      Fail-CLOSED when the encyclopedia API is missing — no study, no bar.
//
// MULTI-HIT: one bar per token (`_active` map). A new loss while a bar is up
// RETARGETS it: green snaps lower, the red ghost is frozen at its current
// rendered width and extended to keep covering [new green → highest recent],
// and the hold/drain clock restarts — a combo reads as one bar being chewed
// down, not a stack of bars.
//
// Not a manifest entry: imported by director-boot.js and initialised from its
// ready hook — loads on a normal hard-reload, no Setup-relaunch.

import { log, warn } from "../logger.js";
import { registerAnimation } from "../director-surfaces.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_HPBAR_PLAY";
const STYLE_ID = "fud-hp-bar-style";

// Lowest successful Study result (Identity). Mirrors action-profile.js /
// encyclopedia-core.js — the encyclopedia's classifyStudyTotal ladder.
const TIER_IDENTITY = 7;

// Timing (ms). Loss life = FADE + HOLD + DRAIN + LINGER + FADE; retargets
// restart the HOLD+DRAIN portion. Deliberately unhurried — the bar is the
// information, players need time to actually read it.
const FADE_MS = 250;        // opacity in/out (CSS transition, both directions)
const GREEN_SLIDE_MS = 250; // loss: green slides down to the new value (fast)
const HOLD_MS = 600;        // red ghost holds at the damage-chunk size
const DRAIN_MS = 700;       // red ghost drains to the green edge (slow)
const GAIN_SLIDE_MS = 600;  // heal: green sweeps up
const LINGER_MS = 1500;     // hold after the drain/sweep completes

// Payload fractions are quantized to 2% steps — visually invisible, but blunts
// deriving max HP from a known damage number over an exact fraction delta.
const QUANT_STEPS = 50;

// Bar geometry (screen px). Width follows the token's on-screen width so a
// boss token gets a wider bar, clamped so tiny/huge zooms stay readable.
// These are the DEFAULTS — the live values come from the world-scoped tuning
// setting below (GM-adjustable via the "HP Bar Tuner" dev tool).
const BAR_MIN_W = 40;
const BAR_MAX_W = 400;
const SLIDE_PX = 16; // spawn/despawn horizontal slide distance

// GM-tunable look config (world setting, read fresh on every spawn so a saved
// tweak shows on the very next hit — no reload). See hp-bar-tuner.js.
export const TUNING_SETTING = "npcHpBarTuning";
// Values hand-tuned by the GM via the HP Bar Tuner (2026-07-15): slightly
// overlapping the token's bottom edge, near-square corners, 80% size.
export const TUNING_DEFAULTS = Object.freeze({
  offsetX: 0,        // px, horizontal shift from token center (+ = right)
  offsetY: -12,      // px, from the token's bottom edge (+ = down)
  height: 10,        // px, bar height
  widthScale: 0.95,  // × the token's on-screen width
  radius: 1,         // px, corner roundness (>= height/2 ⇒ pill)
  scale: 0.80,       // overall multiplier on width + height
});

export function getBarTuning() {
  try {
    const saved = game.settings.get(MODULE_ID, TUNING_SETTING) ?? {};
    return { ...TUNING_DEFAULTS, ...saved };
  } catch (_) {
    return { ...TUNING_DEFAULTS };
  }
}

let _socket = null;
// tokenUuid -> { root, track, fill, ghost, holdTimer, hideTimer, removeTimer }
const _active = new Map();

// ── boot: socket registration ──────────────────────────────────────────────
// Idempotent. Call once on every client after socketlib is up (boot `ready`).
export function initNpcHpBar() {
  try {
    // World-scoped look tuning — hidden from the vanilla settings sheet; edited
    // via the HP Bar Tuner dev tool. Registered on every client (players need
    // it to READ; only the GM can write a world setting).
    try {
      game.settings.register(MODULE_ID, TUNING_SETTING, {
        scope: "world", config: false, type: Object,
        default: { ...TUNING_DEFAULTS },
      });
    } catch (e) { warn("hp-bar: tuning setting registration failed", e); }
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("hp-bar: socketlib unavailable — bars stay local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, renderNpcHpBarLocal);
    log("hp-bar: socket registered");
  } catch (e) {
    warn("hp-bar: init failed", e);
  }
}

// ── GM-side gates ───────────────────────────────────────────────────────────

function resolveTokenDoc(tokenUuid) {
  try {
    const doc = globalThis.fromUuidSync?.(tokenUuid);
    if (doc) return doc;
  } catch (_) { /* fall through to canvas lookup */ }
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return canvas?.tokens?.get?.(tokenId)?.document ?? null;
}

// Persistent "has been studied" check — encyclopedia page for the WORLD actor
// (director-spawned tokens are copies; the page keys the world actor), token
// actor as fallback. Fail-closed: no encyclopedia, no page, no bar.
function isStudiedMonster(tokenDoc, actor) {
  const encApi = globalThis.FUCompanion?.api?.encyclopedia;
  if (!encApi?.getPageForActor) return false;
  const candidates = [];
  const worldActor = game.actors?.get?.(tokenDoc?.actorId);
  if (worldActor?.uuid) candidates.push(worldActor.uuid);
  if (actor?.uuid) candidates.push(actor.uuid);
  for (const uuid of [...new Set(candidates)]) {
    try {
      const page = encApi.getPageForActor(uuid);
      const best = Number(page?.getFlag?.(MODULE_ID, "encyclopedia")?.bestResult ?? 0) || 0;
      if (best >= TIER_IDENTITY) return true;
    } catch (_) { /* try next candidate */ }
  }
  return false;
}

function quantFrac(v) {
  const f = Math.max(0, Math.min(1, Number(v) || 0));
  return Math.round(f * QUANT_STEPS) / QUANT_STEPS;
}

// ── public emit (GM-side, gated) ────────────────────────────────────────────
// Called from the damage/heal write seams with the raw HP facts; applies the
// hostile + studied gates, converts to fractions, renders locally + broadcasts.
// Fire-and-forget; never throws into the caller's HP write.
export function emitNpcHpBar({ tokenUuid, actor = null, hpBefore, hpAfter, maxHp } = {}) {
  try {
    if (!tokenUuid || !(Number(maxHp) > 0)) return;
    const before = Number(hpBefore);
    const after = Number(hpAfter);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return;
    // Per-target gate diagnostics: on a multi-target action every target emits
    // independently, so "the bar only showed on one enemy" is usually a gate —
    // this names which one suppressed which token. Filter console by [BD].
    const who = actor?.name ?? tokenUuid;
    const tokenDoc = resolveTokenDoc(tokenUuid);
    if (!tokenDoc) { log(`hp-bar: gated out (token not found) — ${who}`); return; }
    const HOSTILE = CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
    if (tokenDoc.disposition !== HOSTILE) { log(`hp-bar: gated out (not hostile) — ${who}`); return; }
    if (!isStudiedMonster(tokenDoc, actor)) { log(`hp-bar: gated out (not studied) — ${who}`); return; }
    emitNpcHpBarUnchecked({
      tokenUuid,
      fromFrac: quantFrac(before / maxHp),
      toFrac: quantFrac(after / maxHp),
    });
  } catch (e) {
    warn("emitNpcHpBar threw", e);
  }
}

// Ungated emit — payload is already fractions. Exists for the livetest tool
// (drive the visual on any token) and as emitNpcHpBar's send half. Mirrors the
// cut-in's "local call + executeForOthers" split.
export function emitNpcHpBarUnchecked(payload = {}) {
  try { renderNpcHpBarLocal(payload); }
  catch (e) { warn("emitNpcHpBar: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("emitNpcHpBar: broadcast failed", e); }
}

// ── CSS (injected once, lazily) ─────────────────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
/* Registered so --hpbar-color INTERPOLATES on transition (the gradual
   green→yellow crisis shift). Unregistered custom properties snap. On a
   browser without @property support the color still changes — just instantly. */
@property --hpbar-color {
  syntax: '<color>';
  inherits: false;
  initial-value: #57c96b;
}
/* Entrance: slides in left→right while fading in; exit reverses (right→left +
   fade out). The transform is driven from JS so retargets can cancel a
   mid-exit slide smoothly. */
.fud-hpbar {
  position: fixed; z-index: 99985; pointer-events: none;
  transform: translate(calc(-50% - ${SLIDE_PX}px), 0);
  opacity: 0;
  transition: opacity ${FADE_MS}ms ease,
              transform ${FADE_MS}ms cubic-bezier(.2, .8, .3, 1);
}
/* Track: layered outline — bright inner rim + dark outer ring + drop shadow —
   plus an inset bevel so it reads as a game HP BAR, not a flat block. */
.fud-hpbar-track {
  position: relative; width: 100%; height: 100%;
  border-radius: 999px;
  background: linear-gradient(to bottom, #05060a, #14161d 55%, #0a0b10);
  box-shadow:
    inset 0 2px 3px rgba(0, 0, 0, .85),
    0 0 0 1.5px rgba(235, 240, 255, .75),
    0 0 0 3px rgba(0, 0, 0, .9),
    0 3px 9px rgba(0, 0, 0, .6);
  overflow: hidden;
}
/* Red damage ghost — sits UNDER the green fill, spanning [0 → pre-hit HP].
   The visible red sliver is the chunk between the green edge and its own edge.
   Its width drain (after the hold) is the "health decreasing" animation. */
.fud-hpbar-ghost {
  position: absolute; top: 0; left: 0; bottom: 0;
  border-radius: 999px 4px 4px 999px;
  background: linear-gradient(to bottom, #ff6a55, #d92c1e 60%, #a81c12);
  transition: width ${DRAIN_MS}ms cubic-bezier(.3, .7, .3, 1);
}
/* Current-HP fill. On damage it slides down FAST (much quicker than the red
   drain that follows); the condition color cross-fades on the drain clock, so
   a Crisis crossing reads as a gradual green→yellow shift. Heals override the
   width sweep with a slower, glowing one. */
.fud-hpbar-fill {
  position: absolute; top: 0; left: 0; bottom: 0;
  border-radius: 999px 4px 4px 999px;
  background: linear-gradient(to bottom,
    color-mix(in srgb, var(--hpbar-color, #57c96b) 65%, #ffffff) 0%,
    var(--hpbar-color, #57c96b) 55%,
    color-mix(in srgb, var(--hpbar-color, #57c96b) 70%, #000000) 100%);
  transition: width ${GREEN_SLIDE_MS}ms cubic-bezier(.3, .8, .3, 1),
              --hpbar-color ${DRAIN_MS}ms ease;
}
.fud-hpbar--gain .fud-hpbar-fill {
  transition: width ${GAIN_SLIDE_MS}ms cubic-bezier(.22, .9, .32, 1),
              --hpbar-color ${GAIN_SLIDE_MS}ms ease;
  box-shadow: 0 0 8px 1px rgba(110, 255, 140, .8);
}
/* Gloss highlight across the top — over every layer, part of the "bar feel". */
.fud-hpbar-gloss {
  position: absolute; inset: 0; border-radius: 999px;
  background: linear-gradient(to bottom,
    rgba(255, 255, 255, .30) 0%, rgba(255, 255, 255, .08) 42%, transparent 50%);
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// ── projection helpers (mirror director-damage-numbers.js) ─────────────────
function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

function canvasTokenFromUuid(tokenUuid) {
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return tokenId ? (canvas?.tokens?.get?.(tokenId) ?? null) : null;
}

// Condition color: green while healthy, yellow from Crisis (50%) down, red in
// deep danger (25%). The fill IS the crisis indicator — no notch.
function fillColor(frac) {
  if (frac > 0.5) return "#57c96b";
  if (frac > 0.25) return "#e8c33a";
  return "#e84b3a";
}

// The fill's gradient derives from --hpbar-color. `background` transition on
// gradients isn't animatable everywhere, so the gradual crisis shift also sets
// a plain backgroundColor fallback under the gradient via the custom property.
function paintFill(fill, frac) {
  fill.style.setProperty("--hpbar-color", fillColor(frac));
}

// Enter/exit: slide + fade together. The CSS class holds the "offstage left"
// pose; showing moves to center, hiding returns offstage (right→left).
function poseIn(root) {
  root.style.opacity = "1";
  root.style.transform = "translate(-50%, 0)";
}
function poseOut(root) {
  root.style.opacity = "0";
  root.style.transform = `translate(calc(-50% - ${SLIDE_PX}px), 0)`;
}

// Current rendered width of `el` as a fraction of the track — used to freeze a
// mid-drain ghost exactly where it visually is when a combo retargets the bar.
function renderedFrac(el, track) {
  const tw = track.getBoundingClientRect().width || 1;
  return Math.max(0, Math.min(1, el.getBoundingClientRect().width / tw));
}

// ── render (runs on EVERY client) ──────────────────────────────────────────
// One bar per token: spawn if absent, RETARGET if present. Self-removes after
// hold + drain + linger + fade. Silently no-ops off-canvas — flavor, never
// critical.
export function renderNpcHpBarLocal(payload = {}) {
  try {
    ensureStyle();
    const tokenUuid = payload?.tokenUuid;
    if (!tokenUuid) return;
    if (typeof PIXI === "undefined" || !canvas?.ready) return;
    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) return;

    const fromFrac = Math.max(0, Math.min(1, Number(payload.fromFrac) || 0));
    const toFrac = Math.max(0, Math.min(1, Number(payload.toFrac) || 0));
    const isGain = toFrac > fromFrac;

    const existing = _active.get(tokenUuid);
    if (existing?.root?.isConnected) {
      retarget(existing, tokenUuid, { fromFrac, toFrac, isGain });
      return;
    }
    _active.delete(tokenUuid); // clear a stale (disconnected) entry

    // ── spawn ──
    // Screen-space geometry from the token's on-screen footprint at spawn time
    // (snapshot positioning — same accepted tradeoff as the damage numbers).
    const cfg = getBarTuning();
    const scale = canvas.stage.scale?.x ?? 1;
    const barW = Math.round(
      Math.max(BAR_MIN_W, Math.min(BAR_MAX_W, (token.w ?? 100) * scale * cfg.widthScale)) * cfg.scale
    );
    const barH = Math.max(2, Math.round(cfg.height * cfg.scale));
    const cx = token.center?.x ?? (token.x ?? 0) + (token.w ?? 100) / 2;
    const bottomY = (token.y ?? 0) + (token.h ?? 100);
    const pt = worldToClient(cx, bottomY);

    const root = document.createElement("div");
    root.className = "fud-hpbar" + (isGain ? " fud-hpbar--gain" : "");
    root.style.left = `${pt.x + cfg.offsetX}px`;
    root.style.top = `${pt.y + cfg.offsetY}px`;
    root.style.width = `${barW}px`;
    root.style.height = `${barH}px`;

    // Corner roundness from tuning: full radius on the track + the fills' LEFT
    // edge; the fills' right (leading) edge stays slightly squared so the edge
    // being chewed reads as a crisp line.
    const rad = Math.max(0, Number(cfg.radius) || 0);
    const leadRad = Math.min(4, rad);
    const track = document.createElement("div");
    track.className = "fud-hpbar-track";
    track.style.borderRadius = `${rad}px`;
    const ghost = document.createElement("div");
    ghost.className = "fud-hpbar-ghost";
    ghost.style.borderRadius = `${rad}px ${leadRad}px ${leadRad}px ${rad}px`;
    const fill = document.createElement("div");
    fill.className = "fud-hpbar-fill";
    fill.style.borderRadius = `${rad}px ${leadRad}px ${leadRad}px ${rad}px`;
    const gloss = document.createElement("div");
    gloss.className = "fud-hpbar-gloss";
    gloss.style.borderRadius = `${rad}px`;
    track.appendChild(ghost);
    track.appendChild(fill);
    track.appendChild(gloss);
    root.appendChild(track);
    document.body.appendChild(root);

    const entry = { root, track, fill, ghost, holdTimer: null, hideTimer: null, removeTimer: null };
    _active.set(tokenUuid, entry);

    if (isGain) {
      // Heal: no ghost; green sweeps up from the old value.
      ghost.style.width = "0%";
      fill.style.width = `${fromFrac * 100}%`;
      paintFill(fill, fromFrac);
      void root.offsetWidth; // commit start values before animating
      poseIn(root);
      fill.style.width = `${toFrac * 100}%`;
      paintFill(fill, toFrac);
      entry.hideTimer = setTimeout(() => beginHide(tokenUuid), FADE_MS + GAIN_SLIDE_MS + LINGER_MS);
    } else {
      // Damage ghost: both layers start at the PRE-hit value, then the green
      // slides down fast to the new value — revealing the red chunk just dealt
      // — holds, and the red drains slowly after (scheduleDrain). Color starts
      // at the PRE-hit condition; the crisis shift rides the drain.
      ghost.style.width = `${fromFrac * 100}%`;
      fill.style.width = `${fromFrac * 100}%`;
      paintFill(fill, fromFrac);
      void root.offsetWidth;
      poseIn(root);
      fill.style.width = `${toFrac * 100}%`;
      scheduleDrain(entry, tokenUuid, toFrac);
    }

    registerAnimation({
      kind: "npc-hp-bar",
      durationMs: FADE_MS + GREEN_SLIDE_MS + HOLD_MS + DRAIN_MS + LINGER_MS + FADE_MS,
      meta: { tokenUuid },
    });
  } catch (e) {
    warn("renderNpcHpBarLocal threw", e);
  }
}

// Wait out the green slide + hold, then drain the red ghost down to the green
// edge — shifting the fill's condition color on the same clock — then linger
// and fade.
function scheduleDrain(entry, tokenUuid, toFrac) {
  entry.holdTimer = setTimeout(() => {
    try {
      entry.ghost.style.width = `${toFrac * 100}%`;
      paintFill(entry.fill, toFrac);
    } catch (_) {}
  }, GREEN_SLIDE_MS + HOLD_MS);
  entry.hideTimer = setTimeout(() => beginHide(tokenUuid), GREEN_SLIDE_MS + HOLD_MS + DRAIN_MS + LINGER_MS);
}

// A new payload while the bar is live: green slides fast to the new value, the
// ghost is frozen exactly where it's rendered (mid-drain safe) and extended to
// keep covering the highest recent HP, and the hold/drain clock restarts.
// Cancels any in-progress fade-out (opacity transitions back up smoothly).
function retarget(entry, tokenUuid, { fromFrac, toFrac, isGain }) {
  clearTimeout(entry.holdTimer);
  clearTimeout(entry.hideTimer);
  clearTimeout(entry.removeTimer);
  poseIn(entry.root); // also cancels a mid-exit slide
  entry.root.classList.toggle("fud-hpbar--gain", isGain);

  if (isGain) {
    // Heal mid-bar: sweep green up; whatever ghost remains gets covered (and
    // any later drain can only shrink it further — harmless underneath).
    entry.fill.style.width = `${toFrac * 100}%`;
    paintFill(entry.fill, toFrac);
    entry.hideTimer = setTimeout(() => beginHide(tokenUuid), GAIN_SLIDE_MS + LINGER_MS);
    return;
  }

  // Freeze the ghost at its current rendered width (no transition), then make
  // sure it still covers at least the pre-hit HP of THIS hit.
  const held = Math.max(renderedFrac(entry.ghost, entry.track), fromFrac, toFrac);
  entry.ghost.style.transition = "none";
  entry.ghost.style.width = `${held * 100}%`;
  entry.fill.style.width = `${toFrac * 100}%`;
  void entry.ghost.offsetWidth; // commit the freeze before re-enabling
  entry.ghost.style.transition = "";
  scheduleDrain(entry, tokenUuid, toFrac);
}

function beginHide(tokenUuid) {
  const entry = _active.get(tokenUuid);
  if (!entry) return;
  try { poseOut(entry.root); } catch (_) {}
  entry.removeTimer = setTimeout(() => {
    try { entry.root.remove(); } catch (_) {}
    _active.delete(tokenUuid);
  }, FADE_MS + 60);
}

// Remove every live bar immediately (no exit animation). Used by the tuner so
// a preview always SPAWNS with the newest geometry instead of retargeting a
// bar built from the old values.
export function clearNpcHpBars() {
  for (const [uuid, entry] of _active) {
    clearTimeout(entry.holdTimer);
    clearTimeout(entry.hideTimer);
    clearTimeout(entry.removeTimer);
    try { entry.root.remove(); } catch (_) {}
    _active.delete(uuid);
  }
}
