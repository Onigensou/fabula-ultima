// ============================================================================
// Teleporter System — Bootstrap & Movement Detection
//
// DUNGEON MODE (sceneMode === "dungeon"):
//   Hooks "dungeonPathing.turnEnd" which fires { tokenDoc, node } (single
//   object — all DP events use this shape).  Fires AFTER the DP confirm dialog
//   and tile event dispatch, so the turn is fully resolved before we teleport.
//
// EXPLORATION MODE (sceneMode === "exploration"):
//   Hooks "updateToken".  Fires on all clients; guarded to GM-only so only one
//   client triggers the teleport.  Skips updates caused by our own teleport
//   (options.teleporter = true) to avoid re-triggering on arrival.
//
// SCENE MODE "none":
//   Teleporter logic is fully disabled.
// ============================================================================
(() => {
  const GUARD = "__ONI_TP_BOOTSTRAP__";
  if (window[GUARD]?.installed) return;
  window[GUARD] = { installed: true };

  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const FLAG_ROOT = TP.FLAG_ROOT ?? "teleporter";
  const TAG       = "[TeleporterSystem][Bootstrap]";

  let _teleporting = false;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function getFlags(tileDoc) {
    return tileDoc?.flags?.[MODULE_ID]?.[FLAG_ROOT] ?? null;
  }

  function isTeleporterEnabled(tileDoc) {
    const f = getFlags(tileDoc);
    return f?.enabled === true || f?.enabled === "true";
  }

  function getSceneMode(scene) {
    const sc  = scene ?? canvas?.scene;
    const DP  = globalThis.DungeonPathing;
    if (!DP) return "none";
    const fab  = sc?.flags?.[MODULE_ID]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY];
    const mode = fab?.[DP.SCENE_MODE_KEY];
    if (mode === "dungeon" || mode === "exploration" || mode === "none") return mode;
    const legacy = fab?.cameraFollowToken;
    if (legacy === true || legacy === "true" || legacy === 1) return "exploration";
    return "none";
  }

  function tokenCenter(tokenDoc) {
    const gSize = canvas?.grid?.size ?? 100;
    const tw    = (tokenDoc.width  ?? 1) * gSize;
    const th    = (tokenDoc.height ?? 1) * gSize;
    return { x: (tokenDoc.x ?? 0) + tw / 2, y: (tokenDoc.y ?? 0) + th / 2 };
  }

  function teleporterTileAt(worldX, worldY, scene) {
    const sc = scene ?? canvas?.scene;
    for (const tileDoc of (sc?.tiles ?? [])) {
      if (!isTeleporterEnabled(tileDoc)) continue;
      if (worldX >= tileDoc.x && worldX <= tileDoc.x + tileDoc.width &&
          worldY >= tileDoc.y && worldY <= tileDoc.y + tileDoc.height) {
        return tileDoc;
      }
    }
    return null;
  }

  // ── Confirmation dialog ───────────────────────────────────────────────────────

  async function askTeleportConfirm(destination) {
    let where = "the destination";
    if (destination?.type === "coords") {
      where = `(${Math.round(destination.x ?? 0)}, ${Math.round(destination.y ?? 0)})`;
      if (destination.sceneId && destination.sceneId !== canvas?.scene?.id) {
        const sc = game.scenes.get(destination.sceneId);
        where += ` in <b>${sc?.name ?? "another scene"}</b>`;
      }
    } else if (destination?.type === "tile") {
      if (destination.sceneId && destination.sceneId !== canvas?.scene?.id) {
        const sc = game.scenes.get(destination.sceneId);
        where = `a tile in <b>${sc?.name ?? "another scene"}</b>`;
      } else {
        where = "a nearby tile";
      }
    }
    return Dialog.confirm({
      title:   "Teleporter",
      content: `<p style="text-align:center;padding:8px 4px;">Teleport to ${where}?</p>`,
    });
  }

  // ── Core trigger ──────────────────────────────────────────────────────────────

  async function triggerTeleporter(tileDoc, tokenDoc) {
    if (_teleporting) return;

    const flags = getFlags(tileDoc);
    if (!flags?.enabled) return;

    if (!flags.destination) {
      ui.notifications?.warn?.("Teleporter tile has no destination configured.");
      console.warn(TAG, "Teleporter tile has no destination:", tileDoc.id);
      return;
    }

    console.debug(TAG, "Triggering teleporter on tile", tileDoc.id, "→", flags.destination);

    const confirmMode = flags.confirmMode !== false && flags.confirmMode !== "false";
    if (confirmMode) {
      const confirmed = await askTeleportConfirm(flags.destination);
      if (!confirmed) {
        console.debug(TAG, "Teleport cancelled by player.");
        return;
      }
    }

    _teleporting = true;
    try {
      const sfxUrl = (typeof flags.sfxUrl === "string" && flags.sfxUrl.trim()) ? flags.sfxUrl.trim() : undefined;
      await TP.api.teleportToken(tokenDoc, flags.destination, { sfxUrl });
    } catch (e) {
      console.error(TAG, "Teleportation failed:", e);
      ui.notifications?.error?.("Teleporter error — see console.");
    } finally {
      setTimeout(() => { _teleporting = false; }, 1500);
    }
  }

  // ── DUNGEON MODE — hook on turnEnd ────────────────────────────────────────────
  // NOTE: all DP events pass a SINGLE object as their argument:
  //   Hooks.callAll(DP.HOOKS.TURN_END, { tokenDoc, node })
  // Destructure accordingly.

  Hooks.on("dungeonPathing.turnEnd", async ({ tokenDoc, node } = {}) => {
    try {
      if (getSceneMode() !== "dungeon") return;
      if (_teleporting) return;
      if (!node?.nodeId) return;

      const scene   = canvas?.scene;
      const tileDoc = scene?.tiles?.get?.(node.nodeId);

      console.debug(TAG, "[dungeon] turnEnd fired | nodeId:", node.nodeId, "| tileDoc:", tileDoc?.id, "| enabled:", isTeleporterEnabled(tileDoc));

      if (!tileDoc || !isTeleporterEnabled(tileDoc)) return;

      await triggerTeleporter(tileDoc, tokenDoc);
    } catch (e) {
      console.error(TAG, "dungeonPathing.turnEnd handler error:", e);
    }
  });

  // ── EXPLORATION MODE — hook on updateToken ────────────────────────────────────
  // GM handles all triggers in exploration mode to guarantee a single executor.

  let _exploreTimer = null;

  Hooks.on("updateToken", async (tokenDoc, changes, options) => {
    // Skip teleport-origin updates to prevent re-triggering on arrival
    if (options?.teleporter) return;

    if (!("x" in changes || "y" in changes)) return;

    const mode = getSceneMode();
    if (mode === "none")    return;
    if (mode === "dungeon") return; // handled via turnEnd

    // Only the GM executes exploration-mode teleports
    if (!game.user?.isGM) return;

    if (_exploreTimer) clearTimeout(_exploreTimer);
    _exploreTimer = setTimeout(async () => {
      _exploreTimer = null;
      try {
        await handleExplorationUpdate(tokenDoc);
      } catch (e) {
        console.warn(TAG, "exploration updateToken error:", e);
      }
    }, 300);
  });

  async function handleExplorationUpdate(tokenDoc) {
    if (_teleporting) return;

    // Only act for the party (db_actor) token
    try {
      const dbResult = await window.FUCompanion?.api?.getCurrentGameDb?.();
      if (dbResult?.db && tokenDoc.actorId !== dbResult.db.id) return;
      // If db lookup fails, fall through and check any token (permissive fallback)
    } catch {
      // db resolver not available — skip the check and act on any token move
    }

    const center  = tokenCenter(tokenDoc);
    const tileDoc = teleporterTileAt(center.x, center.y);
    if (!tileDoc) return;

    console.debug(TAG, "[exploration] token center:", center, "| teleporter tile:", tileDoc.id);

    await triggerTeleporter(tileDoc, tokenDoc);
  }

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "API: globalThis.TeleporterSystem.api");
  });
})();
