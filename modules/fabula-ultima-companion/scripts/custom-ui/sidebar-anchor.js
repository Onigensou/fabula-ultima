/**
 * [SidebarAnchor] Publishes a CSS variable reflecting Foundry sidebar width.
 * -----------------------------------------------------------------------------
 * Sets `--fu-sidebar-anchor-right` on :root to `<sidebar.offsetWidth> + 13`
 * pixels. Floating UI buttons (Combat, EXP Awarder, AEM, Check Roller,
 * Request Check) read this variable for their `right:` offset, so when the
 * GM collapses the sidebar the buttons slide right to hug the screen edge
 * and the play area widens.
 *
 * Idle behavior matches the legacy hard-coded `313px` offset — when the
 * sidebar is expanded (~300px wide), this evaluates to 313px.
 *
 * Timing note: Foundry's `collapseSidebar` hook fires in the COMPLETION
 * callback of jQuery's `.animate()` — i.e. AFTER the sidebar's width
 * animation finishes. We can't use that to sync the button slide with the
 * sidebar's slide; doing so would push the button slide into a second
 * disconnected phase after the sidebar settled.
 *
 * Solution: a `ResizeObserver` on the sidebar element. jQuery's `.animate()`
 * mutates the element's inline `style.width` every animation frame, which
 * triggers ResizeObserver. We update the CSS var on each fire, so the
 * buttons track the sidebar's live width frame-by-frame.
 */

Hooks.once("ready", () => {
  const TAG = "[ONI][SidebarAnchor]";
  const VAR_NAME = "--fu-sidebar-anchor-right";
  const PADDING_PX = 13;
  const FALLBACK_PX = 313;

  const root = document.documentElement;

  function setVar(width) {
    const px = width > 0 ? width + PADDING_PX : FALLBACK_PX;
    root.style.setProperty(VAR_NAME, `${px}px`);
  }

  const sidebar = document.getElementById("sidebar");
  if (!sidebar) {
    console.warn(`${TAG} #sidebar not in DOM at ready; falling back to ${FALLBACK_PX}px`);
    setVar(0);
    return;
  }

  // Initial publish — covers cold boot before any sidebar interaction.
  setVar(sidebar.offsetWidth);

  // Live width tracking. ResizeObserver fires whenever the observed element's
  // content-box size changes, including every frame during jQuery's
  // `.animate({width: ...})`. We just republish the live width; the buttons'
  // `right: var(--fu-sidebar-anchor-right, ...)` makes them follow in real time.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      // contentRect.width is the layout width without padding/border. Close
      // enough for the small-padding sidebar; the difference is < 2px.
      setVar(e.contentRect.width);
    }
  });
  ro.observe(sidebar);

  // Browser-window resizes don't always trigger ResizeObserver if the sidebar
  // width stays absolute — refresh defensively next frame.
  window.addEventListener("resize", () => {
    requestAnimationFrame(() => setVar(sidebar.offsetWidth));
  });

  console.debug(`${TAG} Installed (${VAR_NAME} live, ResizeObserver-driven)`);
});
