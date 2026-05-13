// ============================================================================
// Dungeon Pathing — Tile Event: Camp
//
// On use, activates the camp scene linked to the current dungeon scene and
// transports all connected clients there.
//
// The linked scene UUID is configured per-scene via Scene Configuration >
// Fabula > "Linked Camp Scene UUID" (injected by dp-scene-config.js).
//
// Flag: flags.fabula-ultima-companion.campSceneUuid  (on the Scene document)
//
// Does NOT clear the tile after triggering — camp sites persist.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][camp]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.CAMP, {
    label:             "Camp",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const MODULE_ID     = DP.MODULE_ID ?? "fabula-ultima-companion";
      const campSceneUuid = scene?.getFlag(MODULE_ID, "campSceneUuid");

      if (!campSceneUuid) {
        ui.notifications?.warn(
          "Camp | No camp scene linked to this scene. " +
          "Open Scene Configuration > Fabula and set the Linked Camp Scene UUID."
        );
        return;
      }

      // Verify the target scene exists before asking the GM to activate it.
      const campScene = await fromUuid(campSceneUuid).catch(() => null);
      if (!campScene || !(campScene instanceof Scene)) {
        ui.notifications?.error(
          `Camp | Could not find camp scene (UUID: ${campSceneUuid}). ` +
          "Check the Linked Camp Scene UUID in Scene Configuration > Fabula."
        );
        return;
      }

      console.debug(TAG, `Activating camp scene "${campScene.name}" (${campSceneUuid})`);

      // Bookkeeping hook — fires before transport so other systems can listen.
      // Signature: (tileDoc, tokenDoc, dungeonScene, campSceneUuid, campScene)
      Hooks.callAll("dungeonPathing.campStart", tileDoc, tokenDoc, scene, campSceneUuid, campScene);

      const result = await DP.Socket.activateScene(campSceneUuid);
      if (!result?.ok) {
        ui.notifications?.error(
          `Camp | Failed to activate camp scene: ${result?.error ?? "unknown error"}`
        );
      }
    },
  });
})();
