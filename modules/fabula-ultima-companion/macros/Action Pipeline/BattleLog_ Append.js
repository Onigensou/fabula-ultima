// ──────────────────────────────────────────────────────────
// BattleLog: Append  (Foundry V12)
// Optimized version:
// - Resolves DB actor once
// - Reads existing battle_log and battle_log_table once
// - Performs ONE dbActor.update(...) for both fields
// - Returns the async chain so callers can await it properly
// ──────────────────────────────────────────────────────────

return (async () => {
  const MAX = 30;
  const TAG = "[BL-APPEND]";

  const payload =
    typeof __PAYLOAD === "object" && __PAYLOAD
      ? __PAYLOAD
      : {};

  const entries = Array.isArray(payload.entries)
    ? payload.entries.filter(Boolean)
    : [];

  const rows = Array.isArray(payload.rows)
    ? payload.rows.filter(Boolean)
    : [];

  console.debug(TAG, "start.", {
    entries: entries.length,
    rows: rows.length,
    user: game.user?.name,
    isGM: game.user?.isGM,
    batchId: payload?.batchId ?? payload?.battleLogBatchId ?? null,
    source: payload?.source ?? null
  });

  if (!entries.length && !rows.length) {
    console.debug(TAG, "nothing to append.");
    return {
      ok: true,
      appended: false,
      reason: "empty"
    };
  }

  function duplicateSafe(value, fallback) {
    try {
      if (foundry?.utils?.duplicate) return foundry.utils.duplicate(value);
    } catch (_e) {}

    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}

    try {
      return structuredClone(value);
    } catch (_e) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}

    return fallback;
  }

  function parseExistingBattleLog(raw) {
    const existingRaw = String(raw ?? "").trim();

    if (!existingRaw) return [];

    if (existingRaw.startsWith("[") || existingRaw.startsWith("{")) {
      try {
        const parsed = JSON.parse(existingRaw);
        return Array.isArray(parsed)
          ? parsed
          : parsed
            ? [parsed]
            : [];
      } catch (_e) {
        console.warn(TAG, "battle_log contains invalid JSON; resetting.");
        return [];
      }
    }

    console.warn(TAG, "battle_log is not JSON-like; resetting.");
    return [];
  }

  function normalizeExistingTable(table) {
    if (Array.isArray(table)) {
      return duplicateSafe(table, []);
    }

    if (table && typeof table === "object") {
      return duplicateSafe(Object.values(table), []);
    }

    return [];
  }

  async function getDbActor() {
    // Preferred path: use your DB resolver if loaded.
    try {
      const api = globalThis.FUCompanion?.api;
      if (api?.getCurrentGameDb) {
        const result = await api.getCurrentGameDb();
        const db = result?.db ?? null;

        if (db) {
          console.debug(TAG, "DB actor resolved via DB_Resolver.", {
            name: db.name,
            owner: db.testUserPermission?.(game.user, "OWNER") ?? null
          });

          return db;
        }
      }
    } catch (err) {
      console.warn(TAG, "DB_Resolver path failed; falling back.", err);
    }

    // Fallback: preserve your original Current Game → game_id lookup.
    try {
      const currentGameActor = await fromUuid("Actor.DMpK5Bi119jIrCFZ");

      if (!currentGameActor) {
        console.warn(TAG, "Current Game actor not found by UUID Actor.DMpK5Bi119jIrCFZ");
        return null;
      }

      const gameDbUuid = currentGameActor?.system?.props?.game_id;

      if (!gameDbUuid) {
        console.warn(TAG, "system.props.game_id is empty on Current Game actor.");
        return null;
      }

      const dbActor = await fromUuid(gameDbUuid);

      if (!dbActor) {
        console.warn(TAG, "DB actor not found by UUID from system.props.game_id:", gameDbUuid);
        return null;
      }

      console.debug(TAG, "DB actor resolved via fallback.", {
        name: dbActor.name,
        owner: dbActor.testUserPermission?.(game.user, "OWNER") ?? null
      });

      return dbActor;
    } catch (err) {
      console.warn(TAG, "getDbActor failed:", err);
      return null;
    }
  }

  try {
    const dbActor = await getDbActor();

    if (!dbActor) {
      ui.notifications.warn("BattleLog: no DB actor. Is Current Game → game_id set?");
      return {
        ok: false,
        appended: false,
        reason: "missing_db_actor"
      };
    }

    const updateData = {};
    let finalJsonLength = null;
    let finalTableLength = null;

    if (entries.length) {
      let existingJson = parseExistingBattleLog(dbActor.system?.props?.battle_log);

      existingJson.push(...entries);

      if (existingJson.length > MAX) {
        existingJson = existingJson.slice(-MAX);
      }

      updateData["system.props.battle_log"] = JSON.stringify(existingJson, null, 2);
      finalJsonLength = existingJson.length;
    }

    if (rows.length) {
      let existingTable = normalizeExistingTable(dbActor.system?.props?.battle_log_table);

      existingTable.push(...rows);

      if (existingTable.length > MAX) {
        existingTable = existingTable.slice(-MAX);
      }

      updateData["system.props.battle_log_table"] = existingTable;
      finalTableLength = existingTable.length;
    }

    if (!Object.keys(updateData).length) {
      console.debug(TAG, "no update fields produced.");
      return {
        ok: true,
        appended: false,
        reason: "no_update_fields"
      };
    }

    // Main optimization:
    // One actor update instead of separate battle_log and battle_log_table updates.
    await dbActor.update(updateData);

    console.debug(TAG, "append OK.", {
      entriesAdded: entries.length,
      rowsAdded: rows.length,
      finalJsonLength,
      finalTableLength,
      updatedFields: Object.keys(updateData)
    });

    return {
      ok: true,
      appended: true,
      entries: entries.length,
      rows: rows.length,
      finalJsonLength,
      finalTableLength,
      updatedFields: Object.keys(updateData)
    };
  } catch (err) {
    console.warn(TAG, "append failed:", err);
    ui.notifications.warn("BattleLog append failed. Check DB actor ownership & console.");

    return {
      ok: false,
      appended: false,
      reason: "append_failed",
      error: String(err?.message ?? err)
    };
  }
})();