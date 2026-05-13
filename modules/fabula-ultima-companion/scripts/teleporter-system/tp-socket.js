// ============================================================================
// Teleporter System — Socket Handlers
//
// GM-side execution of teleport operations requested via socket.
//
// Messages:
//   TP_SAME_SCENE   — move token within the same scene
//   TP_CROSS_SCENE  — move token to a different scene
//
// TP_SAME_SCENE payload:
//   { tokenId, sceneId, x, y, offX, offY }
//   x, y   — center of destination (world coords)
//   offX/Y — DP.UI.TOKEN_OFFSET values (pre-computed by client, 0 if none)
// ============================================================================
(() => {
  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const SOCKET_CH = TP.SOCKET_CH ?? `module.${MODULE_ID}`;
  const TAG       = "[TeleporterSystem][Socket]";
  const GUARD     = "__ONI_TP_SOCKET__";

  function setup() {
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (typeof msg?.type !== "string" || !msg.type.startsWith("TP_")) return;

      // ── Same-scene token move ───────────────────────────────────────────────
      if (msg.type === "TP_SAME_SCENE") {
        if (!game.user?.isGM) return;
        const { tokenId, sceneId, x, y, offX = 0, offY = 0 } = msg.payload ?? {};

        const scene    = game.scenes.get(sceneId);
        const tokenDoc = scene?.tokens?.get?.(tokenId);
        if (!tokenDoc) {
          console.warn(TAG, "TP_SAME_SCENE: token not found", { tokenId, sceneId });
          return;
        }

        // Wait for dungeon pathing to finish any active rebuild
        const dpState = globalThis.__ONI_DUNGEON_PATHING__?.state;
        if (dpState?.busy) {
          const deadline = performance.now() + 1200;
          while (dpState.busy && performance.now() < deadline) {
            await new Promise(r => setTimeout(r, 30));
          }
        }

        const gSize  = scene.grid?.size ?? 100;
        const tw     = (tokenDoc.width  ?? 1) * gSize;
        const th     = (tokenDoc.height ?? 1) * gSize;
        const finalX = Math.round(x - tw / 2 + offX);
        const finalY = Math.round(y - th / 2 + offY);

        await tokenDoc.update(
          { x: finalX, y: finalY },
          { animate: false, dungeonPathing: true, teleporter: true }
        ).catch(e => console.warn(TAG, "TP_SAME_SCENE update failed:", e));
        return;
      }

      // ── Cross-scene token move ──────────────────────────────────────────────
      if (msg.type === "TP_CROSS_SCENE") {
        if (!game.user?.isGM) return;
        const { actorId, fromSceneId, toSceneId, x, y } = msg.payload ?? {};
        await TP.api.executeCrossSceneTeleport(actorId, fromSceneId, toSceneId, x, y)
          .catch(e => console.error(TAG, "TP_CROSS_SCENE failed:", e));
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  Hooks.once("ready", setup);
})();
