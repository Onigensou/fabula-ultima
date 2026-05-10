// ============================================================================
// Dungeon Pathing System — Sound Manager
// All sounds are local-only (push = false).  Preload on boot.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Sound]";

  const VOLUME = { HOVER: 0.45, FOOTSTEP: 0.6 };

  function play(src, volume) {
    if (!src) return;
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (e) {
      console.warn(TAG, "AudioHelper.play failed:", e);
    }
  }

  DP.Sound = {
    preloadAll() {
      for (const src of Object.values(DP.SOUNDS)) {
        try {
          if (typeof AudioHelper?.preloadSound === "function") {
            AudioHelper.preloadSound(src);
          } else {
            fetch(src, { cache: "force-cache" }).catch(() => {});
          }
        } catch {}
      }
    },

    /** Play cursor hover sound (once per new tile entered). */
    playHover() {
      play(DP.SOUNDS.HOVER, VOLUME.HOVER);
    },

    /**
     * Play footstep sound twice to simulate walking.
     * First step fires immediately; second after half the animation duration.
     */
    playFootstep() {
      const half = Math.round(DP.MOVE_MS / 2);
      play(DP.SOUNDS.FOOTSTEP, VOLUME.FOOTSTEP);
      setTimeout(() => play(DP.SOUNDS.FOOTSTEP, VOLUME.FOOTSTEP), half);
    }
  };
})();
