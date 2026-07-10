// ============================================================================
// Title Screen — Bootstrap
//
// Installs Foundry hooks for all clients (not GM-only) so the title overlay
// opens automatically when a Title-mode scene is active, and closes when
// the scene changes to a different mode.
//
// Socket setup (GM aggregator + all-client receiver) is also installed here.
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][Bootstrap]";

  function _isTitleScene(scene) {
    const mode = scene?.flags?.[TS.MODULE_ID]?.oniFabula?.general?.sceneMode;
    return mode === TS.SCENE_MODE;
  }

  Hooks.once("ready", () => {
    // Install socket listener for all clients (GM aggregator runs inside it).
    TS.Socket.setup();
    TS.Socket.refreshRoster();
    console.log(TAG, "Ready.");
  });

  // Keep the voter roster (and therefore the quorum) in step with who is
  // actually connected. No-op on every client except the primary GM.
  Hooks.on("userConnected", () => TS.Socket.refreshRoster());

  Hooks.on("canvasReady", () => {
    if (_isTitleScene(canvas?.scene)) {
      TS.UI.open();
    } else {
      TS.UI.close();
      if (!TS.LoadUI._showingSuccess) TS.LoadUI.close();
    }
  });

  Hooks.on("canvasTearDown", () => {
    TS.UI.close();
    if (!TS.LoadUI._showingSuccess) TS.LoadUI.close();
    TS.Socket.resetVotes();
  });

  Hooks.on("updateScene", (scene) => {
    if (!canvas?.scene || scene.id !== canvas.scene.id) return;
    if (_isTitleScene(scene)) {
      TS.UI.open();
    } else {
      TS.UI.close();
      if (!TS.LoadUI._showingSuccess) TS.LoadUI.close();
    }
  });

  console.debug(TAG, "Bootstrap loaded.");
})();
