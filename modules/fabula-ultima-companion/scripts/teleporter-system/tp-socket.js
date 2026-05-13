// ============================================================================
// Teleporter System — Socket Handlers
//
// Handles GM-side execution of teleport operations requested via socket.
//
// Messages (all prefixed TP_):
//   TP_SAME_SCENE   — move a token within the current scene (GM executes)
//   TP_CROSS_SCENE  — move a token to a different scene   (GM executes)
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
        const { tokenId, sceneId, x, y } = msg.payload ?? {};

        const scene    = game.scenes.get(sceneId);
        const tokenDoc = scene?.tokens?.get?.(tokenId);
        if (!tokenDoc) {
          console.warn(TAG, "TP_SAME_SCENE: token not found", { tokenId, sceneId });
          return;
        }

        const gSize = scene.grid?.size ?? 100;
        const tw    = (tokenDoc.width  ?? 1) * gSize;
        const th    = (tokenDoc.height ?? 1) * gSize;

        await tokenDoc.update(
          { x: Math.round(x - tw / 2), y: Math.round(y - th / 2) },
          { dungeonPathing: true, teleporter: true }
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
