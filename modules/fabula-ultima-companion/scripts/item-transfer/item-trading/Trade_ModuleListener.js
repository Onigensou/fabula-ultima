// ============================================================================
// DEMO_Trade_ModuleListener
// Foundry VTT v12
//
// Purpose:
//   Central trade "brain" using the GM-as-server pattern.
//   - Listens on module.fabula-ultima-companion socket channel.
//   - GM mediates trade requests and target confirmations.
//   - Later, this will also open and coordinate the shared Trade Window.
//
// Message Types
//   OniTrade_Request
//     Sent by initiator client (player or GM) to ask GM to start a trade.
//   OniTrade_AskTarget
//     Sent by GM to the specific target user, asking them to accept/decline.
//   OniTrade_TargetResponse
//     Sent by target client back to GM saying { accepted: true/false }.
//   OniTrade_NotifyCancelled
//     Sent by GM to both sides when trade is cancelled at any step.
//   OniTrade_StartSession
//     Sent by GM to both sides when trade is accepted.
//     (Future steps: this will open the shared Trade Window.)
//
// Usage:
//   (Module version) This installs automatically on each client after READY.
//   You no longer need to run this manually as a macro.
//
// Dependencies:
//   - At least one active GM online (to act as “server”).
//   - Uses the same module channel as your other systems:
//       module.fabula-ultima-companion
// ============================================================================

(() => {
  console.log(
    "[OniTrade] BOOT Trade_ModuleListener.js loaded (file parsed). user:",
    game?.user?.id,
    "isGM:",
    game?.user?.isGM
  );

  const install = () => {
    const NS        = "__OniTradeModule__";
    const MODULE_ID = "fabula-ultima-companion";
    const CHANNEL   = `module.${MODULE_ID}`;

    // Avoid double-install on same client
    if (globalThis[NS]?.installed) {
      console.log("[OniTrade] Module listener already installed on user", game.user.id);
      ui.notifications?.info?.("OniTrade module listener already installed on this client.");
      return;
    }

    if (!game.socket) {
      console.error("[OniTrade] game.socket is NOT available on user", game.user.id);
      ui.notifications?.error?.("OniTrade: game.socket is not available.");
      return;
    }

    const isGM = () => game.user?.isGM;

    function getPrimaryActiveGM() {
      const gms = (game.users?.contents ?? []).filter((u) => u?.isGM && u?.active);
      return gms[0] ?? null;
    }

    function isPrimaryActiveGM() {
      const gm = getPrimaryActiveGM();
      return !!gm && game.user?.id === gm.id;
    }

    // Small HTML escaper for dialog text
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    // Namespace object for this client
    const GLOBAL = (globalThis[NS] = globalThis[NS] || {});
    GLOBAL.installed = true;

    console.log(
      "=== [OniTrade] MODULE LISTENER INSTALL on user",
      game.user.id,
      "isGM:",
      game.user.isGM,
      "primaryGM:",
      getPrimaryActiveGM()?.id ?? "none",
      "isPrimaryActiveGM:",
      isPrimaryActiveGM(),
      "==="
    );

    // ---------------------------------------------------------------------------
    // Helper: find user object by ID safely
    // ---------------------------------------------------------------------------
    function findUserById(userId) {
      if (!userId) return null;
      return game.users.get(userId) ?? null;
    }

    // ---------------------------------------------------------------------------
    // Helper: show a small chat card to a specific user (local only)
    // This does NOT send over network; it just helps with local feedback.
    // ---------------------------------------------------------------------------
    function showLocalChatMessage(text) {
      try {
        ChatMessage.create({
          content: `<div style="padding:6px 8px;border:1px solid #666;border-radius:6px;">${text}</div>`,
          speaker: ChatMessage.getSpeaker({ user: game.user })
        });
      } catch (err) {
        console.error("[OniTrade] Failed to create chat message.", err);
      }
    }

    // ---------------------------------------------------------------------------
    // Core SOCKET HANDLER
    // ---------------------------------------------------------------------------
    const handler = async (data) => {
      console.log(
        "[OniTrade] SOCKET handler FIRED on user",
        game.user.id,
        "isGM:",
        game.user.isGM,
        "data:",
        data
      );

      if (!data || typeof data !== "object") return;

      const { type, payload } = data;
      if (!type) return;

      switch (type) {
        // -----------------------------------------------------------------------
        // 1) Initiator → GM: request a trade
        // -----------------------------------------------------------------------
        case "OniTrade_Request":
          await handleTradeRequest(payload);
          break;

        // -----------------------------------------------------------------------
        // 2) GM → Target: ask them to accept/decline
        // -----------------------------------------------------------------------
        case "OniTrade_AskTarget":
          await handleAskTarget(payload);
          break;

        // -----------------------------------------------------------------------
        // 3) Target → GM: reply yes/no
        // -----------------------------------------------------------------------
        case "OniTrade_TargetResponse":
          await handleTargetResponse(payload);
          break;

        // -----------------------------------------------------------------------
        // 4) GM → Both: notify cancelled
        // -----------------------------------------------------------------------
        case "OniTrade_NotifyCancelled":
          await handleNotifyCancelled(payload);
          break;

        // -----------------------------------------------------------------------
        // 5) GM → Both: notify accepted & start trade session
        // -----------------------------------------------------------------------
        case "OniTrade_StartSession":
          await handleStartSession(payload);
          break;

        default:
          // Ignore everything else; other systems also share this module channel.
          break;
      }
    };

    game.socket.on(CHANNEL, handler);
    GLOBAL.socketHandler = handler;

    console.log(
      "[OniTrade] Socket handler attached on",
      CHANNEL,
      "for user",
      game.user.id
    );
    ui.notifications?.info?.("OniTrade module listener installed on this client.");

    // ===========================================================================
    // HANDLER IMPLEMENTATIONS
    // ===========================================================================

    // 1) Initiator → GM: OniTrade_Request
    async function handleTradeRequest(payload) {
      console.log("[OniTrade] handleTradeRequest on user", game.user.id, "payload:", payload);

      // Only the PRIMARY active GM should process this message.
      if (!isGM()) {
        console.log("[OniTrade] This user is not GM; ignoring OniTrade_Request.");
        return;
      }

      if (!isPrimaryActiveGM()) {
        console.log("[OniTrade] This GM is not the primary active GM; ignoring OniTrade_Request.", {
          localUserId: game.user.id,
          primaryGmUserId: getPrimaryActiveGM()?.id ?? null
        });
        return;
      }

      if (!payload || typeof payload !== "object") {
        console.warn("[OniTrade] OniTrade_Request payload is invalid.");
        return;
      }

      const {
        requestId,
        initiatorUserId,
        initiatorName,
        initiatorActorUuid,
        targetUserId,
        targetName,
        targetActorUuid
      } = payload;

      if (!requestId || !initiatorUserId || !targetUserId) {
        console.warn("[OniTrade] OniTrade_Request missing required fields.", payload);
        return;
      }

      const initiatorUser = findUserById(initiatorUserId);
      const targetUser    = findUserById(targetUserId);

      if (!initiatorUser || !initiatorUser.active) {
        console.warn("[OniTrade] Initiator user not found or inactive, cancelling trade.", {
          requestId,
          initiatorUserId
        });

        game.socket.emit(CHANNEL, {
          type: "OniTrade_NotifyCancelled",
          payload: {
            requestId,
            reason: "initiator_offline",
            initiatorUserId,
            targetUserId,
            initiatorName,
            targetName
          }
        });
        return;
      }

      if (!targetUser || !targetUser.active) {
        console.warn("[OniTrade] Target user not found or inactive, cancelling trade.", {
          requestId,
          targetUserId
        });

        game.socket.emit(CHANNEL, {
          type: "OniTrade_NotifyCancelled",
          payload: {
            requestId,
            reason: "target_offline",
            initiatorUserId,
            targetUserId,
            initiatorName,
            targetName
          }
        });
        return;
      }

      console.log(
        "[OniTrade] Primary GM accepted OniTrade_Request, will ask target to confirm.",
        { requestId, initiatorUserId, targetUserId }
      );

      // Send a request to the target user to accept the trade
      game.socket.emit(CHANNEL, {
        type: "OniTrade_AskTarget",
        payload: {
          requestId,
          initiatorUserId,
          initiatorName,
          initiatorActorUuid,
          targetUserId,
          targetName,
          targetActorUuid
        }
      });
    }

    // 2) GM → Target: OniTrade_AskTarget (target's client shows dialog)
    async function handleAskTarget(payload) {
      console.log("[OniTrade] handleAskTarget on user", game.user.id, "payload:", payload);

      if (!payload || typeof payload !== "object") return;

      const {
        requestId,
        initiatorUserId,
        initiatorName,
        initiatorActorUuid,
        targetUserId,
        targetName,
        targetActorUuid
      } = payload;

      if (!requestId || !targetUserId || !initiatorUserId) return;

      // Only the target user should see the accept/decline dialog
      if (game.user.id !== targetUserId) {
        console.log("[OniTrade] OniTrade_AskTarget not for this user, ignoring.", {
          localUserId: game.user.id,
          targetUserId
        });
        return;
      }

      const initiatorLabel = esc(initiatorName ?? "Unknown");
      const content = `
        <p style="margin-bottom: 0.5rem;">
          <strong>${initiatorLabel}</strong> would like to initiate a trade with you.
        </p>
        <p style="margin-top: 0.25rem;">
          Do you want to accept this trade request?
        </p>
      `;

      console.log("[OniTrade] Opening trade confirmation dialog on target client.", {
        requestId,
        localUserId: game.user.id
      });

      new Dialog({
        title: "Trade Request",
        content,
        buttons: {
          accept: {
            label: "Accept",
            callback: () => {
              sendTargetResponse({
                requestId,
                accepted: true,
                initiatorUserId,
                targetUserId,
                initiatorName,
                targetName,
                initiatorActorUuid,
                targetActorUuid
              });
            }
          },
          decline: {
            label: "Decline",
            callback: () => {
              sendTargetResponse({
                requestId,
                accepted: false,
                initiatorUserId,
                targetUserId,
                initiatorName,
                targetName,
                initiatorActorUuid,
                targetActorUuid
              });
            }
          }
        },
        default: "accept"
      }).render(true);
    }

    // Target → GM: send OniTrade_TargetResponse
    function sendTargetResponse({
      requestId,
      accepted,
      initiatorUserId,
      targetUserId,
      initiatorName,
      targetName,
      initiatorActorUuid,
      targetActorUuid
    }) {
      if (!game.socket) {
        ui.notifications?.error?.("OniTrade: game.socket is not available (target response).");
        return;
      }

      console.log("[OniTrade] Target sending OniTrade_TargetResponse.", {
        requestId,
        accepted,
        initiatorUserId,
        targetUserId
      });

      game.socket.emit(CHANNEL, {
        type: "OniTrade_TargetResponse",
        payload: {
          requestId,
          accepted: !!accepted,
          initiatorUserId,
          targetUserId,
          initiatorName,
          targetName,
          initiatorActorUuid,
          targetActorUuid
        }
      });
    }

    // 3) Target → GM: OniTrade_TargetResponse
    async function handleTargetResponse(payload) {
      console.log("[OniTrade] handleTargetResponse on user", game.user.id, "payload:", payload);

      // Only the PRIMARY active GM should process this message.
      if (!isGM()) {
        console.log("[OniTrade] This user is not GM; ignoring OniTrade_TargetResponse.");
        return;
      }

      if (!isPrimaryActiveGM()) {
        console.log("[OniTrade] This GM is not the primary active GM; ignoring OniTrade_TargetResponse.", {
          localUserId: game.user.id,
          primaryGmUserId: getPrimaryActiveGM()?.id ?? null
        });
        return;
      }

      if (!payload || typeof payload !== "object") return;

      const {
        requestId,
        accepted,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      } = payload;

      if (!requestId || !initiatorUserId || !targetUserId) {
        console.warn("[OniTrade] OniTrade_TargetResponse missing required fields.", payload);
        return;
      }

      if (!accepted) {
        console.log("[OniTrade] Target declined trade; notifying both sides.", { requestId });

        game.socket.emit(CHANNEL, {
          type: "OniTrade_NotifyCancelled",
          payload: {
            requestId,
            reason: "target_declined",
            initiatorUserId,
            targetUserId,
            initiatorName,
            targetName
          }
        });
        return;
      }

      console.log("[OniTrade] Target accepted trade; starting session.", { requestId });

      // Trade accepted: tell both users we are starting a new trade session
      game.socket.emit(CHANNEL, {
        type: "OniTrade_StartSession",
        payload: {
          requestId,
          initiatorUserId,
          targetUserId,
          initiatorName,
          targetName,
          initiatorActorUuid,
          targetActorUuid
        }
      });
    }

    // 4) GM → Both: OniTrade_NotifyCancelled
    async function handleNotifyCancelled(payload) {
      console.log("[OniTrade] handleNotifyCancelled on user", game.user.id, "payload:", payload);

      if (!payload || typeof payload !== "object") return;

      const {
        requestId,
        reason,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName
      } = payload;

      const localId = game.user.id;
      if (localId !== initiatorUserId && localId !== targetUserId) {
        // Not involved in this trade, ignore.
        return;
      }

      let reasonText = "The trade has been cancelled.";
      switch (reason) {
        case "initiator_offline":
          reasonText = "Trade cancelled: the initiator went offline.";
          break;
        case "target_offline":
          reasonText = "Trade cancelled: the target is offline.";
          break;
        case "target_declined":
          reasonText = "Trade cancelled: the other user declined.";
          break;
        default:
          reasonText = "Trade cancelled.";
          break;
      }

      ui.notifications?.warn?.(`OniTrade: ${reasonText}`);
      showLocalChatMessage(
        `<strong>Trade Cancelled</strong><br>${esc(reasonText)}`
      );
    }

    // 5) GM → Both: OniTrade_StartSession
    async function handleStartSession(payload) {
      console.log("[OniTrade] handleStartSession on user", game.user.id, "payload:", payload);

      if (!payload || typeof payload !== "object") return;

      const {
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      } = payload;

      const localId = game.user.id;
      if (localId !== initiatorUserId && localId !== targetUserId) {
        // Not involved in this trade
        return;
      }

      const otherName =
        localId === initiatorUserId ? targetName ?? "Unknown" : initiatorName ?? "Unknown";

      ui.notifications?.info?.(`OniTrade: Trade session started with ${otherName}.`);

      showLocalChatMessage(
        `<strong>Trade Session Started</strong><br>` +
        `You are now trading with <strong>${esc(otherName)}</strong>. ` +
        `<br><em>The shared Trade Window should now open for both of you.</em>`
      );

      // Ask the Trade Window module to open the shared window for this session
      const TW = globalThis.__OniTradeWindow__;
      if (TW && typeof TW.openTradeWindowForSession === "function") {
        try {
          TW.openTradeWindowForSession({
            requestId,
            initiatorUserId,
            targetUserId,
            initiatorName,
            targetName,
            initiatorActorUuid,
            targetActorUuid
          });
        } catch (err) {
          console.error("[OniTrade] Error calling OniTradeWindow.openTradeWindowForSession:", err);
        }
      } else {
        console.warn(
          "[OniTrade] TradeWindow API not available on this client. " +
          "Make sure DEMO_TradeWindow macro is loaded and run once."
        );
      }
    }
  };

  // KEY CHANGE: install only after the world is READY (socket exists)
  Hooks.once("ready", () => {
    console.log(
      "[OniTrade] READY fired -> installing Trade_ModuleListener. user:",
      game.user?.id,
      "isGM:",
      game.user?.isGM,
      "hasSocket:",
      !!game.socket
    );
    install();
  });
})();