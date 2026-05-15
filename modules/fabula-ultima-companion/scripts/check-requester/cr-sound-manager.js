// ============================================================================
// Check Requester — Sound Manager
//
// Mirrors dp-sound.js conventions: SOUNDS registry (URLs), VOLUME registry,
// play() helper, preloadAll() called on "ready".
//
// Attached to ONI.CheckRequester.Sound after cr-api.js sets up the namespace.
// All playback is local-only (push = false via AudioHelper).
// ============================================================================
(() => {
  const ONI = globalThis.ONI ??= {};
  ONI.CheckRequester ??= {};
  const TAG = "[ONI][CheckRequester][Sound]";

  // ── Sound URL registry ─────────────────────────────────────────────────────
  const SOUNDS = Object.freeze({
    // Check lifecycle
    CHECK_START:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",

    // UI interactions — consistent with DP sound library
    BUTTON_ROLL:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    BUTTON_INVOKE:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
    BUTTON_CONFIRM: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    PANEL_OPEN:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",

    // Group check lobby
    PARTICIPANT_ENTER: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_enter.wav",
    PARTICIPANT_EXIT:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_exit.wav",

    // Individual badge stamp sounds (play per-actor as each verdict reveals)
    STAMP_PASS:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    STAMP_CRIT:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    STAMP_FAIL:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    STAMP_FUMBLE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/fumble_1.WAV",

    // Group outcome fanfares (play after ALL badges are revealed)
    GROUP_SUCCESS:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
    GROUP_FAIL:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Buzzer2.ogg",
    GROUP_FUMBLE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ME/Shock2.ogg",
    GROUP_CRIT:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
  });

  // ── Volume levels ──────────────────────────────────────────────────────────
  const VOLUME = Object.freeze({
    CHECK_START:       0.65,
    BUTTON_ROLL:       0.45,
    BUTTON_INVOKE:     0.40,
    BUTTON_CONFIRM:    0.50,
    PANEL_OPEN:        0.35,
    PARTICIPANT_ENTER: 0.55,
    PARTICIPANT_EXIT:  0.50,
    STAMP:             0.65,
    GROUP:             0.80,
  });

  // ── Preload cache ──────────────────────────────────────────────────────────
  // Tracks which URLs have already been submitted to AudioHelper to avoid
  // redundant fetch calls across preloadAll() and lazy preloads.
  const _preloaded = new Set();

  function _preload(src) {
    if (!src || _preloaded.has(src)) return;
    _preloaded.add(src);
    try {
      if (typeof AudioHelper?.preloadSound === "function") {
        AudioHelper.preloadSound(src);
      } else {
        fetch(src, { cache: "force-cache" }).catch(() => {});
      }
    } catch {}
  }

  function _play(src, volume) {
    if (!src) return;
    // Lazy-preload on first play so the cache warms even if preloadAll missed it
    _preload(src);
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (e) {
      console.warn(TAG, "AudioHelper.play failed:", e);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const CRSound = {
    SOUNDS,

    /** Pre-fetch all registered sounds into the browser audio cache. */
    preloadAll() {
      for (const src of Object.values(SOUNDS)) _preload(src);
      console.debug(TAG, "All sounds preloaded.");
    },

    // ── Check lifecycle ──────────────────────────────────────────────────────

    /** Plays once when a skill check or group check UI is first brought up. */
    playCheckStart()       { _play(SOUNDS.CHECK_START,        VOLUME.CHECK_START);       },

    // ── Group check lobby ────────────────────────────────────────────────────

    /** Plays when an actor joins the group check (claims leader or becomes helper). */
    playParticipantEnter() { _play(SOUNDS.PARTICIPANT_ENTER,  VOLUME.PARTICIPANT_ENTER); },

    /** Plays when a helper leaves the group check lobby. */
    playParticipantExit()  { _play(SOUNDS.PARTICIPANT_EXIT,   VOLUME.PARTICIPANT_EXIT);  },

    // ── UI interactions ──────────────────────────────────────────────────────

    /** Brief click played when the player clicks a die roll button. */
    playRoll()    { _play(SOUNDS.BUTTON_ROLL,    VOLUME.BUTTON_ROLL);    },

    /** Click played when an invoke button (Trait / Bond / Divination) is pressed. */
    playInvoke()  { _play(SOUNDS.BUTTON_INVOKE,  VOLUME.BUTTON_INVOKE);  },

    /** Confirmation click played when the player confirms their roll. */
    playConfirm() { _play(SOUNDS.BUTTON_CONFIRM, VOLUME.BUTTON_CONFIRM); },

    /** Subtle open cue played when the check overlay first appears. */
    playOpen()    { _play(SOUNDS.PANEL_OPEN,     VOLUME.PANEL_OPEN);     },

    // ── Per-actor badge stamp ────────────────────────────────────────────────

    /**
     * Play the badge stamp sound for a single actor's result.
     * Priority: fumble > crit > fail > pass.
     * @param {{ isFumble: boolean, isCrit: boolean, pass: boolean|null }} result
     */
    playStamp(result) {
      if (!result) return;
      if (result.isFumble)       return _play(SOUNDS.STAMP_FUMBLE, VOLUME.STAMP);
      if (result.isCrit)         return _play(SOUNDS.STAMP_CRIT,   VOLUME.STAMP);
      if (result.pass === false)  return _play(SOUNDS.STAMP_FAIL,   VOLUME.STAMP);
      _play(SOUNDS.STAMP_PASS, VOLUME.STAMP);
    },

    // ── Group outcome fanfare ────────────────────────────────────────────────

    /**
     * Play the group-level outcome fanfare after all badges have been revealed.
     * Priority: any fumble > all crit > all pass > any fail.
     * @param {Array<{ isFumble: boolean, isCrit: boolean, pass: boolean|null }>} results
     */
    playGroupOutcome(results) {
      if (!results?.length) return;
      const anyFumble = results.some(r => r.isFumble);
      const allCrit   = results.every(r => r.isCrit);
      const allPass   = results.every(r => r.pass === true || r.isCrit);
      if (anyFumble) return _play(SOUNDS.GROUP_FUMBLE,  VOLUME.GROUP);
      if (allCrit)   return _play(SOUNDS.GROUP_CRIT,    VOLUME.GROUP);
      if (allPass)   return _play(SOUNDS.GROUP_SUCCESS, VOLUME.GROUP);
      _play(SOUNDS.GROUP_FAIL, VOLUME.GROUP);
    },
  };

  ONI.CheckRequester.Sound = CRSound;

  Hooks.once("ready", () => {
    CRSound.preloadAll();
  });

  console.debug(TAG, "Sound manager registered.");
})();
