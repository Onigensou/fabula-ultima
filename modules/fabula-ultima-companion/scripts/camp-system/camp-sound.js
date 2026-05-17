// ============================================================================
// Camp System — Sound Manager
//
// Registry-based API so any camp phase can register/play sounds without
// touching this file.  Extend via CAMP.Sound.register(key, config).
//
// config shape: { src: string, volume?: number, push?: boolean }
//   push: false (default) = local only
//   push: true            = broadcast to all clients via Foundry socket
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][Sound]";

  const _registry = {};

  function _play(src, volume, push) {
    if (!src) return;
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, push);
    } catch (e) {
      console.warn(TAG, "AudioHelper.play failed:", e);
    }
  }

  CAMP.Sound = {
    /**
     * Register a sound key.
     * CAMP.Sound.register("my.key", { src: "...", volume: 0.7, push: false });
     */
    register(key, config) {
      _registry[key] = config;
    },

    /** Play a registered sound by key. Silently skips unknown keys. */
    play(key) {
      const cfg = _registry[key];
      if (!cfg) return;
      _play(cfg.src, cfg.volume ?? 0.7, cfg.push ?? false);
    },

    /** Preload all registered sounds into the browser cache. */
    preloadAll() {
      for (const { src } of Object.values(_registry)) {
        try {
          if (typeof AudioHelper?.preloadSound === "function") {
            AudioHelper.preloadSound(src);
          } else {
            fetch(src, { cache: "force-cache" }).catch(() => {});
          }
        } catch {}
      }
    },
  };

  // ── Canonical key names (import these wherever you need to play a sound) ──
  CAMP.SFX = Object.freeze({
    // Activity Select screen
    ACTIVITY_HOVER:   "activity.hover",
    ACTIVITY_SELECT:  "activity.select",
    ACTIVITY_CONFIRM: "activity.confirm",
    // Phase transitions
    CAMP_START:       "camp.start",
    // Bond Update screen
    BOND_START:            "bond.start",
    BOND_HOVER:            "bond.hover",
    BOND_CONFIRM:          "bond.confirm",
    BOND_DROPDOWN_CHANGE:  "bond.dropdown.change",
    // Bond Summary screen
    BOND_SUM_ENTER:        "bond.summary.enter",
    BOND_SUM_NEW_BOND:     "bond.summary.new_bond",
    BOND_SUM_EMOTION_UP:   "bond.summary.emotion_up",
    BOND_SUM_EMOTION_DN:   "bond.summary.emotion_down",
    BOND_SUM_LEVEL_1:      "bond.summary.level_1",
    BOND_SUM_LEVEL_2:      "bond.summary.level_2",
    BOND_SUM_LEVEL_3:      "bond.summary.level_3",
    BOND_SUM_GENERIC:      "bond.summary.generic",
    BOND_SUM_CLEARED:      "bond.summary.cleared",
  });

  // ── Sound definitions ─────────────────────────────────────────────────────
  const _BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

  // Local-only interaction sounds
  CAMP.Sound.register(CAMP.SFX.ACTIVITY_HOVER,   { src: `${_BASE}BattleCursor_4.wav`, volume: 0.5,  push: false });
  CAMP.Sound.register(CAMP.SFX.ACTIVITY_SELECT,  { src: `${_BASE}BattleCursor_2.wav`, volume: 0.6,  push: false });
  CAMP.Sound.register(CAMP.SFX.ACTIVITY_CONFIRM, { src: `${_BASE}check_ready.wav`,    volume: 0.65, push: false });

  // "Global" — show() runs on every client when the phase changes,
  // so playing locally here naturally plays for the whole group.
  CAMP.Sound.register(CAMP.SFX.CAMP_START,        { src: `${_BASE}check_start.wav`,    volume: 0.7,  push: false });

  // Bond Update screen
  CAMP.Sound.register(CAMP.SFX.BOND_START,           { src: `${_BASE}bond_start.wav`,     volume: 0.7,  push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_HOVER,           { src: `${_BASE}BattleCursor_4.wav`, volume: 0.45, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_CONFIRM,         { src: `${_BASE}Success_1.wav`,      volume: 0.65, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_DROPDOWN_CHANGE, { src: `${_BASE}BattleCursor_2.wav`, volume: 0.5,  push: false });

  // Bond Summary screen — play locally; show() runs on every client so sync is natural
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_ENTER,       { src: `${_BASE}check_start.wav`,    volume: 0.7,  push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_NEW_BOND,    { src: `${_BASE}bond_create.wav`,    volume: 0.7,  push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_EMOTION_UP,  { src: `${_BASE}emotion_up.wav`,     volume: 0.7,  push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_EMOTION_DN,  { src: `${_BASE}emotion_down.wav`,   volume: 0.7,  push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_LEVEL_1,     { src: `${_BASE}bond_level_1.wav`,   volume: 0.75, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_LEVEL_2,     { src: `${_BASE}bond_level_2.wav`,   volume: 0.75, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_LEVEL_3,     { src: `${_BASE}bond_level_3.wav`,   volume: 0.75, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_GENERIC,     { src: `${_BASE}BattleCursor_2.wav`, volume: 0.55, push: false });
  CAMP.Sound.register(CAMP.SFX.BOND_SUM_CLEARED,    { src: `${_BASE}bond_cleared.wav`,   volume: 0.7,  push: false });

  console.debug(TAG, "Sound manager loaded.");
})();
