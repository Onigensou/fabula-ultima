// ──────────────────────────────────────────────────────────
// BattleLog: Clear (Foundry V12) — backend cleanup
// - Clears BOTH:
//   1) system.props.battle_log       (JSON string)
//   2) system.props.battle_log_table (dynamic table)
// - Uses DB_Resolver (window.FUCompanion.api.getCurrentGameDb)
// ──────────────────────────────────────────────────────────
(async () => {
  console.debug("[BL-CLEAR] start. user:", game.user?.name, "isGM:", game.user?.isGM);

  // 1) Resolve DB actor via DB_Resolver
  async function resolveDbActor() {
    // Preferred path (your DB_Resolver API)
    const api = window.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const { db } = await api.getCurrentGameDb(); // returns { db, dbUuid, gameName, source, ... }
      return db ?? null;
    }

    // Fallback (only if resolver isn't loaded for some reason)
    console.warn("[BL-CLEAR] DB_Resolver API not found at window.FUCompanion.api.getCurrentGameDb(). Falling back to Current Game -> game_id lookup.");
    try {
      const currentGameActor = await fromUuid("Actor.DMpK5Bi119jIrCFZ");
      const gameDbUuid = currentGameActor?.system?.props?.game_id;
      if (!gameDbUuid) return null;
      return await fromUuid(gameDbUuid);
    } catch {
      return null;
    }
  }

  // 2) Clear the fields
  try {
    const dbActor = await resolveDbActor();
    if (!dbActor) {
      console.warn("[BL-CLEAR] No DB actor resolved. Check Current Game -> system.props.game_id / DB_Resolver load order.");
      return;
    }

    // Optional permission visibility (no UI feedback)
    const isOwner = dbActor.testUserPermission(game.user, "OWNER");
    console.debug("[BL-CLEAR] DB actor:", dbActor.name, "owner?", isOwner);

    // Clear both logs
    await dbActor.update({
      "system.props.battle_log": "[]",       // keep it valid JSON string for append to parse cleanly
      "system.props.battle_log_table": []    // empty table
    });

    console.log("Battle Log cleared!");
    console.debug("[BL-CLEAR] done.");
  } catch (err) {
    console.warn("[BL-CLEAR] Failed to clear battle log:", err);
  }
})();
