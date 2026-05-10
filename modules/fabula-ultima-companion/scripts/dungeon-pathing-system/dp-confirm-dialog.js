// ============================================================================
// Dungeon Pathing System — Player Confirmation Dialog
// Shown after the token previews its destination so the player can
// confirm landing or revert back to their previous position.
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.ConfirmDialog = {
    /**
     * Show the "Land on this tile?" confirmation dialog.
     * Returns a Promise that resolves to true (confirm) or false (revert).
     * @param {string} nodeName - display name of the destination tile
     */
    ask(nodeName = "this tile") {
      return new Promise(resolve => {
        const dialog = new Dialog({
          title:   "Land on tile?",
          content: `
            <div style="text-align:center; padding: 8px 0;">
              <p style="margin:0 0 6px;">You arrived at</p>
              <p style="font-size:1.3em; font-weight:bold; margin:0 0 12px;">${nodeName}</p>
              <p style="font-size:.9em; opacity:.8; margin:0;">Do you want to land here, or go back?</p>
            </div>
          `,
          buttons: {
            confirm: {
              icon:     '<i class="fas fa-check"></i>',
              label:    "Land Here",
              callback: () => resolve(true)
            },
            revert: {
              icon:     '<i class="fas fa-undo"></i>',
              label:    "Go Back",
              callback: () => resolve(false)
            }
          },
          default: "confirm",
          // Closing with the X is treated as "go back" so the player is never stuck
          close: () => resolve(false)
        }, {
          width: 320
        });
        dialog.render(true);
      });
    }
  };
})();
