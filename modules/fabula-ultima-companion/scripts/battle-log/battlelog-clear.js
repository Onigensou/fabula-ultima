// scripts/battlelog-clear.js
// ──────────────────────────────────────────────────────────────
// Global: BattleLog Clear (Foundry v12)
// Exposes: window.FUCompanion.api.clearBattleLog()
// Depends: window.FUCompanion.api.getCurrentGameDb() from db-resolver.js
// Clears BOTH:
//   1) system.props.battle_log        (JSON string)
//   2) system.props.battle_log_table  (dynamic table)
// ──────────────────────────────────────────────────────────────
(() => {
  // 1) Ensure namespace (same style as db-resolver.js)
  window.FUCompanion = window.FUCompanion || { api: {} };
  const API = window.FUCompanion.api;

  // 2) Fallback constant (only used if db-resolver is not available)
  //    Keep in sync with db-resolver.js if you ever change it.
  const CURRENT_GAME_ACTOR_UUID = "Actor.DMpK5Bi119jIrCFZ";

  // Helper: safely read nested properties (Foundry’s getProperty)
  function _gp(obj, path) {
    try { return getProperty(obj, path); } catch { return undefined; }
  }

  // Resolve DB actor via db-resolver first, then fallback
  async function _resolveDbActor() {
    // Preferred path: your DB resolver API
    const resolver = window.FUCompanion?.api;
    if (resolver?.getCurrentGameDb) {
      const { db } = await resolver.getCurrentGameDb();
      return db ?? null;
    }

    // Fallback: Current Game -> system.props.game_id
    console.warn("[FUCompanion][BattleLogClear] DB_Resolver not found. Falling back to Current Game -> game_id lookup.");
    try {
      const currentGameActor = await fromUuid(CURRENT_GAME_ACTOR_UUID).catch(() => null);
      const gameDbUuid = _gp(currentGameActor, "system.props.game_id");
      if (!gameDbUuid) return null;

      const dbActor = await fromUuid(String(gameDbUuid)).catch(() => null);
      return dbActor ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Clear the Battle Log fields on the resolved DB actor.
   * @param {object} [options]
   * @param {boolean} [options.notify=false] - show a UI notification when done
   * @returns {Promise<{ok:boolean, reason?:string, dbName?:string}>}
   */
  API.clearBattleLog = async function clearBattleLog(options = {}) {
    const { notify = false } = options;

    console.debug("[FUCompanion][BattleLogClear] start. user:", game.user?.name, "isGM:", game.user?.isGM);

    try {
      const dbActor = await _resolveDbActor();
      if (!dbActor) {
        const reason = "No DB actor resolved. Check Current Game -> system.props.game_id / db-resolver load order.";
        console.warn("[FUCompanion][BattleLogClear]", reason);
        if (notify) ui.notifications?.warn(reason);
        return { ok: false, reason };
      }

      // Permission sanity check
      const isOwner = dbActor.testUserPermission(game.user, "OWNER");
      console.debug("[FUCompanion][BattleLogClear] DB actor:", dbActor.name, "owner?", isOwner);

      // If you expect ONLY GM to do this, enforce it here
      // (You can relax this later if you add a GM socket handler.)
      if (!game.user?.isGM && !isOwner) {
        const reason = `You don't have permission to update DB actor: ${dbActor.name}`;
        console.warn("[FUCompanion][BattleLogClear]", reason);
        if (notify) ui.notifications?.warn(reason);
        return { ok: false, reason, dbName: dbActor.name };
      }

      // Clear both logs (same behavior as your macro)
      await dbActor.update({
        "system.props.battle_log": "[]",       // keep valid JSON string
        "system.props.battle_log_table": []    // empty table
      });

      console.log("[FUCompanion][BattleLogClear] Battle Log cleared!");
      console.debug("[FUCompanion][BattleLogClear] done.");
      if (notify) ui.notifications?.info("Battle Log cleared!");

      return { ok: true, dbName: dbActor.name };
    } catch (err) {
      console.warn("[FUCompanion][BattleLogClear] Failed:", err);
      if (notify) ui.notifications?.error("Failed to clear Battle Log (see console).");
      return { ok: false, reason: String(err?.message ?? err) };
    }
  };

  // Optional: small ready ping (helps confirm script is loaded)
  Hooks.once("ready", () => {
    console.debug("[FUCompanion][BattleLogClear] API installed: window.FUCompanion.api.clearBattleLog()");
  });
})();
