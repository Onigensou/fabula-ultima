// Screen Transition System — PS1/PS2-era fade to black between scene changes
// Pure client-side DOM/CSS, no sockets, no PIXI. Each client runs independently.
(() => {
  const OVERLAY_ID   = "fu-screen-transition";
  const FADE_IN_MS   = 350;   // ease-in to black (covers the snap)
  const HOLD_MS      = 150;   // brief dark hold (the "loading" beat)
  const FADE_OUT_MS  = 650;   // ease-out reveal of new scene

  // IDLE | FADING_IN | HOLDING | FADING_OUT
  let state = "IDLE";

  // ── Overlay ──────────────────────────────────────────────────────────────────

  function getOrCreateOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;

    el = document.createElement("div");
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position:       "fixed",
      inset:          "0",
      zIndex:         "99999",
      background:     "#000",
      opacity:        "0",
      pointerEvents:  "none",
      transition:     `opacity ${FADE_IN_MS}ms ease-in`
    });
    document.body.appendChild(el);
    return el;
  }

  // ── Transitions ───────────────────────────────────────────────────────────────

  function fadeIn() {
    if (state !== "IDLE") return;
    state = "FADING_IN";

    const el = getOrCreateOverlay();
    el.style.transition   = `opacity ${FADE_IN_MS}ms ease-in`;
    el.style.pointerEvents = "all";
    el.style.opacity       = "1";
  }

  function fadeOut() {
    // Only reveal if we actually went dark — skip on first load (state is IDLE)
    if (state !== "FADING_IN" && state !== "HOLDING") return;
    state = "FADING_OUT";

    const el = getOrCreateOverlay();

    // Wait for HOLD_MS after canvasReady before starting the reveal.
    // This lets Foundry render at least one frame so the new scene isn't
    // blank behind the overlay when it starts fading out.
    setTimeout(() => {
      el.style.transition   = `opacity ${FADE_OUT_MS}ms ease-out`;
      el.style.opacity       = "0";

      el.addEventListener("transitionend", () => {
        el.style.pointerEvents = "none";
        state = "IDLE";
      }, { once: true });
    }, HOLD_MS);
  }

  // ── Foundry hooks ─────────────────────────────────────────────────────────────

  Hooks.once("ready", () => {
    // canvasTearDown fires when the current scene canvas is being destroyed.
    // This is the exact moment to go dark — Foundry is about to snap the view.
    Hooks.on("canvasTearDown", () => {
      fadeIn();
    });

    // canvasReady fires when the new scene canvas is fully initialised.
    // We wait HOLD_MS then reveal, giving Foundry time to render.
    Hooks.on("canvasReady", () => {
      fadeOut();
    });
  });
})();
