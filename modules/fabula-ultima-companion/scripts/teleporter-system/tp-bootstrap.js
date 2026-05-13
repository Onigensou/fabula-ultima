// ============================================================================
// Teleporter System — Bootstrap & Movement Detection
//
// Two integration paths:
//
// DUNGEON MODE (scene mode === "dungeon")
//   Hooks on "dungeonPathing.turnEnd".  This hook fires only on the client
//   that ran the turn loop (the movement controller), so only one client acts.
//   The DP confirm dialog already confirmed the move; this fires AFTER that.
//
// EXPLORATION / FREE MODE (scene mode === "exploration")
//   Hooks on "updateToken".  Fires on all clients — guarded by movement-
//   controller check (or GM fallback) and a debounce to prevent double-fire.
//   Skips updates that were themselves triggered by a teleport (options.teleporter).
//
// SCENE MODE "none"
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

  // Prevents concurrent teleport triggers (e.g. two quick tile entries)
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
    return TP.api?.getSceneMode?.(scene) ?? "none";
  }

  // Center point of the token document (world coords)
  function tokenCenter(tokenDoc) {
    const gSize = canvas?.grid?.size ?? 100;
    const tw    = (tokenDoc.width  ?? 1) * gSize;
    const th    = (tokenDoc.height ?? 1) * gSize;
    return {
      x: (tokenDoc.x ?? 0) + tw / 2,
      y: (tokenDoc.y ?? 0) + th / 2,
    };
  }

  // Find the first teleporter tile whose bounds contain the given world point
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
      return;
    }

    const confirmMode = flags.confirmMode !== false && flags.confirmMode !== "false";
    if (confirmMode) {
      const confirmed = await askTeleportConfirm(flags.destination);
      if (!confirmed) return;
    }

    _teleporting = true;
    try {
      await TP.api.teleportToken(tokenDoc, flags.destination, { sfxUrl: flags.sfxUrl });
    } catch (e) {
      console.error(TAG, "Teleportation failed:", e);
      ui.notifications?.error?.("Teleporter: an error occurred. See the console.");
    } finally {
      // Brief cooldown so the arrival position update doesn't re-trigger
      setTimeout(() => { _teleporting = false; }, 1500);
    }
  }

  // ── DUNGEON MODE — hook on turnEnd ────────────────────────────────────────────
  // "dungeonPathing.turnEnd" fires only on the movement controller's client,
  // after the DP confirm button has been pressed and the graph rebuilt.

  Hooks.on("dungeonPathing.turnEnd", async (tokenDoc, destinationNode) => {
    if (getSceneMode() !== "dungeon") return;
    if (_teleporting) return;

    const scene   = canvas?.scene;
    const tileDoc = scene?.tiles?.get?.(destinationNode?.nodeId);
    if (!tileDoc || !isTeleporterEnabled(tileDoc)) return;

    await triggerTeleporter(tileDoc, tokenDoc);
  });

  // ── EXPLORATION MODE — hook on updateToken ────────────────────────────────────
  // updateToken fires on ALL clients; only the movement controller (or GM) acts.

  let _exploreTimer = null;

  Hooks.on("updateToken", async (tokenDoc, changes, options) => {
    // Skip token moves caused by a teleport (prevents re-triggering on arrival)
    if (options?.teleporter) return;

    // Only react to position changes
    if (!("x" in changes || "y" in changes)) return;

    const mode = getSceneMode();
    if (mode === "none")    return;
    if (mode === "dungeon") return; // dungeon path handled above via turnEnd

    // Debounce rapid updates
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
    const dbResult = await window.FUCompanion?.api?.getCurrentGameDb?.();
    if (!dbResult?.db || tokenDoc.actorId !== dbResult.db.id) return;

    // Gate to a single client: prefer movement controller, fall back to GM
    const movCtrl = globalThis.__ONI_MOVEMENT_CONTROL_API__;
    if (movCtrl?.isCurrentUserMainController) {
      const isCtrl = await movCtrl.isCurrentUserMainController().catch(() => false);
      if (!isCtrl) return;
    } else {
      if (!game.user?.isGM) return;
    }

    const center  = tokenCenter(tokenDoc);
    const tileDoc = teleporterTileAt(center.x, center.y);
    if (!tileDoc) return;

    await triggerTeleporter(tileDoc, tokenDoc);
  }

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "Flags: flags.fabula-ultima-companion.teleporter.*");
    console.debug(TAG, "API:   globalThis.TeleporterSystem.api");
  });
})();
