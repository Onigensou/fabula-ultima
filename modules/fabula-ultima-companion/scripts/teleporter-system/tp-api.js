// ============================================================================
// Teleporter System — Core API
//
// Exposes: globalThis.TeleporterSystem.api
//
// Key operations:
//   teleportToken(tokenDoc, destination, options) — move token to destination
//   executeCrossSceneTeleport(...)               — GM-only cross-scene transport
//   getFlags(tileDoc)                            — read teleporter flags
//   isTeleporterEnabled(tileDoc)                 — check if tile is a teleporter
//   getSceneMode(scene)                          — read current scene mode
//
// Destination object shape:
//   { type: "coords", x, y, sceneId }
//   { type: "tile",   tileId, sceneId }
//
// options:
//   sfxUrl        string   — override SFX (played fire-and-forget, never blocks)
//   applyDpOffset boolean  — apply DP.UI.TOKEN_OFFSET to arrival position
//                            (use when teleporting to a tile in dungeon mode)
//   forcedNodeId  string   — DP graph node ID of destination tile; allows the
//                            post-teleport rebuild to skip the positional search
//                            and resolve the node in O(1) instead of O(n)
//
// PERF — Dungeon mode double-rebuild prevention:
//   After waitForDpReady(), dpState.busy is false. A plain tokenDoc.update()
//   at that point would trigger DP's updateToken hook → another full rebuild.
//   We suppress it by temporarily setting dpState.busy=true around the update,
//   then doing exactly ONE controlled rebuild with forcedNodeId already set.
//   Net result: 1 rebuild instead of 2 per dungeon teleport.
// ============================================================================
(() => {
  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[TeleporterSystem][API]";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const FLAG_ROOT = "teleporter";

  // ── Flag helpers ─────────────────────────────────────────────────────────────

  function getFlags(tileDoc) {
    return tileDoc?.flags?.[MODULE_ID]?.[FLAG_ROOT] ?? null;
  }

  function isTeleporterEnabled(tileDoc) {
    const f = getFlags(tileDoc);
    return f?.enabled === true || f?.enabled === "true";
  }

  // ── Scene mode ────────────────────────────────────────────────────────────────

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

  // ── SFX ───────────────────────────────────────────────────────────────────────

  async function playTeleportSfx(sfxUrl) {
    const url = (typeof sfxUrl === "string" && sfxUrl.trim()) ? sfxUrl.trim() : TP.DEFAULT_SFX;
    if (!url) return;
    try {
      await AudioHelper.play({ src: url, volume: 0.8, autoplay: true, loop: false }, true);
    } catch (e) {
      console.warn(TAG, "SFX play failed:", e);
    }
  }

  // ── Destination resolution ────────────────────────────────────────────────────

  async function resolveDestination(destination) {
    if (!destination) return null;

    if (destination.type === "coords") {
      return {
        sceneId: destination.sceneId ?? canvas?.scene?.id,
        x:       destination.x,
        y:       destination.y,
      };
    }

    if (destination.type === "tile") {
      const sceneId = destination.sceneId ?? canvas?.scene?.id;
      const scene   = game.scenes.get(sceneId);
      if (!scene) { console.warn(TAG, "resolveDestination: scene not found:", sceneId); return null; }

      const tileDoc = scene.tiles.get(destination.tileId);
      if (!tileDoc) { console.warn(TAG, "resolveDestination: tile not found:", destination.tileId); return null; }

      return {
        sceneId,
        x: tileDoc.x + tileDoc.width  / 2,
        y: tileDoc.y + tileDoc.height / 2,
      };
    }

    console.warn(TAG, "resolveDestination: unknown type:", destination.type);
    return null;
  }

  // ── Wait for dungeon pathing busy state to clear ──────────────────────────────
  // turnEnd fires while the finally-block rebuild() is still running (state.busy=true).
  // Waiting first guarantees the final-rebuild completes before we modify the token,
  // so we don't race two concurrent rebuilds over shared state.

  async function waitForDpReady(maxWaitMs = 1200) {
    const dpState = globalThis.__ONI_DUNGEON_PATHING__?.state;
    if (!dpState?.busy) return;
    const deadline = performance.now() + maxWaitMs;
    while (dpState.busy && performance.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  // ── Same-scene teleport ───────────────────────────────────────────────────────
  // Always routed through GM so dp-bootstrap's preUpdateToken guard never strips x/y.
  //
  // forcedNodeId: when the destination is a DP graph tile, pass its node ID here.
  //   This lets the post-teleport rebuild resolve the current node in O(1) via
  //   dpState.forcedNodeId rather than iterating the full graph to find the token.

  async function sameSceneTeleport(tokenDoc, resolved, { applyDpOffset = false, forcedNodeId = null } = {}) {
    const scene = game.scenes.get(resolved.sceneId) ?? canvas?.scene;
    if (!scene) return;

    const gSize = scene.grid?.size ?? 100;
    const tw    = (tokenDoc.width  ?? 1) * gSize;
    const th    = (tokenDoc.height ?? 1) * gSize;

    const DP   = globalThis.DungeonPathing;
    const offX = (applyDpOffset && DP?.UI?.TOKEN_OFFSET) ? Number(DP.UI.TOKEN_OFFSET.x ?? 0) : 0;
    const offY = (applyDpOffset && DP?.UI?.TOKEN_OFFSET) ? Number(DP.UI.TOKEN_OFFSET.y ?? 0) : 0;

    if (!game.user?.isGM) {
      game.socket.emit(SOCKET_CH, {
        type:    "TP_SAME_SCENE",
        payload: {
          tokenId: tokenDoc.id,
          sceneId: resolved.sceneId,
          // Send CENTER coords + separate offsets so GM can compute correct top-left
          x: resolved.x, y: resolved.y,
          offX, offY,
          forcedNodeId: forcedNodeId ?? null,
        },
      });
      return;
    }

    // Wait for any in-progress dungeon-pathing rebuild before touching the token.
    await waitForDpReady();

    const finalX = Math.round(resolved.x - tw / 2 + offX);
    const finalY = Math.round(resolved.y - th / 2 + offY);

    // ── Dungeon mode: suppress the extra rebuild that DP's updateToken hook ──────
    // would fire immediately after our update (busy=false at this point).
    // We set busy=true, do the update, then call rebuild() exactly once with
    // forcedNodeId so the graph resolves the new node in O(1).
    const dpInternals     = globalThis.__ONI_DUNGEON_PATHING__;
    const dpState         = dpInternals?.state;
    const isDungeonActive = dpState?.active === true;

    if (isDungeonActive) dpState.busy = true;

    await tokenDoc.update(
      { x: finalX, y: finalY },
      // animate:false  — instant position change, no slide animation
      // dungeonPathing — bypasses DP's preUpdateToken guard that strips x/y
      // teleporter     — signals our own updateToken handler to skip re-trigger
      { animate: false, dungeonPathing: true, teleporter: true }
    );

    if (isDungeonActive) {
      dpState.busy = false;
      // O(1) node resolution: set forcedNodeId before rebuild so DP doesn't
      // need to walk all graph nodes to locate the token's new tile.
      if (forcedNodeId) dpState.forcedNodeId = forcedNodeId;
      await dpInternals.rebuild();
    }
  }

  // ── Cross-scene teleport ──────────────────────────────────────────────────────

  async function crossSceneTeleport(tokenDoc, resolved) {
    const actorId     = tokenDoc.actorId;
    const fromSceneId = tokenDoc.parent?.id ?? canvas?.scene?.id;

    if (!game.user?.isGM) {
      game.socket.emit(SOCKET_CH, {
        type:    "TP_CROSS_SCENE",
        payload: { actorId, fromSceneId, toSceneId: resolved.sceneId, x: resolved.x, y: resolved.y },
      });
      return;
    }

    await executeCrossSceneTeleport(actorId, fromSceneId, resolved.sceneId, resolved.x, resolved.y);
  }

  async function executeCrossSceneTeleport(actorId, fromSceneId, toSceneId, spawnX, spawnY) {
    if (!game.user?.isGM) return;

    const destScene = game.scenes.get(toSceneId);
    if (!destScene) { console.warn(TAG, "destination scene not found:", toSceneId); return; }

    const gSize = destScene.grid?.size ?? 100;

    try {
      if (actorId) {
        const actor = game.actors.get(actorId);
        if (actor) {
          const existing = destScene.tokens?.find?.(t => t.actorId === actorId) ?? null;
          if (existing) await existing.delete().catch(e => console.warn(TAG, "cleanup dest token:", e));

          const tokenData   = actor.prototypeToken.toObject();
          tokenData.x       = Math.round(spawnX - (tokenData.width  ?? 1) * gSize / 2);
          tokenData.y       = Math.round(spawnY - (tokenData.height ?? 1) * gSize / 2);
          tokenData.actorId = actorId;
          await destScene.createEmbeddedDocuments("Token", [tokenData])
            .catch(e => console.warn(TAG, "token create failed:", e));
        }
      }
    } catch (e) {
      console.warn(TAG, "token setup failed (non-fatal):", e);
    }

    try { await destScene.activate(); }
    catch (e) { console.error(TAG, "scene activate attempt 1:", e); }

    await new Promise(r => setTimeout(r, 2000));
    if (canvas?.scene?.id !== toSceneId) {
      await destScene.activate().catch(e => console.error(TAG, "scene activate attempt 2:", e));
    }

    if (fromSceneId && actorId && fromSceneId !== toSceneId) {
      const fromScene = game.scenes.get(fromSceneId);
      const oldToken  = fromScene?.tokens?.find?.(t => t.actorId === actorId);
      if (oldToken) oldToken.delete().catch(() => {});
    }
  }

  // ── Main teleport entry point ─────────────────────────────────────────────────

  async function teleportToken(tokenDoc, destination, { sfxUrl, applyDpOffset = false, forcedNodeId = null } = {}) {
    if (!tokenDoc) return;

    const resolved = await resolveDestination(destination);
    if (!resolved) { console.warn(TAG, "Could not resolve destination:", destination); return; }

    // Fire SFX without awaiting — the position change should be instant.
    // AudioHelper.play() for a remote URL fetches+decodes before playing;
    // awaiting it would stall the teleport by 300–800 ms unnecessarily.
    playTeleportSfx(sfxUrl).catch(() => {});

    const currentSceneId = tokenDoc.parent?.id ?? canvas?.scene?.id;
    if (resolved.sceneId && resolved.sceneId !== currentSceneId) {
      await crossSceneTeleport(tokenDoc, resolved);
    } else {
      await sameSceneTeleport(tokenDoc, resolved, { applyDpOffset, forcedNodeId });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  TP.MODULE_ID   = MODULE_ID;
  TP.FLAG_ROOT   = FLAG_ROOT;
  TP.SOCKET_CH   = SOCKET_CH;
  TP.DEFAULT_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_BTL_FootStepNormal_1.ogg";

  TP.api = {
    teleportToken,
    playTeleportSfx,
    resolveDestination,
    executeCrossSceneTeleport,
    getFlags,
    isTeleporterEnabled,
    getSceneMode,
  };

  console.debug(TAG, "Teleporter API loaded.");
})();
