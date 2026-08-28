// ============================================================================
// Dungeon Pathing System — Sound Manager
// All sounds are local-only (push = false).  Preload on boot.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Sound]";

  const VOLUME = {
    HOVER:      0.45,
    FOOTSTEP:   0.6,
    CONFIRM:    0.5,
    CANCEL:     0.55,
    SCAN_ON:    0.5,
    SCAN_OFF:   0.45,
    HELPER_ON:  0.5,
    HELPER_OFF: 0.45,
    FT_OPEN:    0.6,
    FT_CLOSE:   0.45,
    FT_CYCLE:   0.55,
    FT_WIND:    0.7,
    FT_LAND:    0.75,
    VERTIGO:    0.7,
  };

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

    /** Play cursor-confirm sound when the Confirm button is clicked. */
    playConfirm() {
      play(DP.SOUNDS.CONFIRM, VOLUME.CONFIRM);
    },

    /** Play cancel/close sound when the Go Back button is clicked. */
    playCancel() {
      play(DP.SOUNDS.CANCEL, VOLUME.CANCEL);
    },

    playScanOn()    { play(DP.SOUNDS.SCAN_ON,    VOLUME.SCAN_ON);    },
    playScanOff()   { play(DP.SOUNDS.SCAN_OFF,   VOLUME.SCAN_OFF);   },
    playHelperOn()  { play(DP.SOUNDS.HELPER_ON,  VOLUME.HELPER_ON);  },
    playHelperOff() { play(DP.SOUNDS.HELPER_OFF, VOLUME.HELPER_OFF); },
    playFastTravelOpen()  { play(DP.SOUNDS.FT_OPEN,  VOLUME.FT_OPEN);  },
    playFastTravelClose() { play(DP.SOUNDS.FT_CLOSE, VOLUME.FT_CLOSE); },

    /**
     * Play Eagle sound and return a Promise that resolves when it finishes (max 4 s).
     * earlyMs: resolve this many ms before the sound's natural end so the gryphon
     * animation can overlap with the tail of the eagle cry.
     */
    playFastTravelEagle(earlyMs = 0) {
      return new Promise(resolve => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        const fallback = setTimeout(done, 4000);
        let sound;
        try {
          sound = AudioHelper.play({ src: DP.SOUNDS.FT_OPEN, volume: VOLUME.FT_OPEN, autoplay: true, loop: false }, false);
        } catch {
          clearTimeout(fallback);
          done();
          return;
        }
        if (!sound?.on) return; // fallback timeout handles it
        sound.on("end",  done);
        sound.on("stop", done);
        if (earlyMs > 0) {
          const tryEarly = () => {
            const durMs = (sound.duration ?? 0) * 1000;
            if (durMs > earlyMs) {
              clearTimeout(fallback);
              setTimeout(done, Math.max(0, durMs - earlyMs));
            }
            // else: duration unknown or shorter than earlyMs — "end" listener handles it
          };
          if ((sound.duration ?? 0) > 0) tryEarly();
          else sound.on("start", tryEarly);
        }
      });
    },
    /** Play the darkness sting when Vertigo takes hold. */
    playVertigo() { play(DP.SOUNDS.VERTIGO, VOLUME.VERTIGO); },

    playFastTravelCycle() { play(DP.SOUNDS.FT_CYCLE, VOLUME.FT_CYCLE); },
    playFastTravelWind()  { play(DP.SOUNDS.FT_WIND,  VOLUME.FT_WIND);  },
    playFastTravelLand()  { play(DP.SOUNDS.FT_LAND,  VOLUME.FT_LAND);  },

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
