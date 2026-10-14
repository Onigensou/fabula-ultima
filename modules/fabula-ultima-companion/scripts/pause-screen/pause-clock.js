/**
 * [ONI] Pause — a clock that stops while the game is paused
 * Foundry VTT v12
 *
 * File:
 * scripts/pause-screen/pause-clock.js
 *
 * Core pause (game.paused) stops player token movement, but not the module's
 * own timers: a break in the middle of an event would let its text move on
 * and its time limit run out with nobody at the table. A console pause
 * freezes everything, so module timers that should freeze use this instead
 * of setTimeout.
 *
 * A timer counts only while the game is not paused. Pausing keeps the time
 * that is left; resuming counts the rest. A timer made during a pause waits
 * for the resume before it starts counting.
 *
 * Exposes API to:
 *   window.oni.Pause
 *
 * Usage:
 *   const t = window.oni.Pause.timeout(() => { ... }, 30000);
 *   t.clear(); // cancel
 *   window.oni.Pause.isPaused();
 */

(() => {
  const INSTALL_TAG = "[ONI][Pause]";

  window.oni = window.oni || {};
  if (window.oni.Pause?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const isPaused = () => !!globalThis.game?.paused;

  // Live timers: { fn, remaining, startedAt, handle }
  const timers = new Set();

  function arm(t) {
    t.startedAt = Date.now();
    t.handle = setTimeout(() => {
      timers.delete(t);
      try { t.fn(); }
      catch (e) { console.error(INSTALL_TAG, "A timer callback threw.", e); }
    }, Math.max(0, t.remaining));
  }

  function freeze(t) {
    if (t.handle == null) return;
    clearTimeout(t.handle);
    t.handle = null;
    t.remaining -= Date.now() - t.startedAt;
  }

  function timeout(fn, ms) {
    const t = { fn, remaining: Math.max(0, Number(ms) || 0), startedAt: 0, handle: null };
    timers.add(t);
    if (!isPaused()) arm(t);
    return {
      clear() {
        if (t.handle != null) clearTimeout(t.handle);
        t.handle = null;
        timers.delete(t);
      },
    };
  }

  Hooks.on("pauseGame", (paused) => {
    for (const t of timers) {
      if (paused) freeze(t);
      else if (t.handle == null) arm(t);
    }
  });

  window.oni.Pause = {
    installed: true,
    isPaused,
    timeout,
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.Pause");
})();
