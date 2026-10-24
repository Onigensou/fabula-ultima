// Screen Transition System — PS1/PS2-era fade between scene changes
// Pure client-side DOM/CSS. No sockets. Each client runs independently.
(() => {
  const OVERLAY_ID  = "fu-screen-transition";
  const HOLD_MS     = 180;   // dark hold after canvasReady before revealing
  const FADE_OUT_MS = 700;   // ease-out reveal duration
  const POLL_MS     = 500;   // held-for-draw check (a failed draw fires no canvasReady)
  const STUCK_MS    = 90000; // a draw that never ends: reveal anyway rather than stay black

  // IDLE | COVERED | FADING_OUT | SHATTER (the battle shatter hides the swap)
  let state   = "IDLE";
  let overlay = null;
  let glassBroken     = false;  // the shatter is past its cut: the scene shows through
  let blackUnderGlass = false;  // went black beneath the breaking glass
  let drawPoll = null;
  // Bumped whenever something takes the overlay over (cover, blackout, the
  // shatter taking it down). A fade only finishes if no one took the overlay
  // since it began: a cancelled fade's fallback timer once marked a fresh cover
  // IDLE while it was still black, so the next reveal returned early and the
  // screen stayed black until reload.
  let gen = 0;

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
    gen++;
    // The battle shatter (battle-transition/shatter-transition.js) already
    // hides the scene swap behind its frozen, cracked frame: going black here
    // would cover the glass. Still announce the cover; the matching reveal
    // fires when the glass has cleared (fuc:shatterDone).
    if (document.body.classList.contains("fuc-shatter-active")) {
      if (glassBroken) {
        // the swap began after the glass broke: the shards are flying off a
        // scene being torn down, so black it out beneath them
        blackout();
        blackUnderGlass = true;
      } else {
        // a cover still up from an earlier scene change would sit behind the
        // glass and black out the battlefield it opens onto: take it down
        overlay.style.transition    = "none";
        overlay.style.opacity       = "0";
        overlay.style.pointerEvents = "none";
      }
      state = "SHATTER";
      Hooks.callAll("oni:screenCovered");
      return;
    }
    overlay.style.transition    = "none";
    overlay.style.opacity       = "1";
    overlay.style.pointerEvents = "all";
    forceReflow();   // commit to the GPU before this task continues
    state = "COVERED";
    // Anything that should not animate behind the black — badge entrances, etc.
    // — listens for this and waits for the matching reveal.
    Hooks.callAll("oni:screenCovered");
  }

  function blackout() {
    gen++;
    overlay.style.transition    = "none";
    overlay.style.opacity       = "1";
    overlay.style.pointerEvents = "all";
    forceReflow();
  }

  // Foundry sets canvas.loading for the whole of Canvas#draw and clears it just
  // after canvasReady — or when a draw fails / draws blank, with no canvasReady.
  const canvasDrawing = () => globalThis.canvas?.loading === true;

  // ── holdUntilDrawn: the glass cleared before this client's scene drew ───────
  // The shatter gives up waiting on a slow client (a big asset holds Foundry's
  // loader at 99%). Stay black instead of showing the half-drawn scene:
  // canvasReady reveals it, and the poll covers a draw that ends without one.

  function holdUntilDrawn() {
    blackout();
    state = "COVERED";
    const t0 = Date.now();
    clearInterval(drawPoll);
    drawPoll = setInterval(() => {
      if (state !== "COVERED") { clearInterval(drawPoll); return; }
      if (canvasDrawing() && Date.now() - t0 < STUCK_MS) return;
      clearInterval(drawPoll);
      reveal();
    }, POLL_MS);
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
    // Heal: marked IDLE but still black (whatever left it so) — a scene that
    // finished drawing must never stay hidden.
    if (state === "IDLE" && parseFloat(overlay.style.opacity || "0") > 0.01
        && !document.body.classList.contains("fuc-shatter-active")) {
      state = "COVERED";
    }
    if (state !== "COVERED") return;

    // If the destination scene has disableTransition set, skip the animation
    // entirely and snap the overlay off immediately.
    if (isTransitionDisabled()) {
      overlay.style.transition    = "none";
      overlay.style.opacity       = "0";
      overlay.style.pointerEvents = "none";
      forceReflow();
      state = "IDLE";
      Hooks.callAll("oni:screenRevealed");   // snapped, but still "now visible"
      return;
    }

    state = "FADING_OUT";
    const mine = gen;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (mine !== gen) return;   // covered again before the fade began
          overlay.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
          overlay.style.opacity    = "0";

          // Primary cleanup via transitionend.
          // Fallback timer guards against transitionend not firing (e.g. if
          // opacity was already 0, or the element was briefly detached).
          const cleanup = () => {
            if (mine !== gen) return;   // covered mid-fade: that cover owns it now
            overlay.style.pointerEvents = "none";
            state = "IDLE";
            // The scene image is now fully visible — safe to play entrances.
            Hooks.callAll("oni:screenRevealed");
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
    // the shatter is up: any black cover still showing would sit behind the glass
    Hooks.on("fuc:shatterStart", () => {
      glassBroken = blackUnderGlass = false;
      if (state !== "COVERED" && state !== "FADING_OUT") return;
      gen++;
      overlay.style.transition    = "none";
      overlay.style.opacity       = "0";
      overlay.style.pointerEvents = "none";
      state = "SHATTER";
    });
    // the glass breaks on a scene still drawing: go black beneath it (z 99999,
    // under the glass) so the shards fly off black, not a half-drawn scene
    Hooks.on("fuc:shatterBreak", () => {
      glassBroken = true;
      if (state !== "SHATTER" || !canvasDrawing()) return;
      blackout();
      blackUnderGlass = true;
    });
    Hooks.on("fuc:shatterDone", () => {
      const wasBlack = blackUnderGlass;
      glassBroken = blackUnderGlass = false;
      if (state !== "SHATTER") return;
      if (canvasDrawing()) { holdUntilDrawn(); return; }
      // drew while the shards were flying: fade the black off as usual
      if (wasBlack) { state = "COVERED"; reveal(); return; }
      state = "IDLE";
      Hooks.callAll("oni:screenRevealed");
    });
  });
})();
