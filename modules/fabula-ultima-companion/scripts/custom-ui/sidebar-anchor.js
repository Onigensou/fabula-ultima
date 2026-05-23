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
 * Foundry's `collapseSidebar` hook fires synchronously BEFORE the width
 * transition completes; we re-measure after a short delay to capture the
 * settled width. A `resize` listener handles browser resizes.
 */

Hooks.once("ready", () => {
  const TAG = "[ONI][SidebarAnchor]";
  const VAR_NAME = "--fu-sidebar-anchor-right";
  const PADDING_PX = 13; // small gap between buttons and sidebar / screen edge
  const TRANSITION_MS = 350; // Foundry's sidebar transition is ~300ms
  const FALLBACK_PX = 313; // matches the legacy hard-coded value
  const COLLAPSED_WIDTH = 32; // observed Foundry V12 collapsed sidebar width

  const root = document.documentElement;

  // Snapshot of the expanded sidebar width — captured the first time we see
  // the sidebar in an expanded state. Used to predict the post-collapse-back
  // width at hook-fire time so the buttons slide IN SYNC with the sidebar
  // (rather than waiting for the sidebar's transition to finish, then jumping).
  let expandedWidthCache = 300; // Foundry V12 default

  function measure() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return 0;
    const w = sidebar.offsetWidth ?? 0;
    // Anything notably wider than the collapsed strip is "expanded"; cache its
    // width so we can predict it later when transitioning from collapsed→expanded.
    if (w > COLLAPSED_WIDTH + 8) expandedWidthCache = w;
    return w;
  }

  function setVar(width) {
    const px = width > 0 ? width + PADDING_PX : FALLBACK_PX;
    root.style.setProperty(VAR_NAME, `${px}px`);
  }

  // Re-measure the live width and publish. Called on boot, on resize, and as
  // a follow-up after the sidebar's transition finishes (corrects any drift
  // between our hook-time prediction and the actual settled width).
  function refresh() {
    setVar(measure());
  }

  refresh();

  // Foundry V12 hook signature: (sidebar, collapsed). At hook-fire time the
  // sidebar's offsetWidth still reports the OLD width — its CSS transition
  // hasn't started yet. Predict the post-transition width from the boolean
  // so the buttons start sliding the moment the sidebar does (in sync).
  // Then re-measure after TRANSITION_MS to correct any drift.
  Hooks.on("collapseSidebar", (_app, collapsed) => {
    const predicted = collapsed ? COLLAPSED_WIDTH : expandedWidthCache;
    setVar(predicted);
    setTimeout(refresh, TRANSITION_MS);
  });

  // Browser-window resizes don't fire collapseSidebar; refresh on next frame.
  window.addEventListener("resize", () => requestAnimationFrame(refresh));

  console.debug(`${TAG} Installed (${VAR_NAME} live)`);
});
