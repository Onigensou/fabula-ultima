// ============================================================================
// Camp System — Bootstrap / Main Orchestrator
//
// Detects when the active scene is a Camp scene and activates/deactivates
// the camp system accordingly. Listens to updateSetting to drive phase
// transitions across all clients.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const MOD    = CAMP.MODULE_ID;
  const TAG    = "[CampSystem][Bootstrap]";
  const GLOBAL = "__ONI_CAMP_BOOTSTRAP__";

  if (globalThis[GLOBAL]?.installed) return;
  globalThis[GLOBAL] = { installed: true };

  // ---------------------------------------------------------------------------
  // Scene mode detection
  // ---------------------------------------------------------------------------
  function isCampScene(scene) {
    const mode = scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode;
    return mode === "camp";
  }

  // ---------------------------------------------------------------------------
  // Activate / Deactivate
  // ---------------------------------------------------------------------------
  let _campActive = false;

  function activateCamp(scene) {
    _campActive = true;
    console.debug(TAG, "Camp mode activated for scene:", scene?.name);

    CAMP.UIHider?.activate();
    CAMP.Button.show();
    CAMP.GMPanel?.show();
    // Restore UI for current phase immediately
    _onPhaseChange(CAMP.State.getPhase());
  }

  function deactivateCamp() {
    if (!_campActive) return;
    _campActive = false;
    console.debug(TAG, "Camp mode deactivated.");

    CAMP.UIHider?.deactivate();
    CAMP.Button.hide();
    CAMP.GMPanel?.hide();
    _closeOverlay();
    CAMP.SleepUI.cleanup();
  }

  function _closeOverlay() {
    const el = document.getElementById("oni-camp-overlay");
    if (el) { el.classList.add("out"); setTimeout(() => el.remove(), 280); }
  }

  // ---------------------------------------------------------------------------
  // Phase transition handler (called on all clients via updateSetting hook)
  // ---------------------------------------------------------------------------
  async function _onPhaseChange(phase) {
    if (!_campActive) return;
    console.debug(TAG, "Phase →", phase);

    switch (phase) {
      // ── FREE_ROAM ─────────────────────────────────────────────────────────
      case CAMP.PHASE.FREE_ROAM:
        _closeOverlay();
        CAMP.SleepUI.fadeIn();       // fade back in if coming from sleep
        await CAMP.Button.show();    // show() refreshes the party cache, then renders
        break;

      // ── ACTIVITY SELECT ───────────────────────────────────────────────────
      case CAMP.PHASE.ACTIVITY_SELECT:
        _closeOverlay();
        CAMP.Button.hide();
        await CAMP.ActivitySelectUI.show();
        break;

      // ── ACTIVITY RESOLVE ──────────────────────────────────────────────────
      case CAMP.PHASE.ACTIVITY_RESOLVE:
        CAMP.ActivitySelectUI.hide?.();
        await CAMP.ActivityResolveUI.show();
        break;

      // ── BOND UPDATE ───────────────────────────────────────────────────────
      case CAMP.PHASE.BOND_UPDATE:
        CAMP.ActivityResolveUI.hide?.();
        await CAMP.BondUI.show();
        break;

      // ── BOND SUMMARY ──────────────────────────────────────────────────────
      case CAMP.PHASE.BOND_SUMMARY:
        CAMP.BondUI.hide?.();
        await CAMP.BondSummaryUI.show();
        // Note: BondSummaryUI.show() handles auto-advance to SLEEP_LOBBY (GM only)
        break;

      // ── SLEEP LOBBY ───────────────────────────────────────────────────────
      case CAMP.PHASE.SLEEP_LOBBY:
        _closeOverlay();
        await CAMP.Button.show();    // show() refreshes the party cache, then renders
        break;

      // ── SLEEPING ──────────────────────────────────────────────────────────
      case CAMP.PHASE.SLEEPING:
        CAMP.Button.hide();
        await CAMP.SleepUI.run();
        // After run(): GM has already set phase to SET_OUT_LOBBY
        // Non-GM clients wait for the updateSetting hook
        break;

      // ── SET OUT LOBBY ─────────────────────────────────────────────────────
      case CAMP.PHASE.SET_OUT_LOBBY:
        CAMP.SleepUI.fadeIn();   // ensure screen is visible again
        await CAMP.Button.show();    // show() refreshes the party cache, then renders
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    // Check current scene immediately
    if (canvas?.scene && isCampScene(canvas.scene)) {
      activateCamp(canvas.scene);
    }
  });

  Hooks.on("canvasReady", () => {
    if (canvas?.scene && isCampScene(canvas.scene)) {
      _campActive = false; // reset so activateCamp re-runs fully on every scene load
      activateCamp(canvas.scene);
    } else {
      deactivateCamp();
    }
  });

  // React to world setting changes (phase transitions)
  Hooks.on("updateSetting", (setting) => {
    // Self-heal: if we're on a camp scene but _campActive somehow got cleared, reactivate
    if (!_campActive) {
      if (canvas?.scene && isCampScene(canvas.scene)) {
        _campActive = false;
        activateCamp(canvas.scene);
      }
      return;
    }
    const key = setting?.key ?? "";

    if (key === `${MOD}.${CAMP.SETTING.PHASE}`) {
      const phase = CAMP.State.getPhase();
      CAMP.GMPanel?.render();
      _onPhaseChange(phase);
      return;
    }

    // Refresh button UI on any ready-map change
    if ([
      `${MOD}.${CAMP.SETTING.READY}`,
      `${MOD}.${CAMP.SETTING.SLEEP_READY}`,
      `${MOD}.${CAMP.SETTING.SET_OUT_READY}`,
    ].includes(key)) {
      CAMP.Button.render();
      return;
    }

    // Refresh activity selection display on selection changes
    if (key === `${MOD}.${CAMP.SETTING.SELECTIONS}`) {
      CAMP.ActivitySelectUI.refresh?.();
      return;
    }
  });

  // ── Phase order for nextPhase / prevPhase ──────────────────────────────────
  const PHASE_ORDER = [
    CAMP.PHASE.FREE_ROAM,
    CAMP.PHASE.ACTIVITY_SELECT,
    CAMP.PHASE.ACTIVITY_RESOLVE,
    CAMP.PHASE.BOND_UPDATE,
    CAMP.PHASE.BOND_SUMMARY,
    CAMP.PHASE.SLEEP_LOBBY,
    CAMP.PHASE.SLEEPING,
    CAMP.PHASE.SET_OUT_LOBBY,
  ];

  // Expose API for manual override / debugging
  CAMP.debug = {
    activate:   () => activateCamp(canvas?.scene),
    deactivate: () => deactivateCamp(),
    reset:      () => game.user?.isGM && CAMP.State.reset(),
    getState:   () => ({
      phase:      CAMP.State.getPhase(),
      ready:      CAMP.State.getReady(),
      selections: CAMP.State.getSelections(),
    }),

    // Force a specific phase by name or key
    setPhase(p) {
      if (!game.user?.isGM) return;
      const key = Object.values(CAMP.PHASE).includes(p) ? p
        : Object.entries(CAMP.PHASE).find(([k]) => k.toLowerCase() === String(p).toLowerCase())?.[1];
      if (!key) { console.warn(TAG, "Unknown phase:", p, "— valid:", Object.keys(CAMP.PHASE).join(", ")); return; }
      return CAMP.State.setPhase(key);
    },

    // Step forward one phase
    nextPhase() {
      if (!game.user?.isGM) return;
      const cur = CAMP.State.getPhase();
      const idx = PHASE_ORDER.indexOf(cur);
      const nxt = PHASE_ORDER[idx + 1] ?? PHASE_ORDER[0];
      console.debug(TAG, "debug.nextPhase →", nxt);
      return CAMP.State.setPhase(nxt);
    },

    // Step backward one phase
    prevPhase() {
      if (!game.user?.isGM) return;
      const cur = CAMP.State.getPhase();
      const idx = PHASE_ORDER.indexOf(cur);
      const prv = PHASE_ORDER[idx - 1] ?? CAMP.PHASE.FREE_ROAM;
      console.debug(TAG, "debug.prevPhase →", prv);
      return CAMP.State.setPhase(prv);
    },

    // Print a cheat-sheet of available commands
    help() {
      console.log(
        "%c[CampSystem] Debug commands\n" +
        "CAMP.debug.setPhase('free_roam')  — jump to a specific phase\n" +
        "CAMP.debug.nextPhase()            — advance one phase\n" +
        "CAMP.debug.prevPhase()            — go back one phase\n" +
        "CAMP.debug.reset()                — reset all state to FREE_ROAM\n" +
        "CAMP.debug.getState()             — print current state object\n" +
        "CAMP.debug.activate()             — force-activate camp mode\n" +
        "CAMP.debug.help()                 — this message\n" +
        "\nValid phases: " + Object.values(CAMP.PHASE).join(", "),
        "color:#c8a050;font-weight:bold;"
      );
    },
  };

  console.debug(TAG, "Bootstrap installed.");
})();
