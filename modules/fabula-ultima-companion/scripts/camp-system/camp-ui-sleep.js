// ============================================================================
// Camp System — Sleep Sequence UI
//
// Fades screen to black, calls RestAPI.perform() (GM only), then fades back.
// All clients get the visual; data changes are GM-driven via RestAPI.
// ============================================================================
(() => {
  const CAMP       = globalThis.CampSystem ??= {};
  const TAG        = "[CampSystem][SleepUI]";
  const SCREEN_ID  = "oni-camp-sleep-screen";

  CAMP.SleepUI = {
    async run() {
      _ensureScreen();
      await _fadeToBlack();

      // PRIMARY GM only. run() executes on every client via the phase hook, so
      // an `isGM` gate lets BOTH GM clients perform the rest: two jingle
      // broadcasts, two AE sweeps, and campRestCharges decremented twice (food
      // buffs silently expiring a rest early). See shared/primary-gm.js.
      if (globalThis.FUCompanion?.isPrimaryGM?.()) {
        try {
          await CAMP.RestAPI.perform();
        } catch (e) {
          console.error("[CampSystem][SleepUI]", "RestAPI.perform() failed:", e);
        }
        await new Promise(r => setTimeout(r, 500));
        // The screen STAYS black: the save ceremony plays out on top of it and
        // hands off to SET_OUT_LOBBY (or the title screen) when it resolves.
        await CAMP.State.setPhase(CAMP.PHASE.REST_SAVE_PROMPT);
      }
      // Non-GM clients wait for the updateSetting hook to change the phase,
      // which triggers camp-bootstrap to draw the save panel over the black.
    },

    fadeIn() {
      _fadeFromBlack();
    },

    cleanup() {
      const el = document.getElementById(SCREEN_ID);
      if (el) { el.classList.remove("dark"); }
    },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _ensureScreen() {
    if (document.getElementById(SCREEN_ID)) return;
    const el = document.createElement("div");
    el.id = SCREEN_ID;
    document.body.appendChild(el);
  }

  function _fadeToBlack() {
    return new Promise(resolve => {
      const el = document.getElementById(SCREEN_ID);
      if (!el) return resolve();
      // Double-rAF: let the browser paint opacity:0 before adding .dark,
      // otherwise the element goes from "not rendered" → opacity:1 with no transition.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.classList.add("dark");
        setTimeout(resolve, 1300); // matches CSS transition duration
      }));
    });
  }

  function _fadeFromBlack() {
    return new Promise(resolve => {
      const el = document.getElementById(SCREEN_ID);
      if (!el) return resolve();
      el.classList.remove("dark");
      setTimeout(resolve, 1300);
    });
  }

  console.debug(TAG, "Sleep UI loaded.");
})();
