// ============================================================================
// Reload My Client — GM scene-controls button
//
// Adds a 🔄 button to the Token layer toolbar (GM only).
// Reloads only the GM's own browser page — does not affect other clients.
// ============================================================================
(() => {
  const TAG = "[FUCompanion][ReloadButton]";

  async function doReload() {
    if (!game.user?.isGM) return;

    const confirmed = await new Promise(resolve => {
      new Dialog({
        title: "Reload My Client",
        content: `
          <p>Reload your own browser page?</p>
          <p style="opacity:.75;font-size:.88em;margin-top:4px;">
            The world stays running — only your page refreshes.
            Unsaved chat input and open dialogs will be lost.
          </p>
        `,
        buttons: {
          ok: {
            icon:     '<i class="fas fa-sync-alt"></i>',
            label:    "Reload",
            callback: () => resolve(true),
          },
          cancel: {
            icon:     '<i class="fas fa-times"></i>',
            label:    "Cancel",
            callback: () => resolve(false),
          },
        },
        default: "cancel",
        close:   () => resolve(false),
      }).render(true);
    });

    if (!confirmed) return;
    location.reload();
  }

  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;
    const tokenLayer = controls.find(c => c.name === "token");
    if (!tokenLayer) return;
    tokenLayer.tools.push({
      name:    "reloadMyClient",
      title:   "Reload My Client",
      icon:    "fas fa-sync-alt",
      button:  true,
      onClick: () => doReload(),
    });
  });

  console.debug(TAG, "Loaded.");
})();
