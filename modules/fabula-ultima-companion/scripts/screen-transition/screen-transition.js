// Screen Transition System — PS1/PS2-era fade between scene changes
// Pure client-side DOM/CSS. No sockets. Each client runs independently.
(() => {
  const OVERLAY_ID  = "fu-screen-transition";
  const HOLD_MS     = 180;   // dark hold after canvasReady before revealing
  const FADE_OUT_MS = 700;   // ease-out reveal duration

  // IDLE | COVERED | FADING_OUT
  let state   = "IDLE";
  let overlay = null;

  // ── Overlay — created eagerly on ready so first transition has no cold cost ──

  function buildOverlay() {
    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position:      "fixed",
      inset:         "0",
      zIndex:        "99999",
      background:    "#000",
      opacity:       "0",
      pointerEvents: "none",
      willChange:    "opacity",   // promote to compositor layer; transitions are GPU-only
    });
    document.body.appendChild(el);
    return el;
  }

  // Reading a layout property forces the browser to flush pending style changes
  // synchronously. Without this, opacity:1 is batched and may not paint before
  // Foundry's own DOM work in the same task queue.
  function forceReflow() { void overlay.offsetHeight; }

  // ── cover: instant-to-black ──────────────────────────────────────────────────
  // We do NOT use a CSS transition here. Any non-zero fade-in duration means the
  // overlay is semi-transparent when Foundry snaps the scene behind it. Going
  // black instantly (then revealing slowly) gives the same PS1/PS2 feel while
  // guaranteeing the snap is always hidden.
  // Accepts from any state so rapid double-switches are handled correctly.

  function cover() {
    overlay.style.transition    = "none";
    overlay.style.opacity       = "1";
    overlay.style.pointerEvents = "all";
    forceReflow();   // commit to the GPU before this task continues
    state = "COVERED";
  }

  // ── Flag check — read the destination scene's disableTransition flag ─────────

  function isTransitionDisabled() {
    try {
      return !!canvas?.scene?.flags?.["fabula-ultima-companion"]?.oniFabula?.general?.disableTransition;
    } catch { return false; }
  }

  // ── reveal: rAF-gated ease-out ───────────────────────────────────────────────
  // canvasReady fires when Foundry's canvas data is ready, but PIXI may not have
  // painted its first frame yet. Two requestAnimationFrame calls step past that
  // rendering boundary so we never reveal a blank scene.

  function reveal() {
    if (state !== "COVERED") return;

    // If the destination scene has disableTransition set, skip the animation
    // entirely and snap the overlay off immediately.
    if (isTransitionDisabled()) {
      overlay.style.transition    = "none";
      overlay.style.opacity       = "0";
      overlay.style.pointerEvents = "none";
      forceReflow();
      state = "IDLE";
      return;
    }

    state = "FADING_OUT";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          overlay.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
          overlay.style.opacity    = "0";

          // Primary cleanup via transitionend.
          // Fallback timer guards against transitionend not firing (e.g. if
          // opacity was already 0, or the element was briefly detached).
          const cleanup = () => {
            overlay.style.pointerEvents = "none";
            state = "IDLE";
          };

          const fallback = setTimeout(cleanup, FADE_OUT_MS + 100);

          overlay.addEventListener("transitionend", () => {
            clearTimeout(fallback);
            cleanup();
          }, { once: true });

        }, HOLD_MS);
      });
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────

  Hooks.once("ready", () => {
    overlay = buildOverlay();

    Hooks.on("canvasTearDown", cover);
    Hooks.on("canvasReady",    reveal);
  });
})();
