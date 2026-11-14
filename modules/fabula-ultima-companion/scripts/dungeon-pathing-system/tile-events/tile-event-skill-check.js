// ============================================================================
// Dungeon Pathing — Tile Event: Skill Check
//
// Thin request, like the Random Battle tile: the main GM runs everything in
// dp-skill-check.js (picker → theatre trip → event → EXP → log → clear).
// This client's turn waits on the reply, so the party stays put while the GM
// picks. When the party leaves for the theatre scene the turn loop is told to
// skip its closing rebuild (the canvas is about to tear down), exactly as for
// a launching battle.
//
// clearAfterTrigger:false — the runner clears the tile only when the event was
// finished; an event ended early or a skipped tile stays on the map.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][skill_check]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // The GM leaving mid-pick would hold the turn forever: release it.
  function untilGmLeaves(request) {
    const gmId = game.user?.isGM ? null : game.users?.activeGM?.id ?? null;
    if (!gmId) return request;
    let hookId = null;
    const left = new Promise(resolve => {
      hookId = Hooks.on("userConnected", (user, connected) => {
        if (user?.id === gmId && !connected) resolve({ ok: false, error: "GM disconnected" });
      });
    });
    return Promise.race([request, left]).finally(() => Hooks.off("userConnected", hookId));
  }

  DP.TileEventRegistry.register(DP.TILE_TYPES.SKILL_CHECK, {
    label:             "Skill Check",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      let res = null;
      try {
        res = await untilGmLeaves(DP.Socket.requestSkillCheck(scene, tileDoc?.id, tokenDoc?.id));
      } catch (e) {
        console.error(TAG, "requestSkillCheck failed:", e);
        return;
      }
      if (!res?.ok) {
        console.warn(TAG, "skill check not run:", res?.error ?? "(no reason given)");
        if (game.user?.isGM && res?.error) ui.notifications?.warn?.(`Skill Check: ${res.error}`);
        return;
      }
      if (res.travelling) {
        const st = globalThis.__ONI_DUNGEON_PATHING__?.state;
        if (st) st.battleLaunching = true;
      }
    }
  });
})();
