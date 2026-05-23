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

  const root = document.documentElement;

  function refresh() {
    const sidebar = document.getElementById("sidebar");
    const width = sidebar?.offsetWidth ?? 0;
    // When sidebar is mounted, hug it; otherwise fall back to legacy offset.
    const px = width > 0 ? width + PADDING_PX : FALLBACK_PX;
    root.style.setProperty(VAR_NAME, `${px}px`);
  }

  refresh();

  // Foundry V12 hook signature: (sidebar, collapsed). CSS transition runs
  // after the hook fires, so we re-measure once the width has settled.
  Hooks.on("collapseSidebar", () => {
    setTimeout(refresh, TRANSITION_MS);
  });

  // Browser-window resizes don't fire collapseSidebar; refresh on next frame.
  window.addEventListener("resize", () => requestAnimationFrame(refresh));

  console.debug(`${TAG} Installed (${VAR_NAME} live)`);
});
