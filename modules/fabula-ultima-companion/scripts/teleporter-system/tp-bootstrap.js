// ============================================================================
// Teleporter System — Bootstrap & Movement Detection
//
// DUNGEON MODE ("dungeon"):
//   Hooks "dungeonPathing.turnEnd" which fires { tokenDoc, node }.
//   Fires after DP confirm dialog + tile event, when the turn is fully done.
//   Passes forcedNodeId (destination tileId) so the post-teleport rebuild
//   resolves the new node in O(1) via dpState.forcedNodeId.
//   Applies DP.UI.TOKEN_OFFSET to tile-type destinations so the token stands
//   on the tile correctly (same alignment as normal dungeon movement).
//
// EXPLORATION MODE ("exploration"):
//   Hooks "updateToken".  GM-only guard → single executor.
//   Uses a synchronously-checked cached db actor ID (refreshed on ready/updateActor)
//   to avoid an async getCurrentGameDb() call in the hot token-update path.
//   Skips updates tagged options.teleporter to prevent re-triggering on arrival.
//
// LOOP SAFEGUARD:
//   Per-token cooldown map (tokenId → timestamp).  If the same token was
//   just teleported within COOLDOWN_MS, all further triggers are ignored.
//   This prevents A→B→A infinite loops when both tiles are teleporters.
//
// SCENE MODE "none": fully disabled.
// ============================================================================
(() => {
  const GUARD = "__ONI_TP_BOOTSTRAP__";
  if (window[GUARD]?.installed) return;
  window[GUARD] = { installed: true };

  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const FLAG_ROOT = TP.FLAG_ROOT ?? "teleporter";
  const TAG       = "[TeleporterSystem][Bootstrap]";

  // ── Cooldown (loop safeguard) ─────────────────────────────────────────────────
  const COOLDOWN_MS    = 2000;
  const _cooldowns     = new Map(); // tokenId → timestamp

  function isOnCooldown(tokenDoc) {
    const last = _cooldowns.get(tokenDoc.id);
    return !!last && (Date.now() - last) < COOLDOWN_MS;
  }

  function markCooldown(tokenDoc) {
    _cooldowns.set(tokenDoc.id, Date.now());
    // Auto-clean after double the window so the Map doesn't grow forever
    setTimeout(() => _cooldowns.delete(tokenDoc.id), COOLDOWN_MS * 2);
  }

  // ── Cached db actor ID for sync check ────────────────────────────────────────
  // Avoids an async getCurrentGameDb() call on every token move.
  let _cachedDbActorId = null;

  async function warmDbCache() {
    try {
      const res = await window.FUCompanion?.api?.getCurrentGameDb?.();
      _cachedDbActorId = res?.db?.id ?? null;
    } catch {
      _cachedDbActorId = null;
    }
  }

  Hooks.once("ready", () => {
    warmDbCache();
    // Invalidate when any actor changes (game_id or db actor might have changed)
    Hooks.on("updateActor", () => {
      _cachedDbActorId = null;
      warmDbCache();
    });
  });

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
    return {
      x: (tokenDoc.x ?? 0) + (tokenDoc.width  ?? 1) * gSize / 2,
      y: (tokenDoc.y ?? 0) + (tokenDoc.height ?? 1) * gSize / 2,
    };
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
        where = "a tile";
      }
    }
    return Dialog.confirm({
      title:   "Teleporter",
      content: `<p style="text-align:center;padding:8px 4px;">Teleport to ${where}?</p>`,
    });
  }

  // ── Core trigger ──────────────────────────────────────────────────────────────

  async function triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset = false, forcedNodeId = null } = {}) {
    // Loop safeguard — prevent A→B→A infinite teleport chains
    if (isOnCooldown(tokenDoc)) {
      console.debug(TAG, "Trigger skipped (cooldown active) for token:", tokenDoc.id);
      return;
    }

    const flags = getFlags(tileDoc);
    if (!flags?.enabled) return;

    if (!flags.destination) {
      ui.notifications?.warn?.("Teleporter tile has no destination configured.");
      return;
    }

    console.debug(TAG, "Trigger | tile:", tileDoc.id, "→", flags.destination,
      "| offset:", applyDpOffset, "| forcedNodeId:", forcedNodeId);

    const confirmMode = flags.confirmMode !== false && flags.confirmMode !== "false";
    if (confirmMode) {
      const confirmed = await askTeleportConfirm(flags.destination);
      if (!confirmed) return;
    }

    // Mark cooldown BEFORE the async teleport so any concurrent trigger is blocked
    markCooldown(tokenDoc);

    try {
      const sfxUrl = (typeof flags.sfxUrl === "string" && flags.sfxUrl.trim()) ? flags.sfxUrl.trim() : undefined;
      await TP.api.teleportToken(tokenDoc, flags.destination, { sfxUrl, applyDpOffset, forcedNodeId });
    } catch (e) {
      console.error(TAG, "Teleportation failed:", e);
      ui.notifications?.error?.("Teleporter error — see console.");
    }
  }

  // ── DUNGEON MODE — hook on turnEnd ────────────────────────────────────────────
  // DP.Events.turnEnd fires: Hooks.callAll(HOOK, { tokenDoc, node })
  // → must destructure as a single object.
  //
  // forcedNodeId: for tile-type destinations, pass the destination tileId so
  // the post-teleport rebuild resolves in O(1) instead of scanning all nodes.

  Hooks.on("dungeonPathing.turnEnd", async ({ tokenDoc, node } = {}) => {
    try {
      if (getSceneMode() !== "dungeon") return;
      if (!node?.nodeId) return;
      if (isOnCooldown(tokenDoc)) return;

      const scene   = canvas?.scene;
      const tileDoc = scene?.tiles?.get?.(node.nodeId);

      console.debug(TAG, "[dungeon] turnEnd | nodeId:", node.nodeId, "| teleporter enabled:", isTeleporterEnabled(tileDoc));

      if (!tileDoc || !isTeleporterEnabled(tileDoc)) return;

      const flags = getFlags(tileDoc);
      // Apply DP token offset only when destination is a tile (not raw coords)
      const applyDpOffset = flags?.destination?.type === "tile";
      // Pass destination tileId as forcedNodeId for O(1) graph resolution after teleport
      const forcedNodeId  = flags?.destination?.type === "tile" ? (flags?.destination?.tileId ?? null) : null;

      await triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset, forcedNodeId });
    } catch (e) {
      console.error(TAG, "dungeonPathing.turnEnd handler error:", e);
    }
  });

  // ── EXPLORATION MODE — hook on updateToken ────────────────────────────────────
  // GM-only to ensure a single executor.  Uses cached db actor ID to avoid
  // an async lookup in the hot path.

  let _exploreTimer = null;

  Hooks.on("updateToken", (tokenDoc, changes, options) => {
    // Skip updates that came from a teleport (prevents re-triggering on arrival)
    if (options?.teleporter) return;
    if (!("x" in changes || "y" in changes)) return;

    const mode = getSceneMode();
    if (mode === "none")    return;
    if (mode === "dungeon") return; // handled via turnEnd

    if (!game.user?.isGM) return;

    // Synchronous db actor check (cached) — skip non-party-token moves immediately
    if (_cachedDbActorId !== null && tokenDoc.actorId !== _cachedDbActorId) return;

    // Debounce: token drag fires many rapid updates; wait for it to settle
    if (_exploreTimer) clearTimeout(_exploreTimer);
    _exploreTimer = setTimeout(() => {
      _exploreTimer = null;
      handleExplorationUpdate(tokenDoc).catch(e => console.warn(TAG, "exploration error:", e));
    }, 250);
  });

  async function handleExplorationUpdate(tokenDoc) {
    if (isOnCooldown(tokenDoc)) return;

    // If cache miss, do async lookup once and update cache
    if (_cachedDbActorId === null) {
      await warmDbCache();
      if (_cachedDbActorId !== null && tokenDoc.actorId !== _cachedDbActorId) return;
    }

    const center  = tokenCenter(tokenDoc);
    const tileDoc = teleporterTileAt(center.x, center.y);
    if (!tileDoc) return;

    console.debug(TAG, "[exploration] hit teleporter tile:", tileDoc.id, "center:", center);

    // No DP offset or forcedNodeId in exploration mode (no dungeon graph active)
    await triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset: false, forcedNodeId: null });
  }

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "API: globalThis.TeleporterSystem.api");
  });
})();
