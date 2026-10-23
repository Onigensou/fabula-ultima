// ============================================================================
// Dungeon Pathing — Tile Event: Random Battle
// ----------------------------------------------------------------------------
// Thin request only. Everything that decides the outcome — the encounter roll,
// the ambush/advantage roll, the group selection, the pity rate and the battle
// launch — lives GM-side in dp-random-battle.js, because:
//
//   - this handler runs on whichever client walked the turn, and the rolls now
//     drive real combat, so they must be authoritative rather than per-client;
//   - the Battle Director's start() is GM-only.
//
// Does NOT clear the tile after triggering — a Random Battle tile stays live
// for every future landing.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][random_battle]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.RANDOM_BATTLE, {
    label:             "Random Battle",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      // A STORY battle (Tile Config → "Story battle") always triggers — no pity
      // roll — and hands the GM the Battle Prompt to set the fight up by hand.
      const story = tileDoc?.flags?.[DP.MODULE_ID ?? "fabula-ultima-companion"]?.[DP.PATHING_ROOT_KEY]?.storyBattle;
      const opts  = (story === true || story === "true") ? { forced: true, verdict: "customize" } : {};
      let res = null;
      try {
        res = await DP.Socket.requestRandomBattle(scene, tileDoc?.id, tokenDoc?.id, opts);
      } catch (e) {
        // A throw here would strand the player's dungeon turn — swallow it and
        // let the turn end normally instead.
        console.error(TAG, "requestRandomBattle failed:", e);
        return;
      }

      if (!res?.ok) {
        console.warn(TAG, "random battle not resolved:", res?.error ?? "(no reason given)");
        return;
      }

      // A battle is starting: the canvas is about to tear down, so tell the turn
      // loop to skip its closing graph rebuild. Without this the rebuild races
      // the scene switch and warns "party token not found" on the way out.
      if (res.launched) {
        const st = globalThis.__ONI_DUNGEON_PATHING__?.state;
        if (st) st.battleLaunching = true;
      }
    }
  });
})();
