// ============================================================================
// Lightning Crystal FX — how a crystal arrives, counts, and leaves.
//
//   spawn-in   the crystal slides down into place while fading in, and lands
//              with a thud
//   tick       a system tick each time a countdown drops
//   shatter    a white flash, then a quick fade-out
//
// The detonation itself (the announcement card, the explosion, the damage) is
// sequenced by the event — events/lightning-crystal.js — because it is ordered
// around game state. Everything in THIS file is presentation that follows from
// documents every client already receives:
//
//   spawn-in ← the crystal's token is drawn, with no countdown yet (drawToken)
//   tick     ← its countdown Active Effect goes down   (updateActiveEffect)
//   shatter  ← that effect is marked shattering        (updateActiveEffect)
//
// So, like the countdown number and the Rod cursor, there is no socket here:
// each client animates off the world it was already sent, a hidden tab simply
// skips the show, and nothing can desync.
//
// Animation is on the token's MESH only (alpha / y), never the document, so
// nothing is written and the rewind / reload state is untouched. The GM's
// document write that finally hides a shattered crystal comes from the event.
//
// Not a manifest entry on its own account: imported by director-boot.js and
// initialised from its ready hook.
// ============================================================================

import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";
import { shouldRender } from "../battle-director/presentation-clock.js";

const FLAG_NS = "fabula-ultima-companion";
const TAG = "[FU][CrystalFx]";
const STYLE_ID = "fud-crystal-fx-style";

const warn = (...a) => console.warn(TAG, ...a);

/** Mirrors events/lightning-crystal.js. */
const CRYSTAL_OBJECT_ID = "lightning-crystal";
const COUNTDOWN_AE_NAME = "Crystal Countdown";

const SOUND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// Everything tunable lives here — edit and F5.
export const CRYSTAL_FX = Object.freeze({
  // Sounds (from the Forge library).
  landSfx: SOUND_BASE + "Soundboard/Earth3.ogg",
  landVolume: 0.6,
  tickSfx: SOUND_BASE + "System_Tick.mp3",
  tickVolume: 0.45,
  explosionSfx: SOUND_BASE + "Soundboard/Explosion2.ogg",
  explosionVolume: 0.7,
  explosionWebm: "modules/JB2A_DnD5e/Library/Generic/Explosion/Explosion_02_Blue_400x400.webm",
  explosionScale: 5.5,     // relative to the impact player's own token-sized default
  explosionMs: 1400,
  explosionImpactMs: 620,  // explosion appears → damage lands on the targets.
                           // Must cover the shatter (flashMs + fadeOutMs).

  // Spawn-in: slide down + fade in.
  spawnMs: 900,
  spawnDropPx: 160,        // world pixels above its resting spot

  // Shatter: flash, then a quick fade.
  flashMs: 260,
  fadeOutMs: 320,
});

/** Length of the shatter. `explosionImpactMs` must be at least this. */
export const SHATTER_TOTAL_MS = CRYSTAL_FX.flashMs + CRYSTAL_FX.fadeOutMs;

let _hooksOn = false;
let _lastTickAt = 0;
const _spent = new Set();      // tokenIds already shattered on this client
const _entered = new Set();    // tokenIds already given their entrance

function canShow() {
  if (!shouldRender()) return false;
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return false;
  return !!canvas?.ready;
}

function isCrystalActor(actor) {
  try { return actor?.flags?.[FLAG_NS]?.conflictObject === CRYSTAL_OBJECT_ID; }
  catch { return false; }
}

const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

/** Run `step(t)` for t in 0..1 over `ms`, on animation frames. */
function tween(ms, step) {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / ms);
      let alive = true;
      try { alive = step(t) !== false; } catch { alive = false; }
      if (alive && t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// ── Spawn-in ────────────────────────────────────────────────────────────────

async function playSpawnIn(token) {
  if (!token.mesh) return;
  token.mesh.alpha = 0;
  // drawToken fires before the first refresh has seated the mesh, so its
  // resting spot is only readable a couple of frames later.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (token.destroyed || !token.mesh) return;
  const restY = token.mesh.y;
  await tween(CRYSTAL_FX.spawnMs, (t) => {
    if (token.destroyed || !token.mesh) return false;
    const k = easeOutQuad(t);
    // Written every frame: a token refresh mid-drop re-seats the mesh at
    // restY, and the next frame simply puts it back on its way down.
    token.mesh.y = restY - CRYSTAL_FX.spawnDropPx * (1 - k);
    token.mesh.alpha = k;
    return true;
  });
  if (token.destroyed || !token.mesh) return;
  token.mesh.y = restY;
  token.mesh.alpha = 1;
  playSfx(CRYSTAL_FX.landSfx, CRYSTAL_FX.landVolume);
}

function hasCountdown(actor) {
  try { return !!actor?.effects?.find?.((e) => e?.name === COUNTDOWN_AE_NAME); }
  catch { return false; }
}

function onDrawToken(token) {
  try {
    const doc = token?.document;
    if (!doc || !isCrystalActor(token.actor)) return;
    if (_entered.has(doc.id)) return;
    // "Just arrived" is read off the world, not a clock: the event gives a
    // crystal its countdown effect a moment AFTER creating the token, so a
    // crystal drawn without one is brand new, and one drawn with it has been
    // standing there (an F5, a scene re-view) and must not replay its entrance.
    if (hasCountdown(token.actor)) { _entered.add(doc.id); return; }
    _entered.add(doc.id);
    // Warm the cues now, so the tick and the blast are instant when they come.
    preloadSfx([CRYSTAL_FX.landSfx, CRYSTAL_FX.tickSfx, CRYSTAL_FX.explosionSfx]).catch(() => {});
    if (!canShow()) return;
    playSpawnIn(token).catch((e) => warn("spawn-in threw", e));
  } catch (e) { warn("drawToken handler threw", e); }
}

// ── Shatter ─────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  // No backticks inside this block — it is a template literal.
  const css = `
.fud-crystal-flash {
  position: fixed;
  z-index: 99984;
  pointer-events: none;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(214,236,255,.9) 35%, rgba(120,180,255,0) 70%);
  mix-blend-mode: screen;
  animation: fud-crystal-flash ${CRYSTAL_FX.flashMs}ms ease-out forwards;
}
@keyframes fud-crystal-flash {
  0%   { opacity: 0; scale: .4; }
  30%  { opacity: 1; scale: 1; }
  100% { opacity: 0; scale: 1.5; }
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function spriteClientBounds(token) {
  const rect = canvas.app.view.getBoundingClientRect();
  const b = token.mesh?.getBounds?.();
  if (b && b.width > 0 && b.height > 0) {
    return { cx: rect.left + b.x + b.width / 2, cy: rect.top + b.y + b.height / 2, size: Math.max(b.width, b.height) };
  }
  return null;
}

async function playShatter(token) {
  ensureStyles();
  const b = spriteClientBounds(token);
  if (b) {
    const el = document.createElement("div");
    el.className = "fud-crystal-flash";
    el.style.left = `${b.cx}px`;
    el.style.top = `${b.cy}px`;
    el.style.width = el.style.height = `${b.size * 2.2}px`;
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch { /* gone */ } }, CRYSTAL_FX.flashMs + 60);
  }
  // The fade starts under the flash's peak, so the crystal is already going
  // when the white clears.
  await new Promise((r) => setTimeout(r, CRYSTAL_FX.flashMs * 0.35));
  await tween(CRYSTAL_FX.fadeOutMs, (t) => {
    if (token.destroyed || !token.mesh) return false;
    token.mesh.alpha = 1 - t;
    return true;
  });
}

// ── Countdown-driven beats ──────────────────────────────────────────────────

function onCountdownUpdate(effect, changed) {
  try {
    if (String(effect?.name ?? "").trim() !== COUNTDOWN_AE_NAME) return;
    const actor = effect.parent;
    if (actor?.documentName !== "Actor") return;
    const delta = changed?.flags?.[FLAG_NS] ?? {};
    const tokens = actor.getActiveTokens?.(true) ?? [];

    // `crystalShattering` is written as the explosion starts; `crystalSpent`
    // (the rules flag, written after the damage) is accepted too so a crystal
    // can never be removed without its shatter. _spent keeps it to once.
    if (delta.crystalShattering === true || delta.crystalSpent === true) {
      for (const token of tokens) {
        if (_spent.has(token.id)) continue;
        _spent.add(token.id);
        if (!canShow()) continue;
        playShatter(token).catch((e) => warn("shatter threw", e));
      }
      return;
    }

    // A tick: the stamp only changes when a turn start ticked this crystal.
    // (A bump writes the number without touching the stamp, so it stays
    // silent — the floating "+N" is its feedback.)
    if ("crystalTickKey" in delta && Number(effect.flags?.[FLAG_NS]?.crystalCountdown) > 0) {
      if (!canShow()) return;
      // Two crystals tick in the same instant; one tick is enough.
      const now = performance.now();
      if (now - _lastTickAt < 120) return;
      _lastTickAt = now;
      playSfx(CRYSTAL_FX.tickSfx, CRYSTAL_FX.tickVolume);
    }
  } catch (e) { warn("countdown handler threw", e); }
}

/** Idempotent — called on every client from director-boot's ready hook. */
export function initLightningCrystalFx() {
  if (_hooksOn) return;
  _hooksOn = true;
  Hooks.on("drawToken", onDrawToken);
  Hooks.on("updateActiveEffect", onCountdownUpdate);
  Hooks.on("deleteToken", (tokenDoc) => {
    _spent.delete(tokenDoc?.id);
    _entered.delete(tokenDoc?.id);
  });
}
