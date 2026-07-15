// Director-native transient NPC HP bar — DOM screen-space subsystem.
//
// When a STUDIED hostile NPC's HP changes (damage or heal), a bare unlabeled
// bar fades in under the token, slides to the new fill, lingers, and fades
// out — giving players an APPROXIMATE read on the monster's condition without
// exposing numbers. Player characters never get one (they have the resource
// HUD); unstudied monsters never get one (studying is what unlocks it).
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
// MULTI-HIT: one bar per token (`_active` map). A new payload while a bar is
// up RETARGETS the existing fill — CSS width transitions animate from the
// current rendered value, so a 5-hit combo reads as one bar stepping down five
// times — and resets the linger timer.
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

// Timing (ms). Life = FADE_IN + SLIDE + LINGER + FADE_OUT; retargets restart
// the SLIDE+LINGER portion.
const FADE_MS = 200;     // opacity in/out (CSS transition, both directions)
const SLIDE_MS = 600;    // fill width slide
const LINGER_MS = 700;   // hold after the slide completes

// Payload fractions are quantized to 2% steps — visually invisible, but blunts
// deriving max HP from a known damage number over an exact fraction delta.
const QUANT_STEPS = 50;

// Bar geometry (screen px). Width follows the token's on-screen width so a
// boss token gets a wider bar, clamped so tiny/huge zooms stay readable.
const BAR_MIN_W = 64;
const BAR_MAX_W = 240;
const BAR_H = 9;
const BAR_OFFSET_Y = 12; // gap below the token's bottom edge

let _socket = null;
// tokenUuid -> { root, fill, hideTimer, removeTimer } — one live bar per token.
const _active = new Map();

// ── boot: socket registration ──────────────────────────────────────────────
// Idempotent. Call once on every client after socketlib is up (boot `ready`).
export function initNpcHpBar() {
  try {
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
    const tokenDoc = resolveTokenDoc(tokenUuid);
    if (!tokenDoc) return;
    const HOSTILE = CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
    if (tokenDoc.disposition !== HOSTILE) return;
    if (!isStudiedMonster(tokenDoc, actor)) return;
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
.fud-hpbar {
  position: fixed; z-index: 99985; pointer-events: none;
  transform: translate(-50%, 0);
  opacity: 0;
  transition: opacity ${FADE_MS}ms ease;
}
.fud-hpbar-track {
  position: relative; width: 100%; height: 100%;
  border-radius: 999px;
  background: rgba(10, 10, 14, .78);
  border: 1px solid rgba(255, 255, 255, .28);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .55);
  overflow: hidden;
}
.fud-hpbar-fill {
  position: absolute; top: 0; left: 0; bottom: 0;
  border-radius: 999px;
  transition: width ${SLIDE_MS}ms cubic-bezier(.22, .9, .32, 1),
              background-color ${SLIDE_MS}ms ease,
              box-shadow ${SLIDE_MS}ms ease;
}
/* Heal (fill sliding UP) — soft green glow so a recover reads differently. */
.fud-hpbar--gain .fud-hpbar-fill {
  box-shadow: 0 0 8px 1px rgba(110, 255, 140, .8);
}
/* Crisis notch — FU's mechanically meaningful 50% line, over the track. */
.fud-hpbar-notch {
  position: absolute; top: -1px; bottom: -1px; left: 50%;
  width: 2px; margin-left: -1px;
  background: rgba(255, 255, 255, .45);
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

// Approximate condition color from the fill fraction: healthy green above 50%
// (Crisis), wounded amber above 25%, danger red below.
function fillColor(frac) {
  if (frac > 0.5) return "#57c96b";
  if (frac > 0.25) return "#e8c33a";
  return "#e84b3a";
}

// ── render (runs on EVERY client) ──────────────────────────────────────────
// One bar per token: spawn if absent (fade in at fromFrac, slide to toFrac),
// RETARGET if present (CSS transitions continue from the current rendered
// width — mid-animation retargets are smooth for free). Self-removes after
// slide + linger + fade. Silently no-ops off-canvas — flavor, never critical.
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
      // Retarget the live bar: new fill target + color, restart linger clock,
      // cancel any in-progress fade-out (opacity transitions back up smoothly).
      clearTimeout(existing.hideTimer);
      clearTimeout(existing.removeTimer);
      existing.root.style.opacity = "1";
      existing.root.classList.toggle("fud-hpbar--gain", isGain);
      existing.fill.style.width = `${toFrac * 100}%`;
      existing.fill.style.backgroundColor = fillColor(toFrac);
      existing.hideTimer = setTimeout(() => beginHide(tokenUuid), SLIDE_MS + LINGER_MS);
      return;
    }
    _active.delete(tokenUuid); // clear a stale (disconnected) entry

    // ── spawn ──
    // Screen-space geometry from the token's on-screen footprint at spawn time
    // (snapshot positioning — same accepted tradeoff as the damage numbers).
    const scale = canvas.stage.scale?.x ?? 1;
    const barW = Math.round(Math.max(BAR_MIN_W, Math.min(BAR_MAX_W, (token.w ?? 100) * scale)));
    const cx = token.center?.x ?? (token.x ?? 0) + (token.w ?? 100) / 2;
    const bottomY = (token.y ?? 0) + (token.h ?? 100);
    const pt = worldToClient(cx, bottomY);

    const root = document.createElement("div");
    root.className = "fud-hpbar" + (isGain ? " fud-hpbar--gain" : "");
    root.style.left = `${pt.x}px`;
    root.style.top = `${pt.y + BAR_OFFSET_Y}px`;
    root.style.width = `${barW}px`;
    root.style.height = `${BAR_H}px`;

    const track = document.createElement("div");
    track.className = "fud-hpbar-track";
    const fill = document.createElement("div");
    fill.className = "fud-hpbar-fill";
    fill.style.width = `${fromFrac * 100}%`;
    fill.style.backgroundColor = fillColor(fromFrac);
    const notch = document.createElement("div");
    notch.className = "fud-hpbar-notch";
    track.appendChild(fill);
    track.appendChild(notch);
    root.appendChild(track);
    document.body.appendChild(root);

    registerAnimation({
      kind: "npc-hp-bar",
      durationMs: FADE_MS + SLIDE_MS + LINGER_MS + FADE_MS,
      meta: { tokenUuid },
    });

    // Force a reflow so the fill's fromFrac width and the root's opacity:0 are
    // committed BEFORE the animated values land — otherwise the transition is
    // skipped and the bar pops in already at toFrac.
    void root.offsetWidth;
    root.style.opacity = "1";
    fill.style.width = `${toFrac * 100}%`;
    fill.style.backgroundColor = fillColor(toFrac);

    const entry = { root, fill, hideTimer: null, removeTimer: null };
    entry.hideTimer = setTimeout(() => beginHide(tokenUuid), SLIDE_MS + LINGER_MS);
    _active.set(tokenUuid, entry);
  } catch (e) {
    warn("renderNpcHpBarLocal threw", e);
  }
}

function beginHide(tokenUuid) {
  const entry = _active.get(tokenUuid);
  if (!entry) return;
  try { entry.root.style.opacity = "0"; } catch (_) {}
  entry.removeTimer = setTimeout(() => {
    try { entry.root.remove(); } catch (_) {}
    _active.delete(tokenUuid);
  }, FADE_MS + 60);
}
