// ============================================================================
// Camp System — Sleep Sequence UI
//
// Fades screen to black, executes the sleep macro, then fades back.
// Only the GM drives the macro call; all clients get the visual.
// ============================================================================
(() => {
  const CAMP       = globalThis.CampSystem ??= {};
  const TAG        = "[CampSystem][SleepUI]";
  const SCREEN_ID  = "oni-camp-sleep-screen";
  const SLEEP_MACRO_ID = "Macro.q6IO0vvfLe4YNf7x";

  CAMP.SleepUI = {
    async run() {
      _ensureScreen();
      await _fadeToBlack();

      if (game.user?.isGM) {
        await _runSleepMacro();
        // Small pause to let macro effects settle
        await new Promise(r => setTimeout(r, 1000));
        // Advance to set-out phase
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
      el.classList.add("dark");
      setTimeout(resolve, 1300); // matches CSS transition
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

  async function _runSleepMacro() {
    try {
      const macro = await fromUuid(SLEEP_MACRO_ID).catch(() => null)
                 ?? game.macros?.get(SLEEP_MACRO_ID.replace("Macro.", ""))
                 ?? null;
      if (!macro) {
        console.warn(TAG, "Sleep macro not found:", SLEEP_MACRO_ID);
        // Fallback: wait 2 seconds
        await new Promise(r => setTimeout(r, 2000));
        return;
      }
      await macro.execute();
    } catch (e) {
      console.error(TAG, "Sleep macro failed:", e);
    }
  }

  console.debug(TAG, "Sleep UI loaded.");
})();
