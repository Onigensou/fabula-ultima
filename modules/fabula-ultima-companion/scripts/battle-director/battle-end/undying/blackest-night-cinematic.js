// The Blackest Night — revival cinematic.
//
// ── PHASE-1 STUB ──────────────────────────────────────────────────────────
// Timing skeleton only: a GM-local dark pulse, the rise beat, done. The real
// fake-out (reuse of the victory FX + BGM fade → heartbeat → snap-pan to the
// boss → implosion burst → color-flood rise → boss BGM back, broadcast to
// all clients) replaces the INTERNALS of this file in Phase 3. The contract
// below is stable and everything else already codes against it:
//
//   await playBlackestNightCinematic({ mode, director, endCtx, bossTokenUuid, onRise })
//     mode          "full" (first revival this battle) | "short" (later ones)
//     onRise        async — MUST be awaited exactly once, at the moment the
//                   boss visually rises; the engine lands the HP/MP/ZP
//                   restore inside it. Callers have a failsafe if this never
//                   runs, but the beat looks wrong — don't rely on it.
//     resolves      when the cinematic has fully played out (combat resume
//                   is gated on it).

import { log, warn } from "../../logger.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const OVERLAY_ID = "fud-blackest-night-stub";

function showStubOverlay(fadeInMs) {
  try {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = OVERLAY_ID;
      Object.assign(el.style, {
        position: "fixed", inset: "0", zIndex: "99990",
        background: "radial-gradient(ellipse at center, rgba(30,0,50,0.55), rgba(0,0,0,0.85))",
        opacity: "0", pointerEvents: "none",
        transition: `opacity ${fadeInMs}ms ease-in`,
      });
      document.body.appendChild(el);
    }
    requestAnimationFrame(() => { el.style.opacity = "1"; });
  } catch (e) { warn("[BlackestNight:stub] overlay show failed", e); }
}

function hideStubOverlay(fadeOutMs) {
  try {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    el.style.transition = `opacity ${fadeOutMs}ms ease-out`;
    el.style.opacity = "0";
    setTimeout(() => { try { el.remove(); } catch (_) {} }, fadeOutMs + 100);
  } catch (_) {}
}

export async function playBlackestNightCinematic({
  mode = "full",
  director = null,        // reserved for Phase 3 (BGM handles, camera plans)
  endCtx = null,          // reserved for Phase 3 (viewport snapshots)
  bossTokenUuid = null,   // reserved for Phase 3 (pan target, burst anchor)
  onRise = null,
} = {}) {
  const t = mode === "full"
    ? { fadeIn: 600, hold: 1400, riseTail: 900, fadeOut: 500 }
    : { fadeIn: 250, hold: 500,  riseTail: 450, fadeOut: 300 };

  log(`[BlackestNight:stub] cinematic (${mode}) — Phase-3 replaces this with the full fake-out`);

  showStubOverlay(t.fadeIn);
  await wait(t.fadeIn + t.hold);

  // ── the rise beat — restore lands here ──
  if (typeof onRise === "function") {
    try { await onRise(); }
    catch (e) { warn("[BlackestNight:stub] onRise threw", e); }
  }

  await wait(t.riseTail);
  hideStubOverlay(t.fadeOut);
  await wait(t.fadeOut);
}
