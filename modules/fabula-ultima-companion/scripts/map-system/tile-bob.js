/**
 * Fabula Ultima Companion - Bobbing tiles (floating stones)
 * Foundry VTT v12
 *
 * File:
 * scripts/map-system/tile-bob.js
 *
 * What this does:
 * - A tile flagged `flags.fabula-ultima-companion.bob = { amp, period, phase }`
 *   floats: its drawing rises and sinks a few px, slowly. First use: the 19
 *   stepping stones of Maelstrom Confluence, each a cut-out tile over the
 *   painting (the parallax mist layer paints the clean plate under them).
 * - window.oni.TileBob.dip(x, y): the bobbing tile under that map point sinks
 *   and springs back, as if a foot landed on it (Jump To calls it at a landing).
 *
 * Client-only and visual: the tile document never moves, so walls, events and
 * markers stay where they were placed. Reduced-motion players see the stones
 * still; a hidden tab skips the work.
 */

(() => {
  const TAG = "[ONI][TileBob]";
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG = "bob";

  window.oni = window.oni || {};
  if (window.oni.TileBob?.installed) return;

  // Spring for a dip: stiffness and how much of the speed is left after a second.
  const SPRING = { k: 40, damping: 5, keepPerSecond: 0.02, kick: 34 };
  const reduceMotion = () => matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  const state = { tiles: new Map(), tickerFn: null, t0: performance.now() };

  function readBob(doc) {
    const raw = doc?.flags?.[MODULE_ID]?.[FLAG];
    if (!raw || typeof raw !== "object") return null;
    const amp = Number(raw.amp);
    const period = Number(raw.period);
    if (!(amp > 0) || !(period > 0)) return null;
    return { amp, period, phase: Number(raw.phase) || 0 };
  }

  function collect() {
    state.tiles.clear();
    for (const tile of canvas?.tiles?.placeables ?? []) {
      const bob = readBob(tile.document);
      if (bob) state.tiles.set(tile.id, { tile, bob, dip: 0, dv: 0 });
    }
    if (state.tiles.size && !state.tickerFn) {
      state.tickerFn = tick;
      canvas.app.ticker.add(state.tickerFn);
    } else if (!state.tiles.size && state.tickerFn) {
      canvas.app.ticker.remove(state.tickerFn);
      state.tickerFn = null;
    }
  }

  let last = performance.now();
  function tick() {
    try {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.visibilityState === "hidden") return;
      const still = reduceMotion();
      const t = (now - state.t0) / 1000;
      for (const rec of state.tiles.values()) {
        const { tile, bob } = rec;
        const mesh = tile?.mesh;
        if (!mesh || mesh.destroyed) continue;
        // a damped spring for the dip
        const a = (-rec.dip * SPRING.k) - (rec.dv * SPRING.damping);
        rec.dv += a * dt;
        rec.dip += rec.dv * dt;
        rec.dv *= Math.pow(SPRING.keepPerSecond, dt);
        const doc = tile.document;
        const baseY = doc.y + (doc.height / 2);
        const float = still ? 0 : Math.sin((t * Math.PI * 2 / bob.period) + bob.phase) * bob.amp;
        mesh.y = baseY + float + rec.dip;
      }
    } catch (e) {
      console.warn(TAG, "Bob frame failed; stopping.", e);
      try { canvas.app.ticker.remove(state.tickerFn); } catch (_) {}
      state.tickerFn = null;
    }
  }

  function dip(x, y) {
    for (const rec of state.tiles.values()) {
      const d = rec.tile?.document;
      if (!d) continue;
      if (x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height) {
        rec.dv += SPRING.kick;
        return true;
      }
    }
    return false;
  }

  Hooks.on("canvasReady", () => {
    if (state.tickerFn) { try { canvas.app.ticker.remove(state.tickerFn); } catch (_) {} state.tickerFn = null; }
    collect();
  });
  for (const hook of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(hook, (doc) => { if (doc?.parent?.id === canvas?.scene?.id) setTimeout(collect, 0); });
  }

  window.oni.TileBob = { installed: true, dip, collect, FLAG };
  console.debug(TAG, "Installed. API: window.oni.TileBob");
})();
