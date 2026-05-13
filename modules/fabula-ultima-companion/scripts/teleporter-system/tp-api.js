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
// Flag paths — all under flags.fabula-ultima-companion.teleporter.*:
//   enabled      boolean  — is this tile a teleporter?
//   confirmMode  boolean  — show confirmation dialog before teleporting?
//   destination  object   — destination (see above)
//   twoWay       boolean  — auto-link destination tile back to this one
//   sfxUrl       string   — SFX to play on teleportation
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

    console.warn(TAG, "resolveDestination: unknown destination type:", destination.type);
    return null;
  }

  // ── Same-scene teleport ───────────────────────────────────────────────────────
  // Always routed through GM so the dungeon-pathing preUpdateToken block
  // (which strips x/y from non-GM updates) never interferes.

  async function sameSceneTeleport(tokenDoc, resolved) {
    if (!game.user?.isGM) {
      game.socket.emit(SOCKET_CH, {
        type:    "TP_SAME_SCENE",
        payload: {
          tokenId: tokenDoc.id,
          sceneId: resolved.sceneId,
          x:       resolved.x,
          y:       resolved.y,
        },
      });
      return;
    }

    const scene = game.scenes.get(resolved.sceneId) ?? canvas?.scene;
    if (!scene) return;
    const gSize = scene.grid?.size ?? 100;
    const tw    = (tokenDoc.width  ?? 1) * gSize;
    const th    = (tokenDoc.height ?? 1) * gSize;

    await tokenDoc.update(
      { x: Math.round(resolved.x - tw / 2), y: Math.round(resolved.y - th / 2) },
      // dungeonPathing:true bypasses the DP preUpdateToken guard;
      // teleporter:true lets our own updateToken listener skip this move.
      { dungeonPathing: true, teleporter: true }
    );
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
    if (!destScene) { console.warn(TAG, "executeCrossSceneTeleport: destination scene not found:", toSceneId); return; }

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

    try {
      await destScene.activate();
    } catch (e) {
      console.error(TAG, "scene activate attempt 1 threw:", e);
    }

    // Retry activate if canvas hasn't switched after 2 s
    await new Promise(r => setTimeout(r, 2000));
    if (canvas?.scene?.id !== toSceneId) {
      await destScene.activate().catch(e => console.error(TAG, "scene activate attempt 2 threw:", e));
    }

    if (fromSceneId && actorId && fromSceneId !== toSceneId) {
      const fromScene = game.scenes.get(fromSceneId);
      const oldToken  = fromScene?.tokens?.find?.(t => t.actorId === actorId);
      if (oldToken) oldToken.delete().catch(() => {});
    }
  }

  // ── Main teleport entry point ─────────────────────────────────────────────────

  async function teleportToken(tokenDoc, destination, { sfxUrl } = {}) {
    if (!tokenDoc) return;

    const resolved = await resolveDestination(destination);
    if (!resolved) { console.warn(TAG, "Could not resolve destination:", destination); return; }

    await playTeleportSfx(sfxUrl);

    const currentSceneId = tokenDoc.parent?.id ?? canvas?.scene?.id;
    if (resolved.sceneId && resolved.sceneId !== currentSceneId) {
      await crossSceneTeleport(tokenDoc, resolved);
    } else {
      await sameSceneTeleport(tokenDoc, resolved);
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
