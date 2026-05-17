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

      if (game.user?.isGM) {
        try {
          await CAMP.RestAPI.perform();
        } catch (e) {
          console.error("[CampSystem][SleepUI]", "RestAPI.perform() failed:", e);
        }
        await new Promise(r => setTimeout(r, 500));
        await CAMP.State.setPhase(CAMP.PHASE.SET_OUT_LOBBY);
      }
      // Non-GM clients wait for the updateSetting hook to change the phase,
      // which triggers camp-bootstrap to fade back in and show the Set Out button.
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
